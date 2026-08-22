import { supabase } from './supabase'
import { ficGet, getCompanyId, creaDocumentoFIC, eliminaDocumentoFIC } from './fatture-in-cloud'
import { getSocieta, type CodiceSocieta } from './societa'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

type PendingStato = 'in_attesa' | 'creata' | 'annullata'
type PendingTipo = 'fattura_emessa' | 'rapporto_intervento'

interface PendingRow {
  id: string
  tipo: PendingTipo
  payload: Record<string, unknown>
  descrizione: string | null
  conferme: number
  stato: PendingStato
  fic_document_id: string | null
  fic_url: string | null
  created_at?: string
}

interface RigaDocumento {
  name: string
  qty: number
  net_price: number
  aliquota: number
}

interface RigaDocumentoPayload {
  name: string
  qty: number
  net_price: number
  vat: { id: number }
}

/** Chiave: `${societa}:${aliquota}` — gli id IVA sono per azienda. */
const vatIdCache = new Map<string, number>()

function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload })
}

function fail(error: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, error, ...payload })
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
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

function money(value: unknown): number {
  const parsed = parseNumber(value)
  return parsed === null ? 0 : Math.round(parsed * 100) / 100
}

function todayISO(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
}

function escapeFicQuery(value: string): string {
  return value.replace(/[\\']/g, '')
}

async function resolveVatId(aliquota: number, societa: CodiceSocieta): Promise<number | null> {
  // La cache va indicizzata ANCHE per società: gli id delle aliquote IVA sono
  // per azienda, quindi una cache per sola aliquota restituirebbe l'id
  // dell'altra società — e la fattura uscirebbe con l'IVA sbagliata.
  const chiave = `${societa}:${aliquota}`
  if (vatIdCache.has(chiave)) return vatIdCache.get(chiave) ?? null

  const company = await getCompanyId(societa)
  if (!company.ok) return null

  const r = await ficGet(`/c/${company.id}/vat_types`, undefined, societa)
  if (!r.ok) return null

  const list = Array.isArray(r.data?.data) ? r.data.data as Record<string, unknown>[] : []
  const match = list.find(row => parseNumber(row.value) === aliquota)
  const id = parseNumber(match?.id)
  if (id === null) return null

  vatIdCache.set(chiave, id)
  return id
}

/**
 * `aliquotaDefault` viene dalla società, non è più il 22 cablato.
 *
 * Restruktura fa lavori edili (22%), La Real Estate alloggio (10%): una riga
 * senza aliquota esplicita su una fattura La Real Estate usciva al 22%, cioè
 * con l'IVA sbagliata su un documento fiscale vero — mentre il registro
 * dichiarava 10 e il contesto lo annunciava pure al modello.
 */
function normalizeRighe(
  value: unknown,
  aliquotaDefault: number,
  fallbackDescrizione?: string,
): { righe?: RigaDocumento[]; error?: string } {
  const rawRows = Array.isArray(value) ? value : []
  if (rawRows.length === 0 && fallbackDescrizione) {
    return {
      righe: [{
        name: fallbackDescrizione,
        qty: 1,
        net_price: 0,
        aliquota: aliquotaDefault,
      }],
    }
  }
  if (rawRows.length === 0) return { error: 'righe richieste' }

  const righe: RigaDocumento[] = []
  for (const raw of rawRows) {
    const row = asObject(raw)
    const name = cleanString(row.name) ?? cleanString(row.nome) ?? cleanString(row.descrizione)
    if (!name) return { error: 'ogni riga richiede name/descrizione' }

    const qty = money(row.qty ?? row.quantita ?? 1)
    const netPrice = money(row.net_price ?? row.prezzo_unitario ?? row.prezzo ?? row.importo)
    const vat = money(row.aliquota ?? row.vat ?? aliquotaDefault)
    if (qty <= 0) return { error: `quantita non valida per riga "${name}"` }
    if (netPrice < 0) return { error: `prezzo_unitario non valido per riga "${name}"` }
    righe.push({ name, qty, net_price: netPrice, aliquota: vat || aliquotaDefault })
  }
  return { righe }
}

async function resolveClientEntity(
  cliente: string,
  societa: CodiceSocieta,
): Promise<{ ok: true; entity: Record<string, unknown> } | { ok: false; error: string }> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const r = await ficGet(`/c/${company.id}/entities/clients`, {
    q: `name contains '${escapeFicQuery(cliente)}'`,
    per_page: 5,
  }, societa)
  if (!r.ok) return { ok: false, error: r.error }

  const list = Array.isArray(r.data?.data) ? r.data.data as Record<string, unknown>[] : []
  const first = list.find(row => row?.id)
  if (first?.id) return { ok: true, entity: { id: first.id } }
  return { ok: true, entity: { name: cliente } }
}

function descriviDocumento(input: {
  tipo: PendingTipo
  cliente: string
  data: string
  righe: RigaDocumento[]
  note?: string
  id: string
  societa: CodiceSocieta
}): string {
  const titolo = input.tipo === 'fattura_emessa' ? 'Bozza fattura emessa FIC' : 'Bozza rapporto intervento FIC'
  const righe = input.righe
    .map(row => `- ${row.name}: ${row.qty} x ${row.net_price} + IVA ${row.aliquota}%`)
    .join('\n')
  const totaleNetto = Math.round(input.righe.reduce((sum, row) => sum + row.qty * row.net_price, 0) * 100) / 100
  const s = getSocieta(input.societa)
  return [
    titolo,
    // Prima riga dopo il titolo: e il testo che l'Ingegnere legge davvero.
    `SOCIETA EMITTENTE: ${s.denominazione} (P.IVA ${s.piva})`,
    `Cliente: ${input.cliente}`,
    `Data: ${input.data}`,
    `Righe:\n${righe}`,
    `Totale netto: ${totaleNetto}`,
    input.note ? `Note: ${input.note}` : null,
    'Sara creata come BOZZA FIC non trasmessa allo SdI.',
    `1a conferma -> /fic_ok_${input.id}`,
    `annulla -> /fic_no_${input.id}`,
  ].filter(Boolean).join('\n')
}

async function salvaPending(input: {
  tipo: PendingTipo
  payload: Record<string, unknown>
  cliente: string
  data: string
  righe: RigaDocumento[]
  note?: string
  societa: CodiceSocieta
}): Promise<{ ok: true; row: Pick<PendingRow, 'id' | 'descrizione'> } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('cervellone_fic_pending')
    .insert({
      tipo: input.tipo,
      payload: input.payload,
      descrizione: '',
      stato: 'in_attesa',
      conferme: 0,
      // La società viaggia CON la bozza: la conferma avviene in un momento
      // successivo, e senza questo dato dovrebbe indovinare l'azienda.
      societa: input.societa,
    })
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  const id = data?.id
  if (!id) return { ok: false, error: 'pending FIC creato senza id' }

  const descrizione = descriviDocumento({ ...input, id })
  const updated = await supabase
    .from('cervellone_fic_pending')
    .update({ descrizione, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, descrizione')
    .single()

  if (updated.error) return { ok: false, error: updated.error.message }
  return { ok: true, row: updated.data as Pick<PendingRow, 'id' | 'descrizione'> }
}

async function compilaDocumento(
  input: Record<string, unknown>,
  tipo: PendingTipo,
  societa: CodiceSocieta,
): Promise<string> {
  const cliente = cleanString(input.cliente)
  if (!cliente) return fail('cliente richiesto')

  const data = cleanString(input.data) ?? todayISO()
  const descrizione = cleanString(input.descrizione)
  const note = cleanString(input.note) ?? (tipo === 'rapporto_intervento' ? descrizione : undefined)
  const parsedRighe = normalizeRighe(
    input.righe,
    getSocieta(societa).aliquotaIvaDefault,
    tipo === 'rapporto_intervento' ? descrizione : undefined,
  )
  if (parsedRighe.error || !parsedRighe.righe) return fail(parsedRighe.error ?? 'righe non valide')

  const entity = await resolveClientEntity(cliente, societa)
  if (!entity.ok) return fail(entity.error)

  const itemsList: RigaDocumentoPayload[] = []
  for (const riga of parsedRighe.righe) {
    const vatId = await resolveVatId(riga.aliquota, societa)
    if (vatId === null) return fail(`aliquota ${riga.aliquota}% non trovata tra le aliquote IVA di Fatture in Cloud`)
    itemsList.push({
      name: riga.name,
      qty: riga.qty,
      net_price: riga.net_price,
      vat: { id: vatId },
    })
  }

  const payload: Record<string, unknown> = {
    type: tipo === 'fattura_emessa' ? 'invoice' : 'work_report',
    entity: entity.entity,
    items_list: itemsList,
    date: data,
    e_invoice: false,
  }
  if (note) payload.notes = note

  const pending = await salvaPending({ tipo, payload, cliente, data, righe: parsedRighe.righe, note, societa })
  if (!pending.ok) return fail(pending.error)
  const s = getSocieta(societa)
  return ok({
    // La società apre la risposta, non la chiude: e il primo dato che
    // l'Ingegnere legge prima di confermare. La difesa contro l'azienda
    // sbagliata non e il codice — e che lui veda il nome errato PRIMA del /ok.
    societa: s.denominazione,
    partita_iva: s.piva,
    id: pending.row.id,
    stato: 'in_attesa',
    anteprima: pending.row.descrizione,
    conferma_1: `/fic_ok_${pending.row.id}`,
    annulla: `/fic_no_${pending.row.id}`,
  })
}

async function listaBozzeFic(input: Record<string, unknown>, societa: CodiceSocieta): Promise<string> {
  const stato = cleanString(input.stato) as PendingStato | undefined
  let query = supabase
    .from('cervellone_fic_pending')
    .select('id, tipo, descrizione, conferme, stato, fic_document_id, fic_url, created_at, societa')
    // Era l'unica lettura contabile del ramo senza filtro: l'elenco mescolava
    // le bozze delle due aziende.
    .eq('societa', societa)
    .order('created_at', { ascending: false })
    .limit(50)

  if (stato) query = query.eq('stato', stato)
  const { data, error } = await query
  if (error) return fail(error.message)
  return ok({ count: data?.length ?? 0, bozze: data ?? [] })
}

async function eliminaBozzaFic(input: Record<string, unknown>, societa: CodiceSocieta): Promise<string> {
  const id = cleanString(input.id)
  if (!id) return fail('id richiesto')

  const { data, error } = await supabase
    .from('cervellone_fic_pending')
    .select('id, stato, fic_document_id, societa')
    // Senza questo filtro, da un contesto Restruktura si potrebbe annullare —
    // e cancellare da Fatture in Cloud — una bozza de La Real Estate.
    .eq('societa', societa)
    .eq('id', id)
    .maybeSingle()

  if (error) return fail(error.message)
  if (!data) return fail('bozza FIC non trovata', { id })

  const row = data as Pick<PendingRow, 'id' | 'stato' | 'fic_document_id'> & { societa: CodiceSocieta }
  if (row.stato === 'annullata') return ok({ id, stato: 'gia_annullata' })
  if (row.stato === 'creata') {
    if (!row.fic_document_id) return fail('bozza creata senza fic_document_id', { id })
    // La società viene dalla RIGA, non dal contesto corrente: la bozza puo
    // essere stata compilata quando era attiva un'altra società.
    const deleted = await eliminaDocumentoFIC(row.fic_document_id, row.societa)
    if (!deleted.ok) return fail(deleted.error, { id })
  }

  const updated = await supabase
    .from('cervellone_fic_pending')
    .update({ stato: 'annullata', updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('stato', ['in_attesa', 'creata'])
    .select('id, stato')

  if (updated.error) return fail(updated.error.message)
  if (!updated.data?.length) return fail('bozza FIC gia elaborata', { id })
  return ok({ id, stato: 'annullata' })
}

export async function confirmFicStep1(id: string): Promise<string> {
  const cleanId = cleanString(id)
  if (!cleanId) return 'ID bozza FIC richiesto.'

  const { data, error } = await supabase
    .from('cervellone_fic_pending')
    .update({ conferme: 1, updated_at: new Date().toISOString() })
    .eq('id', cleanId)
    .eq('stato', 'in_attesa')
    .eq('conferme', 0)
    .select('id, societa')

  if (error) return `Errore conferma bozza FIC: ${error.message}`
  if (!data?.length) return 'Bozza FIC non trovata o gia confermata/elaborata.'

  // Il nome dell'azienda va ripetuto QUI, sull'ultimo passaggio prima della
  // creazione: e l'ultima occasione in cui l'Ingegnere puo accorgersi che la
  // fattura sta per nascere dalla societa sbagliata.
  const s = getSocieta((data[0] as { societa: CodiceSocieta }).societa)
  return `Prima conferma registrata per *${s.denominazione}* (P.IVA ${s.piva}).\nConferma DEFINITIVA -> /fic_ok2_${cleanId}`
}

export async function confirmFicStep2(id: string): Promise<string> {
  const cleanId = cleanString(id)
  if (!cleanId) return 'ID bozza FIC richiesto.'

  const { data, error } = await supabase
    .from('cervellone_fic_pending')
    .select('id, payload, conferme, stato, societa')
    .eq('id', cleanId)
    .maybeSingle()

  if (error) return `Errore caricamento bozza FIC: ${error.message}`
  if (!data) return 'Bozza FIC non trovata.'

  const row = data as Pick<PendingRow, 'id' | 'payload' | 'conferme' | 'stato'> & { societa: CodiceSocieta }
  if (row.stato !== 'in_attesa') return 'Bozza FIC gia elaborata.'
  if (Number(row.conferme) < 1) return `Serve prima la prima conferma -> /fic_ok_${cleanId}`

  const claim = await supabase
    .from('cervellone_fic_pending')
    .update({ conferme: 2, updated_at: new Date().toISOString() })
    .eq('id', cleanId)
    .eq('stato', 'in_attesa')
    .eq('conferme', 1)
    .select('id')

  if (claim.error) return `Errore claim bozza FIC: ${claim.error.message}`
  if (!claim.data?.length) return 'Bozza gia in elaborazione o elaborata.'

  // Società dalla RIGA, non dal contesto: fra la compilazione e questa conferma
  // puo essere cambiata la società attiva, e il documento deve nascere
  // nell'azienda per cui e stato compilato.
  const created = await creaDocumentoFIC(row.payload, row.societa)
  if (!created.ok) {
    await supabase
      .from('cervellone_fic_pending')
      .update({ conferme: 1, updated_at: new Date().toISOString() })
      .eq('id', cleanId)
      .eq('stato', 'in_attesa')
      .eq('conferme', 2)
    return `Creazione bozza FIC fallita: ${created.error}`
  }

  const updated = await supabase
    .from('cervellone_fic_pending')
    .update({
      stato: 'creata',
      fic_document_id: created.id,
      fic_url: created.url,
      updated_at: new Date().toISOString(),
    })
    .eq('id', cleanId)
    .eq('stato', 'in_attesa')
    .eq('conferme', 2)
    .select('id')

  if (updated.error) return `Bozza creata su FIC ma aggiornamento audit fallito: ${updated.error.message}`
  if (!updated.data?.length) return 'Bozza creata su FIC ma pending gia elaborato: verifica manuale necessaria.'
  return `BOZZA creata su FIC (NON trasmessa allo SdI). Puoi rivederla/eliminarla; l'emissione la fai tu da FIC.${created.url ? `\n${created.url}` : ''}`
}

export async function cancelFic(id: string): Promise<string> {
  const cleanId = cleanString(id)
  if (!cleanId) return 'ID bozza FIC richiesto.'

  const { data, error } = await supabase
    .from('cervellone_fic_pending')
    .update({ stato: 'annullata', updated_at: new Date().toISOString() })
    .eq('id', cleanId)
    .eq('stato', 'in_attesa')
    .select('id')

  if (error) return `Errore annullamento bozza FIC: ${error.message}`
  if (!data?.length) return 'Bozza FIC non trovata o gia elaborata.'
  return 'Bozza FIC annullata.'
}

export const FIC_WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'compila_fattura_emessa',
    description: 'Compila una bozza di fattura emessa su Fatture in Cloud, senza trasmetterla. Richiede doppia conferma prima della creazione.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string' },
        righe: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              descrizione: { type: 'string' },
              quantita: { type: 'number' },
              prezzo_unitario: { type: 'number' },
              aliquota: { type: 'number' },
            },
          },
        },
        data: { type: 'string', description: 'Data documento YYYY-MM-DD. Default oggi.' },
        note: { type: 'string' },
      },
      required: ['cliente', 'righe'],
    },
  },
  {
    name: 'compila_rapporto_intervento',
    description: 'Compila una bozza di rapporto di intervento su Fatture in Cloud, senza trasmettere nulla. Richiede doppia conferma.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string' },
        righe: { type: 'array', items: { type: 'object' } },
        descrizione: { type: 'string' },
        data: { type: 'string', description: 'Data documento YYYY-MM-DD. Default oggi.' },
      },
      required: ['cliente'],
    },
  },
  {
    name: 'lista_bozze_fic',
    description: 'Lista le bozze FIC pending, create o annullate registrate in cervellone_fic_pending.',
    input_schema: {
      type: 'object',
      properties: { stato: { type: 'string', enum: ['in_attesa', 'creata', 'annullata'] } },
    },
  },
  {
    name: 'elimina_bozza_fic',
    description: 'Annulla una bozza FIC pending o elimina da FIC una bozza gia creata, poi marca il pending come annullato.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
]

export async function executeFicWriteTool(
  name: string,
  input: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<string | null> {
  try {
    if (name === 'compila_fattura_emessa') return compilaDocumento(input, 'fattura_emessa', societa)
    if (name === 'compila_rapporto_intervento') return compilaDocumento(input, 'rapporto_intervento', societa)
    if (name === 'lista_bozze_fic') return listaBozzeFic(input, societa)
    if (name === 'elimina_bozza_fic') return eliminaBozzaFic(input, societa)
    return null
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
