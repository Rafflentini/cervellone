import { supabase } from './supabase'
import { ficGet, getCompanyId, creaDocumentoFIC, eliminaDocumentoFIC, caricaAllegatoFIC, creaSpesaFIC } from './fatture-in-cloud'
import { getSocieta, type CodiceSocieta } from './societa'
import { comandoDaMostrare } from './comandi-uuid'
import { modalitaPerDocumenti } from './fic-allegato'
import {
  cercaFattureEmesse,
  cercaFattureRicevute,
  classificaFattura,
  controparteDi,
  datiFattura,
  elencoContiPagamentoFic,
  leggiFatturaEmessa,
  leggiFatturaRicevuta,
  risolviContoPagamento,
  segnaPagataFatturaEmessa,
  segnaPagataFatturaRicevuta,
  TETTO_MASSIVO,
  type ContoPagamentoFic,
  type FatturaDaSegnarePagata,
  type FatturaEsclusa,
  type FatturaRicevuta,
  type Verso,
} from './fic-pagamenti'
import { scegliAllegatoMail, scaricaAllegatoScelto, CASELLE_GOOGLE } from './spesa-allegato'
import type { ChiaveCasella } from './caselle'

/**
 * Le tre operazioni di I/O per verso, prese per NOME dal modulo: i test le
 * sostituiscono una per una (`vi.mock('./fic-pagamenti')`), e un riferimento
 * preso al momento della chiamata e' quello che i test vedono.
 */
const IO_PAGAMENTI = {
  ricevuta: {
    leggi: (id: number, s: CodiceSocieta) => leggiFatturaRicevuta(id, s),
    cerca: (f: Parameters<typeof cercaFattureRicevute>[0], s: CodiceSocieta) => cercaFattureRicevute(f, s),
    segna: (...a: Parameters<typeof segnaPagataFatturaRicevuta>) => segnaPagataFatturaRicevuta(...a),
    pending: 'pagamento_ricevuta' as const,
    verbo: 'PAGAMENTI',
  },
  emessa: {
    leggi: (id: number, s: CodiceSocieta) => leggiFatturaEmessa(id, s),
    cerca: (f: Parameters<typeof cercaFattureEmesse>[0], s: CodiceSocieta) => cercaFattureEmesse(f, s),
    segna: (...a: Parameters<typeof segnaPagataFatturaEmessa>) => segnaPagataFatturaEmessa(...a),
    pending: 'pagamento_emessa' as const,
    verbo: 'INCASSI',
  },
} as const

function versoDelPending(tipo: PendingTipo): Verso | null {
  if (tipo === 'pagamento_ricevuta') return 'ricevuta'
  if (tipo === 'pagamento_emessa') return 'emessa'
  return null
}

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

type PendingStato = 'in_attesa' | 'creata' | 'annullata'
type PendingTipo = 'fattura_emessa' | 'rapporto_intervento' | 'pagamento_ricevuta' | 'pagamento_emessa' | 'autofattura' | 'spesa_ricevuta'

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
/**
 * I campi che danno IDENTITA' FISCALE a un'anagrafica, oltre al nome.
 *
 * ⚠️ 15 settembre 2026. `resolveEntitaFic` leggeva la scheda INTERA
 * dall'anagrafica e poi teneva solo `id` e `name`, affidandosi a Fatture in
 * Cloud per ricostruire il resto dall'id. Su una fattura italiana non si
 * notava. Su un'integrazione TD17 la partita IVA comunitaria del cedente
 * estero — Booking.com B.V., NL805734958B01 — non e' grafica: senza, il
 * documento non e' valido.
 *
 * I dati erano gia' in mano, letti due righe sopra, e venivano buttati via per
 * riaverli da un meccanismo mai verificato. Ora si portano avanti: se la
 * scheda ha il campo, il documento ce l'ha. E si copiano solo i campi
 * VALORIZZATI, perche' spedire una stringa vuota a FIC non e' «lascia stare» —
 * e' «cancella quello che c'e'».
 */
const CAMPI_IDENTITA_FIC = [
  'vat_number',
  'tax_code',
  'address_street',
  'address_postal_code',
  'address_city',
  'address_province',
  'country',
  'country_iso',
] as const

export { identitaFiscale as identitaFiscalePerTest }

function identitaFiscale(scheda: Record<string, unknown> | undefined): Record<string, unknown> {
  const fuori: Record<string, unknown> = {}
  if (!scheda) return fuori
  for (const campo of CAMPI_IDENTITA_FIC) {
    const valore = cleanString(scheda[campo])
    if (valore) fuori[campo] = valore
  }
  return fuori
}

async function resolveEntitaFic(
  cliente: string,
  societa: CodiceSocieta,
  clienteId?: number,
  segmento: 'clients' | 'suppliers' = 'clients',
): Promise<
  | { ok: true; entity: Record<string, unknown>; descrizione: string }
  | { ok: false; error: string }
> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  // ⭐ Se il chiamante ha l'ID — perche' l'ha appena creato con
  // `fic_crea_cliente`, o perche' l'ha cercato — si punta QUELLO e non si cerca
  // per nome. E' la strada che Raffaele ha descritto il 13 set 2026: prima
  // l'anagrafica, poi la fattura che seleziona quel cliente. Cercare per nome
  // quando si ha l'id vorrebbe dire buttare via una certezza per rifare una
  // scelta ambigua.
  //
  // Si rilegge comunque la scheda: serve la denominazione VERA (FIC rifiuta il
  // documento senza `entity.name`) e serve accorgersi di un id che non esiste
  // piu', invece di scoprirlo a fattura in creazione.
  const etichettaId = segmento === 'suppliers' ? 'fornitore_id' : 'cliente_id'
  const etichettaAnagrafica = segmento === 'suppliers' ? 'anagrafica fornitori' : 'anagrafica clienti'

  if (clienteId !== undefined) {
    const r = await ficGet(`/c/${company.id}/entities/${segmento}/${clienteId}`, undefined, societa)
    if (!r.ok) return { ok: false, error: `${etichettaId} ${clienteId} non leggibile: ${r.error}` }
    const scheda = (r.data?.data ?? r.data) as Record<string, unknown> | undefined
    const nome = cleanString(scheda?.name)
    if (!nome) return { ok: false, error: `${etichettaId} ${clienteId} non trovato in anagrafica.` }
    return { ok: true, entity: { id: clienteId, name: nome, ...identitaFiscale(scheda) }, descrizione: `${nome} (id ${clienteId})` }
  }

  const r = await ficGet(`/c/${company.id}/entities/${segmento}`, {
    q: `name contains '${escapeFicQuery(cliente)}'`,
    per_page: 5,
  }, societa)
  if (!r.ok) return { ok: false, error: r.error }

  const list = Array.isArray(r.data?.data) ? r.data.data as Record<string, unknown>[] : []
  const conId = list.filter(row => row?.id)
  const first = conId[0]
  if (first?.id) {
    const nome = cleanString(first.name) ?? cliente
    // ⚠️ Se la ricerca ha pescato PIU' di un'anagrafica, l'Ingegnere deve
    // saperlo PRIMA di confermare: `name contains` su «Rossi» trova tutti i
    // Rossi, e qui si prende il primo. Senza questa riga la scelta e' muta.
    const altri = conId.length > 1
      ? ` ⚠️ ATTENZIONE: in anagrafica ce ne sono ALTRI ${conId.length - 1} che contengono «${cliente}» (${conId
          .slice(1)
          .map(x => cleanString(x.name) ?? '?')
          .join(', ')}). Ho preso il primo: se non e' questo, annulla e scrivi il nome per esteso.`
      : ''
    return { ok: true, entity: { id: first.id, name: nome, ...identitaFiscale(first) }, descrizione: `${nome} (id ${first.id})${altri}` }
  }
  // ⚠️ Nessuna corrispondenza. Il documento si compila lo stesso, col solo
  // nome: e' voluto (FIC accetta un'anagrafica al volo), ma l'Ingegnere deve
  // LEGGERLO, perche' una fattura intestata a un nome scritto a mano non ha ne'
  // P.IVA ne' indirizzo, e su un'anagrafica sbagliata non si torna indietro.
  return {
    ok: true,
    entity: { name: cliente },
    descrizione: `«${cliente}» — ⚠️ NON risulta in ${etichettaAnagrafica}: nessuna P.IVA, nessun indirizzo. Verifica prima di confermare.`,
  }
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
    `1a conferma -> ${comandoDaMostrare('fic_ok', input.id)}`,
    `annulla -> ${comandoDaMostrare('fic_no', input.id)}`,
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

  // `cliente_id` vince sul nome quando c'e': v. `resolveClientEntity`.
  const grezzo = input.cliente_id
  const clienteId = typeof grezzo === 'number' ? grezzo : typeof grezzo === 'string' && grezzo.trim() !== '' ? Number(grezzo) : undefined
  if (clienteId !== undefined && !Number.isFinite(clienteId)) return fail('cliente_id non e\' un numero')
  const entity = await resolveEntitaFic(cliente, societa, clienteId)
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
    // 🚨 Una FATTURA nasce ELETTRONICA. Un rapporto d'intervento no: non e' un
    // documento fiscale e allo SdI non ci va.
    //
    // 15 settembre 2026. Qui c'era `false` per entrambi, senza spiegazione. Su
    // una fattura vera voleva dire che il documento restava nel gestionale e
    // non passava MAI dallo SdI — e su Fatture in Cloud il tasto per
    // trasmetterla non compariva nemmeno, perche' su un documento non
    // elettronico non c'e'. Una fattura che sembra emessa e non lo e'.
    //
    // ⚠️ Elettronico NON vuol dire trasmesso: nessuna funzione di questo repo
    // chiama l'endpoint di invio allo SdI. Il documento nasce pronto e resta
    // fermo finche' l'Ingegnere non lo guarda e lo manda a mano.
    e_invoice: tipo === 'fattura_emessa',
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
    // ⚠️ La descrizione RISOLTA, non la stringa cercata: e' quella che
    // l'Ingegnere legge prima di confermare.
    cliente: entity.descrizione,
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
    conferma_1: comandoDaMostrare('fic_ok', pending.row.id),
    annulla: comandoDaMostrare('fic_no', pending.row.id),
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
  //
  // Vale UGUALE per un incasso su fattura EMESSA (14 set 2026): li' il
  // `fic_document_id` e' la NOSTRA fattura, magari gia' trasmessa allo SdI.
  const versoPagamento = versoDelPending(row.tipo)
  if (versoPagamento) {
    if (row.stato === 'creata') {
      const chi = versoPagamento === 'ricevuta' ? 'le fatture del fornitore' : 'la fattura emessa al cliente'
      return fail(
        `questo pending e' un ${versoPagamento === 'ricevuta' ? 'PAGAMENTO su fatture ricevute' : 'INCASSO su fatture emesse'}, `
        + `gia' scritto su Fatture in Cloud: non si annulla da qui e non cancello ${chi}. `
        + 'Per togliere il pagamento, modifica la fattura su Fatture in Cloud.',
        { id, ids_fatture: row.fic_document_id },
      )
    }
    return annullaPendingInAttesa(id, 'Nessun pagamento era stato scritto.')
  }

  // 🚨 Una SPESA gia' registrata e' un documento RICEVUTO, e `eliminaDocumentoFIC`
  // parla SOLO di `/issued_documents`: passargli l'id di una spesa vorrebbe dire
  // chiedere a Fatture in Cloud di cancellare la fattura EMESSA che porta quel
  // numero — un documento nostro, magari gia' trasmesso allo SdI, che non c'entra
  // niente. E' la stessa famiglia del difetto qui sopra: un «annulla» che
  // distrugge il documento sbagliato.
  if (row.tipo === 'spesa_ricevuta') {
    if (row.stato === 'creata') {
      return fail(
        'questa spesa e\' GIA\' registrata su Fatture in Cloud come documento RICEVUTO: non la cancello da qui. '
        + 'Il verbo che ho per eliminare parla solo delle fatture EMESSE, e usarlo con questo id cancellerebbe un altro '
        + 'documento. Eliminala da Fatture in Cloud, dove la vedi.',
        { id, id_documento: row.fic_document_id },
      )
    }
    return annullaPendingInAttesa(id, 'Nessuna spesa era stata registrata.')
  }

  // 🚨 Un pending di AUTOFATTURE gia' creato porta N id nel `fic_document_id`
  // (separati da virgola): `eliminaDocumentoFIC` ne cancellerebbe uno solo, e
  // per di piu' con una stringa che non e' un id. Qui non si cancella: si
  // elencano gli id e si manda l'Ingegnere a Fatture in Cloud, dove vede cosa
  // sta eliminando. Prima della conferma, invece, non esiste ancora niente e
  // annullare e' solo chiudere la riga.
  if (row.tipo === 'autofattura') {
    if (row.stato === 'creata') {
      return fail(
        'queste autofatture sono GIA state create su Fatture in Cloud: non le cancello da qui. '
        + 'Sono piu documenti in una riga sola, e un\'eliminazione parziale silenziosa e peggio di nessuna. '
        + 'Eliminale da Fatture in Cloud, dove vedi quali sono.',
        { id, ids_documenti: row.fic_document_id },
      )
    }
    return annullaPendingInAttesa(id, 'Nessuna autofattura era stata creata.')
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

/**
 * Quando la voce del piano NON vale il lordo (ritenuta d'acconto, rate) va
 * detto nell'anteprima: l'Ingegnere conferma l'importo che verra' SCRITTO,
 * non il totale della fattura (audit del 14 set 2026).
 */
function notaImporto(f: FatturaDaSegnarePagata): string {
  return Math.abs(f.importo_pagamento - f.importo) > 0.005
    ? ` (si scrive ${euro(f.importo_pagamento)}: la voce del piano, non il lordo)`
    : ''
}

function rigaFattura(f: FatturaDaSegnarePagata): string {
  return `- [${f.id}] ${f.fornitore} — n.${f.numero} del ${f.data} — ${euro(f.importo)} → pagamento il ${f.data_pagamento}${notaImporto(f)}`
}

function intestazioneFattura(f: { id: number; fornitore: string; numero: string; data: string }, verso: Verso): string {
  return `[${f.id}] ${controparteDi(verso)} ${f.fornitore} n.${f.numero} del ${f.data}`
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
  verso: Verso
}): string {
  const s = getSocieta(input.societa)
  // Il totale e' quello che verra' SCRITTO (le voci), non la somma dei lordi.
  const totale = input.daScrivere.reduce((somma, f) => somma + f.importo_pagamento, 0)
  const emessa = input.verso === 'emessa'
  return [
    emessa
      ? `Segno INCASSATE ${input.daScrivere.length} fatture EMESSE su Fatture in Cloud (cliente, data del bonifico)`
      : `Segno PAGATE ${input.daScrivere.length} fatture RICEVUTE su Fatture in Cloud`,
    `SOCIETA: ${s.denominazione} (P.IVA ${s.piva})`,
    `Modalita di pagamento: ${input.conto.nome} (conto FIC id ${input.conto.id})`,
    `DA SCRIVERE: ${input.daScrivere.length} — totale ${euro(Math.round(totale * 100) / 100)}`,
    ...elencoTagliato(input.daScrivere, rigaFattura, 'fatture da scrivere'),
    input.escluse.length > 0 ? `ESCLUSE, non verranno toccate: ${input.escluse.length}` : null,
    ...(input.escluse.length > 0 ? elencoTagliato(input.escluse, rigaEsclusa, 'escluse') : []),
    emessa
      ? 'Non si emette, non si modifica e non si trasmette niente: si scrive solo l\'incasso sulla fattura gia\' emessa.'
      : 'Non si emette e non si trasmette niente: si scrive solo il pagamento sulle fatture di spesa.',
    `1a conferma -> ${comandoDaMostrare('fic_ok', input.id)}`,
    `annulla -> ${comandoDaMostrare('fic_no', input.id)}`,
  ].filter(Boolean).join('\n')
}

