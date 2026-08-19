import { supabase } from '@/lib/supabase'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

type ScadenzaStato = 'attivo' | 'sostituito' | 'archiviato'

interface ScadenzaRow {
  id: string
  soggetto: string
  categoria: string | null
  tipo_documento: string | null
  data_scadenza: string
  reminder_days: number
  recipients: string[]
  drive_file_id: string | null
  drive_url: string | null
  note: string | null
  stato: ScadenzaStato
  /**
   * Id dell'evento Google Calendar creato per questa scadenza, `null` per le
   * righe registrate prima del 2026-08-18 (e per quelle il cui evento non e'
   * stato creato). Serve SOLO a cancellare il vecchio evento quando la scadenza
   * viene sostituita: e' un id tecnico e resta fuori da `summarize()`.
   */
  calendar_event_id?: string | null
  updated_at?: string
}

interface ScadenzaWrite {
  soggetto?: string
  categoria?: string | null
  tipo_documento?: string | null
  data_scadenza?: string
  reminder_days?: number
  recipients?: string[]
  drive_file_id?: string | null
  drive_url?: string | null
  note?: string | null
  stato?: ScadenzaStato
  calendar_event_id?: string | null
  updated_at?: string
}

const DEFAULT_STATO: ScadenzaStato = 'attivo'
const VALID_STATI: ScadenzaStato[] = ['attivo', 'sostituito', 'archiviato']
// Postgres rifiuta i NUL byte (\u0000) dentro text/varchar: capitano nel testo
// estratto da OCR/PDF e farebbero fallire l'INSERT a meta operazione.
const NUL_BYTE = /\u0000/g
// reminder_days finisce in una colonna int4: oltre questo range Postgres alza
// "integer out of range" e l'INSERT esplode. 365 giorni = un anno di anticipo,
// piu che sufficiente per DURC/visite/attestati.
const MAX_REMINDER_DAYS = 365
/**
 * Tetto esplicito per `lista_scadenze`. Senza `.limit()` il troncamento lo fa
 * PostgREST al suo row-cap e nessuno se ne accorge: `count` riporterebbe il
 * numero della pagina troncata e il modello lo leggerebbe come "sono tutte".
 * Si chiede LIMITE+1 riga solo per sapere se ce n'erano altre.
 */
const LISTA_SCADENZE_LIMITE = 200

function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload })
}

function fail(error: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, error, ...payload })
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stripNul(value: string): string {
  return value.replace(NUL_BYTE, '')
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = stripNul(value).trim()
  return trimmed ? trimmed : undefined
}

function normalizeSubject(value: string): string {
  return stripNul(value).replace(/\s+/g, ' ').trim()
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = stripNul(value).trim()
  return trimmed ? trimmed : null
}

function parseInteger(value: unknown, field: string): { value?: number; error?: string } {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'string' && !/^-?\d+$/.test(value.trim())) {
    return { error: `${field} deve essere un intero.` }
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed)) return { error: `${field} deve essere un intero.` }
  return { value: parsed }
}

function parseRecipients(value: unknown): { value?: string[]; error?: string } {
  if (value === undefined || value === null || value === '') return {}

  let raw: unknown = value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return {}
    if (trimmed.startsWith('[')) {
      try {
        raw = JSON.parse(trimmed)
      } catch {
        return { error: 'recipients deve essere un array JSON o una lista email separata da virgole.' }
      }
    } else {
      raw = trimmed.split(',')
    }
  }

  if (!Array.isArray(raw)) return { error: 'recipients deve essere un array di email.' }
  const recipients = raw
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean)

  if (recipients.length === 0) return { error: 'recipients non puo essere vuoto.' }
  return { value: recipients }
}

function parseStato(value: unknown): { value?: ScadenzaStato; error?: string } {
  if (value === undefined || value === null || value === '') return {}
  const stato = String(value).trim().toLowerCase()
  if (VALID_STATI.includes(stato as ScadenzaStato)) return { value: stato as ScadenzaStato }
  return { error: `stato deve essere uno tra: ${VALID_STATI.join(', ')}.` }
}

/**
 * Valida una data ISO con round-trip: non basta la forma `\d{4}-\d{2}-\d{2}`,
 * perche `2026-13-07` e `2026-02-31` passerebbero il tool e verrebbero rifiutate
 * da Postgres a meta operazione. Ricostruiamo la data in UTC e verifichiamo che
 * riformattata dia ESATTAMENTE la stringa in input: cosi l'errore e chiaro e
 * arriva prima di qualsiasi scrittura.
 */
function parseDate(value: unknown, field: string): { value?: string; error?: string } {
  const date = cleanString(value)
  if (!date) return {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: `${field} deve essere nel formato YYYY-MM-DD.` }

  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))
  const parsed = new Date(Date.UTC(year, month - 1, day))
  const roundTrip = [
    String(parsed.getUTCFullYear()).padStart(4, '0'),
    String(parsed.getUTCMonth() + 1).padStart(2, '0'),
    String(parsed.getUTCDate()).padStart(2, '0'),
  ].join('-')
  if (Number.isNaN(parsed.getTime()) || roundTrip !== date) {
    return { error: `${field}: la data ${date} non esiste (usa il formato YYYY-MM-DD con mese 01-12 e giorno valido).` }
  }

  return { value: date }
}

function todayISO(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
}

function addDaysISO(days: number): string {
  const now = new Date()
  now.setDate(now.getDate() + days)
  return now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
}

/**
 * Chiave di confronto per capire se due righe sono "la stessa scadenza".
 * Case-insensitive e whitespace-insensitive su TUTTE le componenti della chiave
 * (soggetto, tipo_documento, categoria): `tipo_documento` arriva testuale
 * dall'LLM, quindi "DURC" / "Durc" / "durc" devono valere lo stesso.
 */
export function normalizeKey(value: string | null | undefined): string {
  if (!value) return ''
  return normalizeSubject(value).toLocaleLowerCase('it-IT')
}

