import Anthropic from '@anthropic-ai/sdk'
import crypto from 'crypto'
import { listFiles, downloadFileBase64 } from './drive'
import { supabase } from './supabase'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

type Direzione = 'entrata' | 'uscita'
type Fonte = 'banca' | 'carta' | 'paypal' | 'altro'

export interface MovimentoEstratto {
  data: string
  importo: number
  direzione: Direzione
  descrizione: string
  controparte: string | null
  fonte: Fonte | null
  conto: string | null
}

type EstraiResult = { ok: true; movimenti: MovimentoEstratto[] } | { ok: false; error: string }

const MODEL = 'claude-haiku-4-5'
const MAX_BASE64_LENGTH = 28 * 1024 * 1024
const client = new Anthropic()

const EXTRACT_PROMPT = `Sei un estrattore contabile da estratti conto banca, carte di credito, PayPal e rendiconti finanziari.
Estrai TUTTI i movimenti presenti nel documento. Rispondi SOLO con un array JSON valido, senza testo prima o dopo e senza markdown.
Schema di ogni elemento:
{
  "data": "YYYY-MM-DD",
  "importo": number positivo,
  "direzione": "entrata" oppure "uscita",
  "descrizione": string,
  "controparte": string oppure null,
  "fonte": "banca" oppure "carta" oppure "paypal" oppure "altro" oppure null,
  "conto": string oppure null
}
Regole:
- Una riga per ogni movimento reale.
- Salta righe senza data o senza importo.
- Converti date italiane GG/MM/AAAA o GG-MM-AAAA in YYYY-MM-DD.
- Converti numeri italiani come 1.234,56 in number 1234.56.
- L'importo deve essere sempre positivo; usa direzione per distinguere entrata e uscita.
- DIREZIONE entrata vs uscita:
  - "entrata" = accredito, bonifico ricevuto, versamento, incasso, dividendo, storno positivo, "AVERE", segno +
  - "uscita" = addebito, bonifico inviato, pagamento, prelievo, commissione, spesa, "DARE", segno -
  - Su estratti conto bancari italiani: colonna "Dare" o "Addebito" o "-" = uscita; colonna "Avere" o "Accredito" o "+" = entrata.
  - Su estratti carte di credito: tipicamente TUTTI uscita (sono spese). Rimborsi/storni accreditati = entrata.
  - Su PayPal: pagamento inviato = uscita; pagamento ricevuto / addebito storno = entrata.
  - NON dedurre la direzione dal solo segno aritmetico se la colonna e ambigua: leggi le intestazioni delle colonne.
- Se non distingui fonte o conto, usa null.
- Non inventare movimenti, controparti o saldi. Non includere subtotali, saldi iniziali/finali o righe descrittive.`

function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload })
}

function fail(error: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, error, ...payload })
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function parseFonte(value: unknown): Fonte | null {
  const fonte = cleanString(value)?.toLowerCase()
  return fonte === 'banca' || fonte === 'carta' || fonte === 'paypal' || fonte === 'altro' ? fonte : null
}

function parseDirezione(value: unknown): Direzione | null {
  const direction = cleanString(value)?.toLowerCase()
  return direction === 'entrata' || direction === 'uscita' ? direction : null
}

function parseAmount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.abs(value)
  if (typeof value !== 'string') return null
  const normalized = value
    .trim()
    .replace(/\s/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
    .replace(/[^\d.-]/g, '')
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? Math.abs(parsed) : null
}

function normalizeMovement(raw: unknown): MovimentoEstratto | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const data = cleanString(row.data)
  const importo = parseAmount(row.importo)
  const direzione = parseDirezione(row.direzione)
  const descrizione = cleanString(row.descrizione)

  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data) || importo === null || !direzione) return null

  return {
    data,
    importo,
    direzione,
    descrizione: descrizione || 'Movimento senza descrizione',
    controparte: cleanString(row.controparte) ?? null,
    fonte: parseFonte(row.fonte),
    conto: cleanString(row.conto) ?? null,
  }
}

function parseMovimentiJson(text: string): MovimentoEstratto[] | null {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('[')
  const end = t.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return null
  try {
    const parsed = JSON.parse(t.slice(start, end + 1))
    if (!Array.isArray(parsed)) return null
    return parsed.map(normalizeMovement).filter((m): m is MovimentoEstratto => Boolean(m))
  } catch {
    return null
  }
}

