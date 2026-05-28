// src/lib/scadenza-extract.ts
// SP-1 toolkit segretaria: legge il CONTENUTO di un allegato mail (PDF/immagine) e ne estrae
// una scadenza strutturata via Claude (vision per immagini, document per PDF con OCR nativo).
// Scope: legge + estrae + ritorna. NON salva nulla (quello è SP-2/SP-3).

import Anthropic from '@anthropic-ai/sdk'
import { getEmailBody } from '@/v19/tools/email/get-email-body'
import type { AccountKey } from '@/v19/tools/email/config'
import { getConfig } from './claude'

// Modello economico: l'estrazione strutturata non richiede Opus.
const MAX_BASE64_LENGTH = 14 * 1024 * 1024
const client = new Anthropic()

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface ScadenzaEstratta {
  tipo_documento: string | null
  soggetto: string | null // dipendente / mezzo a cui si riferisce
  data_scadenza: string | null // YYYY-MM-DD o null
  emittente: string | null
  confidenza: number // 0..1
  note: string | null
}

const EXTRACT_PROMPT = `Sei un estrattore di dati da documenti aziendali e del personale (idoneità alla mansione / visite mediche, attestati di formazione, polizze, revisioni, bollo, DURC, contratti, certificazioni).
Analizza il documento allegato ed estrai SOLO questi campi. Rispondi con UN SOLO oggetto JSON valido, senza testo attorno e senza markdown:
{
  "tipo_documento": stringa breve (es. "idoneita alla mansione", "attestato formazione", "polizza", "revisione") oppure null,
  "soggetto": a chi/cosa si riferisce. Per documenti del personale il NOME del dipendente; per i mezzi la targa/descrizione. null se non leggibile,
  "data_scadenza": data di scadenza in formato YYYY-MM-DD, oppure null se il documento non ha scadenza o non e leggibile,
  "emittente": chi ha emesso il documento (medico competente, ente, societa) oppure null,
  "confidenza": numero tra 0 e 1 su quanto sei sicuro dell'estrazione,
  "note": breve nota utile oppure null
}
Regole: non inventare date. Se non leggi una scadenza chiara, data_scadenza=null. Le date in formato GG/MM/AAAA convertile in YYYY-MM-DD (anno-mese-giorno).`

function buildBlock(base64: string, mimeType: string): Anthropic.ContentBlockParam | null {
  if (mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
  }
  if (mimeType.startsWith('image/')) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: mimeType as 'image/jpeg', data: base64 },
    }
  }
  return null
}

function parseJsonLoose(text: string): ScadenzaEstratta | null {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end === -1) return null
  try {
    const o = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>
    const confidence = Number(o.confidenza)
    return {
      tipo_documento: typeof o.tipo_documento === 'string' ? o.tipo_documento : null,
      soggetto: typeof o.soggetto === 'string' ? o.soggetto : null,
      data_scadenza: typeof o.data_scadenza === 'string' ? o.data_scadenza : null,
      emittente: typeof o.emittente === 'string' ? o.emittente : null,
      confidenza: Number.isNaN(confidence) ? 0 : Math.max(0, Math.min(1, confidence)),
      note: typeof o.note === 'string' ? o.note : null,
    }
  } catch {
    return null
  }
}

/**
 * Estrae una scadenza strutturata dal contenuto di un allegato (foto/PDF) via Claude.
 */