/**
 * Escapa i metacaratteri LIKE dentro un TOKEN (non nei `%` che noi aggiungiamo
 * come separatori).
 *
 * SCELTA (2026-08): escapiamo nel pattern invece di ripulire `normalizeSubject`.
 * Strippare il backslash dal soggetto sarebbe stato piu corto ma avrebbe
 * (a) mutato il valore persistito e (b) lasciato comunque fuori le righe GIA in
 * DB che il backslash ce l'hanno davvero (`Ditta A\B Srl`): il pattern ripulito
 * `%Ditta%AB%Srl%` non le matcherebbe. Escapando invece il pattern resta
 * fedele al dato salvato e la riga vecchia viene ritrovata.
 *
 * Perche serve: in LIKE/ILIKE il backslash e l'ESCAPE di default, quindi il
 * soggetto `Ditta A\B Srl` produceva `%Ditta%A\B%Srl%` dove `\B` diventa una
 * `B` letterale e la riga NON matchava piu → under-match, cioe esattamente il
 * bug che la sostituzione deve evitare. `%` e `_` non erano rotti (allargavano
 * il pattern, innocuo) ma escaparli e comunque piu preciso: il filtro resta un
 * sovrainsieme dell'uguaglianza esatta perche i token restano uniti da `%`.
 */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, match => `\\${match}`)
}

/**
 * Pattern ILIKE tollerante agli spazi per filtrare LATO SERVER.
 * E deliberatamente un SOVRAINSIEME (i token sono uniti da `%`): serve solo a
 * non scaricare tutte le righe attive — la selezione esatta la fa comunque
 * `normalizeKey` in JS. Cosi anche oltre il row-cap di PostgREST la riga da
 * sostituire resta dentro la pagina.
 */
export function ilikePattern(value: string): string {
  const tokens = normalizeSubject(value).split(' ').filter(Boolean).map(escapeLike)
  if (tokens.length === 0) return '%'
  return `%${tokens.join('%')}%`
}

function summarize(row: ScadenzaRow): Record<string, unknown> {
  return {
    id: row.id,
    soggetto: row.soggetto,
    categoria: row.categoria,
    tipo_documento: row.tipo_documento,
    data_scadenza: row.data_scadenza,
    reminder_days: row.reminder_days,
    recipients: row.recipients,
    drive_file_id: row.drive_file_id,
    drive_url: row.drive_url,
    note: row.note,
    stato: row.stato,
  }
}

function parseWriteFields(input: Record<string, unknown>, allowStato: boolean): { fields?: ScadenzaWrite; error?: string } {
  const source = { ...asObject(input.campi), ...input }
  delete source.id
  delete source.campi

  const fields: ScadenzaWrite = {}

  const soggetto = cleanString(source.soggetto)
  if (soggetto !== undefined) fields.soggetto = normalizeSubject(soggetto)

  if ('categoria' in source) fields.categoria = nullableString(source.categoria) ?? null
  if ('tipo_documento' in source) fields.tipo_documento = nullableString(source.tipo_documento) ?? null
  if ('drive_file_id' in source) fields.drive_file_id = nullableString(source.drive_file_id) ?? null
  if ('drive_url' in source) fields.drive_url = nullableString(source.drive_url) ?? null
  if ('note' in source) fields.note = nullableString(source.note) ?? null

  if ('data_scadenza' in source) {
    const parsed = parseDate(source.data_scadenza, 'data_scadenza')
    if (parsed.error) return { error: parsed.error }
    if (parsed.value) fields.data_scadenza = parsed.value
  }

  if ('reminder_days' in source) {
    const parsed = parseInteger(source.reminder_days, 'reminder_days')
    if (parsed.error) return { error: parsed.error }
    if (parsed.value !== undefined && (parsed.value < 0 || parsed.value > MAX_REMINDER_DAYS)) {
      return { error: `reminder_days deve essere un intero tra 0 e ${MAX_REMINDER_DAYS} (ricevuto ${parsed.value}).` }
    }
    if (parsed.value !== undefined) fields.reminder_days = parsed.value
  }

  if ('recipients' in source) {
    const parsed = parseRecipients(source.recipients)
    if (parsed.error) return { error: parsed.error }
    if (parsed.value) fields.recipients = parsed.value
  }

  if (allowStato && 'stato' in source) {
    const parsed = parseStato(source.stato)
    if (parsed.error) return { error: parsed.error }
    if (parsed.value) fields.stato = parsed.value
  }

  return { fields }
}

/**
 * Esito STRUTTURATO della registrazione di una scadenza.
 *
 * Esiste perche registra_scadenza non ha piu un solo chiamante: oltre al tool
 * dell'LLM la usa `confirmProposta` (mail-sentinella → proposta → /conferma),
 * che ha bisogno dei campi tipati e non di una stringa JSON da riparsare.
 */
export interface RegistraScadenzaEsito {
  ok: boolean
  error?: string
  id?: string
  sostituite: string[]
  /** Presente solo quando la sostituzione delle precedenti e fallita. */
  avviso?: string
  /** false = l'evento in agenda NON esiste. Vedi `calendarNota` per il motivo. */
  calendarOk: boolean
  calendarNota: string
}

/**
 * Opzioni di registrazione decise dal CHIAMANTE, non dall'input.
 *
 * Sono un secondo parametro e NON campi di `input` di proposito: `input` del
 * path manuale arriva testualmente dal modello, e una leva che disattiva una
 * scrittura distruttiva non deve essere pilotabile da un LLM (ne da un
 * documento che il modello ha appena letto).
 */
export interface RegistraScadenzaOpzioni {
  /**
   * `false` = NON marcare 'sostituito' nessuna riga precedente: la nuova
   * scadenza si aggiunge e basta.
   *
   * Serve a chi registra con una chiave (soggetto + tipo_documento +
   * categoria) che NON identifica un solo documento. La sostituzione e
   * distruttiva e silenziosa — la riga 'sostituito' sparisce da lista_scadenze
   * e dal cron promemoria, che filtrano stato='attivo' — quindi su una chiave
   * ambigua cancellerebbe la scadenza di un ALTRO documento. Due righe attive
   * sono invece un fastidio visibile (due promemoria) e recuperabile con
   * chiudi_scadenza: e la stessa scelta gia fatta con l'ordine INSERT-prima.
   *
   * Default `true`: il path manuale (registra_scadenza) non cambia
   * comportamento.
   */
  sostituisciPrecedenti?: boolean
}