function buildContentBlock(base64: string, mimeType: string): Anthropic.ContentBlockParam | null {
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

function parseDriveListFiles(output: string): Array<{ id: string; name: string }> {
  return output
    .split('\n')
    .map(line => {
      const match = line.match(/^(?:\S+\s+)?(.+?)\s*(?:\([^)]*\))?(?:\s+—\s+.*?)?\s+\[ID:\s*([^\]]+)\]/)
      return match ? { name: match[1].trim(), id: match[2].trim() } : null
    })
    .filter((item): item is { id: string; name: string } => Boolean(item))
}

function movementHash(m: MovimentoEstratto): string {
  return crypto
    .createHash('sha256')
    .update([m.data, m.importo, m.descrizione, m.fonte ?? '', m.conto ?? ''].join('|'))
    .digest('hex')
}

export async function estraiMovimentiDaPdf(
  base64: string,
  mimeType: string,
  filename: string,
): Promise<EstraiResult> {
  if (base64.length > MAX_BASE64_LENGTH) return { ok: false, error: 'file troppo grande per estrazione movimenti' }

  const block = buildContentBlock(base64, mimeType)
  if (!block) return { ok: false, error: `tipo file non supportato: ${mimeType} (${filename})` }

  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: [block, { type: 'text', text: EXTRACT_PROMPT }] }],
    })

    if (resp.stop_reason === 'max_tokens') return { ok: false, error: 'estratto troppo lungo, dividilo' }

    const textBlock = resp.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    const movimenti = textBlock ? parseMovimentiJson(textBlock.text) : null
    if (!movimenti) return { ok: false, error: 'risposta non in JSON leggibile' }

    return { ok: true, movimenti }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function insertMovement(
  movimento: MovimentoEstratto,
  meta: { driveFileId: string; driveUrl: string; periodo: string | null; fonteOverride: Fonte | null },
): Promise<boolean> {
  const fonte = meta.fonteOverride ?? movimento.fonte
  const periodoEff = meta.periodo ?? movimento.data.slice(0, 7)
  const hash = movementHash({ ...movimento, fonte })

  const existing = await supabase
    .from('cervellone_movimenti')
    .select('id')
    .eq('hash', hash)
    .maybeSingle()

  if (existing.data?.id) return false
  if (existing.error) throw new Error(existing.error.message)

  const { error } = await supabase.from('cervellone_movimenti').insert({
    data: movimento.data,
    importo: movimento.importo,
    direzione: movimento.direzione,
    descrizione: movimento.descrizione,
    controparte: movimento.controparte,
    fonte,
    conto: movimento.conto,
    periodo: periodoEff,
    drive_file_id: meta.driveFileId,
    drive_url: meta.driveUrl,
    hash,
    confidenza: 0.8,
    stato: 'attivo',
  })

  if (error) {
    if (error.code === '23505') return false
    throw new Error(error.message)
  }
  return true
}

async function executeEstraiMovimenti(input: Record<string, unknown>): Promise<string> {
  const folderId = cleanString(input.folder_id)
  const fonteOverride = parseFonte(input.fonte)
  const periodo = cleanString(input.periodo) ?? null
  if (!folderId) return fail('folder_id richiesto')

  const listed = await listFiles(folderId)
  const files = parseDriveListFiles(listed)
  const riepilogo: Array<{ nome: string; estratti: number; nuovi: number; error?: string }> = []
  let entrate = 0
  let uscite = 0
  let nuoviTotali = 0
  let estrattiTotali = 0

  for (const file of files) {
    let downloaded: Awaited<ReturnType<typeof downloadFileBase64>>
    try {
      downloaded = await downloadFileBase64(file.id)
    } catch (err) {
      riepilogo.push({ nome: file.name, estratti: 0, nuovi: 0, error: err instanceof Error ? err.message : String(err) })
      continue
    }

    const isPdf = downloaded.mimeType === 'application/pdf' || downloaded.name.toLowerCase().endsWith('.pdf')
    if (!isPdf) continue

    const extracted = await estraiMovimentiDaPdf(downloaded.base64, 'application/pdf', downloaded.name)
    if (!extracted.ok) {
      riepilogo.push({ nome: downloaded.name, estratti: 0, nuovi: 0, error: extracted.error })
      continue
    }

    let nuoviFile = 0
    for (const movimento of extracted.movimenti) {
      const inserted = await insertMovement(movimento, {
        driveFileId: file.id,
        driveUrl: `https://drive.google.com/file/d/${file.id}/view`,
        periodo,
        fonteOverride,
      })
      if (!inserted) continue
      nuoviFile += 1
      nuoviTotali += 1
      if (movimento.direzione === 'entrata') entrate += movimento.importo
      else uscite += movimento.importo
    }

    estrattiTotali += extracted.movimenti.length
    riepilogo.push({ nome: downloaded.name, estratti: extracted.movimenti.length, nuovi: nuoviFile })
  }

  return ok({
    files: riepilogo,
    totali: {
      estratti: estrattiTotali,
      nuovi: nuoviTotali,
      entrate,
      uscite,
      saldo: entrate - uscite,
    },
  })
}

