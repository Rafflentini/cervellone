/**
 * lib/draft-tools.ts — Gestione bozze/documenti già generati (tabella `documents`).
 *
 * Risolve il bug per cui il bot GENERA un documento (riga in `documents` con
 * content HTML) e poi NON sa ritrovarlo: lo rigenera da zero con UUID diversi e
 * non riesce a salvarlo su Drive. Inoltre abilita la MODIFICA IN-PLACE
 * ("aggiungi un paragrafo senza toccare il resto") → stesso id, stesso link /doc/<id>.
 *
 * Tabella `documents`: id, name, content (HTML), conversation_id, type,
 * metadata (jsonb), created_at. Il link pubblico di un doc è `/doc/<id>`.
 *
 * Tutto best-effort: ogni funzione cattura gli errori e ritorna messaggi/oggetti
 * chiari invece di lanciare.
 */
import { getSupabaseServer } from './supabase-server'
import { generatePdfFromHtml } from './pdf-generator'
import { assertWriteAllowed, uploadBinaryToDrive, DrivePolicyError } from './drive'

/** Path relativo del link pubblico di un documento. Il chiamante compone l'host. */
function docPath(id: string): string {
  return `/doc/${id}`
}

/** Type usato dalle catture automatiche (artifact-capture): content = TESTO PIATTO. */
const AUTO_DRAFT_TYPE = 'auto-bozza'

/**
 * Heuristica: il content sembra già HTML? (contiene almeno un tag a blocco tipico).
 * Conservativa: se NON troviamo nessun tag noto, trattiamo il content come testo piatto.
 */
export function looksLikeHtml(content: string): boolean {
  if (!content) return false
  return /<(?:h[1-6]|p|div|table|tr|td|th|ul|ol|li|br|section|article|html|body)\b[^>]*>/i.test(
    content,
  )
}

/** Escape dei caratteri speciali HTML (&, <, >, ", '). */
function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * Wrappa TESTO PIATTO (es. una auto-bozza con markup Telegram/emoji) in HTML
 * semplice e sicuro per la generazione PDF:
 *  - escapa &, <, >, " , '
 *  - ogni blocco separato da riga vuota → un <p>
 *  - i newline singoli dentro un blocco → <br>
 * Ritorna sempre almeno un <p> non vuoto.
 */
export function wrapPlainTextAsHtml(text: string): string {
  const escaped = escapeHtmlText((text || '').replace(/\r\n/g, '\n').trim())
  if (!escaped) return '<p></p>'
  // Blocchi separati da una o più righe vuote → paragrafi.
  const blocks = escaped.split(/\n{2,}/)
  const paragraphs = blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
  return paragraphs.length > 0 ? paragraphs.join('\n') : '<p></p>'
}

/**
 * Elenca le bozze/documenti più recenti di una conversazione (default 10).
 * Ritorna una stringa leggibile con nome, tipo, data e link /doc/<id> per ognuno.
 * Se non ci sono righe: "Nessuna bozza trovata in questa conversazione.".
 * Fallback: se `created_at` non è disponibile (colonna assente), ordina per id desc.
 */
