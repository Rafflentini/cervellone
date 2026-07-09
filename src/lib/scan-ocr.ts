// src/lib/scan-ocr.ts
/**
 * Tool: leggi_scansione_drive
 *
 * Legge una SCANSIONE archiviata su Google Drive (PDF fatto di immagini, oppure
 * un'immagine JPG/PNG) facendola "vedere" alla vision di Claude lato server.
 *
 * Risolve il buco per cui i PDF scansionati senza testo (drive_read_pdf ->
 * vuoto) non erano leggibili: il sandbox OCR e' senza internet e
 * scarica_file_da_url deposita su Drive, quindi mancava un ponte Drive->OCR.
 *
 * Server-side: scarica i byte da Drive (downloadFileBase64), li passa all'API
 * Anthropic come blocco `document` (PDF) o `image` (immagine) e restituisce il
 * testo estratto. Nessun binario transita nel context del modello chiamante.
 */
import type Anthropic from '@anthropic-ai/sdk'
import AnthropicSDK from '@anthropic-ai/sdk'
import { downloadFileBase64 } from './drive'

const OCR_FALLBACK_MODEL = 'claude-sonnet-4-6'

/** Modello OCR: env OCR_MODEL -> model_default (Supabase) -> fallback Sonnet. */
async function resolveOcrModel(): Promise<string> {
  if (process.env.OCR_MODEL) return process.env.OCR_MODEL
  try {
    const { supabase } = await import('./supabase')
    const { data } = await supabase
      .from('cervellone_config')
      .select('value')
      .eq('key', 'model_default')
      .maybeSingle()
    const v = data?.value ? String(data.value).replace(/"/g, '') : ''
    if (v) return v
  } catch {
    // ignore -> fallback
  }
  return OCR_FALLBACK_MODEL
}

/** Estrae l'ID file da un ID nudo o da un URL Drive (/d/<id> o id=<id>). */
function extractDriveFileId(value: string): string {
  const t = (value || '').trim()
  const p = t.match(/\/d\/([a-zA-Z0-9_-]+)/)
  if (p) return p[1]
  const q = t.match(/[?&]id=([a-zA-Z0-9_-]+)/)
  if (q) return q[1]
  return t
}

export async function readScanFromDrive(fileIdOrUrl: string, prompt?: string): Promise<string> {
  const fileId = extractDriveFileId(fileIdOrUrl)
  if (!fileId) return 'Errore: file_id richiesto.'

  let base64: string
  let mimeType: string
  let name: string
  try {
    const f = await downloadFileBase64(fileId)
    base64 = f.base64
    mimeType = f.mimeType
    name = f.name
  } catch (err) {
    return `Errore download da Drive: ${err instanceof Error ? err.message : err}`
  }

  const isPdf = mimeType.includes('pdf')
  const isImage = mimeType.startsWith('image/')
  if (!isPdf && !isImage) {
    return `File "${name}" non e' PDF ne' immagine (mime: ${mimeType}). Usa drive_read_office / drive_read_document.`
  }

  const instruction =
    prompt && prompt.trim()
      ? prompt.trim()
      : 'Trascrivi TUTTO il testo leggibile del documento, in modo fedele e ordinato. Riporta numeri, importi, date, targhe e codici esattamente come appaiono. Se e\' una ricevuta/quietanza, evidenzia: importo pagato, data pagamento, periodo/annualita\' di riferimento, intestatario e targa/identificativo.'

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contentBlock: any = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }

  try {
    const client = new AnthropicSDK()
    const model = await resolveOcrModel()
    const msg = await client.messages.create({
      model,
      max_tokens: 4096,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: instruction }] as any }],
    })
    const text = msg.content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((b: any) => b.type === 'text')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((b: any) => b.text)
      .join('\n')
      .trim()
    if (!text) return `📄 ${name}: nessun testo estraibile (documento illeggibile o vuoto).`
    return `📄 OCR di "${name}" (${isPdf ? 'PDF' : 'immagine'}):\n\n${text}`
  } catch (err) {
    return `Errore OCR vision: ${err instanceof Error ? err.message : err}`
  }
}

export const READ_SCAN_DRIVE_TOOL: Anthropic.Tool = {
  name: 'leggi_scansione_drive',
  description:
    "Legge una SCANSIONE archiviata su Google Drive (PDF fatto di immagini, o immagine JPG/PNG) di cui drive_read_pdf non estrae testo. Scarica il file lato server e lo fa leggere alla vision di Claude, restituendo il testo trascritto. USA QUESTO quando drive_read_pdf torna vuoto / '(solo immagini)' su ricevute, quietanze bollo, polizze, DURC scansionati, attestati. Accetta l'ID del file Drive o un URL Drive (/d/<id> o id=<id>). Opzionale: 'prompt' per guidare cosa estrarre.",
  input_schema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'ID del file Drive o URL Drive (/d/<id> o id=<id>)' },
      prompt: { type: 'string', description: 'OPZIONALE - istruzione su cosa estrarre (es. "dammi importo e scadenza del bollo")' },
    },
    required: ['file_id'],
  },
}

export async function executeReadScanFromDrive(input: { file_id: string; prompt?: string }): Promise<string> {
  return readScanFromDrive(input.file_id, input.prompt)
}