async function executeListaMovimenti(input: Record<string, unknown>): Promise<string> {
  const periodo = cleanString(input.periodo)
  const dataDal = cleanString(input.data_dal)
  const dataAl = cleanString(input.data_al)
  const fonte = parseFonte(input.fonte)
  const dateRe = /^\d{4}-\d{2}-\d{2}$/

  if (dataDal && !dateRe.test(dataDal)) return fail('data_dal deve essere in formato YYYY-MM-DD')
  if (dataAl && !dateRe.test(dataAl)) return fail('data_al deve essere in formato YYYY-MM-DD')

  let query = supabase
    .from('cervellone_movimenti')
    .select('id, data, importo, direzione, descrizione, controparte, fonte, conto, periodo, drive_url')
    .eq('stato', 'attivo')
    .order('data', { ascending: false })
    .limit(100)

  if (dataDal) query = query.gte('data', dataDal)
  if (dataAl) query = query.lte('data', dataAl)
  if (periodo) query = query.eq('periodo', periodo)
  if (fonte) query = query.eq('fonte', fonte)

  const { data, error } = await query
  if (error) return fail(error.message)

  const rows = data ?? []
  const entrate = rows
    .filter(row => row.direzione === 'entrata')
    .reduce((sum, row) => sum + Number(row.importo || 0), 0)
  const uscite = rows
    .filter(row => row.direzione === 'uscita')
    .reduce((sum, row) => sum + Number(row.importo || 0), 0)

  return ok({
    count: rows.length,
    totali: { entrate, uscite, saldo: entrate - uscite },
    movimenti: rows,
  })
}

export const MOVIMENTI_TOOLS: ToolDefinition[] = [
  {
    name: 'estrai_movimenti',
    description: 'Estrae movimenti da PDF di estratti conto in una cartella Drive e li salva nella tabella cervellone_movimenti con deduplica hash.',
    input_schema: {
      type: 'object',
      properties: {
        folder_id: { type: 'string', description: 'ID della cartella Drive con gli estratti conto PDF.' },
        fonte: { type: 'string', enum: ['banca', 'carta', 'paypal', 'altro'], description: 'Fonte da forzare sui movimenti estratti.' },
        periodo: { type: 'string', description: 'Periodo contabile, es. 2026-05.' },
      },
      required: ['folder_id'],
    },
  },
  {
    name: 'lista_movimenti',
    description: 'Lista movimenti contabili salvati. Filtra per range data (preferito) o periodo (testo) o fonte. Calcola entrate/uscite/saldo.',
    input_schema: {
      type: 'object',
      properties: {
        data_dal: { type: 'string', description: 'Data inizio inclusiva YYYY-MM-DD (preferito a periodo).' },
        data_al: { type: 'string', description: 'Data fine inclusiva YYYY-MM-DD.' },
        periodo: { type: 'string', description: 'Filtro periodo testuale es. 2026-05 (alternativa al range data).' },
        fonte: { type: 'string', enum: ['banca', 'carta', 'paypal', 'altro'] },
      },
    },
  },
]

export async function executeMovimentiTool(name: string, input: Record<string, unknown>): Promise<string | null> {
  if (name === 'estrai_movimenti') return executeEstraiMovimenti(input)
  if (name === 'lista_movimenti') return executeListaMovimenti(input)
  return null
}