export async function registraScadenzaCore(
  input: Record<string, unknown>,
  opzioni: RegistraScadenzaOpzioni = {},
): Promise<RegistraScadenzaEsito> {
  const sostituisciPrecedenti = opzioni.sostituisciPrecedenti !== false
  const rejected = (error: string): RegistraScadenzaEsito => ({
    ok: false,
    error,
    sostituite: [],
    calendarOk: false,
    calendarNota: 'Calendar non aggiornato: scadenza non registrata.',
  })

  const rawSoggetto = cleanString(input.soggetto)
  if (!rawSoggetto) return rejected('soggetto obbligatorio.')
  const soggetto = normalizeSubject(rawSoggetto)

  const parsedDate = parseDate(input.data_scadenza, 'data_scadenza')
  if (parsedDate.error) return rejected(parsedDate.error)
  if (!parsedDate.value) return rejected('data_scadenza obbligatoria nel formato YYYY-MM-DD.')

  const parsedFields = parseWriteFields(input, false)
  if (parsedFields.error) return rejected(parsedFields.error)

  const insertFields: ScadenzaWrite = {
    ...parsedFields.fields,
    soggetto,
    data_scadenza: parsedDate.value,
    stato: DEFAULT_STATO,
  }

  // ORDINE VOLUTO: prima l'INSERT della nuova scadenza, POI la sostituzione
  // delle vecchie. Se si sostituisse prima e l'INSERT fallisse (data invalida,
  // valore fuori range, vincolo DB), la vecchia sarebbe gia 'sostituito' e la
  // nuova non esisterebbe: la scadenza sparirebbe da lista_scadenze e dal cron
  // promemoria (che filtra stato='attivo') senza che nessuno se ne accorga.
  // Con questo ordine il caso peggiore e una riga DUPLICATA — visibile e
  // recuperabile — invece di ZERO righe.
  const { data, error } = await supabase
    .from('cervellone_scadenze')
    .insert(insertFields)
    .select('id')
    .single()

  if (error) return rejected(`Errore inserimento scadenza: ${error.message}`)
  const created = data as Pick<ScadenzaRow, 'id'> | null

  const sostituzione: SostituzioneResult = created?.id && sostituisciPrecedenti
    ? await marcaSostituite({
        nuovoId: created.id,
        soggetto,
        tipoDocumento: insertFields.tipo_documento ?? null,
        categoria: insertFields.categoria ?? null,
      })
    : { ids: [], eventiDaCancellare: [] }
  const replacedIds = sostituzione.ids

  // 2026-07-22: scrive la scadenza anche su Google Calendar. BEST-EFFORT:
  // la registrazione in DB è già andata a buon fine, quindi un errore Calendar
  // (scope/API/rete) NON deve far fallire la scadenza. Riusa executeCalendarTool.
  //
  // 2026-08-18: al RINNOVO il vecchio evento viene ora TOLTO dall'agenda.
  // L'id dell'evento si estrae dalla risposta della create
  // (`extractCalendarEventId`), si salva sulla riga (`calendar_event_id`) e
  // `marcaSostituite` lo riporta indietro per le righe che passa a
  // 'sostituito'; la cancellazione avviene qui sotto. Prima non accadeva e
  // ogni rinnovo lasciava un evento fantasma coi suoi reminder.
  //
  // ⚠️ LIMITE NOTO: le righe registrate PRIMA del 2026-08-18 hanno
  // `calendar_event_id` null — i loro eventi restano in agenda e vanno
  // ripuliti A MANO. Non e recuperabile dal codice: l'id di quegli eventi non
  // e stato salvato da nessuna parte.
  const calendar = await createCalendarForScadenza({
    soggetto,
    dataScadenza: parsedDate.value,
    tipoDocumento: insertFields.tipo_documento ?? null,
    note: insertFields.note ?? null,
  })

  let calendarNota = calendar.nota

  // L'id dell'evento va scritto sulla riga: al RINNOVO e' l'unico modo per
  // sapere quale evento togliere dall'agenda. Best-effort come tutto il resto
  // del Calendar (la scadenza e' gia in DB, un errore qui non la tocca) ma NON
  // silenzioso: se la colonna manca perche' la migration non e' stata
  // applicata, questo e' l'unico punto in cui si vede — e senza avviso i
  // rinnovi continuerebbero a lasciare eventi fantasma senza spiegazione.
  if (created?.id && calendar.eventId) {
    const { error: eventIdError } = await supabase
      .from('cervellone_scadenze')
      .update({ calendar_event_id: calendar.eventId, updated_at: new Date().toISOString() })
      .eq('id', created.id)

    if (eventIdError) {
      calendarNota = `${calendarNota} — ATTENZIONE: id evento NON salvato (${eventIdError.message}), al prossimo rinnovo il vecchio evento restera in agenda.`
    }
  }

  // Le righe appena passate a 'sostituito' non sono piu scadenze: i loro
  // eventi in agenda vanno tolti, altrimenti i reminder continuano a scattare
  // per qualcosa che non esiste piu.
  //
  // Si cancella ANCHE se la creazione del nuovo evento e fallita: la vecchia
  // riga e gia 'sostituito' in DB, quindi il suo promemoria e comunque
  // SBAGLIATO — e un promemoria sbagliato e peggio di nessun promemoria. Il
  // caso "evento nuovo assente" e gia segnalato da calendar_ok:false.
  const notaCancellazione = await cancellaEventiSostituiti(sostituzione.eventiDaCancellare)
  if (notaCancellazione) calendarNota = `${calendarNota} — ${notaCancellazione}`

  return {
    ok: true,
    id: created?.id,
    sostituite: replacedIds,
    ...(sostituzione.warning ? { avviso: sostituzione.warning } : {}),
    calendarOk: calendar.ok,
    calendarNota,
  }
}

