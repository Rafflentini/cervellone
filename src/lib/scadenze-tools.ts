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

function normalizeSubject(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
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

function parseDate(value: unknown, field: string): { value?: string; error?: string } {
  const date = cleanString(value)
  if (!date) return {}
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: `${field} deve essere nel formato YYYY-MM-DD.` }
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

function sameSubject(left: string, right: string): boolean {
  return normalizeSubject(left).toLocaleLowerCase('it-IT') === normalizeSubject(right).toLocaleLowerCase('it-IT')
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
    if (parsed.value !== undefined && parsed.value < 0) return { error: 'reminder_days deve essere >= 0.' }
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

  const tipoDocumento = insertFields.tipo_documento ?? null
  let existingQuery = supabase
    .from('cervellone_scadenze')
    .select('id, soggetto, tipo_documento')
    .eq('stato', 'attivo')

  existingQuery = tipoDocumento === null
    ? existingQuery.is('tipo_documento', null)
    : existingQuery.eq('tipo_documento', tipoDocumento)

  const { data: existingData, error: existingError } = await existingQuery
  if (existingError) return fail(`Errore ricerca scadenza esistente: ${existingError.message}`)

  const existingRows = (existingData ?? []) as Pick<ScadenzaRow, 'id' | 'soggetto' | 'tipo_documento'>[]
  const replacedIds = existingRows
    .filter(row => sameSubject(row.soggetto, soggetto))
    .map(row => row.id)

  if (replacedIds.length > 0) {
    const { error: updateError } = await supabase
      .from('cervellone_scadenze')
      .update({ stato: 'sostituito', updated_at: new Date().toISOString() })
      .in('id', replacedIds)
    if (updateError) return fail(`Errore sostituzione scadenza precedente: ${updateError.message}`)
  }

  const { data, error } = await supabase
    .from('cervellone_scadenze')
    .insert(insertFields)
    .select('id, reminder_days')
    .single()

  if (error) return fail(`Errore inserimento scadenza: ${error.message}`)
  const created = data as Pick<ScadenzaRow, 'id' | 'reminder_days'> | null

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

  return ok({ id: created?.id, sostituite: replacedIds, calendar })
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
    description: 'Registra una scadenza documentale/operativa in cervellone_scadenze. Se esiste gia una scadenza attiva con stesso soggetto e tipo_documento, la marca come sostituita e crea la nuova. Crea AUTOMATICAMENTE anche un evento sul Google Calendar di restruktura.drive (best-effort: se il Calendar non e disponibile la scadenza viene comunque registrata; il campo "calendar" nella risposta indica l\'esito).',
    input_schema: {
      type: 'object' as const,
      properties: {
        soggetto: { type: 'string', description: 'Persona, azienda, mezzo o cantiere a cui si riferisce la scadenza.' },
        categoria: { type: 'string', description: 'Categoria opzionale, es. personale, automezzi, cantiere, azienda.' },
        tipo_documento: { type: 'string', description: 'Tipo documento opzionale, es. DURC, patente, revisione, assicurazione.' },
        data_scadenza: { type: 'string', description: 'Data in formato YYYY-MM-DD.' },
        reminder_days: { type: 'number', description: 'Giorni prima della scadenza in cui inviare il promemoria. Default DB: 5.' },
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
