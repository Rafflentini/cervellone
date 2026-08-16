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
function normalizeKey(value: string | null | undefined): string {
  if (!value) return ''
  return normalizeSubject(value).toLocaleLowerCase('it-IT')
}

/**
 * Pattern ILIKE tollerante agli spazi per filtrare LATO SERVER.
 * E deliberatamente un SOVRAINSIEME (i token sono uniti da `%`): serve solo a
 * non scaricare tutte le righe attive — la selezione esatta la fa comunque
 * `normalizeKey` in JS. Cosi anche oltre il row-cap di PostgREST la riga da
 * sostituire resta dentro la pagina.
 */
function ilikePattern(value: string): string {
  const tokens = normalizeSubject(value).split(' ').filter(Boolean)
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

async function registraScadenza(input: Record<string, unknown>): Promise<string> {
  const rawSoggetto = cleanString(input.soggetto)
  if (!rawSoggetto) return fail('soggetto obbligatorio.')
  const soggetto = normalizeSubject(rawSoggetto)

  const parsedDate = parseDate(input.data_scadenza, 'data_scadenza')
  if (parsedDate.error) return fail(parsedDate.error)
  if (!parsedDate.value) return fail('data_scadenza obbligatoria nel formato YYYY-MM-DD.')

  const parsedFields = parseWriteFields(input, false)
  if (parsedFields.error) return fail(parsedFields.error)

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
    .select('id, reminder_days')
    .single()

  if (error) return fail(`Errore inserimento scadenza: ${error.message}`)
  const created = data as Pick<ScadenzaRow, 'id' | 'reminder_days'> | null

  const sostituzione: SostituzioneResult = created?.id
    ? await marcaSostituite({
        nuovoId: created.id,
        soggetto,
        tipoDocumento: insertFields.tipo_documento ?? null,
        categoria: insertFields.categoria ?? null,
      })
    : { ids: [] }
  const replacedIds = sostituzione.ids

  // 2026-07-22: scrive la scadenza anche su Google Calendar. BEST-EFFORT:
  // la registrazione in DB è già andata a buon fine, quindi un errore Calendar
  // (scope/API/rete) NON deve far fallire la scadenza. Riusa executeCalendarTool.
  // NB: se la stessa scadenza viene ri-registrata (path sostituzione), viene
  // creato un nuovo evento; il vecchio evento NON viene rimosso (nessuna colonna
  // calendar_event_id → niente dedup). Follow-up se diventa fastidioso.
  const calendar = await createCalendarForScadenza({
    soggetto,
    dataScadenza: parsedDate.value,
    tipoDocumento: insertFields.tipo_documento ?? null,
    note: insertFields.note ?? null,
    reminderDays: created?.reminder_days ?? insertFields.reminder_days,
  })

  return ok({
    id: created?.id,
    sostituite: replacedIds,
    calendar,
    ...(sostituzione.warning ? { avviso: sostituzione.warning } : {}),
  })
}

interface SostituzioneResult {
  ids: string[]
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
 */
async function marcaSostituite(opts: {
  nuovoId: string
  soggetto: string
  tipoDocumento: string | null
  categoria: string | null
}): Promise<SostituzioneResult> {
  let existingQuery = supabase
    .from('cervellone_scadenze')
    .select('id, soggetto, tipo_documento, categoria')
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
    return { ids: [], warning: `Scadenza registrata, ma la ricerca delle precedenti e fallita (${existingError.message}): controlla eventuali duplicati con lista_scadenze.` }
  }

  const existingRows = (existingData ?? []) as Pick<ScadenzaRow, 'id' | 'soggetto' | 'tipo_documento' | 'categoria'>[]
  const soggettoKey = normalizeKey(opts.soggetto)
  const tipoKey = normalizeKey(opts.tipoDocumento)
  const categoriaKey = normalizeKey(opts.categoria)

  const replacedIds = existingRows
    .filter(row =>
      row.id !== opts.nuovoId &&
      normalizeKey(row.soggetto) === soggettoKey &&
      normalizeKey(row.tipo_documento) === tipoKey &&
      normalizeKey(row.categoria) === categoriaKey,
    )
    .map(row => row.id)

  if (replacedIds.length === 0) return { ids: [] }

  const { error: updateError } = await supabase
    .from('cervellone_scadenze')
    .update({ stato: 'sostituito', updated_at: new Date().toISOString() })
    .in('id', replacedIds)

  if (updateError) {
    return { ids: [], warning: `Scadenza registrata, ma la precedente non e stata marcata come sostituita (${updateError.message}): restano due righe attive, chiudi la vecchia con chiudi_scadenza.` }
  }

  return { ids: replacedIds }
}

/**
 * Crea un evento all-day sul Google Calendar per una scadenza. Best-effort:
 * ritorna una stringa-nota (successo o motivo del mancato inserimento), mai
 * lancia — il chiamante l'ha già persistita in DB.
 */
async function createCalendarForScadenza(opts: {
  soggetto: string
  dataScadenza: string
  tipoDocumento: string | null
  note: string | null
  reminderDays: number | undefined
}): Promise<string> {
  try {
    const { executeCalendarTool } = await import('./calendar-tools')
    const title = opts.tipoDocumento
      ? `Scadenza ${opts.tipoDocumento}: ${opts.soggetto}`
      : `Scadenza: ${opts.soggetto}`
    const descParts = ['Scadenza registrata in Cervellone.']
    if (opts.tipoDocumento) descParts.push(`Tipo: ${opts.tipoDocumento}.`)
    if (opts.note) descParts.push(`Note: ${opts.note}`)
    const res = await executeCalendarTool('calendar_create_event', {
      summary: title,
      start_date: opts.dataScadenza,
      reminder_days_before: String(opts.reminderDays ?? 5),
      description: descParts.join(' '),
    })
    if (typeof res === 'string' && res.startsWith('✅')) {
      return 'evento creato su Google Calendar'
    }
    return `Calendar non aggiornato: ${(res ?? 'nessuna risposta').slice(0, 200)}`
  } catch (e) {
    return `Calendar non aggiornato: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function listaScadenze(input: Record<string, unknown>): Promise<string> {
  const statoParsed = parseStato(input.stato ?? DEFAULT_STATO)
  if (statoParsed.error) return fail(statoParsed.error)

  let query = supabase
    .from('cervellone_scadenze')
    .select('id, soggetto, categoria, tipo_documento, data_scadenza, reminder_days, recipients, drive_file_id, drive_url, note, stato, updated_at')
    .eq('stato', statoParsed.value ?? DEFAULT_STATO)
    .order('data_scadenza', { ascending: true })

  const rawSoggetto = cleanString(input.soggetto)
  const soggetto = rawSoggetto ? normalizeSubject(rawSoggetto) : undefined
  if (soggetto) query = query.ilike('soggetto', `%${soggetto}%`)

  const categoria = cleanString(input.categoria)
  if (categoria) query = query.eq('categoria', categoria)

  const entroGiorni = parseInteger(input.entro_giorni, 'entro_giorni')
  if (entroGiorni.error) return fail(entroGiorni.error)
  if (entroGiorni.value !== undefined && entroGiorni.value < 0) return fail('entro_giorni deve essere >= 0.')
  if (entroGiorni.value !== undefined) query = query.lte('data_scadenza', addDaysISO(entroGiorni.value))

  const { data, error } = await query
  if (error) return fail(`Errore lista scadenze: ${error.message}`)

  const rows = (data ?? []) as ScadenzaRow[]
  return ok({
    today: todayISO(),
    count: rows.length,
    scadenze: rows.map(summarize),
  })
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

  return ok({ scadenza: summarize(data as ScadenzaRow) })
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
    description: 'Registra una scadenza documentale/operativa in cervellone_scadenze. Se esiste gia una scadenza attiva con stesso soggetto, tipo_documento E categoria (confronto senza distinzione di maiuscole), la marca come sostituita DOPO aver creato la nuova. ATTENZIONE: due documenti dello stesso tipo per la stessa persona (es. tre attestati di formazione di Mario Rossi) vanno distinti con categoria diversa, altrimenti il piu recente sostituisce il precedente. Crea AUTOMATICAMENTE anche un evento sul Google Calendar di restruktura.drive (best-effort: se il Calendar non e disponibile la scadenza viene comunque registrata; il campo "calendar" nella risposta indica l\'esito).',
    input_schema: {
      type: 'object' as const,
      properties: {
        soggetto: { type: 'string', description: 'Persona, azienda, mezzo o cantiere a cui si riferisce la scadenza.' },
        categoria: { type: 'string', description: 'Categoria opzionale, es. personale, automezzi, cantiere, azienda.' },
        tipo_documento: { type: 'string', description: 'Tipo documento opzionale, es. DURC, patente, revisione, assicurazione.' },
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
    description: 'Lista le scadenze con filtri opzionali. Default: solo stato attivo, ordinate per data_scadenza crescente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        soggetto: { type: 'string', description: 'Filtro case-insensitive sul soggetto.' },
        categoria: { type: 'string', description: 'Filtro categoria esatta.' },
        stato: { type: 'string', enum: VALID_STATI, description: 'Default attivo.' },
        entro_giorni: { type: 'number', description: 'Mostra scadenze con data_scadenza <= oggi + N giorni.' },
      },
      required: [],
    },
  },
  {
    name: 'aggiorna_scadenza',
    description: 'Aggiorna una scadenza per id. Accetta i campi modificabili top-level oppure dentro campi.',
    input_schema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'UUID della scadenza.' },
        soggetto: { type: 'string' },
        categoria: { type: 'string' },
        tipo_documento: { type: 'string' },
        data_scadenza: { type: 'string', description: 'YYYY-MM-DD' },
        reminder_days: { type: 'number' },
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