async function registraScadenza(input: Record<string, unknown>): Promise<string> {
  const esito = await registraScadenzaCore(input)
  if (!esito.ok) return fail(esito.error ?? 'Errore registrazione scadenza.')

  // `sostituite: []` da solo e AMBIGUO: vale sia "non c'era nulla da
  // sostituire" (caso normale) sia "la sostituzione e fallita dopo un INSERT
  // riuscito" (restano due righe attive → due mail dal cron). Con l'array vuoto
  // il modello leggeva ok:true e dichiarava la registrazione pulita. Quando c'e
  // un warning emettiamo quindi un campo esplicito `sostituzione: "fallita"`
  // accanto all'`avviso`, cosi i due casi non sono piu confondibili.
  //
  // Stessa logica per il Calendar: la sola nota in prosa dentro `calendar` era
  // ignorabile dal modello ("registrata, te l'ho messa anche in agenda" anche
  // quando l'evento non esisteva). `calendar_ok` e un booleano: non si legge a
  // meta.
  return ok({
    id: esito.id,
    sostituite: esito.sostituite,
    ...(esito.avviso ? { sostituzione: 'fallita', avviso: esito.avviso } : {}),
    calendar_ok: esito.calendarOk,
    calendar: esito.calendarNota,
  })
}

interface SostituzioneResult {
  ids: string[]
  /**
   * Gli id degli eventi Google Calendar delle righe appena marcate
   * 'sostituito' — solo quelle che un evento ce l'hanno davvero (le righe
   * registrate prima del 2026-08-18 hanno `calendar_event_id` null).
   *
   * E un campo a parte e non un rimpiazzo di `ids`: `ids` finisce nell'esito
   * verso l'LLM, questi no.
   */
  eventiDaCancellare: string[]
  warning?: string
}

/**
 * Marca 'sostituito' le scadenze attive precedenti che sono LA STESSA scadenza
 * di quella appena inserita. Chiamata SOLO dopo un INSERT riuscito.
 *
 * Chiave di sostituzione = soggetto + tipo_documento + categoria, tutti
 * normalizzati (lower + spazi collassati):
 *  - senza normalizzare `tipo_documento` "DURC"/"Durc"/"durc" erano tre tipi
 *    diversi → il rinnovo non sostituiva nulla → due righe attive, due mail dal
 *    cron, due eventi in agenda;
 *  - senza `categoria` nella chiave, registrare l'attestato ponteggi di Mario
 *    Rossi marcava 'sostituito' il suo attestato antincendio (l'estrattore li
 *    etichetta entrambi "attestato formazione").
 *
 * Best-effort: un errore qui NON invalida l'INSERT gia riuscito, viene
 * riportato come `avviso` (peggior caso: una riga duplicata, visibile).
 *
 * NON viene chiamata quando il chiamante dichiara la chiave inaffidabile
 * (`sostituisciPrecedenti: false`): con una chiave che non identifica un solo
 * documento questa funzione cancellerebbe la scadenza di un altro documento.
 */
async function marcaSostituite(opts: {
  nuovoId: string
  soggetto: string
  tipoDocumento: string | null
  categoria: string | null
}): Promise<SostituzioneResult> {
  let existingQuery = supabase
    .from('cervellone_scadenze')
    // `calendar_event_id` viaggia QUI e non in una query dedicata: queste sono
    // gia le righe che stiamo per marcare 'sostituito', quindi i loro eventi da
    // togliere dall'agenda arrivano senza un round-trip in piu.
    .select('id, soggetto, tipo_documento, categoria, calendar_event_id')
    .eq('stato', 'attivo')
    .neq('id', opts.nuovoId)
    // Filtro lato server anche sul soggetto: prima si scaricavano TUTTE le
    // righe attive con quel tipo_documento e si filtrava in JS, quindi oltre il
    // row-cap di PostgREST la riga da sostituire poteva restare fuori pagina.
    .ilike('soggetto', ilikePattern(opts.soggetto))

  existingQuery = opts.tipoDocumento === null
    ? existingQuery.is('tipo_documento', null)
    : existingQuery.ilike('tipo_documento', ilikePattern(opts.tipoDocumento))

  const { data: existingData, error: existingError } = await existingQuery
  if (existingError) {
    return { ids: [], eventiDaCancellare: [], warning: `Scadenza registrata, ma la ricerca delle precedenti e fallita (${existingError.message}): controlla eventuali duplicati con lista_scadenze.` }
  }

  const existingRows = (existingData ?? []) as Pick<ScadenzaRow, 'id' | 'soggetto' | 'tipo_documento' | 'categoria' | 'calendar_event_id'>[]
  const soggettoKey = normalizeKey(opts.soggetto)
  const tipoKey = normalizeKey(opts.tipoDocumento)
  const categoriaKey = normalizeKey(opts.categoria)

  // ATTENZIONE: il filtro di identita VERO e questo, in JS. L'ILIKE lato server
  // e deliberatamente un SOVRAINSIEME, quindi gli eventi da cancellare sono
  // quelli delle righe che superano QUESTO filtro — prenderli dalla query
  // grezza significherebbe togliere dall'agenda l'evento di un'altra scadenza.
  const replacedRows = existingRows.filter(row =>
    row.id !== opts.nuovoId &&
    normalizeKey(row.soggetto) === soggettoKey &&
    normalizeKey(row.tipo_documento) === tipoKey &&
    normalizeKey(row.categoria) === categoriaKey,
  )
  const replacedIds = replacedRows.map(row => row.id)

  if (replacedIds.length === 0) return { ids: [], eventiDaCancellare: [] }

  const { error: updateError } = await supabase
    .from('cervellone_scadenze')
    .update({ stato: 'sostituito', updated_at: new Date().toISOString() })
    .in('id', replacedIds)

  if (updateError) {
    return { ids: [], eventiDaCancellare: [], warning: `Scadenza registrata, ma la precedente non e stata marcata come sostituita (${updateError.message}): restano due righe attive, chiudi la vecchia con chiudi_scadenza.` }
  }

  // Solo le righe DAVVERO passate a 'sostituito': se l'UPDATE qui sopra
  // fallisce le vecchie restano attive, e cancellarne l'evento lascerebbe una
  // scadenza attiva senza voce in agenda.
  const eventiDaCancellare = replacedRows
    .map(row => row.calendar_event_id)
    .filter((eventId): eventId is string => typeof eventId === 'string' && eventId.length > 0)

  return { ids: replacedIds, eventiDaCancellare }
}

