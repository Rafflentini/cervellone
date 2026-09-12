import { supabase } from './supabase'
import { ficGet, getCompanyId, creaDocumentoFIC, eliminaDocumentoFIC } from './fatture-in-cloud'
import { getSocieta, type CodiceSocieta } from './societa'
import {
  cercaFattureRicevute,
  classificaFatturaRicevuta,
  elencoContiPagamentoFic,
  leggiFatturaRicevuta,
  risolviContoPagamento,
  segnaPagataFatturaRicevuta,
  TETTO_MASSIVO,
  type ContoPagamentoFic,
  type FatturaDaSegnarePagata,
  type FatturaEsclusa,
} from './fic-pagamenti'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

type PendingStato = 'in_attesa' | 'creata' | 'annullata'
type PendingTipo = 'fattura_emessa' | 'rapporto_intervento' | 'pagamento_ricevuta'

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
  categoria?: string
}

interface RigaDocumentoPayload {
  name: string
  qty: number
  net_price: number
  vat: { id: number }
  category?: string
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

/**
 * Le aliquote IVA di Fatture in Cloud arrivano come numero (10) oppure come
 * stringa ("10", "10.0", "10,0", "10%"): questo parser NON tocca il punto
 * decimale.
 *
 * `parseNumber` cancella i punti perche' serve agli importi in formato
 * italiano ("1.234,56"), ma su "10.0" restituiva 100 e su "10.00" 1000: il
 * confronto con 10 non riusciva MAI, e nessuna fattura di lavori edili era
 * compilabile. Il 22% passava solo per il caso fortunato dell'intero.
 */
function parseAliquotaFic(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const pulito = value.trim().replace('%', '').replace(',', '.')
  if (!pulito) return null
  const parsed = Number(pulito)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Percentuale di cassa/rivalsa: come `parseAliquotaFic`, NON cancella il punto
 * decimale (una rivalsa "4.0" non deve diventare 40).
 *
 * Restituisce null solo se il valore e' assente o illeggibile: **lo zero e' un
 * valore valido**, ed e' proprio quello che serve per azzerare una rivalsa
 * impostata di default sul cliente.
 */
function parsePercentuale(value: unknown): number | null {
  return parseAliquotaFic(value)
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

/**
 * Elenco COMPLETO delle aliquote IVA dell'azienda.
 *
 * Prima si leggeva una pagina sola: un'aliquota perfettamente esistente ma
 * oltre la prima pagina risultava inesistente. Si prova il path con
 * `/settings/` e in fallback quello precedente, cosi' il fix non dipende da
 * quale dei due risponda.
 */
async function elencoAliquoteFic(
  societa: CodiceSocieta,
): Promise<{ ok: true; righe: Record<string, unknown>[] } | { ok: false; error: string }> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const righe: Record<string, unknown>[] = []
  for (let page = 1; page <= 10; page++) {
    const r = await ficGet(`/c/${company.id}/settings/vat_types`, { per_page: 100, page }, societa)
    if (!r.ok) {
      if (page > 1) break
      const legacy = await ficGet(`/c/${company.id}/vat_types`, { per_page: 100 }, societa)
      if (!legacy.ok) return { ok: false, error: legacy.error }
      const lista = Array.isArray(legacy.data?.data) ? legacy.data.data as Record<string, unknown>[] : []
      return { ok: true, righe: lista }
    }
    const lista = Array.isArray(r.data?.data) ? r.data.data as Record<string, unknown>[] : []
    righe.push(...lista)
    if (lista.length === 0) break
    const meta = (r.data as unknown as Record<string, unknown> | undefined) ?? {}
    const ultima = parseAliquotaFic(meta.last_page)
    if (ultima !== null && page >= ultima) break
  }
  return { ok: true, righe }
}

async function resolveVatId(
  aliquota: number,
  societa: CodiceSocieta,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  // La cache va indicizzata ANCHE per società: gli id delle aliquote IVA sono
  // per azienda, quindi una cache per sola aliquota restituirebbe l'id
  // dell'altra società — e la fattura uscirebbe con l'IVA sbagliata.
  const chiave = `${societa}:${aliquota}`
  const inCache = vatIdCache.get(chiave)
  if (inCache !== undefined) return { ok: true, id: inCache }

  const elenco = await elencoAliquoteFic(societa)
  if (!elenco.ok) {
    return { ok: false, error: `aliquote IVA non leggibili da Fatture in Cloud: ${elenco.error}` }
  }

  // Tolleranza invece di uguaglianza stretta: su un float 10 e 10.000000001
  // sono la stessa aliquota, e un documento fiscale non deve fermarsi per un
  // arrotondamento di serializzazione.
  const match = elenco.righe.find((row) => {
    const valore = parseAliquotaFic(row.value)
    return valore !== null && Math.abs(valore - aliquota) < 0.001
  })
  const id = match ? parseAliquotaFic(match.id) : null

  if (id === null) {
    // L'errore DICE cosa ha letto. Prima diceva solo "non trovata": dal
    // messaggio era impossibile capire se il guasto fosse nella chiamata,
    // nell'elenco o nel confronto, e sono serviti cinque tentativi piu' la
    // lettura del sorgente per arrivare alla causa.
    const viste = elenco.righe
      .map((row) => parseAliquotaFic(row.value))
      .filter((v): v is number => v !== null)
      .map((v) => `${v}%`)
    return {
      ok: false,
      error: `aliquota ${aliquota}% non trovata tra le ${elenco.righe.length} aliquote IVA di Fatture in Cloud (trovate: ${viste.join(', ') || 'nessuna'})`,
    }
  }

  vatIdCache.set(chiave, id)
  return { ok: true, id }
}

/**
 * `aliquotaDefault` viene dalla società, non è più il 22 cablato.
 *
 * Restruktura fa lavori edili (22%), La Real Estate alloggio (10%): una riga
 * senza aliquota esplicita su una fattura La Real Estate usciva al 22%, cioè
 * con l'IVA sbagliata su un documento fiscale vero — mentre il registro
 * dichiarava 10 e il contesto lo annunciava pure al modello.
 *
 * `categoriaDefault` e' il centro di ricavo del documento: vale per tutte le
 * righe, e la singola riga puo' sovrascriverlo con `categoria`.
 */
function normalizeRighe(
  value: unknown,
  aliquotaDefault: number,
  fallbackDescrizione?: string,
  categoriaDefault?: string,
): { righe?: RigaDocumento[]; error?: string } {
  const rawRows = Array.isArray(value) ? value : []
  if (rawRows.length === 0 && fallbackDescrizione) {
    return {
      righe: [{
        name: fallbackDescrizione,
        qty: 1,
        net_price: 0,
        aliquota: aliquotaDefault,
        categoria: categoriaDefault,
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
    const categoria = cleanString(row.categoria) ?? cleanString(row.category) ?? categoriaDefault
    righe.push({ name, qty, net_price: netPrice, aliquota: vat || aliquotaDefault, categoria })
  }
  return { righe }
}

/**
 * Cliente del documento, risolto sull'anagrafica di Fatture in Cloud.
 *
 * Si passa SEMPRE anche `name`, non solo l'id: Fatture in Cloud rifiuta il
 * documento con 422 `entity.name: The entity.name field must not be empty`
 * anche quando `entity.id` e valorizzato e corretto.
 *
 * Il difetto era latente: fino a quando mancava il piano pagamenti la
 * validazione FIC si fermava prima, sul totale dei pagamenti, e questo secondo
 * errore non si vedeva mai. Il 10/09/2026, sul saldo SAL n.1 del Condominio
 * Fermi, e emerso alla seconda conferma e la fattura non e nata.
 *
 * Il nome si prende dall'ANAGRAFICA e non dalla stringa cercata: quella puo
 * essere una forma parziale usata solo per la ricerca, e finirebbe scritta sul
 * documento fiscale al posto della denominazione vera.
 */
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
  if (first?.id) {
    return { ok: true, entity: { id: first.id, name: cleanString(first.name) ?? cliente } }
  }
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
  numerazione?: string
  centroRicavi?: string
  cassaPerc?: number | null
  rivalsaPerc?: number | null
}): string {
  const titolo = input.tipo === 'fattura_emessa' ? 'Bozza fattura emessa FIC' : 'Bozza rapporto intervento FIC'
  const righe = input.righe
    .map(row => `- ${row.name}: ${row.qty} x ${row.net_price} + IVA ${row.aliquota}%${row.categoria ? ` [${row.categoria}]` : ''}`)
    .join('\n')
  const totaleNetto = Math.round(input.righe.reduce((sum, row) => sum + row.qty * row.net_price, 0) * 100) / 100
  const s = getSocieta(input.societa)

  // Sezionale, centro di ricavo e cassa vanno LETTI prima del /fic_ok2: sono
  // esattamente i tre dati che, sbagliati, producono una fattura formalmente
  // valida ma con numero, imputazione o importo errati.
  const cassa = input.cassaPerc
  const rivalsa = input.rivalsaPerc
  return [
    titolo,
    // Prima riga dopo il titolo: e il testo che l'Ingegnere legge davvero.
    `SOCIETA EMITTENTE: ${s.denominazione} (P.IVA ${s.piva})`,
    `Cliente: ${input.cliente}`,
    `Data: ${input.data}`,
    input.numerazione ? `Sezionale: ${input.numerazione}` : null,
    input.centroRicavi ? `Centro di ricavo: ${input.centroRicavi}` : null,
    cassa !== undefined && cassa !== null
      ? `Cassa: ${cassa}%${cassa === 0 ? ' (azzerata)' : ''}`
      : null,
    rivalsa !== undefined && rivalsa !== null
      ? `Rivalsa: ${rivalsa}%${rivalsa === 0 ? ' (azzerata)' : ''}`
      : null,
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
  numerazione?: string
  centroRicavi?: string
  cassaPerc?: number | null
  rivalsaPerc?: number | null
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

  const numerazione = cleanString(input.numerazione) ?? cleanString(input.sezionale)
  const centroRicavi = cleanString(input.centro_ricavi) ?? cleanString(input.centro_costo)
  const cassaPerc = parsePercentuale(input.cassa_perc)
  const rivalsaPerc = parsePercentuale(input.rivalsa_perc)

  const parsedRighe = normalizeRighe(
    input.righe,
    getSocieta(societa).aliquotaIvaDefault,
    tipo === 'rapporto_intervento' ? descrizione : undefined,
    centroRicavi,
  )
  if (parsedRighe.error || !parsedRighe.righe) return fail(parsedRighe.error ?? 'righe non valide')

  const entity = await resolveClientEntity(cliente, societa)
  if (!entity.ok) return fail(entity.error)

  const itemsList: RigaDocumentoPayload[] = []
  for (const riga of parsedRighe.righe) {
    const vat = await resolveVatId(riga.aliquota, societa)
    if (!vat.ok) return fail(vat.error)
    const item: RigaDocumentoPayload = {
      name: riga.name,
      qty: riga.qty,
      net_price: riga.net_price,
      vat: { id: vat.id },
    }
    if (riga.categoria) item.category = riga.categoria
    itemsList.push(item)
  }

  const payload: Record<string, unknown> = {
    type: tipo === 'fattura_emessa' ? 'invoice' : 'work_report',
    entity: entity.entity,
    items_list: itemsList,
    date: data,
    e_invoice: false,
  }
  if (note) payload.notes = note
  // Il sezionale NON e' cosmetico: sceglie la serie di numerazione, cioe' il
  // numero che la fattura portera'.
  if (numerazione) payload.numeration = numerazione
  // `!== null` e non la verita' del numero: lo ZERO deve essere inviato, e'
  // l'unico modo per azzerare una cassa/rivalsa che il cliente ha di default.
  if (cassaPerc !== null) payload.cassa = cassaPerc
  if (rivalsaPerc !== null) payload.rivalsa = rivalsaPerc

  const pending = await salvaPending({
    tipo,
    payload,
    cliente,
    data,
    righe: parsedRighe.righe,
    note,
    societa,
    numerazione,
    centroRicavi,
    cassaPerc,
    rivalsaPerc,
  })
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
    sezionale: numerazione ?? null,
    centro_ricavi: centroRicavi ?? null,
    cassa_perc: cassaPerc,
    rivalsa_perc: rivalsaPerc,
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
    .select('id, tipo, stato, fic_document_id, societa')
    // Senza questo filtro, da un contesto Restruktura si potrebbe annullare —
    // e cancellare da Fatture in Cloud — una bozza de La Real Estate.
    .eq('societa', societa)
    .eq('id', id)
    .maybeSingle()

  if (error) return fail(error.message)
  if (!data) return fail('bozza FIC non trovata', { id })

  const row = data as Pick<PendingRow, 'id' | 'tipo' | 'stato' | 'fic_document_id'> & { societa: CodiceSocieta }
  if (row.stato === 'annullata') return ok({ id, stato: 'gia_annullata' })

  // 🚨 Un pagamento su fattura RICEVUTA non e' una bozza nostra: il
  // `fic_document_id` e' l'id della fattura DEL FORNITORE, che esiste su
  // Fatture in Cloud indipendentemente da noi. Senza questa guardia il ramo
  // sotto chiamerebbe `eliminaDocumentoFIC` e CANCELLEREBBE quella fattura:
  // un «annulla» che distrugge un documento fiscale altrui. E' la stessa forma
  // del difetto del 10 set 2026, quando «ok annulla» CREAVA il documento.
  if (row.tipo === 'pagamento_ricevuta') {
    if (row.stato === 'creata') {
      return fail(
        'questo pending e\' un PAGAMENTO su fatture ricevute, gia\' scritto su Fatture in Cloud: non si annulla '
        + 'da qui e non cancello le fatture del fornitore. Per togliere il pagamento, modifica la fattura su '
        + 'Fatture in Cloud.',
        { id, ids_fatture: row.fic_document_id },
      )
    }
    const annullato = await supabase
      .from('cervellone_fic_pending')
      .update({ stato: 'annullata', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('stato', 'in_attesa')
      .select('id, stato')
    if (annullato.error) return fail(annullato.error.message)
    if (!annullato.data?.length) return fail('pending FIC gia elaborato', { id })
    return ok({ id, stato: 'annullata', nota: 'Nessun pagamento era stato scritto.' })
  }

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

/* ------------------------------------------------------------------ *
 * Segnare PAGATA una fattura RICEVUTA (uno o molti documenti)
 * ------------------------------------------------------------------ */

/**
 * Righe mostrate nell'anteprima, per elenco.
 *
 * Una conferma sola per N documenti vale solo se l'anteprima è quella vera:
 * quindi oltre questa soglia l'elenco si taglia DICHIARANDO quante righe non
 * sono mostrate. Un elenco troncato che sembra intero è peggio di nessun
 * elenco, perché fa dire «sì» su cose mai viste.
 */
const MAX_RIGHE_ANTEPRIMA = 20

function euro(n: number): string {
  return n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function intero(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

interface PagamentiPayload {
  conto: ContoPagamentoFic
  /** Data imposta dall'Ingegnere. Assente = la data DI OGNI FATTURA. */
  data_pagamento?: string
  /** Voce scelta nel piano pagamenti. Solo sul caso singolo. */
  voce?: number
  documenti: FatturaDaSegnarePagata[]
}

function rigaFattura(f: FatturaDaSegnarePagata): string {
  return `- [${f.id}] ${f.fornitore} — n.${f.numero} del ${f.data} — ${euro(f.importo)} → pagamento il ${f.data_pagamento}`
}

function rigaEsclusa(f: FatturaEsclusa): string {
  return `- [${f.id}] ${f.fornitore} — n.${f.numero} del ${f.data} — ${f.motivo}`
}

function elencoTagliato<T>(righe: T[], formatta: (r: T) => string, cosa: string): string[] {
  const mostrate = righe.slice(0, MAX_RIGHE_ANTEPRIMA).map(formatta)
  if (righe.length > MAX_RIGHE_ANTEPRIMA) {
    mostrate.push(
      `⚠️ altre ${righe.length - MAX_RIGHE_ANTEPRIMA} ${cosa} NON mostrate qui: `
      + 'restringi la selezione se le vuoi vedere tutte prima di confermare.',
    )
  }
  return mostrate
}

function descriviPagamenti(input: {
  id: string
  societa: CodiceSocieta
  conto: ContoPagamentoFic
  daScrivere: FatturaDaSegnarePagata[]
  escluse: FatturaEsclusa[]
}): string {
  const s = getSocieta(input.societa)
  const totale = input.daScrivere.reduce((somma, f) => somma + f.importo, 0)
  return [
    `Segno PAGATE ${input.daScrivere.length} fatture RICEVUTE su Fatture in Cloud`,
    `SOCIETA: ${s.denominazione} (P.IVA ${s.piva})`,
    `Modalita di pagamento: ${input.conto.nome} (conto FIC id ${input.conto.id})`,
    `DA SCRIVERE: ${input.daScrivere.length} — totale ${euro(Math.round(totale * 100) / 100)}`,
    ...elencoTagliato(input.daScrivere, rigaFattura, 'fatture da scrivere'),
    input.escluse.length > 0 ? `ESCLUSE, non verranno toccate: ${input.escluse.length}` : null,
    ...(input.escluse.length > 0 ? elencoTagliato(input.escluse, rigaEsclusa, 'escluse') : []),
    'Non si emette e non si trasmette niente: si scrive solo il pagamento sulle fatture di spesa.',
    `1a conferma -> /fic_ok_${input.id}`,
    `annulla -> /fic_no_${input.id}`,
  ].filter(Boolean).join('\n')
}

async function salvaPendingPagamenti(
  payload: PagamentiPayload,
  descrivi: (id: string) => string,
  societa: CodiceSocieta,
): Promise<{ ok: true; id: string; descrizione: string } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('cervellone_fic_pending')
    .insert({
      tipo: 'pagamento_ricevuta',
      payload: payload as unknown as Record<string, unknown>,
      descrizione: '',
      stato: 'in_attesa',
      conferme: 0,
      societa,
    })
    .select('id')
    .single()

  if (error) return { ok: false, error: error.message }
  const id = data?.id
  if (!id) return { ok: false, error: 'pending FIC creato senza id' }

  const descrizione = descrivi(id)
  const updated = await supabase
    .from('cervellone_fic_pending')
    .update({ descrizione, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, descrizione')
    .single()

  if (updated.error) return { ok: false, error: updated.error.message }
  return { ok: true, id, descrizione }
}

/**
 * Prepara la scrittura del pagamento su una o più fatture ricevute.
 *
 * Il caso singolo È il caso massivo con un elemento: stesse difese, stesso
 * percorso, stessa doppia conferma. Duplicarle in due tool avrebbe significato
 * due posti dove possono divergere.
 */
async function segnaFatturePagate(
  input: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<string> {
  const idSingolo = intero(input.id)
  const voce = intero(input.voce)
  if (voce !== undefined && idSingolo === undefined) {
    return fail('la voce del piano pagamenti si può indicare solo su UNA fattura: passa anche id')
  }

  const dataImposta = cleanString(input.data_pagamento)
  if (dataImposta && !/^\d{4}-\d{2}-\d{2}$/.test(dataImposta)) {
    return fail(`data_pagamento "${dataImposta}" non valida: serve il formato YYYY-MM-DD`)
  }

  // 1) L'insieme. Si legge SEMPRE da Fatture in Cloud, mai dal testo.
  const documenti: Record<string, unknown>[] = []
  let altrePagine = false
  if (idSingolo !== undefined) {
    const letta = await leggiFatturaRicevuta(idSingolo, societa)
    if (!letta.ok) return fail(letta.error)
    documenti.push(letta.valore)
  } else {
    const fornitore = cleanString(input.fornitore)
    const anno = intero(input.anno)
    const mese = intero(input.mese)
    if (!fornitore && !anno) {
      return fail('serve almeno un criterio: id di una fattura, oppure fornitore e/o anno. Non segno pagate «tutte» le fatture di spesa.')
    }
    const trovate = await cercaFattureRicevute({ fornitore, anno, mese }, societa)
    if (!trovate.ok) return fail(trovate.error)
    documenti.push(...trovate.valore.documenti)
    altrePagine = trovate.valore.altre_pagine
  }

  if (documenti.length === 0) {
    return fail('nessuna fattura ricevuta corrisponde alla selezione: non ho scritto niente')
  }

  // 2) Il tetto. Una scrittura di massa su un gestionale fiscale non deve
  // poter scappare, e una conferma unica su più di così non è più una lettura.
  if (documenti.length > TETTO_MASSIVO || altrePagine) {
    return fail(
      `la selezione tocca ${altrePagine ? `più di ${documenti.length}` : String(documenti.length)} fatture, `
      + `oltre il tetto di ${TETTO_MASSIVO} per singola conferma: restringi (per fornitore, anno o mese) `
      + 'e ripeti. Non ho scritto niente.',
      { trovate: documenti.length, tetto: TETTO_MASSIVO },
    )
  }

  // 3) La modalità di pagamento, SCELTA FRA QUELLE CHE FIC ESPONE.
  const conti = await elencoContiPagamentoFic(societa)
  if (!conti.ok) return fail(`conti di pagamento non leggibili da Fatture in Cloud: ${conti.error}`)
  const richiesta = cleanString(input.modalita_pagamento) ?? ''
  const conto = risolviContoPagamento(conti.valore, richiesta)
  if (!conto.ok) {
    return ok({
      need: 'modalita_pagamento',
      messaggio: conto.error,
      // L'elenco viene da Fatture in Cloud: qui non c'è nessuna lista scritta
      // a mano da cui scegliere.
      modalita_disponibili: conti.valore.map((c) => ({ id: c.id, nome: c.nome })),
      fatture_selezionate: documenti.length,
      nota: 'Chiedi all Ingegnere quale di queste modalita, poi richiama il tool. Non ho scritto niente.',
    })
  }

  // 4) Classificazione: chi si scrive, chi si esclude e PERCHE'.
  const daScrivere: FatturaDaSegnarePagata[] = []
  const escluse: FatturaEsclusa[] = []
  for (const doc of documenti) {
    const c = classificaFatturaRicevuta(doc, { data_pagamento: dataImposta, voce })
    if (c.stato === 'da_scrivere') daScrivere.push(c.fattura)
    else escluse.push(c.fattura)
  }

  if (daScrivere.length === 0) {
    return fail('nessuna delle fatture selezionate si può segnare pagata: non ho scritto niente', {
      escluse: escluse.map((f) => ({ id: f.id, fornitore: f.fornitore, numero: f.numero, motivo: f.motivo })),
    })
  }

  const payload: PagamentiPayload = {
    conto: conto.valore,
    data_pagamento: dataImposta,
    voce,
    documenti: daScrivere,
  }

  const pending = await salvaPendingPagamenti(
    payload,
    (id) => descriviPagamenti({ id, societa, conto: conto.valore, daScrivere, escluse }),
    societa,
  )
  if (!pending.ok) return fail(pending.error)

  const s = getSocieta(societa)
  return ok({
    societa: s.denominazione,
    partita_iva: s.piva,
    id: pending.id,
    stato: 'in_attesa',
    modalita_pagamento: conto.valore.nome,
    da_scrivere: daScrivere.length,
    escluse: escluse.map((f) => ({ id: f.id, fornitore: f.fornitore, numero: f.numero, motivo: f.motivo })),
    anteprima: pending.descrizione,
    conferma_1: `/fic_ok_${pending.id}`,
    annulla: `/fic_no_${pending.id}`,
    nota: 'Mostra l anteprima COM E, comprese le escluse col motivo: e l unica cosa che l Ingegnere legge prima di una conferma che vale per tutte.',
  })
}

function leggiPagamentiPayload(payload: unknown): PagamentiPayload | null {
  const p = asObject(payload)
  const conto = asObject(p.conto)
  const id = Number(conto.id)
  const nome = cleanString(conto.nome)
  if (!Number.isFinite(id) || !nome) return null
  const documenti = Array.isArray(p.documenti) ? p.documenti.map(asObject) : []
  if (documenti.length === 0) return null
  return {
    conto: { id, nome },
    data_pagamento: cleanString(p.data_pagamento),
    voce: Number.isFinite(Number(p.voce)) && p.voce !== null && p.voce !== undefined ? Number(p.voce) : undefined,
    documenti: documenti as unknown as FatturaDaSegnarePagata[],
  }
}

interface EsitoPagamenti {
  messaggio: string
  scritte: number
  ids: number[]
}

/**
 * Esegue le scritture, UNA FATTURA PER VOLTA, e riferisce PER DOCUMENTO.
 *
 * 🚨 Il conteggio delle riuscite si costruisce contando le RILETTURE che
 * confermano, non le risposte della PUT: `segnaPagataFatturaRicevuta` torna
 * `ok` solo dopo aver riletto e confrontato. Un «fatte tutte» sul gruppo
 * quando due sono fallite sarebbe il difetto peggiore introducibile qui.
 *
 * Se la scrittura si interrompe a metà, le fatture già scritte RESTANO
 * scritte: si dice quali, e non si tenta nessun rollback contabile.
 */
async function eseguiPagamentiRicevute(
  payload: unknown,
  societa: CodiceSocieta,
): Promise<EsitoPagamenti> {
  const dati = leggiPagamentiPayload(payload)
  if (!dati) {
    return {
      messaggio: 'NESSUN pagamento registrato: il pending non contiene una selezione leggibile.',
      scritte: 0,
      ids: [],
    }
  }

  const s = getSocieta(societa)
  const riuscite: string[] = []
  const fallite: string[] = []
  const ids: number[] = []
  let interruzione: string | null = null
  let trattate = 0

  for (const f of dati.documenti) {
    try {
      const esito = await segnaPagataFatturaRicevuta(
        f.id,
        dati.conto,
        { data_pagamento: dati.data_pagamento, voce: dati.voce },
        societa,
      )
      trattate++
      const intestazione = `[${f.id}] ${f.fornitore} n.${f.numero} del ${f.data}`
      if (esito.ok) {
        ids.push(f.id)
        riuscite.push(`✅ ${intestazione} — ${euro(f.importo)} pagata il ${f.data_pagamento} su ${dati.conto.nome}`)
      } else {
        fallite.push(`❌ ${intestazione} — ${esito.motivo}`)
      }
    } catch (err) {
      // Rete, token, 429: si ferma qui e si DICE dove si è fermata.
      interruzione = err instanceof Error ? err.message : String(err)
      break
    }
  }

  const totale = dati.documenti.length
  const nonTrattate = dati.documenti.slice(trattate)
  const coda = [
    riuscite.length > 0 ? `RIUSCITE (${riuscite.length}), verificate rileggendo ogni fattura:\n${riuscite.join('\n')}` : null,
    fallite.length > 0 ? `NON RIUSCITE (${fallite.length}), NON sono state segnate pagate:\n${fallite.join('\n')}` : null,
    interruzione
      ? `⚠️ La scrittura si è INTERROTTA (${interruzione}). Le fatture elencate come riuscite RESTANO scritte `
        + 'su Fatture in Cloud: non tento nessun rollback. Da riprendere: '
        + `${nonTrattate.map((f) => `[${f.id}] ${f.fornitore} n.${f.numero}`).join(', ') || 'nessuna'}.`
      : null,
  ].filter(Boolean).join('\n\n')

  if (riuscite.length === 0) {
    return { messaggio: `NESSUN pagamento registrato su ${s.denominazione}: 0 su ${totale}.\n\n${coda}`, scritte: 0, ids }
  }
  if (riuscite.length < totale) {
    return {
      messaggio: `PAGAMENTI REGISTRATI IN PARTE su ${s.denominazione}: ${riuscite.length} su ${totale}.\n\n${coda}`,
      scritte: riuscite.length,
      ids,
    }
  }
  return {
    messaggio: `PAGAMENTI REGISTRATI su ${s.denominazione}: ${riuscite.length} su ${totale}.\n\n${coda}`,
    scritte: riuscite.length,
    ids,
  }
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
    .select('id, tipo, payload, conferme, stato, societa')
    .eq('id', cleanId)
    .maybeSingle()

  if (error) return `Errore caricamento bozza FIC: ${error.message}`
  if (!data) return 'Bozza FIC non trovata.'

  const row = data as Pick<PendingRow, 'id' | 'tipo' | 'payload' | 'conferme' | 'stato'> & { societa: CodiceSocieta }
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

  // Il pagamento di fatture RICEVUTE passa per la STESSA doppia conferma, la
  // stessa riga e gli stessi comandi /fic_ok_ e /fic_ok2_ — quindi funziona
  // identico su Telegram e sulla chat web senza toccare i due dispatch. Un
  // secondo meccanismo di conferma sarebbe un secondo posto dove sbagliare.
  if (row.tipo === 'pagamento_ricevuta') {
    const esito = await eseguiPagamentiRicevute(row.payload, row.societa)

    if (esito.scritte === 0) {
      // Niente e' stato scritto: la riga torna a una conferma, come quando la
      // creazione di una bozza fallisce, cosi' si puo' ritentare.
      await supabase
        .from('cervellone_fic_pending')
        .update({ conferme: 1, updated_at: new Date().toISOString() })
        .eq('id', cleanId)
        .eq('stato', 'in_attesa')
        .eq('conferme', 2)
      return esito.messaggio
    }

    // Almeno una scrittura e' andata: la riga si CHIUDE. Non si ritenta un
    // gruppo in cui qualcosa e' gia' stato scritto — un secondo giro su una
    // fattura gia' pagata e' esattamente l'errore contabile da evitare.
    const chiusa = await supabase
      .from('cervellone_fic_pending')
      .update({
        stato: 'creata',
        fic_document_id: esito.ids.join(','),
        fic_url: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', cleanId)
      .eq('stato', 'in_attesa')
      .eq('conferme', 2)
      .select('id')

    if (chiusa.error) return `${esito.messaggio}\n\n⚠️ Aggiornamento audit fallito: ${chiusa.error.message}`
    return esito.messaggio
  }

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

/**
 * Oltre questa finestra una bozza non e' piu' «quella di cui stiamo parlando»:
 * serve contro un «ok» detto domani, a proposito d'altro, che risveglia la
 * bozza dimenticata di oggi e fa nascere una fattura. Con un id esplicito la
 * finestra non si applica: li' l'Ingegnere ha detto QUALE documento.
 */
const FINESTRA_CONFERMA_MS = 24 * 60 * 60 * 1000

/**
 * Distanza minima fra prima e seconda conferma.
 *
 * La doppia conferma vale solo se sono DUE risposte distinte dell'Ingegnere.
 * Senza questa guardia il modello potrebbe chiamare il tool due volte dentro
 * lo stesso turno e creare da se' un documento fiscale: cinque secondi non
 * disturbano una persona che legge e risponde, ma fermano il doppio scatto.
 */
const DISTANZA_MINIMA_CONFERME_MS = 5 * 1000

/**
 * Avanza di UN passo la doppia conferma di una bozza FIC gia' compilata,
 * quando l'Ingegnere conferma A PAROLE.
 *
 * Il 10 set 2026 era in auto e doveva emettere il saldo SAL n.1 del Condominio
 * Fermi: la bozza si sbloccava solo con `/fic_ok_<uuid>` e `/fic_ok2_<uuid>`,
 * 45 caratteri da copiare a mano — e nemmeno tappabili, perche' Telegram
 * tronca il command link al primo trattino dell'uuid. Ha scritto «confermo»
 * sei volte in un'ora e la riga e' rimasta a `conferme: 1`.
 *
 * Qui la conferma la puo' eseguire il modello, ma la doppia conferma NON viene
 * indebolita: restano due passaggi, ognuno legato a una risposta affermativa
 * NUOVA, e con piu' di una bozza in attesa non si indovina — si chiede.
 */
async function confermaBozzaFic(
  input: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<string> {
  const id = cleanString(input.id)

  let query = supabase
    .from('cervellone_fic_pending')
    .select('id, conferme, descrizione, created_at, updated_at')
    .eq('stato', 'in_attesa')
    // Filtro societa: da un contesto Restruktura non si conferma — ne' si crea
    // su Fatture in Cloud — un documento de La Real Estate.
    .eq('societa', societa)
    .order('created_at', { ascending: false })
    .limit(5)

  if (id) query = query.eq('id', id)
  else query = query.gte('created_at', new Date(Date.now() - FINESTRA_CONFERMA_MS).toISOString())

  const { data, error } = await query
  if (error) return fail(error.message)

  const righe = (data ?? []) as Array<{
    id: string
    conferme: number
    descrizione: string | null
    created_at: string
    updated_at: string | null
  }>

  if (righe.length === 0) {
    return fail('nessuna bozza FIC in attesa di conferma', {
      societa: getSocieta(societa).denominazione,
      nota: 'Non e stato creato nessun documento. Se serve, ricompila la bozza.',
    })
  }

  if (righe.length > 1) {
    // Non si sceglie al posto suo quale documento fiscale far nascere.
    return ok({
      need: 'disambigua',
      messaggio: 'Ci sono piu bozze in attesa: chiedi all Ingegnere quale, poi richiama il tool con l id.',
      bozze: righe.map((r) => ({ id: r.id, conferme: r.conferme, descrizione: r.descrizione })),
    })
  }

  const riga = righe[0]
  const conferme = Number(riga.conferme)

  if (conferme >= 2) {
    return ok({
      id: riga.id,
      stato: 'in_elaborazione',
      messaggio: 'Bozza gia in elaborazione su Fatture in Cloud: attendi l esito, non ritentare.',
    })
  }

  if (conferme === 0) {
    const messaggio = await confirmFicStep1(riga.id)
    // Se il primo passaggio non e' andato a buon fine il testo va riportato
    // com'e': non si finge di aver registrato niente.
    const registrata = messaggio.includes('/fic_ok2_')
    return ok({
      id: riga.id,
      passo: registrata ? 1 : 0,
      conferma_registrata: registrata,
      messaggio,
      prossimo_passo: registrata
        ? 'Chiedi ORA la conferma DEFINITIVA e fermati. Richiama questo tool solo dopo una NUOVA risposta affermativa dell Ingegnere, in un messaggio successivo.'
        : 'La conferma NON e stata registrata: riporta il messaggio testualmente.',
    })
  }

  const ultimoTocco = riga.updated_at ? Date.parse(riga.updated_at) : 0
  if (ultimoTocco && Date.now() - ultimoTocco < DISTANZA_MINIMA_CONFERME_MS) {
    return fail(
      'la prima conferma e appena stata registrata: la seconda deve arrivare da una NUOVA risposta dell Ingegnere, non dallo stesso turno',
      { id: riga.id, passo: 1, documento_creato: false },
    )
  }

  const messaggio = await confirmFicStep2(riga.id)
  // Il pending puo' essere una bozza da creare oppure un pagamento da
  // scrivere: senza riconoscere anche il secondo, un pagamento riuscito
  // veniva riferito come «NON riuscito» — cioe' il codice avrebbe mentito
  // all'Ingegnere sull'esito di una scrittura contabile.
  const parziale = messaggio.startsWith('PAGAMENTI REGISTRATI IN PARTE')
  const eseguita = messaggio.startsWith('BOZZA creata su FIC') || messaggio.startsWith('PAGAMENTI REGISTRATI')
  return ok({
    id: riga.id,
    passo: 2,
    documento_creato: eseguita,
    esito_parziale: parziale,
    messaggio,
    avviso: !eseguita
      ? 'L operazione NON e riuscita: riporta il messaggio TESTUALMENTE e non dire che e stata fatta.'
      : parziale
        ? 'ATTENZIONE: solo ALCUNE fatture sono state scritte. Riporta il messaggio TESTUALMENTE, con l elenco di quali SI e quali NO col motivo. Non dire «fatte tutte».'
        : null,
  })
}

export const FIC_WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'compila_fattura_emessa',
    description: 'Compila una bozza di fattura emessa su Fatture in Cloud, senza trasmetterla. Richiede doppia conferma prima della creazione. Supporta il sezionale di numerazione (es. "ED" per l\'edilizia), il centro di ricavo delle righe e l\'azzeramento della cassa previdenziale/rivalsa INARCASSA impostata di default sul cliente (passa cassa_perc: 0).',
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
              categoria: { type: 'string', description: 'Centro di ricavo della singola riga. Se assente vale centro_ricavi del documento.' },
            },
          },
        },
        data: { type: 'string', description: 'Data documento YYYY-MM-DD. Default oggi.' },
        numerazione: { type: 'string', description: 'Sezionale/serie di numerazione FIC, es. "ED" per la serie edilizia. Se omesso usa la serie predefinita dell\'azienda (per Restruktura: ingegneria).' },
        centro_ricavi: { type: 'string', description: 'Centro di ricavo applicato a tutte le righe, es. "Edilizia".' },
        cassa_perc: { type: 'number', description: 'Percentuale cassa previdenziale. Passa 0 per AZZERARE una cassa/rivalsa INARCASSA impostata di default (tipico sulle fatture di soli lavori edili). Se omesso, FIC applica il default del cliente.' },
        rivalsa_perc: { type: 'number', description: 'Percentuale rivalsa. Passa 0 per azzerarla. Se omesso, FIC applica il default del cliente.' },
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
        numerazione: { type: 'string', description: 'Sezionale/serie di numerazione FIC.' },
        centro_ricavi: { type: 'string', description: 'Centro di ricavo applicato alle righe.' },
        cassa_perc: { type: 'number', description: 'Percentuale cassa previdenziale. 0 per azzerarla.' },
        rivalsa_perc: { type: 'number', description: 'Percentuale rivalsa. 0 per azzerarla.' },
      },
      required: ['cliente'],
    },
  },
  {
    name: 'conferma_bozza_fic',
    description: 'Avanza di UN SOLO passo la doppia conferma di una bozza FIC gia compilata, quando l Ingegnere conferma A PAROLE ("confermo", "procedi", "vai", "si", "va bene"). Serve quando e da cellulare e non puo copiare i codici /fic_ok_. REGOLE FERREE: (1) chiamalo SOLO se in QUESTO messaggio l Ingegnere ha detto di procedere — mai di tua iniziativa; (2) MAI due volte nello stesso turno: dopo il passo 1 devi CHIEDERGLI la conferma definitiva e fermarti, e richiamarlo solo dopo una sua NUOVA risposta affermativa (il tool rifiuta comunque il doppio scatto ravvicinato); (3) leggi l esito: se "documento_creato" e false la fattura NON esiste, riporta il campo "messaggio" testualmente e non dire che e stata creata; (4) se torna need "disambigua" ci sono piu bozze in attesa: elenca e chiedi quale, non sceglierne una.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID della bozza da confermare. Omettilo se ce n e una sola in attesa nelle ultime 24 ore.' },
      },
    },
  },
  {
    // Nome al PLURALE di proposito: e' lo stesso tool per una fattura e per
    // cinquanta — il caso singolo e' il massivo con un elemento, e due tool
    // separati sarebbero due posti dove le difese possono divergere.
    name: 'segna_fatture_ricevute_pagate',
    description: 'Segna PAGATA (saldata) una fattura RICEVUTA da un fornitore su Fatture in Cloud, registrando la modalita di pagamento: serve per i pagamenti in CONTANTI o con carta al ritiro, che non lasciano nessun movimento bancario da riconciliare. Funziona su UNA fattura (passa id) o su un INSIEME di fatture di spesa (fornitore e/o anno, mese): es. "segna pagate in contanti tutte le fatture Limongi del 2026". La modalita di pagamento si scegli fra i conti che Fatture in Cloud espone: se non la passi, il tool ti restituisce l elenco vero e tu CHIEDI all Ingegnere quale. La data di pagamento e la DATA DELLA FATTURA (pagata al ritiro), salvo che l Ingegnere ne indichi un altra. REGOLE: (1) non scrive niente subito — prepara l anteprima e serve la doppia conferma /fic_ok_<id> poi /fic_ok2_<id>; (2) mostra l anteprima COM E, comprese le fatture ESCLUSE col motivo (gia pagate, o con piu voci nel piano pagamenti: quelle non le tocca e non sceglie al posto suo); (3) massimo 50 fatture per conferma; (4) l esito e PER FATTURA e viene da una RILETTURA: se dice che 3 su 5 sono riuscite, riporta quali si e quali no col motivo, e NON dire «fatte tutte».',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Id della singola fattura ricevuta su Fatture in Cloud. Alternativo ai filtri fornitore/anno/mese.' },
        fornitore: { type: 'string', description: 'Nome (anche parziale) del fornitore, per selezionare piu fatture. Es. "Limongi".' },
        anno: { type: 'integer', description: 'Anno delle fatture da selezionare.' },
        mese: { type: 'integer', description: 'Mese 1-12, insieme ad anno.' },
        modalita_pagamento: { type: 'string', description: 'Nome o id del conto di pagamento di Fatture in Cloud, es. "Contanti", "Carta di credito". Se omesso o non riconosciuto, il tool torna l elenco vero dei conti dell azienda: chiedi all Ingegnere quale e richiama.' },
        data_pagamento: { type: 'string', description: 'Data del pagamento YYYY-MM-DD. Se omessa vale la DATA DI OGNI FATTURA, non oggi: il contante si paga al ritiro.' },
        voce: { type: 'integer', description: 'Quale voce del piano pagamenti segnare pagata (1 = la prima), solo quando la fattura ne ha piu di una e l Ingegnere ha detto quale. Richiede id.' },
      },
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
    if (name === 'segna_fatture_ricevute_pagate') return segnaFatturePagate(input, societa)
    if (name === 'conferma_bozza_fic') return confermaBozzaFic(input, societa)
    if (name === 'lista_bozze_fic') return listaBozzeFic(input, societa)
    if (name === 'elimina_bozza_fic') return eliminaBozzaFic(input, societa)
    return null
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
