/**
 * src/lib/artifact-capture.ts — Cattura automatica degli ARTEFATTI composti dal bot.
 *
 * Bug risolto: durante un task lungo il bot "perde memoria" di ciò che ha già
 * composto (es. riscrive da capo una mail già scritta 30 min prima). Qui salviamo
 * automaticamente nello store esistente `documents` (riusando i draft-tools) gli
 * artefatti sostanziali (mail/lettere/documenti) prodotti dall'assistente, con
 * type 'auto-bozza', e forniamo un POINTER breve da ri-iniettare nel contesto così
 * che il modello sappia che la bozza esiste già e la recuperi con ritrova_bozza
 * invece di rigenerarla.
 *
 * NB: questo modulo NON è ancora agganciato al turno live (lo farà Claude dopo, con
 * conferma). Espone solo le primitive.
 *
 * Schema tabella `documents` (riuso identico a draft-tools / agent-job):
 *   id, name, content, conversation_id, type, metadata (jsonb), created_at.
 * Shape insert valida (vedi agent-job.ts:136):
 *   { name, content, conversation_id, type, metadata }.
 *
 * Tutto best-effort: nessuna funzione lancia mai; in caso di errore ritorna
 * { saved: false, reason } / ''.
 */

import { getSupabaseServer } from './supabase-server'
import { isWorkingMemoryEnabled } from './working-memory'

/* ─── Costanti tunabili ─── */

/** Soglia minima di lunghezza (char) perché un testo sia considerato un artefatto. */
const MIN_ARTIFACT_LENGTH = 600

/** Type usato per le righe catturate automaticamente nella tabella `documents`. */
const AUTO_DRAFT_TYPE = 'auto-bozza'

/** Marker testuali tipici di una lettera/mail/documento formale (case-insensitive). */
const DOCUMENT_MARKERS = [
  'oggetto:',
  'gentile',
  'spett',
  'cordiali saluti',
  'distinti saluti',
  'in fede',
  'egregio',
  'alla cortese attenzione',
  // Documenti tecnici italiani (relazioni, verbali, preventivi, computi).
  'relazione',
  'premesso che',
  'verbale',
  'preventivo n',
  'computo',
]

/** Finestra di recency (ms) per le bozze auto-catturate mostrate nel pointer: 24h. */
const POINTER_RECENCY_MS = 24 * 60 * 60 * 1000

/** Voci massime nel pointer + lunghezza massima titolo nel pointer. */
const POINTER_MAX_ENTRIES = 5
const POINTER_TITLE_MAXLEN = 80

/** Lunghezza massima del titolo derivato da una riga libera. */
const DERIVED_TITLE_MAXLEN = 60

/* ─── Euristica: il testo è un artefatto sostanziale? ─── */

/**
 * Euristica conservativa: true SOLO se il testo è abbastanza lungo E contiene un
 * marker documentale (lettera/mail/relazione/verbale/preventivo/computo…). Falso
 * per le chat brevi e per QUALSIASI risposta lunga ma senza marcatori documentali
 * (anche se strutturata a paragrafi): una normale spiegazione del bot NON è una
 * bozza. Conservativo > rumoroso: meglio catturare meno.
 */
export function isSubstantialArtifact(text: string): boolean {
  if (!text) return false
  const trimmed = text.trim()
  if (trimmed.length < MIN_ARTIFACT_LENGTH) return false

  const lower = trimmed.toLowerCase()
  const hasMarker = DOCUMENT_MARKERS.some((m) => lower.includes(m))
  return hasMarker
}

/* ─── Derivazione titolo ─── */

/**
 * Deriva un titolo dall'artefatto: usa "Oggetto: ..." se presente, altrimenti le
 * prime ~DERIVED_TITLE_MAXLEN char della prima riga non vuota.
 */
function deriveTitle(text: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim().slice(0, 120)

  const lines = text.split(/\r?\n/)

  // 1. "Oggetto: ..."
  for (const line of lines) {
    const m = line.match(/^\s*oggetto\s*:\s*(.+)$/i)
    if (m && m[1].trim()) return m[1].trim().slice(0, 120)
  }

  // 2. Prima riga non vuota
  for (const line of lines) {
    const t = line.trim()
    if (t.length > 0) {
      return t.length > DERIVED_TITLE_MAXLEN ? `${t.slice(0, DERIVED_TITLE_MAXLEN)}…` : t
    }
  }

  return 'Bozza'
}

/* ─── Cattura ─── */

/**
 * Cattura un artefatto sostanziale prodotto dall'assistente nella tabella
 * `documents` (type 'auto-bozza'), se la working memory è attiva e il testo è un
 * artefatto sostanziale.
 *
 * DEDUP: non salva se l'ULTIMA riga 'auto-bozza' della conversazione ha content
 * identico (evita di accumulare la stessa bozza ad ogni turno).
 *
 * Best-effort: non lancia mai. Ritorna { saved, id?, reason? }.
 */