export async function estraiScadenzaDaAllegato(
  base64: string,
  mimeType: string,
  filename: string,
): Promise<{ ok: true; data: ScadenzaEstratta } | { ok: false; error: string }> {
  console.log(`[SCAD-EXTRACT] start filename="${filename}" mimeType="${mimeType}" base64Length=${base64.length}`)
  if (base64.length > MAX_BASE64_LENGTH) {
    const error = "Allegato troppo grande per l'estrazione (>~10MB)"
    console.log(`[SCAD-EXTRACT] error filename="${filename}" error="${error}"`)
    return { ok: false, error }
  }

  const block = buildBlock(base64, mimeType)
  if (!block) {
    const error = `Tipo allegato non supportato: ${mimeType} (${filename})`
    console.log(`[SCAD-EXTRACT] error filename="${filename}" error="${error}"`)
    return { ok: false, error }
  }
  try {
    const { modelExtractFast } = await getConfig()
    const resp = await client.messages.create({
      model: modelExtractFast,
      max_tokens: 900,
      messages: [{ role: 'user', content: [block, { type: 'text', text: EXTRACT_PROMPT }] }],
    })
    if (resp.stop_reason === 'max_tokens') {
      const error = 'risposta troncata (documento troppo lungo)'
      console.log(`[SCAD-EXTRACT] error filename="${filename}" error="${error}"`)
      return { ok: false, error }
    }
    const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    const parsed = textBlock ? parseJsonLoose(textBlock.text) : null
    if (!parsed) {
      const error = 'Estrazione non riuscita (risposta non in JSON leggibile)'
      console.log(`[SCAD-EXTRACT] error filename="${filename}" error="${error}"`)
      return { ok: false, error }
    }
    console.log(`[SCAD-EXTRACT] ok filename="${filename}" confidenza=${parsed.confidenza}`)
    return { ok: true, data: parsed }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    console.log(`[SCAD-EXTRACT] error filename="${filename}" error="${error}"`)
    return { ok: false, error }
  }
}

// ── Tool interattivo ──────────────────────────────────────────────────────────

export const LEGGI_ALLEGATO_TOOLS: ToolDefinition[] = [
  {
    name: 'leggi_allegato_mail',
    description:
      'Legge il CONTENUTO di un allegato (PDF/immagine) di una mail TopHost (account info o raffaele) ed estrae una scadenza strutturata: tipo_documento, soggetto (es. nome dipendente), data_scadenza, emittente. Usalo per leggere idoneita/visite mediche, attestati di formazione, polizze ricevute via email. Ritorna SOLO i dati estratti (non salva nulla; per registrare usa registra_scadenza).',
    input_schema: {
      type: 'object',
      properties: {
        account: { type: 'string', enum: ['info', 'raffaele'], description: 'Casella TopHost' },
        uid: { type: 'integer', description: 'UID IMAP della mail (ottenuto da read_email)' },
        folder: { type: 'string', description: 'Cartella IMAP, default INBOX' },
        indice: { type: 'integer', description: 'Indice allegato (0 = primo, default 0)' },
      },
      required: ['account', 'uid'],
    },
  },
]

export async function executeLeggiAllegatoTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'leggi_allegato_mail') return null
  try {
    const account = String(input.account || '') as AccountKey
    const uid = Number(input.uid)
    const indice = input.indice != null ? Number(input.indice) : 0
    const folder = input.folder ? String(input.folder) : undefined
    if (account !== 'info' && account !== 'raffaele') {
      return JSON.stringify({ ok: false, error: 'account deve essere info o raffaele' })
    }
    if (!Number.isInteger(uid) || uid < 1) {
      return JSON.stringify({ ok: false, error: 'uid deve essere un intero >= 1' })
    }
    const mail = await getEmailBody({ account, uid, folder, include_attachments: true })
    const atts = mail.attachments || []
    if (atts.length === 0) return JSON.stringify({ ok: false, error: 'La mail non ha allegati' })
    const att = atts[indice]
    if (!att) return JSON.stringify({ ok: false, error: `Allegato indice ${indice} inesistente (totale: ${atts.length})` })
    if (!att.contentBase64) return JSON.stringify({ ok: false, error: 'Contenuto allegato non disponibile' })
    const res = await estraiScadenzaDaAllegato(att.contentBase64, att.contentType, att.filename || 'allegato')
    if (!res.ok) return JSON.stringify({ ok: false, error: res.error, filename: att.filename })
    return JSON.stringify({ ok: true, filename: att.filename, allegati_totali: atts.length, estratto: res.data })
  } catch (err) {
    return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
