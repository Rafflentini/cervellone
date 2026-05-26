import { supabase } from './supabase'
import { ficGet, getCompanyId } from './fatture-in-cloud'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

type StatoRiconciliazione = 'proposta' | 'confermata' | 'scartata'
type TipoMatch = 'deterministico' | 'ragionato'

interface MovimentoRow {
  id: string
  data: string
  importo: number
  direzione: 'entrata' | 'uscita'
  descrizione: string | null
  controparte: string | null
  fonte: string | null
  conto: string | null
  periodo: string | null
}

interface FatturaAperta {
  id: string
  numero: string | null
  cliente: string | null
  totale: number | null
  data: string | null
}

interface RiconciliazioneRow {
  id: string
  movimento_id: string
  fattura_id: string
  fattura_numero: string | null
  importo_abbinato: number
  periodo: string | null
  stato: StatoRiconciliazione
  tipo_match: TipoMatch
  confidenza: number
  note: string | null
}

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

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const parsed = Number(value.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(parsed) ? parsed : null
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .toLocaleLowerCase('it-IT')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(value: unknown): string[] {
  return normalize(value).split(' ').filter(token => token.length >= 3)
}

function isPaid(d: Record<string, unknown>): boolean | null {
  if (typeof d.is_marked === 'boolean') return d.is_marked
  const payments = Array.isArray(d.payments_list)
    ? d.payments_list
    : Array.isArray(d.paymentsList)
      ? d.paymentsList
      : null
  if (!payments) return null
  return payments.every((p: unknown) => {
    const row = p && typeof p === 'object' ? p as Record<string, unknown> : {}
    return row.status === 'paid'
  })
}

function mapInvoice(d: Record<string, unknown>): FatturaAperta {
  const entity = d.entity && typeof d.entity === 'object' ? d.entity as Record<string, unknown> : {}
  return {
    id: String(d.id),
    numero: cleanString(d.number) ?? cleanString(d.numeration) ?? null,
    cliente: cleanString(entity.name) ?? null,
    totale: parseNumber(d.amount_gross) ?? parseNumber(d.amountGross) ?? parseNumber(d.amount_net) ?? parseNumber(d.amountNet),
    data: cleanString(d.date) ?? null,
  }
}

function invoiceMatchesMovement(movimento: MovimentoRow, fattura: FatturaAperta): boolean {
  if (fattura.totale === null || Math.abs(Number(movimento.importo) - fattura.totale) > 0.01) return false

  const movementText = normalize(`${movimento.descrizione ?? ''} ${movimento.controparte ?? ''}`)
  const invoiceNumber = normalize(fattura.numero)
  if (invoiceNumber && movementText.includes(invoiceNumber)) return true

  const customerTokens = tokens(fattura.cliente)
  if (!customerTokens.length) return false
  const movementTokens = new Set(tokens(`${movimento.controparte ?? ''} ${movimento.descrizione ?? ''}`))
  return customerTokens.some(token => token.length >= 4 && movementTokens.has(token))
}

async function getOpenInvoices(): Promise<{ ok: true; fatture: FatturaAperta[] } | { ok: false; error: string }> {
  const company = await getCompanyId()
  if (!company.ok) return { ok: false, error: company.error }
  const r = await ficGet(`/c/${company.id}/issued_documents`, { type: 'invoice', per_page: 100, sort: '-date' })
  if (!r.ok) return { ok: false, error: r.error }
  const rows = Array.isArray(r.data?.data) ? r.data.data as Record<string, unknown>[] : []
  return {
    ok: true,
    fatture: rows
      .filter(row => isPaid(row) !== true)
      .map(mapInvoice)
      .filter(fattura => fattura.id && fattura.totale !== null),
  }
}

async function getMovimentiEntrata(periodo?: string): Promise<{ ok: true; movimenti: MovimentoRow[] } | { ok: false; error: string }> {
  let query = supabase
    .from('cervellone_movimenti')
    .select('id, data, importo, direzione, descrizione, controparte, fonte, conto, periodo')
    .eq('direzione', 'entrata')
    .eq('stato', 'attivo')
    .order('data', { ascending: false })
    .limit(500)

  if (periodo) query = query.eq('periodo', periodo)

  const { data, error } = await query
  if (error) return { ok: false, error: error.message }

  const rec = await supabase
    .from('cervellone_riconciliazioni')
    .select('movimento_id')
    .in('stato', ['proposta', 'confermata'])

  if (rec.error) return { ok: false, error: rec.error.message }
  const used = new Set((rec.data ?? []).map(row => row.movimento_id))
  return { ok: true, movimenti: ((data ?? []) as MovimentoRow[]).filter(row => !used.has(row.id)) }
}

async function insertReconciliation(input: {
  movimentoId: string
  fatturaId: string
  fatturaNumero?: string | null
  importoAbbinato: number
  periodo?: string | null
  stato: StatoRiconciliazione
  tipoMatch: TipoMatch
  confidenza: number
  note?: string | null
}): Promise<{ inserted: boolean; id?: string }> {
  const existing = await supabase
    .from('cervellone_riconciliazioni')
    .select('id')
    .eq('movimento_id', input.movimentoId)
    .eq('fattura_id', input.fatturaId)
    .maybeSingle()

  if (existing.data?.id) return { inserted: false, id: existing.data.id }
  if (existing.error) throw new Error(existing.error.message)

  const { data, error } = await supabase
    .from('cervellone_riconciliazioni')
    .insert({
      movimento_id: input.movimentoId,
      fattura_id: input.fatturaId,
      fattura_numero: input.fatturaNumero ?? null,
      importo_abbinato: input.importoAbbinato,
      periodo: input.periodo ?? null,
      stato: input.stato,
      tipo_match: input.tipoMatch,
      confidenza: input.confidenza,
      note: input.note ?? null,
    })
    .select('id')
    .single()

  if (error) {
    if (error.code === '23505') return { inserted: false }
    throw new Error(error.message)
  }
  return { inserted: true, id: data?.id }
}

async function riconciliaAutomatico(input: Record<string, unknown>): Promise<string> {
  const periodo = cleanString(input.periodo)
  if (!periodo) return fail('periodo richiesto')

  const movimentiResult = await getMovimentiEntrata(periodo)
  if (!movimentiResult.ok) return fail(movimentiResult.error)
  const fattureResult = await getOpenInvoices()
  if (!fattureResult.ok) return fail(fattureResult.error)

  let abbinatiAuto = 0
  const matchedMovimenti = new Set<string>()
  const matchedFatture = new Set<string>()

  for (const movimento of movimentiResult.movimenti) {
    const fattura = fattureResult.fatture.find(candidate => !matchedFatture.has(candidate.id) && invoiceMatchesMovement(movimento, candidate))
    if (!fattura || fattura.totale === null) continue

    const rec = await insertReconciliation({
      movimentoId: movimento.id,
      fatturaId: fattura.id,
      fatturaNumero: fattura.numero,
      importoAbbinato: Number(movimento.importo),
      periodo,
      stato: 'proposta',
      tipoMatch: 'deterministico',
      confidenza: 0.95,
      note: 'Match automatico per importo e numero fattura/cliente.',
    })
    if (!rec.inserted) continue
    abbinatiAuto += 1
    matchedMovimenti.add(movimento.id)
    matchedFatture.add(fattura.id)
  }

  return ok({
    abbinati_auto: abbinatiAuto,
    residui: {
      movimenti: movimentiResult.movimenti.filter(row => !matchedMovimenti.has(row.id)).length,
      fatture_aperte: fattureResidue(fattureResult.fatture, matchedFatture),
    },
  })
}

function fattureResidue(fatture: FatturaAperta[], matched: Set<string>): number {
  return fatture.filter(row => !matched.has(row.id)).length
}

async function proponiRiconciliazione(input: Record<string, unknown>): Promise<string> {
  const movimentoId = cleanString(input.movimento_id)
  const fatturaId = cleanString(input.fattura_id)
  if (!movimentoId || !fatturaId) return fail('movimento_id e fattura_id richiesti')

  const { data: movimento, error } = await supabase
    .from('cervellone_movimenti')
    .select('id, importo, periodo')
    .eq('id', movimentoId)
    .maybeSingle()

  if (error) return fail(error.message)
  if (!movimento) return fail('movimento non trovato')

  const importoAbbinato = parseNumber(input.importo_abbinato) ?? Number(movimento.importo)
  const confidenza = Math.max(0, Math.min(1, parseNumber(input.confidenza) ?? 0.7))

  const { data, error: upsertError } = await supabase
    .from('cervellone_riconciliazioni')
    .upsert({
      movimento_id: movimentoId,
      fattura_id: fatturaId,
      fattura_numero: cleanString(input.fattura_numero) ?? null,
      importo_abbinato: importoAbbinato,
      periodo: cleanString(input.periodo) ?? movimento.periodo ?? null,
      stato: 'proposta',
      tipo_match: 'ragionato',
      confidenza,
      note: cleanString(input.note) ?? null,
    }, { onConflict: 'movimento_id,fattura_id' })
    .select('id')
    .single()

  if (upsertError) return fail(upsertError.message)
  return ok({ id: data?.id, stato: 'proposta' })
}

async function listaRiconciliazioni(input: Record<string, unknown>): Promise<string> {
  const periodo = cleanString(input.periodo)
  const stato = cleanString(input.stato) as StatoRiconciliazione | undefined

  let query = supabase
    .from('cervellone_riconciliazioni')
    .select('id, movimento_id, fattura_id, fattura_numero, importo_abbinato, periodo, stato, tipo_match, confidenza, note')
    .order('created_at', { ascending: false })
    .limit(100)

  if (periodo) query = query.eq('periodo', periodo)
  if (stato) query = query.eq('stato', stato)

  const { data, error } = await query
  if (error) return fail(error.message)
  const rows = (data ?? []) as RiconciliazioneRow[]
  const movimentoIds = [...new Set(rows.map(row => row.movimento_id))]

  const movimenti = movimentoIds.length
    ? await supabase
      .from('cervellone_movimenti')
      .select('id, data, importo, direzione, descrizione, controparte, fonte, conto, periodo')
      .in('id', movimentoIds)
    : { data: [], error: null }

  if (movimenti.error) return fail(movimenti.error.message)
  const movMap = new Map(((movimenti.data ?? []) as MovimentoRow[]).map(row => [row.id, row]))

  const elenco = rows.map(row => {
    const movimento = movMap.get(row.movimento_id)
    return {
      id: row.id,
      movimento: movimento ? {
        id: movimento.id,
        data: movimento.data,
        importo: movimento.importo,
        controparte: movimento.controparte,
        descrizione: movimento.descrizione,
      } : { id: row.movimento_id },
      fattura_id: row.fattura_id,
      fattura_numero: row.fattura_numero,
      importo_abbinato: row.importo_abbinato,
      tipo_match: row.tipo_match,
      confidenza: row.confidenza,
      stato: row.stato,
      note: row.note,
    }
  })

  const totale = rows.reduce((sum, row) => sum + Number(row.importo_abbinato || 0), 0)
  return ok({ count: rows.length, totale_abbinato: totale, riconciliazioni: elenco })
}

async function cambiaStato(id: string | undefined, stato: 'confermata' | 'scartata'): Promise<string> {
  if (!id) return fail('id richiesto')
  const { data, error } = await supabase
    .from('cervellone_riconciliazioni')
    .update({ stato })
    .eq('id', id)
    .eq('stato', 'proposta')
    .select('id')

  if (error) return fail(error.message)
  if (!data?.length) return ok({ id, stato: 'gia_elaborata' })
  return ok({ id, stato })
}

export const RICONCILIAZIONE_TOOLS: ToolDefinition[] = [
  {
    name: 'riconcilia_automatico',
    description: 'Propone riconciliazioni automatiche tra movimenti entrata e fatture Fatture in Cloud aperte, senza scrivere su FIC.',
    input_schema: {
      type: 'object',
      properties: { periodo: { type: 'string', description: 'Periodo da riconciliare, es. 2026-05.' } },
      required: ['periodo'],
    },
  },
  {
    name: 'proponi_riconciliazione',
    description: 'Crea o aggiorna una proposta ragionata di riconciliazione tra un movimento e una fattura.',
    input_schema: {
      type: 'object',
      properties: {
        movimento_id: { type: 'string' },
        fattura_id: { type: 'string' },
        fattura_numero: { type: 'string' },
        importo_abbinato: { type: 'number' },
        confidenza: { type: 'number' },
        note: { type: 'string' },
      },
      required: ['movimento_id', 'fattura_id'],
    },
  },
  {
    name: 'lista_riconciliazioni',
    description: 'Elenca le riconciliazioni proposte, confermate o scartate con totali.',
    input_schema: {
      type: 'object',
      properties: {
        periodo: { type: 'string' },
        stato: { type: 'string', enum: ['proposta', 'confermata', 'scartata'] },
      },
    },
  },
  {
    name: 'conferma_riconciliazione',
    description: 'Conferma una riconciliazione proposta. Non scrive su Fatture in Cloud.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'scarta_riconciliazione',
    description: 'Scarta una riconciliazione proposta.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
]

export async function executeRiconciliazioneTool(name: string, input: Record<string, unknown>): Promise<string | null> {
  if (name === 'riconcilia_automatico') return riconciliaAutomatico(input)
  if (name === 'proponi_riconciliazione') return proponiRiconciliazione(input)
  if (name === 'lista_riconciliazioni') return listaRiconciliazioni(input)
  if (name === 'conferma_riconciliazione') return cambiaStato(cleanString(input.id), 'confermata')
  if (name === 'scarta_riconciliazione') return cambiaStato(cleanString(input.id), 'scartata')
  return null
}