export async function captureArtifact(
  conversationId: string,
  assistantText: string,
  opts?: { title?: string },
): Promise<{ saved: boolean; id?: string; reason?: string }> {
  try {
    if (!conversationId) return { saved: false, reason: 'no-conversation' }
    if (!isSubstantialArtifact(assistantText)) return { saved: false, reason: 'not-substantial' }

    const enabled = await isWorkingMemoryEnabled()
    if (!enabled) return { saved: false, reason: 'disabled' }

    const supabase = getSupabaseServer()
    const content = assistantText.trim()

    // DEDUP: confronta col content dell'ultima auto-bozza della conversazione.
    try {
      const { data: last } = await supabase
        .from('documents')
        .select('content')
        .eq('conversation_id', conversationId)
        .eq('type', AUTO_DRAFT_TYPE)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (last && typeof last.content === 'string' && last.content.trim() === content) {
        return { saved: false, reason: 'duplicate' }
      }
    } catch (dedupErr) {
      // Se il dedup fallisce non blocchiamo il salvataggio: meglio una bozza in più.
      console.error(
        '[artifact-capture] dedup check failed:',
        dedupErr instanceof Error ? dedupErr.message : dedupErr,
      )
    }

    const title = deriveTitle(content, opts?.title)

    const { data, error } = await supabase
      .from('documents')
      .insert({
        name: title,
        content,
        conversation_id: conversationId,
        type: AUTO_DRAFT_TYPE,
        metadata: { source: 'artifact-capture', auto: true },
      })
      .select('id')
      .single()

    if (error) {
      console.error('[artifact-capture] insert failed:', error.message)
      return { saved: false, reason: error.message }
    }

    return { saved: true, id: (data as { id?: string } | null)?.id }
  } catch (err) {
    console.error(
      '[artifact-capture] captureArtifact error:',
      err instanceof Error ? err.message : err,
    )
    return { saved: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/* ─── Pointer da ri-iniettare ─── */

/**
 * Costruisce un blocco breve che elenca le bozze auto-catturate RECENTI della
 * conversazione, così il modello non le riscrive da zero. Ritorna '' se non ce ne
 * sono.
 *
 * Filtra a type='auto-bozza' (solo le catture automatiche, NON i documenti generati
 * via tool/agent-job) E a created_at nelle ultime 24h: su Telegram la conversation
 * è globale e permanente, quindi senza il filtro recency il pointer mostrerebbe
 * bozze vecchie di task ormai chiusi (stale/cross-task).
 * Max POINTER_MAX_ENTRIES voci, titoli troncati a POINTER_TITLE_MAXLEN char.
 *
 * Best-effort: qualsiasi errore → ''.
 */
export async function buildArtifactsPointer(conversationId: string): Promise<string> {
  try {
    if (!conversationId) return ''
    const supabase = getSupabaseServer()

    const sinceIso = new Date(Date.now() - POINTER_RECENCY_MS).toISOString()

    const { data, error } = await supabase
      .from('documents')
      .select('id, name, type, created_at')
      .eq('conversation_id', conversationId)
      .eq('type', AUTO_DRAFT_TYPE)
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(POINTER_MAX_ENTRIES)

    if (error) {
      console.error('[artifact-capture] buildArtifactsPointer read failed:', error.message)
      return ''
    }
    if (!data || data.length === 0) return ''

    const lines: string[] = []
    lines.push("=== BOZZE GIÀ PRONTE (non rifarle da capo) ===")
    for (const row of data) {
      const r = row as { id?: string; name?: string | null; created_at?: string | null }
      if (!r.id) continue
      const rawTitle = (r.name && r.name.trim()) || '(senza nome)'
      const title =
        rawTitle.length > POINTER_TITLE_MAXLEN
          ? `${rawTitle.slice(0, POINTER_TITLE_MAXLEN)}…`
          : rawTitle
      // Hint di data (facoltativo): YYYY-MM-DD se created_at è parsabile.
      let dateHint = ''
      if (r.created_at) {
        const d = new Date(r.created_at)
        if (!Number.isNaN(d.getTime())) dateHint = ` [${d.toISOString().slice(0, 10)}]`
      }
      lines.push(
        `- «${title}»${dateHint} (id ${r.id}) — recuperala intera con ritrova_bozza id=${r.id}, non riscriverla`,
      )
    }

    // Se per qualche motivo nessuna riga aveva id, non emettere un blocco vuoto.
    if (lines.length <= 1) return ''

    lines.push('=== fine bozze ===')
    return lines.join('\n')
  } catch (err) {
    console.error(
      '[artifact-capture] buildArtifactsPointer error:',
      err instanceof Error ? err.message : err,
    )
    return ''
  }
}