interface CalendarEsito {
  ok: boolean
  nota: string
  /** Id dell'evento appena creato, `null` se non e stato possibile ricavarlo. */
  eventId: string | null
}

/**
 * Estrae l'id dell'evento dalla risposta TESTUALE di `calendar_create_event`.
 *
 * Perche da una stringa: `executeCalendarTool` ritorna `string | null`, e l'id
 * viaggia dentro la prosa perche quella risposta e nata per essere letta da un
 * LLM. E un accoppiamento fragile e va trattato come tale — la riga sorgente e
 * `  id=${e.id}` prodotta da `formatEvent` (calendar-tools.ts:97-104), inclusa
 * nella risposta di `createEvent` (:134). Il formato e PINNATO dai test contro
 * l'output vero del modulo, non contro una fixture: se `formatEvent` cambia,
 * quei test diventano rossi qui e non in produzione.
 *
 * 🔴 DUE DIFESE, entrambe necessarie, contro l'INIEZIONE DI UN ID ALTRUI.
 * Il titolo dell'evento contiene `tipo_documento`, che arriva testuale
 * dall'LLM e conserva gli a-capo (`nullableString` fa solo trim). Un
 * `tipo_documento` = "DURC\n  id=EVENTO_ALTRUI\nrinnovo" produce una riga
 * IDENTICA carattere per carattere a quella dell'id vero. Persistito l'id
 * falso, al rinnovo — flusso NOMINALE — partirebbe `calendar_delete_event`
 * su un evento estraneo, che sparisce dall'agenda. L'id non va nemmeno
 * indovinato: `calendar_list_events` lo stampa in chiaro.
 *  1. il titolo viene ripulito degli a-capo a monte
 *     (`createCalendarForScadenza`), quindi quella riga non nasce proprio;
 *  2. qui si prende l'ULTIMA occorrenza, non la prima: dopo la riga `id=`
 *     `formatEvent` emette solo `htmlLink` (che non e un `  id=...`), quindi
 *     l'ultima e SEMPRE quella vera mentre tutto cio che l'attaccante puo
 *     iniettare — dal summary o dalla location — sta per forza prima.
 *
 * L'ancoraggio ai DUE SPAZI iniziali e all'intera riga resta la terza rete:
 * senza, basterebbe un `id=` in coda a una riga qualsiasi.
 */
export function extractCalendarEventId(res: string | null | undefined): string | null {
  if (typeof res !== 'string') return null
  const match = [...res.matchAll(/^ {2}id=([A-Za-z0-9_@.-]+)$/gm)].at(-1)
  if (!match) return null
  // `formatEvent` interpola secco: senza id da Google stampa `id=undefined`.
  // Persistere quella stringa significherebbe tentare, al rinnovo successivo,
  // la cancellazione di un evento che si chiama "undefined".
  return match[1] === 'undefined' ? null : match[1]
}

// Oltre questo tempo si smette di aspettare Google. NON e un limite di cortesia:
// la chiamata era `await`-ata senza timeout, quindi con Google appeso la
// richiesta restava viva fino al kill di Vercel (maxDuration 800). La scadenza
// era gia in DB, ma l'utente vedeva il turno morire e ri-registrava → duplicato.
const CALENDAR_TIMEOUT_MS = 10_000