/**
 * Salva un pending la cui anteprima ha bisogno dell'id della riga per scrivere
 * i comandi di conferma: si inserisce, si legge l'id, si riscrive la
 * descrizione. Nato per i pagamenti, serve IDENTICO alle autofatture — il
 * payload e' quindi un oggetto qualsiasi, non piu' il solo `PagamentiPayload`.
 */
async function salvaPendingPagamenti(
  payload: PagamentiPayload | AutofatturePayload | SpesaRicevutaPayload,
  descrivi: (id: string) => string,
  societa: CodiceSocieta,
  tipo: PendingTipo,
): Promise<{ ok: true; id: string; descrizione: string } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from('cervellone_fic_pending')
    .insert({
      tipo,
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
  verso: Verso = 'ricevuta',
): Promise<string> {
  const io = IO_PAGAMENTI[verso]
  const controparte = controparteDi(verso)
  const idSingolo = intero(input.id)
  const voce = intero(input.voce)
  if (voce !== undefined && idSingolo === undefined) {
    return fail('la voce del piano pagamenti si può indicare solo su UNA fattura: passa anche id')
  }

  const dataImposta = cleanString(input.data_pagamento)
  if (dataImposta && !/^\d{4}-\d{2}-\d{2}$/.test(dataImposta)) {
    return fail(`data_pagamento "${dataImposta}" non valida: serve il formato YYYY-MM-DD`)
  }
  // L'importo del bonifico, se l'Ingegnere lo passa, deve combaciare AL
  // CENTESIMO con la voce che verra' scritta: un bonifico parziale non segna
  // pagata l'intera voce (audit del 14 set 2026). Solo sul caso singolo.
  const importoBonifico = input.importo_bonifico === undefined || input.importo_bonifico === null || input.importo_bonifico === ''
    ? undefined
    : Number(input.importo_bonifico)
  if (importoBonifico !== undefined && !Number.isFinite(importoBonifico)) {
    return fail(`importo_bonifico "${String(input.importo_bonifico)}" non e' un numero`)
  }
  if (importoBonifico !== undefined && idSingolo === undefined) {
    return fail('importo_bonifico si puo indicare solo su UNA fattura: passa anche id')
  }
  // Un incasso ha la data del bonifico e nessun predefinito: si rifiuta QUI,
  // prima di leggere e prima del pending, cosi' non nasce un'anteprima con una
  // data che poi la classificazione escluderebbe fattura per fattura.
  if (verso === 'emessa' && !dataImposta) {
    return fail('manca la data del bonifico (data_pagamento, YYYY-MM-DD): un incasso si registra alla data in cui e\' arrivato, non la invento. Non ho scritto niente.')
  }

  // 1) L'insieme. Si legge SEMPRE da Fatture in Cloud, mai dal testo.
  let documenti: Record<string, unknown>[] = []
  let elencoTroncato = false
  let pagineLette = 1
  if (idSingolo !== undefined) {
    const letta = await io.leggi(idSingolo, societa)
    if (!letta.ok) return fail(letta.error)
    documenti.push(letta.valore)
  } else {
    // Sulle ricevute il filtro si chiama `fornitore`, sulle emesse `cliente`:
    // e' la parola con cui l'Ingegnere lo chiederebbe.
    const nomeControparte = cleanString(input[controparte])
    const anno = intero(input.anno)
    const mese = intero(input.mese)
    if (!nomeControparte && !anno) {
      return fail(`serve almeno un criterio: id di una fattura, oppure ${controparte} e/o anno. Non segno pagate «tutte» le fatture ${verso === 'emessa' ? 'emesse' : 'di spesa'}.`)
    }
    const trovate = await io.cerca({ fornitore: nomeControparte, anno, mese }, societa)
    if (!trovate.ok) return fail(trovate.error)
    documenti.push(...trovate.valore.documenti)
    elencoTroncato = trovate.valore.elenco_troncato
    pagineLette = trovate.valore.pagine_lette
  }

  if (documenti.length === 0) {
    return fail(`nessuna fattura ${verso} corrisponde alla selezione: non ho scritto niente`)
  }

  // 2) Il tetto e la completezza. Due cause DIVERSE di rifiuto, due messaggi
  // diversi: un rifiuto che dichiara il motivo sbagliato manda a caccia del
  // problema inesistente (successo il 12 set 2026 con «7 fatture, oltre il
  // tetto di 50» — 7 non supera 50, il messaggio era incoerente).
  if (documenti.length > TETTO_MASSIVO) {
    return fail(
      `la selezione tocca ${documenti.length} fatture, oltre il tetto di ${TETTO_MASSIVO} per singola conferma: `
      + 'restringi (per fornitore, anno o mese) e ripeti. Non ho scritto niente.',
      { trovate: documenti.length, tetto: TETTO_MASSIVO },
    )
  }
  // Una scrittura di massa su un gestionale fiscale non deve poter scappare:
  // se abbiamo esaurito il tetto di pagine lette SENZA finire l'elenco di FIC,
  // l'insieme che stiamo per confermare potrebbe non essere quello vero.
  if (elencoTroncato) {
    return fail(
      `ho letto ${pagineLette} pagine di Fatture in Cloud e non sono bastate per vedere tutte le fatture della `
      + 'selezione: non garantisco che l\'elenco sia completo, quindi non lo uso per una conferma unica. '
      + 'Restringi la ricerca (per fornitore, anno o mese) e ripeti. Non ho scritto niente.',
      { pagine_lette: pagineLette },
    )
  }

  // 2.5) Scrematura per la modalita' che il FORNITORE ha scritto sulla
  // fattura (Task 15). Legge l'allegato di OGNI fattura della selezione con
  // `modalitaPerDocumenti` (stessa lettura di fic_modalita_pagamento_fornitore,
  // sullo stesso insieme gia' in mano: non si rifa' la ricerca).
  //
  // ⭐ La regola piu' importante: se anche UNA sola fattura non e' leggibile,
  // il filtro NON si applica in silenzio. «Non sono riuscito a leggerla» e un
  // GUASTO, non e' «non l'ha messa» — e qui il risultato non e' un elenco, e
  // una SCRITTURA su un gestionale fiscale.
  const soloModalita = Array.isArray(input.solo_modalita_fornitore)
    ? input.solo_modalita_fornitore.map((v) => cleanString(v)).filter((v): v is string => !!v)
    : []
  if (soloModalita.length > 0 && verso === 'emessa') {
    return fail('solo_modalita_fornitore vale per le fatture RICEVUTE: su una fattura emessa la modalita\' la scriviamo noi. Non ho scritto niente.')
  }
  if (soloModalita.length > 0) {
    const letti = await modalitaPerDocumenti(documenti, societa)
    if (!letti.ok) return fail(letti.error)
    const { righe, non_leggibili } = letti.valore
    if (non_leggibili > 0) {
      return fail(
        `di ${righe.length} fatture, ${non_leggibili} non sono leggibili: il filtro solo_modalita_fornitore le `
        + 'lascia fuori, e non so se dovevano starci. Non ho scritto niente. Restringi la selezione (per id o '
        + 'per un fornitore/periodo piu preciso), o richiama senza solo_modalita_fornitore per vedere quali sono.',
        { trovate: righe.length, non_leggibili },
      )
    }
    const richieste = soloModalita.map((m) => m.toLowerCase().trim())
    const idAmmessi = new Set(
      righe
        .filter((r) => r.esito === 'dichiarata' && r.modalita
          && richieste.some((req) => (r.modalita as string).toLowerCase().includes(req)))
        .map((r) => r.id),
    )
    documenti = documenti.filter((doc) => idAmmessi.has(Number((doc as { id: unknown }).id)))
    if (documenti.length === 0) {
      return fail(
        `nessuna fattura della selezione ha dichiarato una di queste modalita di pagamento: ${soloModalita.join(', ')}. `
        + 'Non ho scritto niente.',
      )
    }
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
    const c = classificaFattura(doc, { data_pagamento: dataImposta, voce }, verso)
    if (c.stato === 'da_scrivere' && importoBonifico !== undefined
      && Math.abs(c.fattura.importo_pagamento - importoBonifico) > 0.005) {
      escluse.push({
        ...c.fattura,
        motivo: `il bonifico e' di ${euro(importoBonifico)} e la voce da segnare pagata e' di ${euro(c.fattura.importo_pagamento)}: `
          + 'non combaciano al centesimo, e non segno pagata una voce con un importo diverso da quello arrivato',
      })
      continue
    }
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
    (id) => descriviPagamenti({ id, societa, conto: conto.valore, daScrivere, escluse, verso }),
    societa,
    io.pending,
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
    conferma_1: comandoDaMostrare('fic_ok', pending.id),
    annulla: comandoDaMostrare('fic_no', pending.id),
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
async function eseguiPagamenti(
  payload: unknown,
  societa: CodiceSocieta,
  verso: Verso,
): Promise<EsitoPagamenti> {
  const io = IO_PAGAMENTI[verso]
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
      const esito = await io.segna(
        f.id,
        dati.conto,
        { data_pagamento: dati.data_pagamento, voce: dati.voce },
        societa,
      )
      trattate++
      const intestazione = intestazioneFattura(f, verso)
      if (esito.ok) {
        ids.push(f.id)
        riuscite.push(`✅ ${intestazione} — ${euro(f.importo_pagamento)} pagata il ${f.data_pagamento} su ${dati.conto.nome}`)
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
      messaggio: `${io.verbo} REGISTRATI IN PARTE su ${s.denominazione}: ${riuscite.length} su ${totale}.\n\n${coda}`,
      scritte: riuscite.length,
      ids,
    }
  }
  return {
    messaggio: `${io.verbo} REGISTRATI su ${s.denominazione}: ${riuscite.length} su ${totale}.\n\n${coda}`,
    scritte: riuscite.length,
    ids,
  }
}

/* ------------------------------------------------------------------ *
 * AUTOFATTURE in reverse charge (fatture estere) — N documenti, UNA conferma
 * ------------------------------------------------------------------ */

/**
 * Il tipo documento di Fatture in Cloud per l'autofattura da fornitore estero.
 *
 * ⚠️ `self_supplier_invoice` e NON `self_own_invoice`: il primo e'
 * «un'autofattura in cui chi emette compare come cliente, mentre l'altra
 * azienda e' il fornitore» — il caso delle commissioni Booking a LA REAL
 * ESTATE. Il secondo e' quello in cui si e' cliente e fornitore di se' stessi
 * (autoconsumo), che qui sarebbe il documento sbagliato.
 */
/**
 * ⚠️ DA CONFERMARE SU UN DOCUMENTO VERO — e per questo sta scritto QUI e in
 * nessun altro punto: si cambia in una riga.
 *
 * La documentazione di Fatture in Cloud si contraddice sui due valori. La FAQ
 * sviluppatori dice «self_supplier_invoice = quando sei sia cliente sia
 * fornitore»; la descrizione del campo dice invece che con
 * `self_supplier_invoice` l'emittente compare come CLIENTE e l'altra azienda
 * come FORNITORE — che e' esattamente il caso dell'integrazione TD17 su una
 * fattura Booking.
 *
 * Si e' scelta la seconda lettura, perche' e' quella che descrive il caso
 * vero. Ma e' una lettura, non una prova: se la prima autofattura creata su
 * Fatture in Cloud risultasse sbagliata, il valore da provare e'
 * `self_own_invoice` e si cambia solo questa riga.
 */
const TIPO_FIC_AUTOFATTURA = 'self_supplier_invoice'

/**
 * 🚨 Il codice TD17 NON sta nel campo `type`: sta in `ei_raw`.
 *
 * `type` sceglie la FORMA del documento su Fatture in Cloud; il tipo documento
 * dell'XML SdI e' un'altra cosa, e senza questa struttura il documento non e'
 * un'integrazione TD17 — e' una normale autofattura, corretta in apparenza e
 * sbagliata nella sostanza. Era il punto su cui questo lavoro poteva essere
 * silenziosamente sbagliato (documentazione ufficiale FIC, FAQ sviluppatori).
 *
 * TD17 = integrazione/autofattura per acquisto di servizi dall'estero,
 * art. 17 c.2 DPR 633/72, servizio generico ex art. 7-ter.
 */
const TIPO_DOCUMENTO_SDI = 'TD17'

function eiRawTipoDocumento(codice: string): Record<string, unknown> {
  return {
    FatturaElettronicaBody: {
      DatiGenerali: {
        DatiGeneraliDocumento: { TipoDocumento: codice },
      },
    },
  }
}

/**
 * Il `TipoDocumento` che Fatture in Cloud riporta su un documento riletto,
 * oppure `undefined` se la rilettura non espone `ei_raw`.
 *
 * ⚠️ `undefined` NON vuol dire «assente sul documento»: vuol dire «non l'ho
 * visto». La differenza conta, perche' da qui si decide se dichiarare un
 * documento sospetto, e un guasto di lettura non deve travestirsi da errore
 * del documento.
 */
function tipoDocumentoRiletto(doc: Record<string, unknown>): string | undefined {
  const body = asObject(asObject(doc.ei_raw).FatturaElettronicaBody)
  const generali = asObject(asObject(body.DatiGenerali).DatiGeneraliDocumento)
  return cleanString(generali.TipoDocumento)
}

interface AutofatturaRiga {
  /** Denominazione del fornitore estero, risolta sull'anagrafica. */
  fornitore: string
  /** Numero della fattura ORIGINALE del fornitore, non dell'autofattura. */
  numero: string
  /** Data della fattura ORIGINALE. */
  data: string
  /**
   * Data in cui la fattura estera e' stata RICEVUTA: e' la data che va
   * sull'integrazione, non oggi e non la data di emissione se diversa.
   * (Specifica contabile del 14 settembre 2026.)
   */
  data_ricezione: string
  imponibile: number
  /** Il payload FIC gia' costruito: quello che verra' spedito, senza ritocchi. */
  payload: Record<string, unknown>
}

interface AutofatturePayload {
  /** L'aliquota indicata nella chiamata, con l'etichetta letta da FIC. */
  vat: { id: number; etichetta: string }
  /** Serie di numerazione dedicata alle integrazioni. */
  numerazione: string
  documenti: AutofatturaRiga[]
}

/**
 * Etichetta leggibile di una riga `vat_types` di Fatture in Cloud.
 *
 * Si compone SOLO con i campi che FIC ha davvero restituito (`cleanString`
 * lascia cadere quelli assenti): niente natura inventata, niente «22%» di
 * ripiego. L'elenco grezzo viaggia comunque intero nella risposta del tool.
 */
function etichettaAliquota(row: Record<string, unknown>): string {
  const valore = parseAliquotaFic(row.value)
  return [
    `id ${String(row.id ?? '?')}`,
    valore !== null ? `${valore}%` : null,
    cleanString(row.description),
    cleanString(row.ei_type) ? `natura ${cleanString(row.ei_type)}` : null,
    cleanString(row.ei_description),
    cleanString(row.notes),
  ].filter(Boolean).join(' — ')
}

/**
 * Importo di una riga, letto SENZA `parseNumber`.
 *
 * `parseNumber` cancella i punti perche' serve al formato italiano
 * ("1.234,56"): su "18.32" restituirebbe 1832, cioe' cento volte l'imponibile
 * vero su un documento fiscale. Qui si accetta un numero, oppure una stringa
 * che Number() legge senza ambiguita'; tutto il resto viene RIFIUTATO invece
 * di essere interpretato.
 */
function importoSenzaAmbiguita(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const testo = cleanString(value)
  if (!testo) return null
  const n = Number(testo)
  return Number.isFinite(n) ? n : null
}

function rigaAutofattura(f: AutofatturaRiga, etichettaIva: string): string {
  return `- ${f.fornitore} — fattura n.${f.numero} del ${f.data}, ricevuta il ${f.data_ricezione} `
    + `→ integrazione datata ${f.data_ricezione} — imponibile ${euro(f.imponibile)} — IVA: ${etichettaIva}`
}

function descriviAutofatture(input: {
  id: string
  societa: CodiceSocieta
  numerazione: string
  etichettaIva: string
  documenti: AutofatturaRiga[]
}): string {
  const s = getSocieta(input.societa)
  const totale = Math.round(input.documenti.reduce((somma, f) => somma + f.imponibile, 0) * 100) / 100
  return [
    `Compilo ${input.documenti.length} AUTOFATTURE (reverse charge, fatture estere) su Fatture in Cloud`,
    `SOCIETA: ${s.denominazione} (P.IVA ${s.piva})`,
    `Tipo documento FIC: ${TIPO_FIC_AUTOFATTURA} — chi emette compare come CLIENTE, il fornitore estero come fornitore`,
    `Serie di numerazione: ${input.numerazione} (dedicata alle integrazioni, separata dalle fatture attive)`,
    // ⚠️ L'etichetta NON dice «scelta dall'Ingegnere»: l'id arriva dalla
    // chiamata, e chi chiama potrebbe essere il modello. Quello che il codice
    // garantisce e' che l'aliquota ESISTE su Fatture in Cloud e che e' scritta
    // qui, dove si legge prima dell'unica conferma — non chi l'ha scelta.
    `IVA applicata a TUTTE (id indicato nella chiamata, letto da Fatture in Cloud): ${input.etichettaIva}`,
    `DA CREARE: ${input.documenti.length} — totale imponibile ${euro(totale)}`,
    ...elencoTagliato(input.documenti, (f) => rigaAutofattura(f, input.etichettaIva), 'autofatture da creare'),
    '⚠️ L\'imponibile deve essere quello delle sole COMMISSIONI della piattaforma (fee sui pagamenti gestiti compresa). '
    + 'Gli incassi girati dalla piattaforma sono soldi degli ospiti e NON si integrano: se un importo qui sopra somiglia a un incasso, annulla.',
    'Nascono ELETTRONICHE ma NON vengono trasmesse: il documento e pronto per lo SdI e la trasmissione la fai tu da Fatture in Cloud, dopo averlo controllato.',
    `Tipo documento SdI: ${TIPO_DOCUMENTO_SDI} (integrazione art. 17 c.2 DPR 633/72, servizio generico art. 7-ter), impostato su ogni documento.`,
    '⚠️ I «dati fattura collegata» questo tool NON li compila: il riferimento alla fattura originale (numero e data) '
    + 'e\' scritto nella riga e nelle note, ma non nel campo strutturato. Controllalo su Fatture in Cloud prima di trasmettere.',
    `1a conferma -> ${comandoDaMostrare('fic_ok', input.id)}`,
    `annulla -> ${comandoDaMostrare('fic_no', input.id)}`,
  ].filter(Boolean).join('\n')
}

/**
 * Prepara N autofatture e le mette in UN solo pending, con UNA sola conferma.
 *
 * 🚨 L'IVA NON SI INDOVINA. Non c'e' nessun predefinito, nemmeno «quella del
 * 22%»: senza `vat_id` il tool si ferma e restituisce l'elenco VERO delle
 * aliquote di Fatture in Cloud — che portano dentro anche la natura N6.x —
 * perche' scelga l'Ingegnere. E' la stessa forma con cui
 * `segna_fatture_emesse_pagate` chiede il conto di pagamento.
 *
 * Il motivo e' la conferma unica: con un default sbagliato, un solo «confermo»
 * farebbe nascere quindici documenti fiscali tutti errati allo stesso modo.
 */
async function compilaAutofatture(
  input: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<string> {
  const grezze = Array.isArray(input.fatture) ? input.fatture : []
  if (grezze.length === 0) {
    return fail('serve l\'elenco delle fatture estere da autofatturare (`fatture`): fornitore, numero, data e imponibile di ognuna. Non ho preparato niente.')
  }
  if (grezze.length > TETTO_MASSIVO) {
    return fail(
      `la selezione tocca ${grezze.length} autofatture, oltre il tetto di ${TETTO_MASSIVO} per singola conferma: `
      + 'spezzala e ripeti. Non ho preparato niente.',
      { trovate: grezze.length, tetto: TETTO_MASSIVO },
    )
  }

  // 🚨 LA DATA DEL VIES. Il reverse charge vale PERCHE' la societa' e'
  // iscritta al VIES: una fattura estera anteriore a quella data riporta IVA
  // italiana gia' esposta e NON si integra affatto — si registra come un
  // normale acquisto con IVA detraibile. Autofatturarla produrrebbe un
  // documento illegittimo, quindi qui e' un RIFIUTO, non un avviso.
  //
  // Societa' senza data VIES nota = non si autofattura: il silenzio non vale
  // «si'» su un dato che decide la legittimita' del documento.
  const s0 = getSocieta(societa)
  const viesDal = s0.viesDal
  if (!viesDal) {
    return fail(
      `non so da quando ${s0.denominazione} e' iscritta al VIES, e senza quella data non so se queste fatture estere `
      + 'vadano integrate o registrate con l\'IVA italiana che riportano. Non ho preparato niente: '
      + 'la data va scritta in `societa.ts` (campo viesDal).',
    )
  }

  if (cleanString(input.data_documento) || cleanString(input.data)) {
    return fail(
      'la data dell\'integrazione non si passa: e\' la DATA DI RICEZIONE di ogni fattura estera (data_ricezione, una per fattura), '
      + 'non una data unica del gruppo e non oggi. Non ho preparato niente.',
    )
  }
  const note = cleanString(input.note)

  // 1) Le righe, lette dall'input SENZA completarle. Un dato mancante si
  //    rifiuta: su un'autofattura il numero e la data della fattura originale
  //    sono l'unica traccia di cosa si sta autofatturando.
  interface RigaGrezza {
    fornitore: string
    fornitoreId?: number
    numero: string
    data: string
    dataRicezione: string
    imponibile: number
    descrizione: string
  }
  const righe: RigaGrezza[] = []
  for (const g of grezze) {
    const row = asObject(g)
    const fornitore = cleanString(row.fornitore) ?? cleanString(row.nome) ?? cleanString(row.controparte)
    if (!fornitore) return fail('ogni fattura da autofatturare richiede `fornitore` (es. "Booking.com B.V."). Non ho preparato niente.')

    const numero = cleanString(row.numero) ?? cleanString(row.numero_fattura)
    if (!numero) return fail(`manca il numero della fattura di ${fornitore}: non lo invento. Non ho preparato niente.`)

    const data = cleanString(row.data) ?? cleanString(row.data_fattura)
    if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
      return fail(`la data della fattura n.${numero} di ${fornitore} manca o non e' nel formato YYYY-MM-DD. Non ho preparato niente.`)
    }

    const dataRicezione = cleanString(row.data_ricezione)
    if (!dataRicezione || !/^\d{4}-\d{2}-\d{2}$/.test(dataRicezione)) {
      return fail(
        `manca la data di RICEZIONE della fattura n.${numero} di ${fornitore} (data_ricezione, YYYY-MM-DD): `
        + 'e\' la data che va sull\'integrazione, e non la invento. Non ho preparato niente.',
      )
    }

    // Si guardano ENTRAMBE le date, emissione e ricezione. La specifica parla
    // del documento «ricevuto prima» del VIES, ma una fattura EMESSA prima
    // riporta gia' l'IVA italiana: rifiutare un caso di confine in piu' costa
    // una domanda, integrarne uno di troppo costa un documento illegittimo.
    const primaDelVies = [
      data < viesDal ? `emessa il ${data}` : null,
      dataRicezione < viesDal ? `ricevuta il ${dataRicezione}` : null,
    ].filter(Boolean)
    if (primaDelVies.length > 0) {
      return fail(
        `la fattura n.${numero} di ${fornitore} e' ${primaDelVies.join(' e ')}, cioe' PRIMA dell'iscrizione al VIES di `
        + `${s0.denominazione} (${viesDal}): non si integra. Una fattura estera anteriore a quella data riporta gia' l'IVA `
        + 'italiana al 22% e si registra come un normale acquisto con IVA detraibile — un\'autofattura qui sarebbe un '
        + 'documento illegittimo. Non ho preparato niente, nemmeno le altre del gruppo.',
        { numero, fornitore, vies_dal: viesDal },
      )
    }

    const imponibile = importoSenzaAmbiguita(row.imponibile ?? row.importo ?? row.totale)
    if (imponibile === null || imponibile <= 0) {
      return fail(
        `l'imponibile della fattura n.${numero} di ${fornitore} manca o non e' un numero leggibile `
        + '(passa un numero, es. 18.32 — non "1.234,56"). Non ho preparato niente.',
      )
    }

    const fornitoreIdGrezzo = row.fornitore_id ?? row.cliente_id
    const fornitoreId = fornitoreIdGrezzo === undefined || fornitoreIdGrezzo === null || fornitoreIdGrezzo === ''
      ? undefined
      : Number(fornitoreIdGrezzo)
    if (fornitoreId !== undefined && !Number.isFinite(fornitoreId)) return fail('fornitore_id non e\' un numero')

    righe.push({
      fornitore,
      fornitoreId,
      numero,
      data,
      dataRicezione,
      imponibile: Math.round(imponibile * 100) / 100,
      // Il riferimento alla fattura originale sta nel testo della riga: il
      // campo strutturato «dati fattura collegata» questo tool NON lo compila,
      // e l'anteprima lo dichiara invece di lasciarlo credere.
      descrizione: cleanString(row.descrizione)
        ?? `Integrazione art. 17 c.2 DPR 633/72 — ${fornitore}, fattura n.${numero} del ${data}`,
    })
  }

  // 2) 🚨 L'IVA. Si legge l'elenco vero di Fatture in Cloud e ci si scrive
  //    dentro l'id che l'Ingegnere ha indicato: un id assente dall'elenco e'
  //    un id inventato, e su un documento fiscale non passa.
  const elenco = await elencoAliquoteFic(societa)
  if (!elenco.ok) return fail(`aliquote IVA non leggibili da Fatture in Cloud: ${elenco.error}`)

  const vatId = intero(input.vat_id)
  const scelta = vatId === undefined
    ? undefined
    : elenco.righe.find((row) => parseAliquotaFic(row.id) === vatId)

  if (!scelta) {
    return ok({
      need: 'vat_id',
      messaggio: vatId === undefined
        ? 'Non scelgo io l\'aliquota IVA di un\'autofattura: la natura (N6.x) e l\'aliquota sono dati fiscali, e una conferma sola varrebbe per tutte le autofatture. Chiedi all\'Ingegnere QUALE di queste usare e richiamami con vat_id.'
        : `l'id IVA ${vatId} non esiste fra le ${elenco.righe.length} aliquote di questa azienda su Fatture in Cloud. Chiedi all'Ingegnere quale usare e richiamami con vat_id.`,
      // L'elenco e' quello GREZZO di Fatture in Cloud: descrizione, natura e
      // note comprese. Ripulirlo vorrebbe dire scegliere quali campi contano
      // in una decisione fiscale che non e' nostra.
      aliquote_disponibili: elenco.righe,
      // ⚠️ Un'INDICAZIONE da girare a chi sceglie, NON una scelta fatta qui:
      // sopra non c'e' nessun predefinito, e questo campo non ne introduce uno
      // (non nomina nessun id e nessuna percentuale). Serve perche' l'errore
      // tipico e' confondere l'aliquota della commissione della piattaforma
      // con quella degli affitti brevi, che e' un'altra operazione — quella
      // che l'ospite paga all'albergatore.
      contesto_per_l_ingegnere:
        'Di norma la commissione di una piattaforma estera in reverse charge si integra con l\'aliquota ORDINARIA, '
        + 'non con quella ridotta degli affitti brevi (che riguarda cio che l ospite paga, un altra operazione). '
        + '⚠️ Girala all Ingegnere perche scelga LUI: non e una scelta che puoi fare tu, e senza la sua risposta non richiamarmi con un vat_id.',
      autofatture_selezionate: righe.length,
      nota: 'Non ho preparato niente e non ho scritto niente su Fatture in Cloud.',
    })
  }

  const etichettaIva = etichettaAliquota(scelta)
  const idIva = parseAliquotaFic(scelta.id) as number

  // 3) La SERIE DI NUMERAZIONE. Le integrazioni vanno su una serie dedicata,
  //    separata dalle fatture attive: senza `numeration` FIC userebbe la serie
  //    predefinita, cioe' proprio quella delle attive. Un codice di sezionale
  //    non si inventa — si chiede, come l'aliquota.
  //
  //    Si chiede DOPO l'aliquota di proposito: l'IVA e' la decisione che fa
  //    danno, e deve essere la prima cosa che il tool rimanda all'Ingegnere.
  const numerazione = cleanString(input.numerazione) ?? cleanString(input.sezionale)
  if (!numerazione) {
    return ok({
      need: 'numerazione',
      messaggio:
        'Le integrazioni/autofatture vanno su una SERIE di numerazione dedicata, separata dalle fatture attive, e io non '
        + 'invento un codice di sezionale. Chiedi all\'Ingegnere quale serie usare su Fatture in Cloud (la sigla che '
        + 'vede nel menu della numerazione) e richiamami con `numerazione`.',
      autofatture_selezionate: righe.length,
      nota: 'Non ho preparato niente e non ho scritto niente su Fatture in Cloud.',
    })
  }

  // 4) Il fornitore estero sull'anagrafica. Stessa risoluzione della fattura
  //    emessa, avvisi compresi: se non risulta in anagrafica lo DICE, invece
  //    di far nascere il documento su un nome scritto a mano senza dirlo.
  const documenti: AutofatturaRiga[] = []
  for (const r of righe) {
    // ⚠️ `clients` e non `suppliers`, e la ragione va scritta perche' e' una
    // domanda APERTA, non una certezza.
    //
    // Su una TD17 il cedente/prestatore e' il fornitore estero: verrebbe da
    // cercarlo fra i FORNITORI. Il 15 settembre 2026, notte, l'ho cambiato —
    // e ho sbagliato metodo: l'ho fatto sulla base dell'etichetta
    // «DESTINATARIO» letta su un PDF, senza una prova che Fatture in Cloud
    // voglia un'entita' dell'elenco fornitori su un `issued_document`.
    //
    // I fatti che abbiamo: con l'id preso dall'elenco CLIENTI, FIC ha accettato
    // il documento senza obiezioni sull'anagrafica (l'unico 422 riguardava il
    // conto di saldo, altra cosa). E l'elenco fornitori, su La Real Estate,
    // risponde 403: forzarlo bloccherebbe tutto invece di correggere.
    //
    // ⬜ Da chiarire guardando l'XML di un documento vero, non un'etichetta del
    // PDF: e' l'XML che decide chi e' cedente e chi cessionario.
    const entity = await resolveEntitaFic(r.fornitore, societa, r.fornitoreId)


    if (!entity.ok) return fail(`${r.fornitore}: ${entity.error}. Non ho preparato niente.`)

    // 🚨 Qui l'anagrafica non e' facoltativa come su una fattura emessa.
    // L'integrazione deve riportare i dati del CEDENTE estero — indirizzo e
    // partita IVA comunitaria — e su un'entita' col solo nome quei dati non
    // ci sono: uscirebbe un documento formalmente incompleto.
    if (!asObject(entity.entity).id) {
      return fail(
        `«${r.fornitore}» non risulta in anagrafica su Fatture in Cloud, e un'integrazione senza i dati del cedente estero `
        + '(indirizzo e partita IVA comunitaria) non e\' un documento valido. Crea prima l\'anagrafica con fic_crea_cliente '
        + 'e richiamami con fornitore_id. ⚠️ Il fornitore estero va creato fra i FORNITORI: fic_crea_cliente con elenco fornitore, non fra i clienti. Non ho preparato niente.',
      )
    }

    const payload: Record<string, unknown> = {
      type: TIPO_FIC_AUTOFATTURA,
      entity: entity.entity,
      items_list: [{
        name: r.descrizione,
        qty: 1,
        net_price: r.imponibile,
        // L'id arriva dall'elenco di FIC, non da una tabella nostra.
        vat: { id: idIva },
      }],
      // 🚨 Il codice TD17 viaggia QUI, non nel `type`: senza questa struttura
      // il documento sarebbe una normale autofattura, non un'integrazione.
      ei_raw: eiRawTipoDocumento(TIPO_DOCUMENTO_SDI),
      // La data dell'integrazione e' quella di RICEZIONE della fattura estera.
      date: r.dataRicezione,
      // Serie dedicata: senza, FIC numererebbe fra le fatture attive.
      numeration: numerazione,
      // ⚠️ Il documento NASCE elettronico, e non e' un dettaglio: un'
      // integrazione TD17 si assolve TRASMETTENDOLA allo SdI, e Fatture in
      // Cloud il tasto per farlo non lo mostra nemmeno su un documento non
      // elettronico. Prima qui c'era `false` con scritto accanto «l'invio lo
      // fa l'Ingegnere»: non poteva farlo nessuno.
      //
      // Elettronico NON vuol dire trasmesso: nessuna funzione di questo repo
      // chiama l'endpoint di invio. Il documento resta fermo su Fatture in
      // Cloud finche' l'Ingegnere non lo guarda e lo manda a mano.
      e_invoice: true,
    }
    // Il riferimento alla fattura originale viaggia nelle note ANCHE quando
    // l'Ingegnere ne ha scritte di sue: e' il dato che lega l'integrazione al
    // documento estero, non un commento.
    payload.notes = [`Riferimento: ${r.fornitore}, fattura n.${r.numero} del ${r.data}, ricevuta il ${r.dataRicezione}.`, note]
      .filter(Boolean)
      .join(' ')

    documenti.push({
      // La denominazione RISOLTA (con l'eventuale avviso): e' quella che
      // l'Ingegnere legge prima dell'unica conferma.
      fornitore: entity.descrizione,
      numero: r.numero,
      data: r.data,
      data_ricezione: r.dataRicezione,
      imponibile: r.imponibile,
      payload,
    })
  }

  const payloadPending: AutofatturePayload = {
    vat: { id: idIva, etichetta: etichettaIva },
    numerazione,
    documenti,
  }

  const pending = await salvaPendingPagamenti(
    payloadPending,
    (id) => descriviAutofatture({ id, societa, numerazione, etichettaIva, documenti }),
    societa,
    'autofattura',
  )
  if (!pending.ok) return fail(pending.error)

  const s = getSocieta(societa)
  return ok({
    societa: s.denominazione,
    partita_iva: s.piva,
    id: pending.id,
    stato: 'in_attesa',
    tipo_documento_fic: TIPO_FIC_AUTOFATTURA,
    e_invoice: true,
    trasmissione: 'il documento nasce elettronico ma NON viene trasmesso: l invio allo SdI lo fai tu da Fatture in Cloud, dopo averlo controllato.',
    iva: { id: idIva, etichetta: etichettaIva },
    numerazione,
    da_creare: documenti.length,
    tipo_documento_sdi: TIPO_DOCUMENTO_SDI,
    da_controllare_su_fic: 'i «dati fattura collegata» non li imposta questo tool: il riferimento alla fattura originale sta nella riga e nelle note, non nel campo strutturato.',
    anteprima: pending.descrizione,
    conferma_1: comandoDaMostrare('fic_ok', pending.id),
    annulla: comandoDaMostrare('fic_no', pending.id),
    nota: 'Mostra l anteprima COM E, con tutte le autofatture elencate: e l unica cosa che l Ingegnere legge prima di una conferma che vale per tutte.',
  })
}

function leggiAutofatturePayload(payload: unknown): AutofatturePayload | null {
  const p = asObject(payload)
  const vat = asObject(p.vat)
  const id = Number(vat.id)
  const etichetta = cleanString(vat.etichetta)
  if (!Number.isFinite(id) || !etichetta) return null
  const numerazione = cleanString(p.numerazione)
  if (!numerazione) return null
  const grezzi = Array.isArray(p.documenti) ? p.documenti.map(asObject) : []
  if (grezzi.length === 0) return null
  const documenti: AutofatturaRiga[] = []
  for (const d of grezzi) {
    const payloadDoc = asObject(d.payload)
    // Un payload vuoto vorrebbe dire spedire un documento senza contenuto:
    // meglio dichiarare il pending illeggibile che creare un guscio su FIC.
    if (Object.keys(payloadDoc).length === 0) return null
    documenti.push({
      fornitore: cleanString(d.fornitore) ?? '(fornitore non indicato)',
      numero: cleanString(d.numero) ?? '?',
      data: cleanString(d.data) ?? '?',
      data_ricezione: cleanString(d.data_ricezione) ?? '?',
      imponibile: Number(d.imponibile) || 0,
      payload: payloadDoc,
    })
  }
  return { vat: { id, etichetta }, numerazione, documenti }
}

interface EsitoAutofatture {
  messaggio: string
  create: number
  /** Create su FIC ma NON confermate dalla rilettura: non sono un successo. */
  da_verificare: number
  ids: string[]
}

/**
 * Crea le N autofatture, UNA PER VOLTA, e riferisce PER DOCUMENTO.
 *
 * 🚨 Il conteggio delle riuscite NON viene dalla risposta della POST: dopo
 * ogni creazione il documento si RILEGGE da Fatture in Cloud e si controlla
 * che esista e che sia davvero del tipo giusto. Un «fatte tutte» su un gruppo
 * in cui due non sono nate sarebbe il difetto peggiore introducibile qui.
 *
 * Tre esiti, mai confusi:
 * - riuscita: creata E riletta;
 * - NON riuscita: la POST ha rifiutato, il documento non esiste;
 * - DA VERIFICARE: la POST ha risposto ma la rilettura no. Non e' un successo
 *   e non e' un fallimento — e non si ritenta, perche' un secondo tentativo
 *   creerebbe il doppione di un documento che forse c'e' gia'.
 */
async function creaAutofatture(
  payload: unknown,
  societa: CodiceSocieta,
): Promise<EsitoAutofatture> {
  const dati = leggiAutofatturePayload(payload)
  if (!dati) {
    return {
      messaggio: 'NESSUNA autofattura creata: il pending non contiene un elenco leggibile.',
      create: 0,
      da_verificare: 0,
      ids: [],
    }
  }

  const s = getSocieta(societa)
  const riuscite: string[] = []
  const fallite: string[] = []
  const daVerificare: string[] = []
  const ids: string[] = []
  let interruzione: string | null = null
  let trattate = 0

  for (const d of dati.documenti) {
    const intestazione = `${d.fornitore} — fattura n.${d.numero} del ${d.data} — ${euro(d.imponibile)}`
    try {



      const creato = await creaDocumentoFIC(d.payload, societa)
      trattate++
      if (!creato.ok) {
        fallite.push(`❌ ${intestazione} — ${creato.error}`)
        continue
      }
      const riletta = await rileggiAutofattura(creato.id, societa)
      if (!riletta.ok) {
        ids.push(creato.id)
        daVerificare.push(
          `⚠️ ${intestazione} — Fatture in Cloud ha risposto con l'id ${creato.id}, ma la rilettura NON conferma: `
          + `${riletta.error}. Controllala a mano su Fatture in Cloud prima di rifarla.`,
        )
        continue
      }
      ids.push(creato.id)
      riuscite.push(`✅ ${intestazione} — autofattura ${TIPO_FIC_AUTOFATTURA} id ${creato.id}${creato.url ? ` — ${creato.url}` : ''}`)
    } catch (err) {
      // Rete, token, 429: si ferma qui e si DICE dove si e' fermata.
      interruzione = err instanceof Error ? err.message : String(err)
      break
    }
  }

  const totale = dati.documenti.length
  const nonTrattate = dati.documenti.slice(trattate)
  const coda = [
    riuscite.length > 0 ? `CREATE (${riuscite.length}), verificate rileggendo ogni documento su Fatture in Cloud:\n${riuscite.join('\n')}` : null,
    fallite.length > 0 ? `NON CREATE (${fallite.length}), su Fatture in Cloud non esistono:\n${fallite.join('\n')}` : null,
    daVerificare.length > 0 ? `DA VERIFICARE A MANO (${daVerificare.length}), non le conto fra le riuscite:\n${daVerificare.join('\n')}` : null,
    interruzione
      ? `⚠️ La creazione si e' INTERROTTA (${interruzione}). Le autofatture elencate come create RESTANO su `
        + 'Fatture in Cloud: non tento nessun rollback. Da riprendere: '
        + `${nonTrattate.map((f) => `${f.fornitore} n.${f.numero}`).join(', ') || 'nessuna'}.`
      : null,
    `Nessuna e' stata trasmessa allo SdI: sono compilate, tipo documento . L'invio lo decidi tu da Fatture in Cloud.`,
  ].filter(Boolean).join('\n\n')

  if (riuscite.length === 0) {
    return {
      messaggio: `NESSUNA autofattura creata su ${s.denominazione}: 0 su ${totale}.\n\n${coda}`,
      create: 0,
      da_verificare: daVerificare.length,
      ids,
    }
  }
  if (riuscite.length < totale) {
    return {
      messaggio: `AUTOFATTURE CREATE IN PARTE su ${s.denominazione}: ${riuscite.length} su ${totale}.\n\n${coda}`,
      create: riuscite.length,
      da_verificare: daVerificare.length,
      ids,
    }
  }
  return {
    messaggio: `AUTOFATTURE CREATE su ${s.denominazione}: ${riuscite.length} su ${totale}.\n\n${coda}`,
    create: riuscite.length,
    da_verificare: daVerificare.length,
    ids,
  }
}

/**
 * Rilegge da Fatture in Cloud il documento appena creato.
 *
 * Non basta che la POST abbia risposto 200: si controlla che l'id torni e che
 * il tipo sia davvero quello dell'autofattura. E' l'unica prova che il
 * documento esiste come lo volevamo.
 */
async function rileggiAutofattura(
  id: string,
  societa: CodiceSocieta,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }
  const r = await ficGet(`/c/${company.id}/issued_documents/${encodeURIComponent(id)}`, undefined, societa)
  if (!r.ok) return { ok: false, error: r.error }
  const doc = asObject(r.data?.data ?? r.data)
  if (String(doc.id ?? '') !== String(id)) return { ok: false, error: 'la rilettura non ha restituito quel documento' }
  const tipo = cleanString(doc.type)
  if (tipo !== TIPO_FIC_AUTOFATTURA) {
    return { ok: false, error: `su Fatture in Cloud risulta di tipo «${tipo ?? 'sconosciuto'}», non ${TIPO_FIC_AUTOFATTURA}` }
  }
  // Il TipoDocumento SdI si controlla SOLO se la rilettura lo espone. Se FIC
  // non restituisce `ei_raw` non si conclude niente: un dato che non si vede
  // non e' un dato sbagliato, e trattarlo come tale renderebbe ogni
  // autofattura «sospetta» per un guasto di lettura. Se invece c'e' ed e'
  // DIVERSO, quello e' il caso da dichiarare: il documento esiste ma non e'
  // l'integrazione che l'Ingegnere ha confermato.
  const tipoSdi = tipoDocumentoRiletto(doc)
  if (tipoSdi !== undefined && tipoSdi !== TIPO_DOCUMENTO_SDI) {
    return {
      ok: false,
      error: `su Fatture in Cloud il tipo documento SdI risulta «${tipoSdi}», non ${TIPO_DOCUMENTO_SDI}: `
        + 'il documento c\'e\' ma non e\' l\'integrazione confermata',
    }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * Registrare la SPESA di un fornitore (documento RICEVUTO + il suo PDF)
 * ------------------------------------------------------------------ */

/**
 * Il tipo FIC di un documento di spesa. Sta fra i `type` di
 * `received_documents`, che e' un endpoint diverso da quello delle fatture
 * emesse: qui non si emette niente, si REGISTRA quello che ci ha mandato il
 * fornitore.
 */
const TIPO_FIC_SPESA = 'expense'

/**
 * Perche' questo tool esiste (14 settembre 2026).
 *
 * `compila_autofattura` sa creare l'integrazione TD17 in reverse charge per le
 * fatture estere. Ma l'integrazione e' META' adempimento: mette l'IVA a
 * DEBITO senza la fattura passiva a monte. La spesa del fornitore — quella
 * che porta il costo e l'IVA a credito — nessuno la registrava.
 *
 * Il perimetro l'ha dettato l'Ingegnere in una riga: «deve solo mettere PDF e
 * importo». Non si legge il PDF, non si estrae nessun importo da nessuna
 * parte, non si indovina niente: il numero lo dice lui, il file e' quello
 * della mail.
 */
interface SpesaRicevutaPayload {
  /**
   * 🚨 La denominazione NUDA, com'e' scritta in anagrafica: e' la chiave con
   * cui si cerca il doppione, e deve restare pulita. Qui c'era
   * `entity.descrizione`, che porta con se' gli avvisi («Booking.com B.V.
   * (id 9)»): cercare con quella stringa non trovava NIENTE, e
   * l'anti-doppione della conferma passava sempre. Trovato da un test, non
   * in produzione.
   */
  fornitore: string
  /** Lo stesso fornitore come lo legge l'Ingegnere: id, avvisi di anagrafica. */
  fornitore_descritto: string
  /** Numero della fattura DEL FORNITORE: e' la chiave dell'anti-doppione. */
  numero: string
  data: string
  imponibile: number
  /** IVA in euro, calcolata sul valore dell'aliquota LETTO da Fatture in Cloud. */
  iva: number
  totale: number
  vat: { id: number; etichetta: string }
  conto: ContoPagamentoFic
  /** Dove sta il PDF. Si scarica alla conferma, non prima: v. `spesa-allegato.ts`. */
  allegato: { casella: string; message_id: string; attachment_id: string; filename: string; oggetto: string }
  /** Il payload FIC gia' costruito, SENZA `attachment_token`: quello nasce al caricamento. */
  payload: Record<string, unknown>
}

/**
 * Chiude una riga in attesa senza toccare Fatture in Cloud.
 *
 * Tre rami di `elimina_bozza_fic` (pagamenti, autofatture, spese) facevano la
 * stessa identica cosa scritta tre volte: e tre copie della stessa query sono
 * tre posti dove la clausola `stato = 'in_attesa'` puo' sparire da una sola.
 * Quella clausola e' la difesa: senza, un «annulla» arrivato tardi
 * marcherebbe annullata una riga gia' eseguita.
 */
async function annullaPendingInAttesa(id: string, nota: string): Promise<string> {
  const annullato = await supabase
    .from('cervellone_fic_pending')
    .update({ stato: 'annullata', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('stato', 'in_attesa')
    .select('id, stato')
  if (annullato.error) return fail(annullato.error.message)
  if (!annullato.data?.length) return fail('pending FIC gia elaborato', { id })
  return ok({ id, stato: 'annullata', nota })
}

/**
 * Due numeri di fattura sono lo stesso numero se differiscono solo per
 * punteggiatura o maiuscole: «FT 123/2026» e «ft123-2026» sono lo stesso
 * documento, e un anti-doppione che non lo vede non serve a niente.
 */
function chiaveNumeroFattura(numero: string): string {
  return numero.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/**
 * 🚨 L'ANTI-DOPPIONE. Cerca su Fatture in Cloud una fattura RICEVUTA dello
 * stesso fornitore con lo stesso numero.
 *
 * I doppioni sono un difetto che questo progetto ha gia' pagato (anagrafiche
 * clienti duplicate, settembre 2026), e su una fattura d'acquisto costano di
 * piu': due volte lo stesso costo e due volte la stessa IVA a credito.
 *
 * ⚠️ Un elenco che NON si riesce a leggere, o che si legge a meta', non e' un
 * «non c'e'»: e' un «non lo so», e qui torna come errore. Una ricerca fallita
 * che si traveste da via libera e' esattamente il guasto che invece di
 * chiudere APRE.
 */
async function cercaSpesaDoppione(
  fornitore: string,
  numero: string,
  data: string,
  societa: CodiceSocieta,
): Promise<{ ok: true; esistente: FatturaRicevuta | null } | { ok: false; error: string }> {
  const anno = Number(data.slice(0, 4))
  const r = await cercaFattureRicevute(
    { fornitore, anno: Number.isFinite(anno) ? anno : undefined },
    societa,
  )
  if (!r.ok) {
    return { ok: false, error: `non riesco a leggere le fatture gia' registrate di ${fornitore} su Fatture in Cloud (${r.error}), quindi non posso escludere il doppione` }
  }
  if (r.valore.elenco_troncato) {
    return {
      ok: false,
      error: `l'elenco delle fatture ricevute del ${anno} e' TRONCATO (${r.valore.pagine_lette} pagine lette e Fatture in Cloud ne dichiara altre): `
        + 'su un elenco incompleto non posso dire che questa spesa non c\'e\' gia\'',
    }
  }
  const cercato = chiaveNumeroFattura(numero)
  const esistente = r.valore.documenti
    .map((d) => datiFattura(d, 'ricevuta'))
    .find((f) => chiaveNumeroFattura(f.numero) === cercato) ?? null
  return { ok: true, esistente }
}

function descriviSpesa(input: { id: string; societa: CodiceSocieta; spesa: SpesaRicevutaPayload }): string {
  const s = getSocieta(input.societa)
  const d = input.spesa
  return [
    `Registro una SPESA (fattura RICEVUTA) su Fatture in Cloud, col PDF allegato`,
    `SOCIETA: ${s.denominazione} (P.IVA ${s.piva})`,
    `Fornitore: ${d.fornitore_descritto}`,
    `Fattura n.${d.numero} del ${d.data}`,
    `Imponibile ${euro(d.imponibile)} + IVA ${euro(d.iva)} = totale ${euro(d.totale)}`,
    `IVA applicata (id indicato nella chiamata, letto da Fatture in Cloud): ${d.vat.etichetta}`,
    // 🚨 La riga che spiega perche' la spesa nasce gia' saldata.
    `PAGATA per COMPENSAZIONE il ${d.data} sul conto «${d.conto.nome}» (id ${d.conto.id}): `
    + 'il fornitore trattiene il dovuto dal bonifico, quindi non c\'e\' niente da pagare e questa fattura NON deve finire nello scadenzario.',
    `Allegato: «${d.allegato.filename}» dalla mail «${d.allegato.oggetto}» (casella ${d.allegato.casella}).`,
    '⚠️ Il PDF viene scaricato e caricato su Fatture in Cloud al momento della conferma: se in quel momento non si scarica, '
    + 'la spesa NON nasce affatto — non nasce senza il suo documento.',
    'Ho gia\' controllato che su Fatture in Cloud non ci sia una fattura di questo fornitore con questo numero, e lo ricontrollo prima di crearla.',
    `conferma -> ${comandoDaMostrare('fic_ok', input.id)} (a voce basta un «confermo»: e' una conferma sola)`,
    `annulla -> ${comandoDaMostrare('fic_no', input.id)}`,
  ].filter(Boolean).join('\n')
}

/**
 * Prepara la spesa e la mette in attesa di conferma. NON scrive niente su
 * Fatture in Cloud e non scarica ancora il PDF.
 *
 * 🚨 QUI NON SI INDOVINA NIENTE. Due dati non hanno predefinito e non lo
 * avranno mai:
 *
 * - l'ALIQUOTA IVA, perche' decide se l'IVA e' detraibile, in reverse charge o
 *   esclusa — e' una qualificazione fiscale, non un dettaglio tecnico;
 * - il CONTO su cui la spesa risulta pagata, perche' finisce su un documento
 *   contabile vero.
 *
 * Se mancano, il tool restituisce l'elenco VERO letto da Fatture in Cloud e si
 * ferma. Nessuna percentuale cablata da nessuna parte, nemmeno nel testo di un
 * messaggio di rifiuto: una percentuale scritta in un rifiuto e' un suggerimento,
 * e un suggerimento su una scelta fiscale e' gia' una scelta.
 */
async function compilaSpesaFornitore(
  input: Record<string, unknown>,
  societa: CodiceSocieta,
): Promise<string> {
  const s = getSocieta(societa)

  // 1) I dati che non si inventano. Ognuno manca -> non si prepara NIENTE.
  const fornitore = cleanString(input.fornitore) ?? cleanString(input.nome)
  if (!fornitore) {
    return fail('serve il `fornitore` della spesa (es. "Booking.com B.V."): non lo invento. Non ho preparato niente.')
  }

  const numero = cleanString(input.numero) ?? cleanString(input.numero_fattura)
  if (!numero) {
    return fail(
      `manca il numero della fattura di ${fornitore}, e senza numero non posso nemmeno controllare se e' gia' registrata. `
      + 'Non ho preparato niente.',
    )
  }

  const data = cleanString(input.data) ?? cleanString(input.data_fattura)
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return fail(`la data della fattura n.${numero} di ${fornitore} manca o non e' nel formato YYYY-MM-DD. Non ho preparato niente.`)
  }

  // `importoSenzaAmbiguita` e non `parseNumber`: quello cancella i punti per il
  // formato italiano, e su "18.32" restituirebbe 1832 — cento volte la spesa.
  const letto = importoSenzaAmbiguita(input.imponibile ?? input.importo)
  if (letto === null || letto <= 0) {
    return fail(
      `l'imponibile della fattura n.${numero} di ${fornitore} manca o non e' un numero leggibile `
      + '(passa un numero, es. 18.32 — non "1.234,56"). Non ho preparato niente.',
    )
  }
  const imponibile = Math.round(letto * 100) / 100

  const casella = cleanString(input.casella)
  const messageId = cleanString(input.message_id)
  if (!casella || !messageId) {
    return fail(
      'servono `casella` e `message_id` della mail che porta il PDF della fattura: una spesa si registra CON il suo '
      + 'documento, non senza. Trovali con gmail_search. Non ho preparato niente.',
    )
  }

  // 2) 🚨 L'IVA. Si legge l'elenco vero di Fatture in Cloud e ci si scrive
  //    dentro l'id indicato: un id assente dall'elenco e' un id inventato.
  const elenco = await elencoAliquoteFic(societa)
  if (!elenco.ok) return fail(`aliquote IVA non leggibili da Fatture in Cloud: ${elenco.error}. Non ho preparato niente.`)

  const vatId = intero(input.vat_id)
  const scelta = vatId === undefined
    ? undefined
    : elenco.righe.find((row) => parseAliquotaFic(row.id) === vatId)

  if (!scelta) {
    return ok({
      need: 'vat_id',
      messaggio: vatId === undefined
        ? 'Non scelgo io l\'aliquota IVA di una fattura d\'acquisto: dice se l\'IVA e\' detraibile, in reverse charge o esclusa, '
          + 'ed e\' una qualificazione fiscale, non un dettaglio. Chiedi all\'Ingegnere QUALE di queste usare e richiamami con vat_id.'
        : `l'id IVA ${vatId} non esiste fra le ${elenco.righe.length} aliquote di questa azienda su Fatture in Cloud. `
          + 'Chiedi all\'Ingegnere quale usare e richiamami con vat_id.',
      // L'elenco GREZZO di FIC: descrizione, natura e note comprese. Ripulirlo
      // vorrebbe dire scegliere quali campi contano in una decisione non nostra.
      aliquote_disponibili: elenco.righe,
      nota: 'Non ho preparato niente e non ho scritto niente su Fatture in Cloud.',
    })
  }

  const idIva = parseAliquotaFic(scelta.id) as number
  const etichettaIva = etichettaAliquota(scelta)
  const valoreIva = parseAliquotaFic(scelta.value)
  if (valoreIva === null) {
    // Non si legge -> si dice. L'alternativa sarebbe scrivere «0» e far
    // nascere una spesa con l'IVA sbagliata, che e' un dato inventato.
    return fail(
      `Fatture in Cloud non dice a quanto ammonta l'aliquota «${etichettaIva}»: senza quel valore non so quanta IVA `
      + 'scrivere sulla spesa, e non la calcolo a naso. Non ho preparato niente.',
    )
  }
  const iva = Math.round(imponibile * valoreIva) / 100
  const totale = Math.round((imponibile + iva) * 100) / 100

  // 3) 🚨 IL CONTO. Stessa forma: elenco vero, nessun predefinito.
  const conti = await elencoContiPagamentoFic(societa)
  if (!conti.ok) return fail(`conti di pagamento non leggibili da Fatture in Cloud: ${conti.error}. Non ho preparato niente.`)

  const richiesta = cleanString(input.modalita_pagamento)
  const risolto = richiesta ? risolviContoPagamento(conti.valore, richiesta) : null
  if (!risolto || !risolto.ok) {
    return ok({
      need: 'modalita_pagamento',
      messaggio: risolto
        ? `${risolto.error}. Chiedi all'Ingegnere quale conto usare e richiamami.`
        : 'Questa spesa nasce gia\' saldata (il fornitore trattiene il dovuto dal bonifico), e il conto su cui risulta '
          + 'pagata non lo scelgo io. Chiedi all\'Ingegnere quale usare e richiamami con modalita_pagamento.',
      conti_disponibili: conti.valore,
      nota: 'Non ho preparato niente e non ho scritto niente su Fatture in Cloud.',
    })
  }
  const conto = risolto.valore

  // 4) L'ALLEGATO: si SCEGLIE ora (e se non e' univoco ci si ferma), si scarica
  //    dopo la conferma. Vedi `spesa-allegato.ts`.
  const scelto = await scegliAllegatoMail(casella as ChiaveCasella, messageId, cleanString(input.nome_file))
  if (!scelto.ok) return fail(`${scelto.error}. Non ho preparato niente.`)

  // 5) Il fornitore sull'anagrafica FORNITORI (non clienti: qui il documento e'
  //    ricevuto). Se non risulta, il documento si prepara lo stesso col solo
  //    nome — FIC accetta — ma l'avviso finisce nell'anteprima.
  const entity = await resolveEntitaFic(fornitore, societa, intero(input.fornitore_id), 'suppliers')
  if (!entity.ok) return fail(`${fornitore}: ${entity.error}. Non ho preparato niente.`)
  const nomeFornitore = cleanString(asObject(entity.entity).name) ?? fornitore

  // 6) 🚨 ANTI-DOPPIONE, con la denominazione RISOLTA: cercare col nome
  //    scritto a mano avrebbe mancato la fattura registrata sotto il nome
  //    dell'anagrafica, cioe' avrebbe dichiarato «non c'e'» proprio quando c'e'.
  const doppione = await cercaSpesaDoppione(nomeFornitore, numero, data, societa)
  if (!doppione.ok) {
    return fail(`${doppione.error}. Non ho preparato niente: prima di creare una spesa devo poter escludere il doppione.`)
  }
  if (doppione.esistente) {
    return fail(
      `su Fatture in Cloud c'e' GIA' una fattura ricevuta di ${doppione.esistente.fornitore} con il numero `
      + `${doppione.esistente.numero} (id ${doppione.esistente.id}, del ${doppione.esistente.data}, `
      + `${euro(doppione.esistente.importo)}): non ne creo una seconda. Se quella e' sbagliata, correggila o eliminala `
      + 'su Fatture in Cloud. Non ho preparato niente.',
      { id_esistente: doppione.esistente.id, doppione: doppione.esistente },
    )
  }

  const descrizione = cleanString(input.descrizione) ?? `${nomeFornitore} — fattura n.${numero} del ${data}`

  const payloadFic: Record<string, unknown> = {
    type: TIPO_FIC_SPESA,
    entity: entity.entity,
    date: data,
    // Il numero DEL FORNITORE: su un documento ricevuto la numerazione interna
    // di FIC e' un'altra cosa, e non si tocca.
    invoice_number: numero,
    amount_net: imponibile,
    amount_vat: iva,
    amount_gross: totale,
    items_list: [{ name: descrizione, qty: 1, net_price: imponibile, vat: { id: idIva } }],
    // 🚨 IL PIANO PAGAMENTI, ESPLICITO E SALDATO. Lasciarlo vuoto non e'
    // neutro: la spesa comparirebbe come DA PAGARE nello scadenzario, e
    // qualcuno pagherebbe una seconda volta qualcosa che il fornitore ha gia'
    // trattenuto. Per questo la data del pagamento e' quella del documento e
    // lo stato e' `paid` fin da subito.
    payments_list: [{
      due_date: data,
      paid_date: data,
      amount: totale,
      status: 'paid',
      payment_account: { id: conto.id },
    }],
  }

  const spesa: SpesaRicevutaPayload = {
    fornitore: nomeFornitore,
    fornitore_descritto: entity.descrizione,
    numero,
    data,
    imponibile,
    iva,
    totale,
    vat: { id: idIva, etichetta: etichettaIva },
    conto,
    allegato: {
      casella,
      message_id: messageId,
      attachment_id: scelto.allegato.attachmentId,
      filename: scelto.allegato.filename,
      oggetto: scelto.oggetto,
    },
    payload: payloadFic,
  }

  const pending = await salvaPendingPagamenti(
    spesa,
    (id) => descriviSpesa({ id, societa, spesa }),
    societa,
    'spesa_ricevuta',
  )
  if (!pending.ok) return fail(pending.error)

  return ok({
    societa: s.denominazione,
    partita_iva: s.piva,
    id: pending.id,
    stato: 'in_attesa',
    tipo_documento_fic: TIPO_FIC_SPESA,
    fornitore: entity.descrizione,
    numero,
    data,
    imponibile,
    iva,
    totale,
    aliquota: { id: idIva, etichetta: etichettaIva },
    pagamento: { conto: conto.nome, conto_id: conto.id, data, stato: 'paid', motivo: 'compensazione: non va nello scadenzario' },
    allegato: spesa.allegato.filename,
    anteprima: pending.descrizione,
    conferma: comandoDaMostrare('fic_ok', pending.id),
    annulla: comandoDaMostrare('fic_no', pending.id),
    nota: 'Mostra l anteprima COM E. Non ho scritto niente su Fatture in Cloud e non ho ancora scaricato il PDF.',
  })
}

function leggiSpesaPayload(payload: unknown): SpesaRicevutaPayload | null {
  const p = asObject(payload)
  const fornitore = cleanString(p.fornitore)
  const numero = cleanString(p.numero)
  const data = cleanString(p.data)
  if (!fornitore || !numero || !data) return null

  const vat = asObject(p.vat)
  const idIva = Number(vat.id)
  const etichetta = cleanString(vat.etichetta)
  if (!Number.isFinite(idIva) || !etichetta) return null

  const conto = asObject(p.conto)
  const contoId = Number(conto.id)
  const contoNome = cleanString(conto.nome)
  if (!Number.isFinite(contoId) || !contoNome) return null

  const allegato = asObject(p.allegato)
  const casella = cleanString(allegato.casella)
  const messageId = cleanString(allegato.message_id)
  const attachmentId = cleanString(allegato.attachment_id)
  const filename = cleanString(allegato.filename)
  // Senza le coordinate del file non c'e' spesa da creare: il documento non
  // nasce senza il suo PDF, e non si ripiega su una spesa «senza allegato».
  if (!casella || !messageId || !attachmentId || !filename) return null

  const payloadDoc = asObject(p.payload)
  if (Object.keys(payloadDoc).length === 0) return null

  return {
    fornitore,
    fornitore_descritto: cleanString(p.fornitore_descritto) ?? fornitore,
    numero,
    data,
    imponibile: Number(p.imponibile) || 0,
    iva: Number(p.iva) || 0,
    totale: Number(p.totale) || 0,
    vat: { id: idIva, etichetta },
    conto: { id: contoId, nome: contoNome },
    allegato: {
      casella,
      message_id: messageId,
      attachment_id: attachmentId,
      filename,
      oggetto: cleanString(allegato.oggetto) ?? '(oggetto non registrato)',
    },
    payload: payloadDoc,
  }
}

interface EsitoSpesa {
  messaggio: string
  creata: boolean
  /** Creata su FIC ma NON confermata dalla rilettura: non e' un successo. */
  da_verificare: boolean
  /** true = NON si ritenta (o e' nata, o e' incerta, o e' gia' li'). */
  bloccato: boolean
  id: string | null
}

/**
 * Rilegge da Fatture in Cloud la spesa appena creata.
 *
 * Non basta che la POST abbia risposto: si controlla che l'id torni, che il
 * tipo sia quello di una spesa, e che l'ALLEGATO ci sia — perche' una fattura
 * d'acquisto registrata senza il suo documento e' meta' del lavoro fatto e
 * l'altra meta' persa in silenzio.
 *
 * ⚠️ Le due assenze non sono la stessa cosa. Se `attachment_url` non compare
 * affatto nella rilettura, non l'abbiamo VISTO e non si conclude niente; se
 * compare VUOTO, il documento c'e' e l'allegato no — e quello e' un guasto da
 * dichiarare. Trattare «non l'ho visto» come «non c'e'» renderebbe ogni spesa
 * sospetta per un capriccio del fieldset.
 */
async function rileggiSpesa(
  id: string,
  societa: CodiceSocieta,
): Promise<{ ok: true; allegato: 'verificato' | 'non_visto' } | { ok: false; error: string }> {
  const company = await getCompanyId(societa)
  if (!company.ok) return { ok: false, error: company.error }

  const r = await ficGet(`/c/${company.id}/received_documents/${encodeURIComponent(id)}`, { fieldset: 'detailed' }, societa)
  if (!r.ok) return { ok: false, error: r.error }

  const doc = asObject(r.data?.data ?? r.data)
  if (String(doc.id ?? '') !== String(id)) return { ok: false, error: 'la rilettura non ha restituito quel documento' }

  const tipo = cleanString(doc.type)
  if (tipo !== undefined && tipo !== TIPO_FIC_SPESA) {
    return { ok: false, error: `su Fatture in Cloud risulta di tipo «${tipo}», non ${TIPO_FIC_SPESA}` }
  }

  const haChiave = Object.prototype.hasOwnProperty.call(doc, 'attachment_url')
  const url = cleanString(doc.attachment_url)
  if (haChiave && !url) {
    return { ok: false, error: 'il documento c\'e\' ma l\'allegato NON risulta: sarebbe una fattura d\'acquisto registrata senza il suo PDF' }
  }
  return { ok: true, allegato: url ? 'verificato' : 'non_visto' }
}

/**
 * Crea la spesa: anti-doppione, PDF da Gmail, caricamento su FIC, POST,
 * RILETTURA. In quest'ordine, e ogni passo che fallisce ferma tutto.
 *
 * Tre esiti, mai confusi:
 * - REGISTRATA: creata E riletta;
 * - NON REGISTRATA: non esiste su Fatture in Cloud, col motivo;
 * - DA VERIFICARE: la POST ha risposto ma la rilettura no. Non e' un successo
 *   e non e' un fallimento — e non si ritenta, perche' un secondo tentativo
 *   creerebbe il doppione di un documento che forse c'e' gia'.
 */
async function creaSpesa(payload: unknown, societa: CodiceSocieta): Promise<EsitoSpesa> {
  const s = getSocieta(societa)
  const dati = leggiSpesaPayload(payload)
  if (!dati) {
    return {
      messaggio: 'SPESA NON REGISTRATA: il pending non contiene una spesa leggibile (mancano i dati o le coordinate del PDF). Non ho creato niente.',
      creata: false,
      da_verificare: false,
      bloccato: true,
      id: null,
    }
  }

  const intestazione = `${dati.fornitore_descritto} — fattura n.${dati.numero} del ${dati.data} — imponibile ${euro(dati.imponibile)}, totale ${euro(dati.totale)}`
  const non = (motivo: string, bloccato = false, id: string | null = null): EsitoSpesa => ({
    messaggio: `SPESA NON REGISTRATA su ${s.denominazione}: ${intestazione}.\n\n${motivo}`,
    creata: false,
    da_verificare: false,
    bloccato,
    id,
  })

  // 🚨 L'anti-doppione si rifa' QUI, subito prima di creare. Quello della
  // compilazione serve a non far confermare un doppione; questo serve a non
  // CREARLO — fra le due cose c'e' una conferma, e in mezzo la stessa fattura
  // puo' essere entrata da un altro canale.
  const doppione = await cercaSpesaDoppione(dati.fornitore, dati.numero, dati.data, societa)
  if (!doppione.ok) return non(`${doppione.error}. Non ho creato niente.`)
  if (doppione.esistente) {
    return non(
      `su Fatture in Cloud c'e' GIA' una fattura ricevuta con il numero ${doppione.esistente.numero} `
      + `(id ${doppione.esistente.id}, del ${doppione.esistente.data}, ${euro(doppione.esistente.importo)}): `
      + 'non ne creo una seconda e non ritento. Controllala su Fatture in Cloud.',
      true,
      String(doppione.esistente.id),
    )
  }

  const scaricato = await scaricaAllegatoScelto(
    dati.allegato.casella as ChiaveCasella,
    dati.allegato.message_id,
    { filename: dati.allegato.filename, attachmentId: dati.allegato.attachment_id },
  )
  if (!scaricato.ok) {
    return non(`${scaricato.error}. La spesa NON nasce senza il suo documento: su Fatture in Cloud non c'e' niente.`)
  }

  const caricato = await caricaAllegatoFIC(dati.allegato.filename, scaricato.contenuto, societa)
  if (!caricato.ok) {
    return non(`caricamento dell'allegato su Fatture in Cloud fallito: ${caricato.error}. Nessun documento e' stato creato.`)
  }

  const creato = await creaSpesaFIC({ ...dati.payload, attachment_token: caricato.token }, societa)
  if (!creato.ok) return non(`Fatture in Cloud ha rifiutato la creazione: ${creato.error}.`)

  const riletta = await rileggiSpesa(creato.id, societa)
  if (!riletta.ok) {
    return {
      messaggio: `SPESA DA VERIFICARE su ${s.denominazione}: ${intestazione}.\n\n`
        + `Fatture in Cloud ha risposto con l'id ${creato.id}, ma la rilettura NON conferma: ${riletta.error}. `
        + 'Controllala a mano su Fatture in Cloud prima di rifarla: non la conto fra le riuscite e non ritento, '
        + 'perche\' un secondo tentativo creerebbe il doppione di un documento che forse c\'e\' gia\'.',
      creata: false,
      da_verificare: true,
      bloccato: true,
      id: creato.id,
    }
  }

  return {
    messaggio: [
      `SPESA REGISTRATA su ${s.denominazione}: ${intestazione}.`,
      '',
      `✅ Documento RICEVUTO id ${creato.id}${creato.url ? ` — ${creato.url}` : ''}, verificato rileggendolo su Fatture in Cloud.`,
      `IVA: ${dati.vat.etichetta} — ${euro(dati.iva)}.`,
      `Risulta PAGATA il ${dati.data} sul conto «${dati.conto.nome}» (compensazione): non entra nello scadenzario.`,
      riletta.allegato === 'verificato'
        ? `Allegato «${dati.allegato.filename}»: c'e', l'ho riletto sul documento.`
        : `⚠️ Allegato «${dati.allegato.filename}»: caricato, ma la rilettura non espone il campo dell'allegato, quindi NON l'ho verificato. Controllalo su Fatture in Cloud.`,
    ].join('\n'),
    creata: true,
    da_verificare: false,
    bloccato: true,
    id: creato.id,
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
  return `Prima conferma registrata per *${s.denominazione}* (P.IVA ${s.piva}).\nConferma DEFINITIVA -> ${comandoDaMostrare('fic_ok2', cleanId)}`
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
  if (Number(row.conferme) < 1) return `Serve prima la prima conferma -> ${comandoDaMostrare('fic_ok', cleanId)}`

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
  const versoPagamento = versoDelPending(row.tipo)
  if (versoPagamento) {
    const esito = await eseguiPagamenti(row.payload, row.societa, versoPagamento)

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

  // Le AUTOFATTURE sono N documenti dentro UN pending: stessa doppia conferma
  // e stessi comandi, ma la creazione e' un ciclo con esito PER DOCUMENTO.
  if (row.tipo === 'autofattura') {
    const esito = await creaAutofatture(row.payload, row.societa)

    // 🚨 Si ritenta SOLO se non e' nato niente E non c'e' niente di incerto.
    // Una riga rimessa a `conferme: 1` quando un documento potrebbe esistere
    // gia' e' il modo per creare il doppione al secondo «confermo».
    if (esito.create === 0 && esito.da_verificare === 0) {
      await supabase
        .from('cervellone_fic_pending')
        .update({ conferme: 1, updated_at: new Date().toISOString() })
        .eq('id', cleanId)
        .eq('stato', 'in_attesa')
        .eq('conferme', 2)
      return esito.messaggio
    }

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

  // La SPESA di un fornitore e' UN documento RICEVUTO con il suo PDF: stessa
  // riga e stessa conferma, ma la creazione e' una catena (anti-doppione,
  // scaricamento del PDF da Gmail, caricamento su FIC, POST) e l'esito viene
  // dalla RILETTURA, non dalla risposta della POST.
  if (row.tipo === 'spesa_ricevuta') {
    const esito = await creaSpesa(row.payload, row.societa)

    // 🚨 Si ritenta SOLO se non e' nato niente E niente e' incerto. Una riga
    // rimessa a `conferme: 1` quando il documento potrebbe esistere gia' e' il
    // modo per creare il doppione al secondo «confermo» — che e' proprio la
    // cosa che questo tool esiste per evitare.
    if (!esito.creata && !esito.da_verificare && !esito.bloccato) {
      await supabase
        .from('cervellone_fic_pending')
        .update({ conferme: 1, updated_at: new Date().toISOString() })
        .eq('id', cleanId)
        .eq('stato', 'in_attesa')
        .eq('conferme', 2)
      return esito.messaggio
    }

    const nato = esito.creata || esito.da_verificare
    const chiusa = await supabase
      .from('cervellone_fic_pending')
      .update({
        stato: nato ? 'creata' : 'annullata',
        // Se il documento NON e' nato, qui non ci va nessun id: il
        // `fic_document_id` di un documento che non abbiamo creato manderebbe
        // un futuro «annulla» a cancellare la fattura di qualcun altro.
        fic_document_id: nato ? esito.id : null,
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
  //
  // Il verbo cambia col verso (PAGAMENTI sulle ricevute, INCASSI sulle
  // emesse): riconoscere un solo verbo rifaceva la stessa bugia sull'altro
  // (audit del 14 set 2026).
  //
  // Le autofatture portano un terzo verbo (AUTOFATTURE CREATE): senza
  // riconoscerlo, un gruppo creato davvero verrebbe riferito come NON riuscito.
  const parziale = /^(PAGAMENTI|INCASSI) REGISTRATI IN PARTE/.test(messaggio)
    || /^AUTOFATTURE CREATE IN PARTE/.test(messaggio)
  // La spesa di un fornitore porta un QUARTO verbo (SPESA REGISTRATA), e con se'
  // un esito che gli altri non hanno: SPESA DA VERIFICARE, cioe' «Fatture in
  // Cloud ha risposto ma la rilettura non conferma». Quello non e' ne' un si'
  // ne' un no, e riferirlo come uno dei due sarebbe mentire in una delle due
  // direzioni.
  const daVerificare = /^SPESA DA VERIFICARE/.test(messaggio)
  const eseguita = messaggio.startsWith('BOZZA creata su FIC')
    || /^(PAGAMENTI|INCASSI) REGISTRATI/.test(messaggio)
    || /^AUTOFATTURE CREATE/.test(messaggio)
    || /^SPESA REGISTRATA/.test(messaggio)
  return ok({
    id: riga.id,
    passo: 2,
    documento_creato: eseguita,
    esito_parziale: parziale,
    esito_incerto: daVerificare,
    messaggio,
    avviso: daVerificare
      ? 'ESITO INCERTO: Fatture in Cloud ha risposto ma la rilettura NON conferma. Riporta il messaggio TESTUALMENTE, non dire ne che e stata registrata ne che non lo e, e NON ritentare: un secondo tentativo creerebbe il doppione.'
      : !eseguita
      ? 'L operazione NON e riuscita: riporta il messaggio TESTUALMENTE e non dire che e stata fatta.'
      : parziale
        ? 'ATTENZIONE: solo ALCUNE fatture sono state scritte. Riporta il messaggio TESTUALMENTE, con l elenco di quali SI e quali NO col motivo. Non dire «fatte tutte».'
        : null,
  })
}

export const FIC_WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'compila_fattura_emessa',
    description:
      'Compila una bozza di fattura emessa su Fatture in Cloud, senza trasmetterla. Richiede doppia conferma prima della creazione. ' +
      'Supporta il sezionale di numerazione (es. "ED" per l\'edilizia), il centro di ricavo delle righe e l\'azzeramento della cassa ' +
      'previdenziale/rivalsa INARCASSA impostata di default sul cliente (passa cassa_perc: 0). ' +
      'PRIMA DI CHIAMARMI, IL CLIENTE VA IN ANAGRAFICA. Tre passi, in questo ordine: ' +
      '1) fic_cerca_anagrafica per codice fiscale o partita IVA (chiavi certe) o per nome; ' +
      "2) se NON c'e', fic_crea_cliente — per gli affitti brevi de La Real Estate e' il caso normale, quasi ogni ospite e' nuovo; " +
      '3) passa qui il cliente_id ottenuto. Senza id cerco per nome e, se in anagrafica ci sono due persone simili, prendo il primo.',
    input_schema: {
      type: 'object',
      properties: {
        cliente: { type: 'string', description: "Nome del cliente. Se hai il cliente_id usa QUELLO: il nome serve solo a ritrovarlo." },
        cliente_id: {
          type: 'number',
          description:
            "Id dell'anagrafica su Fatture in Cloud. USALO SEMPRE quando ce l'hai — te lo restituisce fic_crea_cliente " +
            "o fic_cerca_anagrafica. Con l'id la fattura punta il cliente giusto senza ambiguita'; col solo nome, se in " +
            'anagrafica ci sono due persone simili, viene preso il primo.',
        },
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
    description: 'Segna PAGATA (saldata) una fattura RICEVUTA da un fornitore su Fatture in Cloud, registrando la modalita di pagamento: serve per i pagamenti in CONTANTI o con carta al ritiro, che non lasciano nessun movimento bancario da riconciliare. Funziona su UNA fattura (passa id) o su un INSIEME di fatture di spesa (fornitore e/o anno, mese): es. "segna pagate in contanti tutte le fatture Limongi del 2026". La modalita di pagamento si scegli fra i conti che Fatture in Cloud espone: se non la passi, il tool ti restituisce l elenco vero e tu CHIEDI all Ingegnere quale. La data di pagamento e la DATA DELLA FATTURA (pagata al ritiro), salvo che l Ingegnere ne indichi un altra. Puoi restringere la selezione a quelle in cui il FORNITORE ha scritto una certa modalita di pagamento sulla fattura (contanti/carta/bonifico/...) con solo_modalita_fornitore, es. per scremare "quali fatture Limongi erano state pagate in contanti al ritiro". REGOLE: (1) non scrive niente subito — prepara l anteprima e serve la doppia conferma /fic_ok_<id> poi /fic_ok2_<id>; (2) mostra l anteprima COM E, comprese le fatture ESCLUSE col motivo (gia pagate, o con piu voci nel piano pagamenti: quelle non le tocca e non sceglie al posto suo); (3) massimo 50 fatture per conferma; (4) l esito e PER FATTURA e viene da una RILETTURA: se dice che 3 su 5 sono riuscite, riporta quali si e quali no col motivo, e NON dire «fatte tutte»; (5) con solo_modalita_fornitore, se anche una sola fattura della selezione non ha l allegato leggibile il tool NON applica il filtro in silenzio: rifiuta dichiarando quante non sono leggibili, e tu lo riporti cosi.',
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
        solo_modalita_fornitore: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restringe la selezione alle fatture in cui il FORNITORE ha scritto sulla fattura una di queste modalita (es. ["contanti","carta"]). Legge l allegato di ogni fattura della selezione (tetto 30, come fic_modalita_pagamento_fornitore): se anche una sola non e leggibile, il tool RIFIUTA dichiarandolo invece di applicare il filtro senza quella fattura.',
        },
      },
    },
  },
  {
    // Lo specchio del tool qui sopra, per le fatture EMESSE: l'incasso di un
    // bonifico. Nato il 14 set 2026: il bot aveva abbinato la fattura al
    // bonifico e non aveva il verbo per scriverlo.
    name: 'segna_fatture_emesse_pagate',
    description: 'Segna INCASSATA (pagata dal cliente) una fattura EMESSA su Fatture in Cloud, registrando il conto su cui e arrivato il bonifico e la DATA del bonifico: e il verbo con cui si chiude una fattura emessa che risulta ancora scaduta/non saldata quando il pagamento e arrivato in banca (es. un bonifico da un condominio che combacia per importo e data con una fattura aperta). Funziona su UNA fattura (passa id) o su un INSIEME (cliente e/o anno, mese). La modalita di pagamento si sceglie fra i conti che Fatture in Cloud espone (es. "Intesa Sanpaolo"): se non la passi, il tool ti restituisce l elenco vero e tu CHIEDI all Ingegnere quale. La data_pagamento e OBBLIGATORIA ed e la data del bonifico: non c e nessun predefinito, un incasso non si data a caso. REGOLE: (1) non scrive niente subito — prepara l anteprima e serve la doppia conferma /fic_ok_<id> poi /fic_ok2_<id>; (2) mostra l anteprima COM E, comprese le fatture ESCLUSE col motivo (gia incassate, o con piu voci nel piano pagamenti); (3) massimo 50 fatture per conferma; (4) l esito e PER FATTURA e viene da una RILETTURA: riporta quali si e quali no col motivo, e NON dire «fatte tutte». Non emette, non modifica e non trasmette nessuna fattura: scrive solo l incasso.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Id della singola fattura emessa su Fatture in Cloud (quello di fic_fatture_emesse / fic_dettaglio_documento). Alternativo ai filtri cliente/anno/mese.' },
        cliente: { type: 'string', description: 'Nome (anche parziale) del cliente, per selezionare piu fatture. Es. "Vallina".' },
        anno: { type: 'integer', description: 'Anno delle fatture da selezionare.' },
        mese: { type: 'integer', description: 'Mese 1-12, insieme ad anno.' },
        modalita_pagamento: { type: 'string', description: 'Nome o id del conto di pagamento di Fatture in Cloud su cui e arrivato l incasso, es. "Intesa Sanpaolo". Se omesso o non riconosciuto, il tool torna l elenco vero dei conti: chiedi all Ingegnere quale e richiama.' },
        data_pagamento: { type: 'string', description: 'OBBLIGATORIA. Data del bonifico YYYY-MM-DD, presa dall estratto conto o dallo screenshot della banca. Vale per tutte le fatture della selezione.' },
        importo_bonifico: { type: 'number', description: 'Importo del bonifico arrivato, in euro (es. 501.05). PASSALO SEMPRE quando lo conosci: se non combacia al centesimo con la voce da segnare pagata, la fattura viene ESCLUSA e te lo dice — un bonifico parziale non chiude una fattura. Richiede id.' },
        voce: { type: 'integer', description: 'Quale voce del piano pagamenti segnare incassata (1 = la prima), solo quando la fattura ne ha piu di una e l Ingegnere ha detto quale. Richiede id.' },
      },
      required: ['data_pagamento'],
    },
  },
  {
    // Nome al SINGOLARE ma accetta N fatture: come i due tool dei pagamenti,
    // il caso singolo e' il massivo con un elemento. Una conferma sola per N
    // autofatture e' il motivo per cui esiste — «non e che mi metto a
    // confermare quindici fatture vocalmente».
    name: 'compila_autofattura',
    description: 'Compila su Fatture in Cloud le AUTOFATTURE/INTEGRAZIONI in reverse charge per le fatture ESTERE (il caso vero: la fattura mensile delle COMMISSIONI di Booking.com B.V. a LA REAL ESTATE, scadenza fiscale il 16 del mese; identico per le fee di Airbnb Ireland UC). Prepara UN documento per ogni fattura estera, tipo FIC self_supplier_invoice (chi emette compare come CLIENTE, il fornitore estero come fornitore), integrazione ex art. 17 c.2 DPR 633/72 su servizio generico art. 7-ter. I documenti vengono COMPILATI e NON trasmessi allo SdI: li controlla e li invia l Ingegnere. Accetta N fatture in una volta sola e chiede UNA SOLA conferma per tutte (in due passaggi: /fic_ok_<id> poi /fic_ok2_<id>, ma una conferma sola per tutto il gruppo). REGOLE FERREE: (1) 🚨 L IVA NON SI INDOVINA: non scegliere tu l aliquota ne la natura. Se non passi vat_id il tool NON prepara niente e ti restituisce l elenco VERO delle aliquote IVA di quell azienda lette da Fatture in Cloud — con descrizione e natura — e tu CHIEDI all Ingegnere quale usare, poi richiami con vat_id. Non esiste nessun predefinito; (2) 🚨 SI INTEGRA SOLO LA FATTURA COMMISSIONI (fee sui pagamenti gestiti dalla piattaforma compresa). Gli INCASSI girati dalla piattaforma sono soldi degli ospiti riscossi per conto della societa e NON si integrano: se non sei sicuro che l importo sia una commissione, FERMATI E CHIEDI invece di chiamarmi; (3) 🚨 il tool RIFIUTA le fatture anteriori all iscrizione al VIES della societa: quelle riportano IVA italiana e si registrano come normali acquisti con IVA detraibile, non si integrano. Se te lo dice, riportalo e non insistere; (4) il fornitore estero deve essere IN ANAGRAFICA con indirizzo e partita IVA comunitaria: fic_cerca_anagrafica, se non c e fic_crea_cliente, poi passa qui fornitore_id. Senza anagrafica il tool rifiuta; (5) numero, data, data di RICEZIONE e imponibile sono quelli della fattura ORIGINALE e non si inventano: se non li hai, chiedili. La data dell integrazione e la data di RICEZIONE, non oggi; (6) serve una SERIE di numerazione dedicata alle integrazioni, separata dalle fatture attive: se non la passi il tool te la chiede, non la inventa; (7) mostra l anteprima COM E — elenca tutte le autofatture con fornitore, numero, date e imponibile: e l unica cosa che l Ingegnere legge prima di una conferma che vale per tutte; (8) l esito e PER DOCUMENTO e viene da una RILETTURA su Fatture in Cloud: riporta quali si e quali no col motivo, e NON dire «fatte tutte»; (9) il tool imposta il tipo documento SdI TD17 (in ei_raw, non nel campo type), ma NON compila i «dati fattura collegata»: il riferimento alla fattura originale sta nella riga e nelle note, e il campo strutturato va controllato su Fatture in Cloud prima di trasmettere.',
    input_schema: {
      type: 'object',
      properties: {
        fatture: {
          type: 'array',
          description: 'Le fatture estere di COMMISSIONI da integrare, una voce per documento. Una sola voce = una sola autofattura. Mai gli incassi girati dalla piattaforma.',
          items: {
            type: 'object',
            properties: {
              fornitore: { type: 'string', description: 'Denominazione del fornitore estero, es. "Booking.com B.V." o "Airbnb Ireland UC".' },
              fornitore_id: { type: 'number', description: 'Id dell anagrafica su Fatture in Cloud, da fic_cerca_anagrafica o fic_crea_cliente. Senza anagrafica il tool rifiuta: un integrazione deve riportare indirizzo e partita IVA comunitaria del cedente.' },
              numero: { type: 'string', description: 'Numero della fattura ORIGINALE del fornitore estero. Obbligatorio: non si inventa.' },
              data: { type: 'string', description: 'Data di emissione della fattura ORIGINALE, YYYY-MM-DD. Obbligatoria: non si inventa.' },
              data_ricezione: { type: 'string', description: 'Data in cui la fattura estera e stata RICEVUTA, YYYY-MM-DD. Obbligatoria: e la data che va sull integrazione (non oggi, non la data di emissione se diversa).' },
              imponibile: { type: 'number', description: 'Imponibile in euro delle sole COMMISSIONI, fee sui pagamenti gestiti compresa, come numero (es. 300 oppure 18.32). Mai l importo di un incasso girato dalla piattaforma.' },
              descrizione: { type: 'string', description: 'Descrizione della riga. Se omessa viene composta dai dati della fattura originale.' },
            },
            required: ['fornitore', 'numero', 'data', 'data_ricezione', 'imponibile'],
          },
        },
        vat_id: {
          type: 'number',
          description: '🚨 Id dell aliquota IVA di Fatture in Cloud da usare (porta con se anche la natura). NON sceglierlo tu e non tirarlo a indovinare: se non ti e stato detto quale, chiama SENZA questo parametro — il tool ti restituisce l elenco vero delle aliquote dell azienda e tu chiedi all Ingegnere quale. Un id inventato viene rifiutato.',
        },
        numerazione: { type: 'string', description: 'Sigla della serie di numerazione DEDICATA alle integrazioni su Fatture in Cloud, separata dalle fatture attive. Se non ce l hai chiama senza: il tool te la chiede invece di inventarne una.' },
        note: { type: 'string', description: 'Note aggiuntive riportate su ogni autofattura del gruppo. Il riferimento alla fattura originale viene scritto comunque.' },
      },
      required: ['fatture'],
    },
  },
  {
    // ⚠️ Nome al singolare e UNA spesa per chiamata, al contrario dei tool dei
    // pagamenti e delle autofatture. Non e' un'omissione: li' il caso massivo
    // nasceva da un bisogno vero («non e che mi metto a confermare quindici
    // fatture vocalmente»), qui ogni spesa porta con se' il SUO PDF, il SUO
    // numero e il SUO anti-doppione — e un gruppo confermato in blocco
    // vorrebbe dire dire «si» a quindici documenti mai visti uno per uno.
    name: 'registra_spesa_fornitore',
    description:
      "Registra su Fatture in Cloud la FATTURA D ACQUISTO di un fornitore (documento RICEVUTO, la SPESA) prendendo il PDF da una mail di Gmail e allegandoglielo. Il caso vero: la fattura mensile delle COMMISSIONI di Booking.com B.V. a LA REAL ESTATE, quella per cui compila_autofattura crea l integrazione TD17. Le due cose sono le due meta dello stesso adempimento: l autofattura mette l IVA a DEBITO, questa registra il COSTO e la fattura passiva a monte. Senza, l integrazione resta a meta. COSA SERVE: la mail col PDF (casella e message_id, da gmail_search), il fornitore, il numero e la data della sua fattura, e l IMPONIBILE. Nient altro: il PDF non lo leggo e nessun importo lo ricavo da solo. REGOLE FERREE: (1) 🚨 L IVA NON SI INDOVINA: se non passi vat_id il tool NON prepara niente e ti restituisce l elenco VERO delle aliquote di quell azienda lette da Fatture in Cloud (con descrizione e natura) — tu CHIEDI all Ingegnere quale usare e richiami con vat_id. Non esiste nessun predefinito, e l aliquota decide se l IVA e detraibile, in reverse charge o esclusa; (2) 🚨 nemmeno il CONTO di pagamento si indovina: senza modalita_pagamento il tool torna l elenco vero dei conti dell azienda e chiede; (3) la spesa nasce GIA SALDATA alla data del documento, per COMPENSAZIONE (la piattaforma trattiene le commissioni dal bonifico dei soggiorni): non deve finire nello scadenzario, e per questo il piano pagamenti viene scritto esplicitamente; (4) 🚨 ANTI-DOPPIONE: prima di preparare, e di nuovo prima di creare, il tool cerca su Fatture in Cloud se esiste gia una fattura ricevuta di quel fornitore con quel numero. Se c e NON ne crea una seconda: te lo dice e ti da l id di quella esistente. Se l elenco non si legge o e troncato il tool RIFIUTA, perche su un elenco incompleto non si puo dire che il doppione non c e; (5) l allegato: se la mail ha un solo allegato lo usa, se ne ha piu di uno e non passi nome_file si RIFIUTA e li elenca — aprire quello sbagliato vuol dire registrare una spesa vera col documento di un altra; (6) non scrive niente subito: prepara l anteprima e serve la conferma (/fic_ok_<id>, oppure un «confermo» a voce: e una conferma sola). Il PDF viene scaricato e caricato SOLO dopo la conferma, e se non si scarica la spesa NON nasce affatto; (7) l esito viene da una RILETTURA su Fatture in Cloud, non dalla risposta della creazione: se dice DA VERIFICARE il documento potrebbe esserci o no, riporta il messaggio testualmente e NON ritentare.",
    input_schema: {
      type: 'object',
      properties: {
        casella: {
          type: 'string',
          enum: CASELLE_GOOGLE,
          description: 'Da quale casella Google viene la mail con il PDF della fattura. Se non la sai, guarda da dove veniva il risultato di gmail_search.',
        },
        message_id: { type: 'string', description: 'Id della mail che porta il PDF (campo id dei risultati di gmail_search / gmail_list_inbox).' },
        nome_file: { type: 'string', description: 'Nome dell allegato, se la mail ne ha piu di uno. Senza, con piu allegati il tool si rifiuta e te li elenca.' },
        fornitore: { type: 'string', description: 'Denominazione del fornitore, es. "Booking.com B.V.". Obbligatoria.' },
        fornitore_id: { type: 'number', description: 'Id dell anagrafica FORNITORI su Fatture in Cloud (fic_cerca_anagrafica con tipo fornitore). Con l id il documento punta il fornitore giusto senza ambiguita.' },
        numero: { type: 'string', description: 'Numero della fattura DEL FORNITORE, come sta scritto sul documento. Obbligatorio: e la chiave con cui controllo che non sia gia registrata.' },
        data: { type: 'string', description: 'Data della fattura del fornitore, YYYY-MM-DD. Obbligatoria: e anche la data a cui la spesa risulta pagata.' },
        imponibile: { type: 'number', description: 'Imponibile in euro come numero (es. 218.44). Lo dice l Ingegnere: dal PDF non lo ricavo io.' },
        vat_id: {
          type: 'number',
          description: '🚨 Id dell aliquota IVA di Fatture in Cloud (porta con se anche la natura). NON sceglierlo tu e non tirarlo a indovinare: se non ti e stato detto quale, chiama SENZA questo parametro — il tool ti restituisce l elenco vero delle aliquote dell azienda e tu chiedi all Ingegnere quale. Un id inventato viene rifiutato.',
        },
        modalita_pagamento: { type: 'string', description: 'Nome o id del conto di pagamento di Fatture in Cloud su cui la spesa risulta saldata. Se omesso o non riconosciuto, il tool torna l elenco vero dei conti dell azienda: chiedi all Ingegnere quale e richiama.' },
        descrizione: { type: 'string', description: 'Descrizione della riga di spesa. Se omessa viene composta da fornitore, numero e data.' },
      },
      required: ['casella', 'message_id', 'fornitore', 'numero', 'data', 'imponibile'],
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
    if (name === 'compila_autofattura') return compilaAutofatture(input, societa)
    if (name === 'registra_spesa_fornitore') return compilaSpesaFornitore(input, societa)
    if (name === 'segna_fatture_ricevute_pagate') return segnaFatturePagate(input, societa, 'ricevuta')
    if (name === 'segna_fatture_emesse_pagate') return segnaFatturePagate(input, societa, 'emessa')
    if (name === 'conferma_bozza_fic') return confermaBozzaFic(input, societa)
    if (name === 'lista_bozze_fic') return listaBozzeFic(input, societa)
    if (name === 'elimina_bozza_fic') return eliminaBozzaFic(input, societa)
    return null
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}
