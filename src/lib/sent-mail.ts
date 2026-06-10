/**
 * src/lib/sent-mail.ts — Consapevolezza delle MAIL GIÀ INVIATE in una conversazione.
 *
 * Bug risolto: il bot ha proposto di RE-INVIARE una mail già spedita ufficialmente,
 * perché non aveva memoria del fatto che quell'invio era già avvenuto. Qui registriamo
 * ogni invio riuscito (status='sent') nella tabella `documents` con type='mail-inviata',
 * e forniamo un POINTER breve da ri-iniettare nel contesto a ogni turno così che il
 * modello sappia che la mail è già partita e NON la rifaccia senza richiesta esplicita.
 *
 * Schema `documents` (riuso identico a draft-tools / artifact-capture / agent-job):
 *   id, name, content, conversation_id, type, metadata (jsonb), created_at.
 *
 * Tutto best-effort: nessuna funzione lancia mai; in caso di errore non blocca il flusso.
 */

import { getSupabaseServer } from './supabase-server'

/** Type usato per le righe di mail inviata nella tabella `documents`. */
const SENT_MAIL_TYPE = 'mail-inviata'

/** Finestra di recency (ms) per le mail inviate mostrate nel pointer: 48h. */
const POINTER_RECENCY_MS = 48 * 60 * 60 * 1000

/** Voci massime nel pointer. */
const POINTER_MAX_ENTRIES = 5

/**
 * Registra una mail effettivamente INVIATA nella tabella `documents`.
 * Best-effort: non lancia mai (cattura ogni errore internamente).
 *
 * @param conversationId conversazione in cui è avvenuto l'invio
 * @param info dati dell'invio: destinatario (to) e oggetto (subject)
 */
export async function recordSentMail(
  conversationId: string,
  info: { to?: string; subject?: string },
): Promise<void> {
  try {
    if (!conversationId) return
    const supabase = getSupabaseServer()

    const to = (info.to ?? '').trim()
    const subject = (info.subject ?? '').trim()
    const name = subject || '(senza oggetto)'
    const sentAtIso = new Date().toISOString()
    const content = `A: ${to}\nOggetto: ${subject}\nInviata: ${sentAtIso}`

    const { error } = await supabase.from('documents').insert({
      name,
      content,
      conversation_id: conversationId,
      type: SENT_MAIL_TYPE,
      metadata: { source: 'sent-mail' },
    })

    if (error) {
      console.error('[sent-mail] recordSentMail insert failed:', error.message)
    }
  } catch (err) {
    console.error(
      '[sent-mail] recordSentMail error:',
      err instanceof Error ? err.message : err,
    )
  }
}

/**
 * Costruisce un blocco breve che elenca le mail GIÀ INVIATE recenti (ultime 48h, max 5)
 * della conversazione, così il modello non le re-invia senza richiesta esplicita.
 * Ritorna '' se non ce ne sono.
 *
 * Best-effort: qualsiasi errore → ''.
 */
export async function buildSentMailPointer(conversationId: string): Promise<string> {
  try {
    if (!conversationId) return ''
    const supabase = getSupabaseServer()

    const sinceIso = new Date(Date.now() - POINTER_RECENCY_MS).toISOString()

    const { data, error } = await supabase
      .from('documents')
      .select('name, content, created_at')
      .eq('conversation_id', conversationId)
      .eq('type', SENT_MAIL_TYPE)
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(POINTER_MAX_ENTRIES)

    if (error) {
      console.error('[sent-mail] buildSentMailPointer read failed:', error.message)
      return ''
    }
    if (!data || data.length === 0) return ''

    const lines: string[] = []
    lines.push(
      '=== MAIL GIÀ INVIATE in questa chat (NON re-inviarle senza richiesta ESPLICITA) ===',
    )
    for (const row of data) {
      const r = row as {
        name?: string | null
        content?: string | null
        created_at?: string | null
      }
      const subject = (r.name && r.name.trim()) || '(senza oggetto)'
      const dest = extractDest(r.content) || '?'
      let dateHint = '?'
      if (r.created_at) {
        const d = new Date(r.created_at)
        if (!Number.isNaN(d.getTime())) dateHint = d.toISOString().slice(0, 10)
      }
      lines.push(`- «${subject}» → ${dest} (inviata il ${dateHint})`)
    }
    lines.push('=== fine ===')
    return lines.join('\n')
  } catch (err) {
    console.error(
      '[sent-mail] buildSentMailPointer error:',
      err instanceof Error ? err.message : err,
    )
    return ''
  }
}

/** Estrae il destinatario dalla riga "A: ..." del content salvato. '' se assente. */
function extractDest(content: string | null | undefined): string {
  if (!content) return ''
  const m = content.match(/^A:\s*(.*)$/m)
  return m ? m[1].trim() : ''
}