const CALENDAR_TIMEOUT = Symbol('calendar-timeout')

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof CALENDAR_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof CALENDAR_TIMEOUT>(resolve => {
    timer = setTimeout(() => resolve(CALENDAR_TIMEOUT), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Crea un evento all-day sul Google Calendar per una scadenza. Best-effort:
 * ritorna `{ ok, nota }` (mai lancia) — il chiamante l'ha già persistita in DB.
 *
 * `ok` e un BOOLEANO e non una nota in prosa perche il modello la prosa la
 * ignorava: con lo scope calendar scaduto ogni registrazione tornava ok:true
 * con "Calendar non aggiornato: ..." dentro un campo testuale, e il bot
 * rispondeva comunque "te l'ho messa anche in agenda".
 *
 * NIENTE `reminder_days_before` (decisione 2026-08): il promemoria lo manda il
 * cron `/api/cron/scadenze`, unica sorgente. Gli override email+popup
 * dell'evento erano un secondo allarme non voluto — per giunta clampato a 28
 * giorni da Calendar (reminder_days 60 → due allarmi a un mese di distanza) e
 * recapitato a restruktura.drive@gmail.com, casella che nessuno legge.
 * L'evento qui e solo la voce VISIVA in agenda.
 */
async function createCalendarForScadenza(opts: {
  soggetto: string
  dataScadenza: string
  tipoDocumento: string | null
  note: string | null
}): Promise<CalendarEsito> {
  try {
    const { executeCalendarTool } = await import('./calendar-tools')
    const title = opts.tipoDocumento
      ? `Scadenza ${opts.tipoDocumento}: ${opts.soggetto}`
      : `Scadenza: ${opts.soggetto}`
    const descParts = ['Scadenza registrata in Cervellone.']
    if (opts.tipoDocumento) descParts.push(`Tipo: ${opts.tipoDocumento}.`)
    if (opts.note) descParts.push(`Note: ${opts.note}`)
    const res = await withTimeout(
      Promise.resolve(executeCalendarTool('calendar_create_event', {
        // 🔴 Gli spazi bianchi si COLLASSANO: `tipo_documento` arriva testuale
        // dall'LLM e `nullableString` fa solo trim, quindi gli a-capo interni
        // sopravvivono fino a qui. Un titolo multi-riga e gia un bug a se (in
        // agenda si legge un evento con dentro tre righe), ma soprattutto una
        // riga "  id=<altrui>" iniettata li dentro e indistinguibile da quella
        // che `formatEvent` stampa per l'id VERO — vedi `extractCalendarEventId`.
        summary: title.replace(/\s+/g, ' '),
        start_date: opts.dataScadenza,
        description: descParts.join(' '),
      })),
      CALENDAR_TIMEOUT_MS,
    )
    if (res === CALENDAR_TIMEOUT) {
      return {
        ok: false,
        eventId: null,
        nota: `Calendar non aggiornato: timeout dopo ${CALENDAR_TIMEOUT_MS / 1000}s, Google non ha risposto. La scadenza e registrata, l'evento in agenda NO.`,
      }
    }
    if (typeof res === 'string' && res.startsWith('✅')) {
      return { ok: true, eventId: extractCalendarEventId(res), nota: 'evento creato su Google Calendar' }
    }
    return { ok: false, eventId: null, nota: `Calendar non aggiornato: ${(res ?? 'nessuna risposta').slice(0, 200)}` }
  } catch (e) {
    return { ok: false, eventId: null, nota: `Calendar non aggiornato: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * Riconosce una cancellazione FALLITA, non una riuscita.
 *
 * 🔴 `deleteEvent` risponde `🗑 Evento <id> eliminato dal calendario.`
 * (calendar-tools.ts:197) — NON `✅`, che e l'emoji della sola create. Riusare
 * il check `startsWith('✅')` di `createCalendarForScadenza` darebbe per fallita
 * OGNI cancellazione riuscita, e l'Ingegnere leggerebbe un avviso allarmante a
 * ogni singolo rinnovo. Si guarda quindi il FALLIMENTO, che ha una forma
 * stabile: `❌ Errore Calendar: ...` dal catch di `executeCalendarTool`,
 * `⚠️ Manca event_id.` dalla validazione, oppure nessuna risposta.
 */
function deleteCalendarFallita(res: string | null | undefined): boolean {
  if (typeof res !== 'string' || res.trim() === '') return true
  return res.startsWith('❌') || res.startsWith('⚠️')
}

/**
 * Toglie dall'agenda gli eventi delle scadenze appena marcate 'sostituito'.
 * Ritorna una nota se qualcosa non e stato rimosso, `null` se e filato tutto.
 *
 * Best-effort come il resto del Calendar: la scadenza e gia in DB e un errore
 * qui non la tocca. Ma il fallimento NON e silenzioso — un evento fantasma
 * continua a far scattare i suoi reminder per una scadenza che non esiste piu,
 * e chi lo riceve deve sapere perche'.
 */
async function cancellaEventiSostituiti(eventIds: string[]): Promise<string | null> {
  if (eventIds.length === 0) return null

  const falliti: string[] = []
  try {
    const { executeCalendarTool } = await import('./calendar-tools')
    for (const eventId of eventIds) {
      try {
        const res = await withTimeout(
          Promise.resolve(executeCalendarTool('calendar_delete_event', { event_id: eventId })),
          CALENDAR_TIMEOUT_MS,
        )
        if (res === CALENDAR_TIMEOUT || deleteCalendarFallita(res)) falliti.push(eventId)
      } catch {
        falliti.push(eventId)
      }
    }
  } catch (e) {
    return `il vecchio evento NON e stato rimosso dall'agenda (${e instanceof Error ? e.message : String(e)}): cancellalo a mano, altrimenti arrivera un promemoria per una scadenza gia sostituita.`
  }

  if (falliti.length === 0) return null
  return `ATTENZIONE: il vecchio evento NON e stato rimosso dall'agenda (${falliti.join(', ')}): cancellalo a mano, altrimenti arrivera un promemoria per una scadenza gia sostituita.`
}

async function listaScadenze(input: Record<string, unknown>): Promise<string> {
  const statoParsed = parseStato(input.stato ?? DEFAULT_STATO)
  if (statoParsed.error) return fail(statoParsed.error)

  let query = supabase
    .from('cervellone_scadenze')
    .select('id, soggetto, categoria, tipo_documento, data_scadenza, reminder_days, recipients, drive_file_id, drive_url, note, stato, updated_at')
    .eq('stato', statoParsed.value ?? DEFAULT_STATO)
    .order('data_scadenza', { ascending: true })
    .limit(LISTA_SCADENZE_LIMITE + 1)

  const rawSoggetto = cleanString(input.soggetto)
  const soggetto = rawSoggetto ? normalizeSubject(rawSoggetto) : undefined
  // Stesso escape della sostituzione: senza `ilikePattern` il soggetto
  // `Ditta A\B Srl` produceva `%Ditta A\B Srl%`, dove `\B` e un escape LIKE che
  // diventa una `B` letterale → la riga esiste ma non viene trovata.
  if (soggetto) query = query.ilike('soggetto', ilikePattern(soggetto))

  // Filtro categoria case- e whitespace-insensitive. Stessa dottrina di
  // `marcaSostituite`: ILIKE lato server come SOVRAINSIEME (per non scaricare
  // tutte le righe attive) + selezione esatta in JS con `normalizeKey`, perche
  // `%ponteggi%` da solo prenderebbe anche "sub-ponteggi".
  // NB: il path di scrittura non normalizza il case, quindi in DB convivono
  // 'personale' e 'Personale': il filtro deve tollerarli entrambi.
  const categoria = cleanString(input.categoria)
  if (categoria) query = query.ilike('categoria', ilikePattern(categoria))

  const entroGiorni = parseInteger(input.entro_giorni, 'entro_giorni')
  if (entroGiorni.error) return fail(entroGiorni.error)
  if (entroGiorni.value !== undefined && entroGiorni.value < 0) return fail('entro_giorni deve essere >= 0.')
  if (entroGiorni.value !== undefined) query = query.lte('data_scadenza', addDaysISO(entroGiorni.value))

  const { data, error } = await query
  if (error) return fail(`Errore lista scadenze: ${error.message}`)

  const allRows = (data ?? []) as ScadenzaRow[]
  const categoriaKey = categoria ? normalizeKey(categoria) : null
  const rows = categoriaKey === null
    ? allRows
    : allRows.filter(row => normalizeKey(row.categoria) === categoriaKey)

  // `troncato` si misura sulla pagina SERVER (`allRows`), non sulle righe
  // rimaste dopo il filtro categoria in JS: se il server ha tagliato, le altre
  // righe della categoria cercata non sono mai arrivate: dichiarare
  // `troncato:false` solo perche il filtro ha assottigliato la pagina
  // rimetterebbe in piedi la bugia che questo campo esiste per togliere.
  const troncato = allRows.length > LISTA_SCADENZE_LIMITE
  const visibili = rows.length > LISTA_SCADENZE_LIMITE ? rows.slice(0, LISTA_SCADENZE_LIMITE) : rows

  return ok({
    today: todayISO(),
    count: visibili.length,
    troncato,
    limite: LISTA_SCADENZE_LIMITE,
    scadenze: visibili.map(summarize),
  })
}

/**
 * Cerca ALTRE righe attive che, dopo un aggiornamento, avrebbero la stessa
 * chiave di identita della riga appena modificata.
 *
 * NON marca nulla: si limita a riportare gli id. E deliberato. `marcaSostituite`
 * fa sparire righe da lista_scadenze e dal cron: applicarla a un UPDATE
 * significherebbe che correggere un refuso nel soggetto puo cancellare in
 * silenzio la scadenza di qualcun altro. Vale qui la stessa regola dell'INSERT
 * (vedi il commento sull'ORDINE VOLUTO): una riga duplicata e un fastidio
 * visibile e recuperabile con chiudi_scadenza, zero righe no.
 */
async function trovaCollisioniChiave(opts: {
  id: string
  soggetto: string
  tipoDocumento: string | null
  categoria: string | null
}): Promise<string[]> {
  let query = supabase
    .from('cervellone_scadenze')
    .select('id, soggetto, tipo_documento, categoria')
    .eq('stato', 'attivo')
    .neq('id', opts.id)
    .ilike('soggetto', ilikePattern(opts.soggetto))

  query = opts.tipoDocumento === null
    ? query.is('tipo_documento', null)
    : query.ilike('tipo_documento', ilikePattern(opts.tipoDocumento))

  const { data, error } = await query
  if (error) return []

  const soggettoKey = normalizeKey(opts.soggetto)
  const tipoKey = normalizeKey(opts.tipoDocumento)
  const categoriaKey = normalizeKey(opts.categoria)

  return ((data ?? []) as Pick<ScadenzaRow, 'id' | 'soggetto' | 'tipo_documento' | 'categoria'>[])
    .filter(row =>
      row.id !== opts.id &&
      normalizeKey(row.soggetto) === soggettoKey &&
      normalizeKey(row.tipo_documento) === tipoKey &&
      normalizeKey(row.categoria) === categoriaKey,
    )
    .map(row => row.id)
}

async function aggiornaScadenza(input: Record<string, unknown>): Promise<string> {
  const id = cleanString(input.id)
  if (!id) return fail('id obbligatorio.')

  const parsedFields = parseWriteFields(input, true)
  if (parsedFields.error) return fail(parsedFields.error)

  const fields = parsedFields.fields ?? {}
  if (Object.keys(fields).length === 0) return fail('Nessun campo da aggiornare.')
  fields.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('cervellone_scadenze')
    .update(fields)
    .eq('id', id)
    .select('id, soggetto, categoria, tipo_documento, data_scadenza, reminder_days, recipients, drive_file_id, drive_url, note, stato, updated_at')
    .maybeSingle()

  if (error) return fail(`Errore aggiornamento scadenza: ${error.message}`, { id })
  if (!data) return fail('Scadenza non trovata.', { id })

  const aggiornata = data as ScadenzaRow

  // La chiave di identita e soggetto+tipo_documento+categoria: se l'update ne
  // ha toccata anche solo una, la riga puo essere finita addosso a un'altra
  // scadenza attiva. Si controlla SOLO in quel caso: aggiornare data o note
  // non deve costare una query in piu.
  const chiaveToccata = 'soggetto' in fields || 'tipo_documento' in fields || 'categoria' in fields
  const collisione = chiaveToccata
    ? await trovaCollisioniChiave({
        id: aggiornata.id,
        soggetto: aggiornata.soggetto,
        tipoDocumento: aggiornata.tipo_documento ?? null,
        categoria: aggiornata.categoria ?? null,
      })
    : []

  if (collisione.length > 0) {
    return ok({
      scadenza: summarize(aggiornata),
      collisione,
      avviso: `Attenzione: ora ci sono ${collisione.length + 1} scadenze attive con la stessa chiave (stesso soggetto, tipo documento e categoria). Il cron mandera un promemoria per ciascuna. Chiudi quella di troppo con chiudi_scadenza.`,
    })
  }

  return ok({ scadenza: summarize(aggiornata) })
}

async function chiudiScadenza(input: Record<string, unknown>): Promise<string> {
  const id = cleanString(input.id)
  if (!id) return fail('id obbligatorio.')

  const { data, error } = await supabase
    .from('cervellone_scadenze')
    .update({ stato: 'archiviato', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('stato', 'attivo')
    .select('id, soggetto, categoria, tipo_documento, data_scadenza, reminder_days, recipients, drive_file_id, drive_url, note, stato, updated_at')
    .maybeSingle()

  if (error) return fail(`Errore chiusura scadenza: ${error.message}`, { id })
  if (!data) {
    const { data: existing, error: existingError } = await supabase
      .from('cervellone_scadenze')
      .select('id, stato')
      .eq('id', id)
      .maybeSingle()
    if (existingError) return fail(`Errore verifica scadenza: ${existingError.message}`, { id })
    if (existing) return fail('Scadenza gia chiusa.', { id, stato: existing.stato })
    return fail('Scadenza non trovata.', { id })
  }

  return ok({ scadenza: summarize(data as ScadenzaRow) })
}

export async function executeScadenzeTool(name: string, input: Record<string, unknown>): Promise<string | null> {
  switch (name) {
    case 'registra_scadenza':
      return registraScadenza(input)
    case 'lista_scadenze':
      return listaScadenze(input)
    case 'aggiorna_scadenza':
      return aggiornaScadenza(input)
    case 'chiudi_scadenza':
      return chiudiScadenza(input)
    default:
      return null
  }
}

export const SCADENZE_TOOLS: ToolDefinition[] = [
  {
    name: 'registra_scadenza',
    description: 'Registra una scadenza documentale/operativa in cervellone_scadenze. CHIAVE DI IDENTITA della scadenza = soggetto + tipo_documento + categoria (confronto senza distinzione di maiuscole ne di spazi): se esiste gia una scadenza attiva con la stessa chiave, viene marcata come sostituita DOPO aver creato la nuova. Quindi: al RINNOVO dello stesso documento ripeti la chiave IDENTICA (stessa categoria di prima), altrimenti restano due righe attive e arrivano due promemoria; per due documenti DIVERSI dello stesso tipo e dello stesso soggetto (es. tre attestati di formazione di Mario Rossi) usa categorie DIVERSE (es. antincendio / primo soccorso / ponteggi), altrimenti il piu recente cancella il precedente. Crea AUTOMATICAMENTE anche l\'evento sul Google Calendar di restruktura.drive: NON chiamare calendar_create_event per una scadenza, faresti un doppione. Il promemoria lo manda il cron (mail ai destinatari), l\'evento e solo la voce in agenda. ESITO — REGOLA FERREA: se la risposta contiene il campo "avviso" (e "sostituzione":"fallita") la registrazione NON e pulita, restano due righe attive: riporta l\'avviso TESTUALMENTE all\'Ingegnere e proponi di chiudere la vecchia con chiudi_scadenza. E se "calendar_ok" e false l\'evento in agenda NON esiste: dillo esplicitamente citando il campo "calendar" (che spiega il motivo) e NON dire che hai messo la scadenza in agenda. Non dire mai solo "scadenza registrata" quando c\'e un avviso o calendar_ok false.',
    input_schema: {
      type: 'object' as const,
      properties: {
        soggetto: { type: 'string', description: 'Persona, azienda, mezzo o cantiere a cui si riferisce la scadenza.' },
        categoria: { type: 'string', description: 'Fa parte della CHIAVE DI IDENTITA della scadenza (insieme a soggetto e tipo_documento). Va ripetuta IDENTICA a ogni rinnovo dello stesso documento — se cambia (o se la ometti) il rinnovo non sostituisce il vecchio e restano due righe attive. Serve a distinguere documenti diversi dello stesso tipo dello stesso soggetto: es. "antincendio" vs "ponteggi" per due attestati di formazione di Mario Rossi, "polizza RCA" vs "polizza kasko" per lo stesso mezzo. Se il documento e unico per quel soggetto va bene una macro-area (personale, automezzi, cantiere, azienda), purche sempre la stessa.' },
        tipo_documento: { type: 'string', description: 'Tipo documento, es. DURC, patente, revisione, assicurazione. Fa parte della CHIAVE DI IDENTITA: ripetilo identico a ogni rinnovo dello stesso documento.' },
        data_scadenza: { type: 'string', description: 'Data in formato YYYY-MM-DD. Deve essere una data reale (mese 01-12, giorno esistente).' },
        reminder_days: { type: 'number', description: 'Giorni prima della scadenza in cui inviare il promemoria, intero tra 0 e 365. Default DB: 5.' },
        recipients: { type: 'array', items: { type: 'string' }, description: 'Email destinatari promemoria. Default DB: info@restruktura.it e raffaele.lentini@restruktura.it.' },
        drive_file_id: { type: 'string', description: 'ID file Drive collegato, opzionale.' },
        drive_url: { type: 'string', description: 'URL file Drive collegato, opzionale.' },
        note: { type: 'string', description: 'Note opzionali.' },
      },
      required: ['soggetto', 'data_scadenza'],
    },
  },
  {
    name: 'lista_scadenze',
    description: 'Lista le scadenze con filtri opzionali. Default: solo stato attivo, ordinate per data_scadenza crescente. Se `troncato` e true la lista NON e completa (fermata a `limite` righe): restringi con soggetto/categoria/entro_giorni invece di rispondere come se fossero tutte.',
    input_schema: {
      type: 'object' as const,
      properties: {
        soggetto: { type: 'string', description: 'Filtro case-insensitive sul soggetto.' },
        categoria: { type: 'string', description: 'Filtro categoria, case-insensitive.' },
        stato: { type: 'string', enum: VALID_STATI, description: 'Default attivo.' },
        entro_giorni: { type: 'number', description: 'Mostra scadenze con data_scadenza <= oggi + N giorni.' },
      },
      required: [],
    },
  },
  {
    name: 'aggiorna_scadenza',
    description: 'Aggiorna una scadenza per id. Accetta i campi modificabili top-level oppure dentro campi. Applica le stesse validazioni di registra_scadenza: data_scadenza deve essere una data REALE in formato YYYY-MM-DD e reminder_days un intero tra 0 e 365, altrimenti l\'aggiornamento viene rifiutato senza scrivere nulla. NB: soggetto/tipo_documento/categoria sono la chiave di identita della scadenza — cambiarli qui la scollega dai rinnovi futuri. Se dopo l\'aggiornamento torna `collisione`, ci sono piu scadenze attive identiche: riportalo all\'utente e proponi chiudi_scadenza su quella di troppo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'UUID della scadenza.' },
        soggetto: { type: 'string' },
        categoria: { type: 'string', description: 'Parte della chiave di identita (vedi registra_scadenza).' },
        tipo_documento: { type: 'string', description: 'Parte della chiave di identita (vedi registra_scadenza).' },
        data_scadenza: { type: 'string', description: 'Data in formato YYYY-MM-DD. Deve essere una data reale (mese 01-12, giorno esistente).' },
        reminder_days: { type: 'number', description: 'Giorni prima della scadenza in cui inviare il promemoria, intero tra 0 e 365.' },
        recipients: { type: 'array', items: { type: 'string' } },
        drive_file_id: { type: 'string' },
        drive_url: { type: 'string' },
        note: { type: 'string' },
        stato: { type: 'string', enum: VALID_STATI },
        campi: { type: 'object', description: 'Oggetto opzionale con gli stessi campi aggiornabili.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'chiudi_scadenza',
    description: 'Archivia una scadenza impostando stato=archiviato.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'UUID della scadenza da chiudere.' },
      },
      required: ['id'],
    },
  },
]