export async function listRecentDrafts(conversationId: string, limit = 10): Promise<string> {
  try {
    const supabase = getSupabaseServer()

    // Prova con ordinamento per created_at; se la colonna non esiste, fallback su id.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any[] | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let error: any = null
    {
      const res = await supabase
        .from('documents')
        .select('id, name, type, created_at')
        .eq('conversation_id', conversationId)
        .neq('type', 'image-extraction')
        .order('created_at', { ascending: false })
        .limit(limit)
      data = res.data
      error = res.error
    }

    if (error) {
      const retry = await supabase
        .from('documents')
        .select('id, name, type')
        .eq('conversation_id', conversationId)
        .neq('type', 'image-extraction')
        .order('id', { ascending: false })
        .limit(limit)
      data = retry.data
      error = retry.error
    }

    if (error) {
      return `Errore nel recupero delle bozze: ${error.message}`
    }

    if (!data || data.length === 0) {
      return 'Nessuna bozza trovata in questa conversazione.'
    }

    const lines = data.map(row => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = row as any
      const name = d.name || '(senza nome)'
      const type = d.type ? ` [${d.type}]` : ''
      let date = ''
      if (d.created_at) {
        const parsed = new Date(d.created_at)
        if (!isNaN(parsed.getTime())) date = ` — ${parsed.toLocaleDateString('it-IT')}`
      }
      return `📄 ${name}${type}${date} — ${docPath(d.id)} (id: ${d.id})`
    })

    return `${data.length} bozze in questa conversazione:\n${lines.join('\n')}`
  } catch (err) {
    return `Errore nel recupero delle bozze: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Recupera un documento per id. Ritorna { ok, name, content, type, url } oppure
 * { ok: false, error }. L'url è il path relativo `/doc/<id>`.
 */
export async function getDraft(
  id: string,
): Promise<{ ok: boolean; name?: string; content?: string; type?: string; url?: string; error?: string }> {
  try {
    const supabase = getSupabaseServer()
    const { data, error } = await supabase
      .from('documents')
      .select('name, content, type')
      .eq('id', id)
      .single()

    if (error || !data) {
      return { ok: false, error: error?.message || `Documento ${id} non trovato.` }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = data as any
    return {
      ok: true,
      name: d.name,
      content: d.content,
      type: d.type,
      url: docPath(id),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * MODIFICA IN-PLACE: aggiorna SOLO il content di un documento esistente.
 * Stesso record, stesso id, stesso link /doc/<id> — NON crea un nuovo documento.
 * Aggiorna anche `updated_at` se la colonna esiste, altrimenti solo `content`.
 */
export async function updateDraft(id: string, newContent: string): Promise<string> {
  try {
    const supabase = getSupabaseServer()

    // Prova con updated_at; se la colonna non esiste, riprova col solo content.
    let { error } = await supabase
      .from('documents')
      .update({ content: newContent, updated_at: new Date().toISOString() })
      .eq('id', id)

    if (error) {
      const retry = await supabase
        .from('documents')
        .update({ content: newContent })
        .eq('id', id)
      error = retry.error
    }

    if (error) {
      return `Errore aggiornando il documento ${id}: ${error.message}`
    }

    return `✅ Documento aggiornato (stesso link): ${docPath(id)}`
  } catch (err) {
    return `Errore aggiornando il documento ${id}: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Genera il PDF di un documento esistente e lo carica su Google Drive.
 * Rispetta la policy scritture (assertWriteAllowed). Ritorna il link Drive del
 * file caricato, oppure un messaggio d'errore CHIARO (doc inesistente, cartella
 * non scrivibile, generazione PDF fallita, upload fallito).
 */
export async function saveDraftPdfToDrive(id: string, folderId: string): Promise<string> {
  // 1. Recupera il documento
  const draft = await getDraft(id)
  if (!draft.ok || !draft.content) {
    return `Impossibile salvare: documento ${id} non trovato${draft.error ? ` (${draft.error})` : ''}.`
  }

  const name = draft.name || 'Documento'

  // 2. Genera il PDF dall'HTML.
  // Le auto-bozze (artifact-capture) salvano content = TESTO PIATTO, NON HTML: se
  // lo passassimo tale e quale a generatePdfFromHtml otterremmo un PDF illeggibile
  // (markup Telegram *grassetto*, emoji, niente <p>). Quindi: se il documento è
  // type='auto-bozza' OPPURE il content non sembra HTML, lo wrappiamo in HTML semplice.
  const isAutoDraft = draft.type === AUTO_DRAFT_TYPE
  const htmlContent =
    isAutoDraft || !looksLikeHtml(draft.content)
      ? wrapPlainTextAsHtml(draft.content)
      : draft.content

  let pdf: Buffer
  try {
    pdf = await generatePdfFromHtml(htmlContent, name)
  } catch (err) {
    return `Impossibile generare il PDF del documento "${name}": ${err instanceof Error ? err.message : String(err)}`
  }

  // 3. Verifica la policy di scrittura sulla cartella di destinazione
  try {
    await assertWriteAllowed(folderId)
  } catch (err) {
    if (err instanceof DrivePolicyError) return `🔒 ${err.message}`
    return `Cartella ${folderId} non scrivibile: ${err instanceof Error ? err.message : String(err)}`
  }

  // 4. Carica il PDF su Drive
  try {
    const fileName = name.endsWith('.pdf') ? name : `${name}.pdf`
    const { webViewLink } = await uploadBinaryToDrive(pdf, fileName, 'application/pdf', folderId)
    return `✅ PDF "${fileName}" salvato su Drive.\n👉 ${webViewLink}`
  } catch (err) {
    return `Errore caricando il PDF su Drive: ${err instanceof Error ? err.message : String(err)}`
  }
}
