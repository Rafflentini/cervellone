import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Test di correttezza per registra_scadenza.
 *
 * Dominio: lo scadenzario tiene DURC, visite mediche, attestati di formazione,
 * revisioni mezzi. Una scadenza che sparisce silenziosamente = una formazione
 * scaduta non rilevata in cantiere. Questi test coprono i due modi in cui
 * poteva sparire/duplicarsi.
 *
 * Mock Supabase: query-builder chainabile che REGISTRA ogni operazione
 * (`mockOps`) invece di limitarsi a restituire dati, cosi i test possono
 * asserire *cosa* e' stato scritto e in che ordine — in particolare che un
 * UPDATE stato='sostituito' NON parta quando l'INSERT fallisce.
 */

interface MockQueryResult {
  data: unknown
  error: { message: string } | null
}

type MockOpKind = 'none' | 'select' | 'insert' | 'update' | 'delete'

interface MockOp {
  table: string
  op: MockOpKind
  payload?: unknown
  columns?: string
  filters: { method: string; args: unknown[] }[]
}

const mockOps: MockOp[] = []

const mockDefaultHandler = (op: MockOp): MockQueryResult => {
  if (op.op === 'insert') return { data: { id: 'new-id', reminder_days: 5 }, error: null }
  if (op.op === 'select') return { data: [], error: null }
  return { data: null, error: null }
}

let mockHandler: (op: MockOp) => MockQueryResult = mockDefaultHandler

class MockQueryBuilder implements PromiseLike<MockQueryResult> {
  private readonly rec: MockOp

  constructor(table: string) {
    this.rec = { table, op: 'none', filters: [] }
    mockOps.push(this.rec)
  }

  select(columns?: string): this {
    if (this.rec.op === 'none') this.rec.op = 'select'
    this.rec.columns = columns
    return this
  }

  insert(payload: unknown): this {
    this.rec.op = 'insert'
    this.rec.payload = payload
    return this
  }

  update(payload: unknown): this {
    this.rec.op = 'update'
    this.rec.payload = payload
    return this
  }

  delete(): this {
    this.rec.op = 'delete'
    return this
  }

  eq(...args: unknown[]): this { return this.addFilter('eq', args) }
  neq(...args: unknown[]): this { return this.addFilter('neq', args) }
  is(...args: unknown[]): this { return this.addFilter('is', args) }
  in(...args: unknown[]): this { return this.addFilter('in', args) }
  ilike(...args: unknown[]): this { return this.addFilter('ilike', args) }
  lte(...args: unknown[]): this { return this.addFilter('lte', args) }
  limit(...args: unknown[]): this { return this.addFilter('limit', args) }
  order(...args: unknown[]): this { return this.addFilter('order', args) }

  single(): Promise<MockQueryResult> { return Promise.resolve(mockHandler(this.rec)) }
  maybeSingle(): Promise<MockQueryResult> { return Promise.resolve(mockHandler(this.rec)) }

  then<TResult1 = MockQueryResult, TResult2 = never>(
    onfulfilled?: ((value: MockQueryResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(mockHandler(this.rec)).then(onfulfilled, onrejected)
  }

  private addFilter(method: string, args: unknown[]): this {
    this.rec.filters.push({ method, args })
    return this
  }
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: (table: string) => new MockQueryBuilder(table) },
}))

// Nessun test deve toccare Google Calendar. L'implementazione e sostituibile per
// test (`calendarImpl`) e ogni chiamata viene registrata (`calendarCalls`), cosi
// si puo asserire *cosa* viene passato all'evento (es. nessun reminder override).
const CALENDAR_OK = '✅ Evento creato'
let calendarImpl: (name: string, input: Record<string, unknown>) => Promise<string> = async () => CALENDAR_OK
const calendarCalls: { name: string; input: Record<string, unknown> }[] = []

vi.mock('./calendar-tools', () => ({
  executeCalendarTool: (name: string, input: Record<string, unknown>) => {
    calendarCalls.push({ name, input })
    return calendarImpl(name, input)
  },
  CALENDAR_TOOLS: [],
}))

/**
 * Evento che la fake Google API restituisce a `events.insert`. Serve SOLO ai
 * test che fanno `vi.importActual('./calendar-tools')` per ottenere la stringa
 * VERA prodotta da `formatEvent` (vedi `rispostaRealeCreateEvent`): tutti gli
 * altri test usano il mock di `./calendar-tools` qui sopra.
 */
let mockEventoGoogle: Record<string, unknown> = {}

vi.mock('googleapis', () => ({
  google: {
    calendar: () => ({
      events: {
        insert: async () => ({ data: mockEventoGoogle }),
      },
    }),
  },
}))

vi.mock('./google-oauth', () => ({
  getAuthorizedClient: async () => ({}),
}))

/**
 * Ritorna la stringa che `executeCalendarTool('calendar_create_event', ...)`
 * produce DAVVERO, chiamando il modulo reale con una Google API finta.
 *
 * Perche non una stringa scritta a mano: l'id dell'evento viaggia dentro TESTO
 * LIBERO (`executeCalendarTool` ritorna `string | null`) e il formato lo decide
 * `formatEvent` in calendar-tools.ts. Una fixture inventata proverebbe che
 * l'estrattore sa leggere la fixture, non l'output vero — e il giorno in cui
 * `formatEvent` cambia riga o indentazione i test resterebbero verdi mentre in
 * produzione l'id smette di arrivare.
 */
async function rispostaRealeCreateEvent(evento: Record<string, unknown>): Promise<string> {
  mockEventoGoogle = evento
  const actual = await vi.importActual<typeof import('./calendar-tools')>('./calendar-tools')
  const res = await actual.executeCalendarTool('calendar_create_event', {
    summary: 'Scadenza DURC: Mario Rossi',
    start_date: '2027-06-17',
    description: 'Scadenza registrata in Cervellone.',
  })
  return res ?? ''
}

interface ParsedResult {
  ok: boolean
  error?: string
  id?: string
  sostituite?: string[]
  sostituzione?: string
  avviso?: string
  calendar?: string
  calendar_ok?: boolean
  count?: number
  scadenze?: { id: string; soggetto: string; categoria: string | null }[]
  troncato?: boolean
  limite?: number
  collisione?: string[]
}

/**
 * Invoca un tool dello scadenzario e ne parsa il JSON.
 * NB: il modulo si importa DINAMICAMENTE (come fa tutto il resto del file):
 * i `vi.mock` sopra devono essere applicati prima del primo import reale.
 */
async function callTool(name: string, input: Record<string, unknown>): Promise<ParsedResult> {
  const { executeScadenzeTool } = await import('./scadenze-tools')
  const raw = await executeScadenzeTool(name, input)
  return JSON.parse(raw ?? '{}') as ParsedResult
}

async function registra(input: Record<string, unknown>): Promise<ParsedResult> {
  return callTool('registra_scadenza', input)
}

function updateOps(): MockOp[] {
  return mockOps.filter(op => op.op === 'update')
}

function sostituzioneOps(): MockOp[] {
  return updateOps().filter(op => {
    const payload = op.payload as { stato?: string } | undefined
    return payload?.stato === 'sostituito'
  })
}

function insertOps(): MockOp[] {
  return mockOps.filter(op => op.op === 'insert')
}

/** Gli UPDATE che scrivono l'id dell'evento Calendar sulla riga. */
function eventIdOps(): MockOp[] {
  return updateOps().filter(op => {
    const payload = op.payload as Record<string, unknown> | undefined
    return payload !== undefined && 'calendar_event_id' in payload
  })
}

/**
 * Fa rispondere il finto Calendar con la stringa VERA di `createEvent` per
 * quell'id. Passa dal modulo reale (vedi `rispostaRealeCreateEvent`) perche' un
 * test che si inventa la risposta finirebbe per provare solo se stesso.
 */
async function calendarRispondeConEvento(id: string): Promise<string> {
  const risposta = await rispostaRealeCreateEvent({
    id,
    summary: 'Scadenza DURC: Mario Rossi',
    start: { date: '2027-06-17' },
    htmlLink: 'https://www.google.com/calendar/event?eid=YWJj',
  })
  calendarImpl = async () => risposta
  return risposta
}

const BASE = {
  soggetto: 'Mario Rossi',
  data_scadenza: '2027-06-17',
}

beforeEach(() => {
  mockOps.length = 0
  mockHandler = mockDefaultHandler
  calendarCalls.length = 0
  calendarImpl = async () => CALENDAR_OK
})

describe('registra_scadenza — atomicita sostituzione (BUG 1)', () => {
  it('se l INSERT fallisce NON marca sostituito nessuna riga precedente', async () => {
    // Scenario reale: rinnovo visita medica di Mario Rossi. In DB c e gia la
    // visita 2026 attiva. L INSERT della nuova esplode (vincolo DB, colonna
    // fuori range, ecc.). Prima del fix l UPDATE partiva PRIMA dell INSERT:
    // la vecchia risultava 'sostituito', la nuova non esisteva → la scadenza
    // spariva da lista_scadenze e dal cron promemoria (che filtra stato=attivo).
    mockHandler = (op) => {
      if (op.op === 'insert') return { data: null, error: { message: 'value too long for type character varying' } }
      if (op.op === 'select') {
        return {
          data: [{ id: 'old-1', soggetto: 'Mario Rossi', tipo_documento: 'visita medica', categoria: 'personale' }],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = await registra({
      ...BASE,
      tipo_documento: 'visita medica',
      categoria: 'personale',
    })

    expect(res.ok).toBe(false)
    expect(res.error).toContain('value too long')
    expect(sostituzioneOps()).toHaveLength(0)
  })

  it('happy path: INSERT ok → ok:true con id', async () => {
    const res = await registra({ ...BASE, tipo_documento: 'DURC' })
    expect(res.ok).toBe(true)
    expect(res.id).toBe('new-id')
    expect(insertOps()).toHaveLength(1)
  })

  it('la sostituzione esclude esplicitamente la riga appena creata', async () => {
    mockHandler = (op) => {
      if (op.op === 'insert') return { data: { id: 'new-id', reminder_days: 5 }, error: null }
      if (op.op === 'select') {
        return {
          data: [
            { id: 'old-1', soggetto: 'Mario Rossi', tipo_documento: 'DURC', categoria: 'azienda' },
            { id: 'new-id', soggetto: 'Mario Rossi', tipo_documento: 'DURC', categoria: 'azienda' },
          ],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = await registra({ ...BASE, tipo_documento: 'DURC', categoria: 'azienda' })
    expect(res.ok).toBe(true)
    expect(res.sostituite).toEqual(['old-1'])

    const marked = sostituzioneOps()
    expect(marked).toHaveLength(1)
    const ids = marked[0].filters.find(f => f.method === 'in')?.args[1]
    expect(ids).toEqual(['old-1'])
  })
})

describe('registra_scadenza — validazione input (BUG 1, cause a monte)', () => {
  it('rifiuta 2026-13-07 (mese inesistente) senza scrivere su Supabase', async () => {
    const res = await registra({ soggetto: 'Mario Rossi', data_scadenza: '2026-13-07' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/data_scadenza/i)
    expect(res.error).toMatch(/non esiste|non valida|valida/i)
    expect(mockOps).toHaveLength(0)
  })

  it('rifiuta 2026-02-31 (giorno inesistente) senza scrivere su Supabase', async () => {
    const res = await registra({ soggetto: 'Mario Rossi', data_scadenza: '2026-02-31' })
    expect(res.ok).toBe(false)
    expect(mockOps).toHaveLength(0)
  })

  it('accetta una data valida di anno bisestile (2028-02-29)', async () => {
    const res = await registra({ soggetto: 'Mario Rossi', data_scadenza: '2028-02-29' })
    expect(res.ok).toBe(true)
  })

  it('rifiuta reminder_days fuori range int4 (3000000000) senza scrivere', async () => {
    const res = await registra({ ...BASE, reminder_days: 3000000000 })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/reminder_days/i)
    expect(mockOps).toHaveLength(0)
  })

  it('accetta reminder_days = 30', async () => {
    const res = await registra({ ...BASE, reminder_days: 30 })
    expect(res.ok).toBe(true)
    const payload = insertOps()[0].payload as { reminder_days?: number }
    expect(payload.reminder_days).toBe(30)
  })

  it('rimuove i NUL byte da soggetto e note (testo da OCR/PDF)', async () => {
    const res = await registra({
      soggetto: 'Mario\u0000 Rossi',
      data_scadenza: '2027-06-17',
      note: 'estratto\u0000 da PDF',
    })
    expect(res.ok).toBe(true)
    const payload = insertOps()[0].payload as { soggetto?: string; note?: string }
    expect(payload.soggetto).not.toContain('\u0000')
    expect(payload.note).not.toContain('\u0000')
  })
})

describe('registra_scadenza — chiave di sostituzione (BUG 2)', () => {
  it('under-match: "DURC" poi "durc" stesso soggetto → la seconda sostituisce la prima', async () => {
    mockHandler = (op) => {
      if (op.op === 'insert') return { data: { id: 'durc-2', reminder_days: 5 }, error: null }
      if (op.op === 'select') {
        return {
          data: [{ id: 'durc-1', soggetto: 'Restruktura Srl', tipo_documento: 'DURC', categoria: 'azienda' }],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = await registra({
      soggetto: 'restruktura srl',
      data_scadenza: '2026-12-31',
      tipo_documento: 'durc',
      categoria: 'Azienda',
    })

    expect(res.ok).toBe(true)
    expect(res.sostituite).toEqual(['durc-1'])
  })

  it('over-match: due "attestato formazione" con categoria diversa NON si sostituiscono', async () => {
    // Mario Rossi ha 3 attestati (antincendio, primo soccorso, ponteggi) e
    // l estrattore li etichetta tutti "attestato formazione". Registrare quello
    // ponteggi NON deve marcare 'sostituito' quello antincendio.
    mockHandler = (op) => {
      if (op.op === 'insert') return { data: { id: 'att-ponteggi', reminder_days: 5 }, error: null }
      if (op.op === 'select') {
        return {
          data: [{
            id: 'att-antincendio',
            soggetto: 'Mario Rossi',
            tipo_documento: 'attestato formazione',
            categoria: 'antincendio',
          }],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = await registra({
      soggetto: 'Mario Rossi',
      data_scadenza: '2029-03-01',
      tipo_documento: 'attestato formazione',
      categoria: 'ponteggi',
    })

    expect(res.ok).toBe(true)
    expect(res.sostituite).toEqual([])
    expect(sostituzioneOps()).toHaveLength(0)
  })

  it('stessa categoria (case/spazi diversi) → sostituisce', async () => {
    mockHandler = (op) => {
      if (op.op === 'insert') return { data: { id: 'att-2', reminder_days: 5 }, error: null }
      if (op.op === 'select') {
        return {
          data: [{
            id: 'att-1',
            soggetto: 'Mario Rossi',
            tipo_documento: 'Attestato Formazione',
            categoria: 'Ponteggi',
          }],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = await registra({
      soggetto: 'Mario  Rossi',
      data_scadenza: '2029-03-01',
      tipo_documento: 'attestato formazione',
      categoria: ' ponteggi ',
    })

    expect(res.sostituite).toEqual(['att-1'])
  })
})

/**
 * Il vecchio test "filtra il soggetto lato server" era TAUTOLOGICO: guardava
 * solo che *un* filtro puntasse alla colonna `soggetto`, mai il pattern, e il
 * mock ignora comunque i filtri — sarebbe passato identico con `'%zzz%'`.
 * Qui il pattern lo ispezioniamo davvero, sia in unita che come argomento
 * realmente passato a `.ilike()`.
 */
describe('ilikePattern — pattern ILIKE lato server', () => {
  async function pattern(value: string): Promise<string> {
    const { ilikePattern } = await import('./scadenze-tools')
    return ilikePattern(value)
  }

  it('unisce i token con % (sovrainsieme tollerante agli spazi)', async () => {
    expect(await pattern('Mario Rossi')).toBe('%Mario%Rossi%')
    expect(await pattern('  Mario   Rossi  ')).toBe('%Mario%Rossi%')
  })

  it('token singolo e stringa vuota', async () => {
    expect(await pattern('Restruktura')).toBe('%Restruktura%')
    expect(await pattern('   ')).toBe('%')
  })

  it('escapa il backslash: senza escape la riga NON matcherebbe piu', async () => {
    // In LIKE/ILIKE `\` e l'escape di default: `%Ditta%A\B%Srl%` fa diventare
    // `\B` una `B` letterale e la riga `Ditta A\B Srl` resta fuori dal filtro
    // → under-match, cioe il rinnovo non sostituisce nulla. Serve `\\`.
    const p = await pattern('Ditta A\\B Srl')
    expect(p).toBe('%Ditta%A\\\\B%Srl%')
    expect(p).not.toBe('%Ditta%A\\B%Srl%')
  })

  it('escapa anche i metacaratteri % e _ dentro il token', async () => {
    expect(await pattern('Ditta 100% Srl')).toBe('%Ditta%100\\%%Srl%')
    expect(await pattern('AB_123')).toBe('%AB\\_123%')
  })

  it('apostrofi e trattini restano letterali (nessun metacarattere LIKE)', async () => {
    expect(await pattern("D'Amico Sud-Est")).toBe("%D'Amico%Sud-Est%")
  })

  it('e il pattern che finisce davvero nel filtro .ilike lato server', async () => {
    const res = await registra({ soggetto: 'Ditta A\\B Srl', data_scadenza: '2027-06-17', tipo_documento: 'DURC' })
    expect(res.ok).toBe(true)

    const select = mockOps.find(op => op.op === 'select')
    const soggettoFilter = (select?.filters ?? []).find(f => f.method === 'ilike' && f.args[0] === 'soggetto')
    expect(soggettoFilter).toBeDefined()
    expect(soggettoFilter?.args[1]).toBe(await pattern('Ditta A\\B Srl'))
  })
})

describe('registra_scadenza — esito non ambiguo quando la sostituzione fallisce', () => {
  it('UPDATE fallito dopo INSERT riuscito → ok:true ma avviso + sostituzione:"fallita"', async () => {
    // Caso peggiore accettato dal fix di ordine: la nuova riga esiste, la
    // vecchia NON e stata chiusa → due righe attive, due mail dal cron. Deve
    // essere DISTINGUIBILE da "non c'era nulla da sostituire", altrimenti il
    // modello legge sostituite:[] e dichiara la registrazione pulita.
    mockHandler = (op) => {
      if (op.op === 'insert') return { data: { id: 'durc-2', reminder_days: 5 }, error: null }
      if (op.op === 'select') {
        return {
          data: [{ id: 'durc-1', soggetto: 'Restruktura Srl', tipo_documento: 'DURC', categoria: 'azienda' }],
          error: null,
        }
      }
      if (op.op === 'update') return { data: null, error: { message: 'could not serialize access due to concurrent update' } }
      return { data: null, error: null }
    }

    const res = await registra({
      soggetto: 'Restruktura Srl',
      data_scadenza: '2026-12-31',
      tipo_documento: 'DURC',
      categoria: 'azienda',
    })

    expect(res.ok).toBe(true)
    expect(res.id).toBe('durc-2')
    expect(res.sostituite).toEqual([])
    expect(res.sostituzione).toBe('fallita')
    expect(res.avviso).toBeDefined()
    expect(res.avviso).toContain('concurrent update')
    expect(res.avviso).toMatch(/chiudi_scadenza/)
    // L UPDATE e stato tentato davvero sulla riga giusta.
    const marked = sostituzioneOps()
    expect(marked).toHaveLength(1)
    expect(marked[0].filters.find(f => f.method === 'in')?.args[1]).toEqual(['durc-1'])
  })

  it('SELECT delle precedenti fallito → ok:true ma avviso + sostituzione:"fallita", nessun UPDATE', async () => {
    mockHandler = (op) => {
      if (op.op === 'insert') return { data: { id: 'durc-2', reminder_days: 5 }, error: null }
      if (op.op === 'select') return { data: null, error: { message: 'statement timeout' } }
      return { data: null, error: null }
    }

    const res = await registra({
      soggetto: 'Restruktura Srl',
      data_scadenza: '2026-12-31',
      tipo_documento: 'DURC',
      categoria: 'azienda',
    })

    expect(res.ok).toBe(true)
    expect(res.id).toBe('durc-2')
    expect(res.sostituite).toEqual([])
    expect(res.sostituzione).toBe('fallita')
    expect(res.avviso).toContain('statement timeout')
    expect(res.avviso).toMatch(/lista_scadenze/)
    expect(sostituzioneOps()).toHaveLength(0)
  })

  it('nessuna precedente da sostituire → sostituite:[] SENZA avviso ne sostituzione', async () => {
    // Il controcaso: qui sostituite:[] significa davvero "tutto a posto".
    const res = await registra({ ...BASE, tipo_documento: 'DURC', categoria: 'azienda' })
    expect(res.ok).toBe(true)
    expect(res.sostituite).toEqual([])
    expect(res.sostituzione).toBeUndefined()
    expect(res.avviso).toBeUndefined()
  })
})

/**
 * FIX 1/2/4 — l'esito Calendar deve essere un BOOLEANO, non una nota in prosa.
 *
 * Scenario reale: il refresh token perde lo scope calendar. Ogni
 * registra_scadenza tornava ok:true con una frase d'errore dentro `calendar`,
 * il modello rispondeva "registrata, te l'ho messa anche in agenda" e
 * l'Ingegnere si fidava dell'agenda per settimane senza un solo evento.
 */
describe('registra_scadenza — esito Calendar non ignorabile (FIX 1/2/4)', () => {
  it('Calendar fallito → ok:true, calendar_ok:false, la scadenza resta in DB', async () => {
    calendarImpl = async () => '❌ Errore Calendar: scope non autorizzato.'

    const res = await registra({ ...BASE, tipo_documento: 'DURC' })

    expect(res.ok).toBe(true)
    expect(res.id).toBe('new-id')
    expect(res.calendar_ok).toBe(false)
    expect(res.calendar).toMatch(/scope non autorizzato/)
    // La scadenza e stata comunque scritta: il Calendar e best-effort.
    expect(insertOps()).toHaveLength(1)
  })

  it('Calendar che lancia → calendar_ok:false, la registrazione non fallisce', async () => {
    calendarImpl = async () => { throw new Error('ECONNRESET') }

    const res = await registra({ ...BASE, tipo_documento: 'DURC' })

    expect(res.ok).toBe(true)
    expect(res.calendar_ok).toBe(false)
    expect(res.calendar).toMatch(/ECONNRESET/)
  })

  it('Calendar che non risponde → ritorna entro il timeout con calendar_ok:false', async () => {
    // Senza timeout la chiamata "best-effort" tiene aperta la richiesta finche
    // Vercel la uccide (maxDuration 800): la scadenza e gia in DB ma l'utente
    // vede il turno morire e ri-registra → duplicato.
    await import('./scadenze-tools') // pre-carica i moduli: i fake timer non devono correre durante gli import
    calendarImpl = () => new Promise<string>(() => {})

    vi.useFakeTimers()
    try {
      const pending = registra({ ...BASE, tipo_documento: 'DURC' })
      await vi.advanceTimersByTimeAsync(15_000)
      const res = await pending

      expect(res.ok).toBe(true)
      expect(res.id).toBe('new-id')
      expect(res.calendar_ok).toBe(false)
      expect(res.calendar).toMatch(/timeout/i)
      expect(insertOps()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('Calendar ok → calendar_ok:true', async () => {
    const res = await registra({ ...BASE, tipo_documento: 'DURC' })

    expect(res.ok).toBe(true)
    expect(res.calendar_ok).toBe(true)
    expect(res.calendar).toMatch(/Calendar/i)
    expect(calendarCalls).toHaveLength(1)
    expect(calendarCalls[0].name).toBe('calendar_create_event')
  })

  it('l evento della scadenza NON porta override di reminder (il cron e l unica sorgente)', async () => {
    // Il cron scadenze manda gia la mail a N giorni. Gli override email+popup
    // dell'evento erano un secondo allarme non voluto, per giunta clampato a 28
    // giorni da Calendar (reminder_days 60 → due allarmi a un mese di distanza)
    // e recapitato a restruktura.drive@gmail.com, casella che nessuno legge.
    const res = await registra({ ...BASE, tipo_documento: 'DURC', reminder_days: 60 })

    expect(res.ok).toBe(true)
    expect(calendarCalls).toHaveLength(1)
    expect(calendarCalls[0].input).not.toHaveProperty('reminder_days_before')
    expect(Object.keys(calendarCalls[0].input)).not.toContain('reminder_days_before')
  })
})

/**
 * L'id dell'evento Calendar ARRIVA GIA' oggi dentro la risposta testuale di
 * `calendar_create_event` e veniva buttato via. Senza di lui, quando una
 * scadenza viene SOSTITUITA, il vecchio evento resta in agenda coi suoi
 * reminder: una notifica futura per una scadenza che non esiste piu.
 *
 * Questi test pinnano l'ACCOPPIAMENTO FRAGILE: il formato non e un contratto,
 * e la riga `  id=${e.id}` che `formatEvent` (calendar-tools.ts:97-104) stampa
 * dentro la risposta di `createEvent` (:134). Per questo la stringa di partenza
 * viene dal modulo REALE, non scritta a mano.
 */
describe('extractCalendarEventId — l id dell evento non si butta piu', () => {
  it('estrae l id dalla risposta VERA di calendar_create_event', async () => {
    const risposta = await rispostaRealeCreateEvent({
      id: 'a1b2c3d4e5f6g7h8',
      summary: 'Scadenza DURC: Mario Rossi',
      start: { date: '2027-06-17' },
      htmlLink: 'https://www.google.com/calendar/event?eid=YWJj',
    })

    // Controprova che la stringa sia davvero quella di produzione e non una
    // fixture degenerata: se `formatEvent` smettesse di stampare l'id, questa
    // asserzione cade e il test diventa rosso PRIMA dell'estrazione.
    expect(risposta).toContain('✅ Evento creato sul Google Calendar')
    expect(risposta).toContain('id=a1b2c3d4e5f6g7h8')
    expect(risposta.split('\n').length).toBeGreaterThan(1)

    const { extractCalendarEventId } = await import('./scadenze-tools')
    expect(extractCalendarEventId(risposta)).toBe('a1b2c3d4e5f6g7h8')
  }, 20000)

  it('senza htmlLink (l id e sull ULTIMA riga) lo estrae lo stesso', async () => {
    // `formatEvent` aggiunge la riga del link solo se `htmlLink` c'e: l'id puo
    // quindi trovarsi a fine stringa, senza `\n` finale.
    const risposta = await rispostaRealeCreateEvent({
      id: 'zzz999',
      summary: 'Scadenza DURC: Mario Rossi',
      start: { date: '2027-06-17' },
    })

    const { extractCalendarEventId } = await import('./scadenze-tools')
    expect(extractCalendarEventId(risposta)).toBe('zzz999')
  }, 20000)

  it('Google che non restituisce un id → null, NON la stringa "undefined"', async () => {
    // `formatEvent` fa interpolazione secca: con `e.id` assente stampa
    // letteralmente `id=undefined`. Persistere quella stringa significherebbe
    // provare a cancellare l'evento "undefined" al rinnovo successivo.
    const risposta = await rispostaRealeCreateEvent({
      summary: 'Scadenza DURC: Mario Rossi',
      start: { date: '2027-06-17' },
    })

    expect(risposta).toContain('id=undefined')

    const { extractCalendarEventId } = await import('./scadenze-tools')
    expect(extractCalendarEventId(risposta)).toBeNull()
  }, 20000)

  it('risposte senza id (errore, null, prosa) → null', async () => {
    const { extractCalendarEventId } = await import('./scadenze-tools')
    expect(extractCalendarEventId(null)).toBeNull()
    expect(extractCalendarEventId('')).toBeNull()
    expect(extractCalendarEventId('❌ Errore Calendar: scope non autorizzato.')).toBeNull()
    expect(extractCalendarEventId('✅ Evento creato')).toBeNull()
  })

  it('un id iniettato nel TITOLO non viene scambiato per quello vero', async () => {
    // `tipo_documento` arriva testuale dall'LLM e finisce nel summary senza che
    // i newline vengano collassati (`nullableString` fa solo trim). Un
    // `tipo_documento` con dentro "\nid=..." produrrebbe una riga che somiglia
    // a quella dell'id: l'estrazione deve ancorarsi all'indentazione esatta di
    // `formatEvent`, non accontentarsi di trovare "id=" da qualche parte.
    const risposta = await rispostaRealeCreateEvent({
      id: 'idvero123',
      summary: 'Scadenza DURC\nid=idfalso — 2020-01-01: Mario Rossi',
      start: { date: '2027-06-17' },
    })

    const { extractCalendarEventId } = await import('./scadenze-tools')
    expect(extractCalendarEventId(risposta)).toBe('idvero123')
  }, 20000)
})

/**
 * Persistere l'id e' il ponte fra "l'evento e' stato creato" e "al rinnovo so
 * quale evento cancellare". Senza questa scrittura il Task successivo non ha
 * nulla da cui partire.
 */
describe('registra_scadenza — l id evento finisce sulla riga appena creata', () => {
  it('Calendar OK → UPDATE calendar_event_id sulla riga nuova', async () => {
    await calendarRispondeConEvento('evt-abc123')

    const res = await registra({ ...BASE, tipo_documento: 'DURC' })

    expect(res.ok).toBe(true)
    expect(res.calendar_ok).toBe(true)

    const scritture = eventIdOps()
    expect(scritture).toHaveLength(1)
    expect((scritture[0].payload as Record<string, unknown>).calendar_event_id).toBe('evt-abc123')
    // Sulla riga APPENA CREATA, non su tutte quelle del soggetto.
    expect(scritture[0].filters).toContainEqual({ method: 'eq', args: ['id', 'new-id'] })
    // Stesso stile di `marcaSostituite`: updated_at esplicito.
    expect((scritture[0].payload as Record<string, unknown>).updated_at).toEqual(expect.any(String))
    expect(scritture[0].table).toBe('cervellone_scadenze')
  }, 20000)

  it('Calendar fallito → NESSUN update di calendar_event_id', async () => {
    // Non deve scrivere `null` sopra un valore ne emettere un update inutile.
    calendarImpl = async () => '❌ Errore Calendar: scope non autorizzato.'

    const res = await registra({ ...BASE, tipo_documento: 'DURC' })

    expect(res.ok).toBe(true)
    expect(res.calendar_ok).toBe(false)
    expect(eventIdOps()).toHaveLength(0)
  })

  it('Calendar OK ma senza id ricavabile → NESSUN update', async () => {
    // E' il caso della fixture storica `'✅ Evento creato'`: risposta di
    // successo, ma nessun id da salvare. Non deve produrre una scrittura.
    calendarImpl = async () => CALENDAR_OK

    const res = await registra({ ...BASE, tipo_documento: 'DURC' })

    expect(res.calendar_ok).toBe(true)
    expect(eventIdOps()).toHaveLength(0)
  })

  it('se la colonna non esiste (migration non applicata) la scadenza resta registrata e l esito lo DICE', async () => {
    // Best-effort: l'UPDATE fallisce, ma la scadenza e' gia in DB. Il
    // fallimento pero' non deve essere SILENZIOSO, altrimenti il rinnovo
    // successivo non cancellera' nulla e nessuno sapra' perche'.
    await calendarRispondeConEvento('evt-abc123')
    mockHandler = (op) => {
      if (op.op === 'insert') return { data: { id: 'new-id', reminder_days: 5 }, error: null }
      if (op.op === 'update') return { data: null, error: { message: 'column "calendar_event_id" does not exist' } }
      return { data: [], error: null }
    }

    const res = await registra({ ...BASE, tipo_documento: 'DURC' })

    expect(res.ok).toBe(true)
    expect(res.id).toBe('new-id')
    expect(insertOps()).toHaveLength(1)
    // Deve riportare il messaggio del DB E dire cosa comporta, altrimenti
    // "id evento non salvato" non significa niente per chi legge.
    expect(res.calendar).toMatch(/does not exist/)
    expect(res.calendar).toMatch(/calendar_event_id/)
    expect(res.calendar).toMatch(/restera in agenda/)
  }, 20000)
})

describe('lista_scadenze — filtro soggetto escapato (FIX 6)', () => {
  async function lista(input: Record<string, unknown>): Promise<ParsedResult> {
    const { executeScadenzeTool } = await import('./scadenze-tools')
    const raw = await executeScadenzeTool('lista_scadenze', input)
    return JSON.parse(raw ?? '{}') as ParsedResult
  }

  it('un soggetto con backslash produce il pattern escapato, non `%Ditta A\\B Srl%`', async () => {
    const { ilikePattern } = await import('./scadenze-tools')
    const res = await lista({ soggetto: 'Ditta A\\B Srl' })
    expect(res.ok).toBe(true)

    const select = mockOps.find(op => op.op === 'select')
    const filter = (select?.filters ?? []).find(f => f.method === 'ilike' && f.args[0] === 'soggetto')
    expect(filter).toBeDefined()
    expect(filter?.args[1]).toBe(ilikePattern('Ditta A\\B Srl'))
    expect(filter?.args[1]).toBe('%Ditta%A\\\\B%Srl%')
    expect(filter?.args[1]).not.toBe('%Ditta A\\B Srl%')
  })

  it('anche % e _ nel soggetto restano letterali', async () => {
    await lista({ soggetto: 'Ditta 100% Srl' })
    const select = mockOps.find(op => op.op === 'select')
    const filter = (select?.filters ?? []).find(f => f.method === 'ilike' && f.args[0] === 'soggetto')
    expect(filter?.args[1]).toBe('%Ditta%100\\%%Srl%')
  })
})

describe('SCADENZE_TOOLS — le istruzioni all LLM sono allineate al codice', () => {
  async function toolByName(name: string) {
    const { SCADENZE_TOOLS } = await import('./scadenze-tools')
    const tool = SCADENZE_TOOLS.find(t => t.name === name)
    expect(tool).toBeDefined()
    return tool!
  }

  function propDescription(tool: { input_schema: Record<string, unknown> }, prop: string): string {
    const props = tool.input_schema.properties as Record<string, { description?: string }>
    return props[prop]?.description ?? ''
  }

  it('categoria e documentata come parte della chiave, non come macro-area libera', async () => {
    const tool = await toolByName('registra_scadenza')
    const desc = propDescription(tool, 'categoria')
    expect(desc).toMatch(/CHIAVE DI IDENTITA/)
    expect(desc).toMatch(/IDENTICA/)
    expect(desc).toMatch(/rinnovo/i)
    // e la description del tool non deve contraddirla
    expect(tool.description).toMatch(/CHIAVE DI IDENTITA/)
  })

  it('la description di registra_scadenza obbliga a riportare il campo avviso', async () => {
    const tool = await toolByName('registra_scadenza')
    expect(tool.description).toMatch(/avviso/)
    expect(tool.description).toMatch(/TESTUALMENTE/)
  })

  it('registra_scadenza documenta calendar_ok come booleano da riportare (FIX 1)', async () => {
    const tool = await toolByName('registra_scadenza')
    expect(tool.description).toMatch(/calendar_ok/)
    // Non basta nominarlo: deve dire che a false l'agenda NON e aggiornata.
    expect(tool.description).toMatch(/calendar_ok["']?\s*(:|=)?\s*false|calendar_ok e false|calendar_ok è false/i)
  })

  it('calendar_create_event NON invita piu a duplicare le scadenze (FIX 5)', async () => {
    // La description vecchia ("Ideale per registrare scadenze anche sul
    // calendario, oltre che nello scadenzario") spingeva il modello a creare a
    // mano l'evento che registra_scadenza crea gia da solo → due eventi.
    const actual = await vi.importActual<typeof import('./calendar-tools')>('./calendar-tools')
    const tool = actual.CALENDAR_TOOLS.find(t => t.name === 'calendar_create_event')
    expect(tool).toBeDefined()
    expect(tool!.description).not.toMatch(/Ideale per registrare scadenze/i)
    expect(tool!.description).toMatch(/registra_scadenza/)
    expect(tool!.description).toMatch(/appuntament|riunion/i)
    // 20s e non i 5s di default: questo test fa un importActual REALE di
    // ./calendar-tools, e nella suite intera (71 file in parallelo) la transform
    // di un modulo vero supera i 5s sotto contesa di CPU. In isolamento passa
    // sempre: il timeout stava misurando la macchina, non il codice.
  }, 20000)

  it('aggiorna_scadenza dichiara le validazioni condivise con parseWriteFields', async () => {
    const tool = await toolByName('aggiorna_scadenza')
    expect(tool.description).toMatch(/365/)
    expect(propDescription(tool, 'reminder_days')).toMatch(/365/)
    expect(propDescription(tool, 'data_scadenza')).toMatch(/data reale|reale/i)
  })
})

describe('registraScadenzaCore — opzione sostituisciPrecedenti (P0 chiave non distintiva)', () => {
  const CANDIDATA = { id: 'old-1', soggetto: 'Mario Rossi', tipo_documento: 'attestato formazione', categoria: 'Documenti' }

  it('sostituisciPrecedenti:false → INSERT sì, nessun UPDATE sostituito e nessuna ricerca delle precedenti', async () => {
    // Chi registra con una chiave che non identifica un solo documento (il flusso
    // mail-sentinella → proposta → conferma, dove `categoria` e una costante)
    // deve poter aggiungere la scadenza SENZA marcare 'sostituito' una riga che
    // e un ALTRO documento: quella sparirebbe da lista_scadenze e dal cron.
    mockHandler = (op) => {
      if (op.op === 'insert') return { data: { id: 'new-id', reminder_days: 5 }, error: null }
      if (op.op === 'select') return { data: [CANDIDATA], error: null }
      return { data: null, error: null }
    }

    const { registraScadenzaCore } = await import('./scadenze-tools')
    const esito = await registraScadenzaCore(
      { ...BASE, tipo_documento: 'attestato formazione', categoria: 'Documenti' },
      { sostituisciPrecedenti: false },
    )

    expect(esito.ok).toBe(true)
    expect(esito.id).toBe('new-id')
    expect(esito.sostituite).toEqual([])
    expect(esito.avviso).toBeUndefined()
    expect(insertOps()).toHaveLength(1)
    expect(sostituzioneOps()).toHaveLength(0)
    expect(mockOps.filter(op => op.table === 'cervellone_scadenze' && op.op === 'select')).toHaveLength(0)
  })

  it('default (nessuna opzione) → la sostituzione resta attiva: il path manuale non cambia', async () => {
    mockHandler = (op) => {
      if (op.op === 'insert') return { data: { id: 'new-id', reminder_days: 5 }, error: null }
      if (op.op === 'select') return { data: [CANDIDATA], error: null }
      return { data: null, error: null }
    }

    const { registraScadenzaCore } = await import('./scadenze-tools')
    const esito = await registraScadenzaCore({ ...BASE, tipo_documento: 'attestato formazione', categoria: 'Documenti' })

    expect(esito.ok).toBe(true)
    expect(esito.sostituite).toEqual(['old-1'])
    expect(sostituzioneOps()).toHaveLength(1)
  })
})

/**
 * BUG A — `lista_scadenze` filtrava la categoria con uguaglianza binaria
 * (`.eq`), mentre il path di SCRITTURA non normalizza il case: in DB
 * convivono 'personale' e 'Personale'. Cercare 'Personale' non trovava le
 * righe salvate 'personale'.
 *
 * NB: il mock Supabase NON filtra nulla, registra soltanto le operazioni.
 * Per questo servono entrambe le forme di asserzione: quella comportamentale
 * prova che la selezione esatta in JS esiste, quella strutturale che la query
 * lato server e un SOVRAINSIEME (ilike) e non un `eq`.
 */
describe('lista_scadenze — filtro categoria case-insensitive (BUG A)', () => {
  function riga(over: Record<string, unknown>) {
    return {
      id: 'x', soggetto: 'Mario Rossi', categoria: 'personale', tipo_documento: 'visita medica',
      data_scadenza: '2027-01-01', reminder_days: 5, recipients: [], drive_file_id: null,
      drive_url: null, note: null, stato: 'attivo', updated_at: '2026-08-17T00:00:00Z',
      ...over,
    }
  }

  it('lista_scadenze trova la categoria anche con case diverso (BUG A)', async () => {
    mockHandler = (op) => {
      if (op.op === 'select') {
        return {
          data: [
            riga({ id: 'a', categoria: 'personale' }),
            riga({ id: 'b', soggetto: 'Fiat Ducato', categoria: 'Automezzi', tipo_documento: 'revisione', data_scadenza: '2027-02-01' }),
          ],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = await callTool('lista_scadenze', { categoria: 'Personale' })

    expect(res.ok).toBe(true)
    expect(res.count).toBe(1)
    expect(res.scadenze?.[0].id).toBe('a')
  })

  it('lista_scadenze tollera gli spazi interni nella categoria (BUG A)', async () => {
    mockHandler = (op) => {
      if (op.op === 'select') {
        return { data: [riga({ id: 'a', categoria: 'primo soccorso', tipo_documento: 'attestato' })], error: null }
      }
      return { data: null, error: null }
    }

    const res = await callTool('lista_scadenze', { categoria: ' Primo  Soccorso ' })

    expect(res.count).toBe(1)
  })

  it('lista_scadenze scarta la categoria che NON coincide dopo la normalizzazione (BUG A)', async () => {
    // L'ilike lato server e volutamente un sovrainsieme: `%ponteggi%` prende
    // anche 'sub-ponteggi'. La selezione esatta la deve fare `normalizeKey`.
    mockHandler = (op) => {
      if (op.op === 'select') {
        return {
          data: [
            riga({ id: 'a', categoria: 'Ponteggi' }),
            riga({ id: 'b', categoria: 'sub-ponteggi' }),
          ],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = await callTool('lista_scadenze', { categoria: 'ponteggi' })

    expect(res.count).toBe(1)
    expect(res.scadenze?.[0].id).toBe('a')
  })

  it('lista_scadenze filtra la categoria server-side con ilike, non con eq (BUG A)', async () => {
    const { ilikePattern } = await import('./scadenze-tools')
    mockHandler = (op) => (op.op === 'select' ? { data: [], error: null } : { data: null, error: null })

    await callTool('lista_scadenze', { categoria: 'Personale' })

    const select = mockOps.find(op => op.op === 'select')
    expect(select?.filters.find(f => f.method === 'eq' && f.args[0] === 'categoria')).toBeUndefined()
    expect(select?.filters.find(f => f.method === 'ilike' && f.args[0] === 'categoria')?.args[1])
      .toBe(ilikePattern('Personale'))
  })

  it('lista_scadenze non scarta le righe quando la categoria non e richiesta (BUG A - controprova)', async () => {
    mockHandler = (op) => {
      if (op.op === 'select') {
        return {
          data: [
            riga({ id: 'a', categoria: 'personale' }),
            riga({ id: 'b', soggetto: 'Fiat Ducato', categoria: null, tipo_documento: 'revisione' }),
          ],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = await callTool('lista_scadenze', {})

    expect(res.count).toBe(2)
  })

  it('la description del parametro categoria non promette piu un match esatto', async () => {
    const { SCADENZE_TOOLS } = await import('./scadenze-tools')
    const tool = SCADENZE_TOOLS.find(t => t.name === 'lista_scadenze')!
    const props = tool.input_schema.properties as Record<string, { description?: string }>
    expect(props.categoria?.description).toMatch(/case-insensitive/i)
    expect(props.categoria?.description).not.toMatch(/esatta/i)
  })
})

/**
 * BUG B — `lista_scadenze` non chiedeva alcun `.limit()`: il troncamento lo
 * faceva PostgREST al suo row-cap, in silenzio, e `count` riportava il numero
 * della pagina troncata. Il modello lo leggeva come "sono tutte".
 */
describe('lista_scadenze — troncamento dichiarato (BUG B)', () => {
  function righe(n: number, over: Record<string, unknown> = {}) {
    return Array.from({ length: n }, (_, i) => ({
      id: `s-${i}`, soggetto: `Soggetto ${i}`, categoria: 'personale',
      tipo_documento: 'attestato', data_scadenza: '2027-01-01', reminder_days: 5,
      recipients: [], drive_file_id: null, drive_url: null, note: null,
      stato: 'attivo', updated_at: '2026-08-17T00:00:00Z',
      ...over,
    }))
  }

  it('lista_scadenze chiede un limite esplicito al server (BUG B)', async () => {
    mockHandler = (op) => (op.op === 'select' ? { data: [], error: null } : { data: null, error: null })

    await callTool('lista_scadenze', {})

    const select = mockOps.find(op => op.op === 'select')
    expect(select?.filters.find(f => f.method === 'limit')).toBeDefined()
  })

  it('lista_scadenze segnala il troncamento invece di mentire sul conteggio (BUG B)', async () => {
    // 201 righe = LIMITE(200) + 1: il server ne aveva altre.
    mockHandler = (op) => (op.op === 'select' ? { data: righe(201), error: null } : { data: null, error: null })

    const res = await callTool('lista_scadenze', {})

    expect(res.troncato).toBe(true)
    expect(res.limite).toBe(200)
    expect(res.count).toBe(200)
    expect(res.scadenze).toHaveLength(200)
  })

  it('lista_scadenze dichiara troncato:false quando la lista e completa (BUG B)', async () => {
    mockHandler = (op) => (op.op === 'select' ? { data: righe(3), error: null } : { data: null, error: null })

    const res = await callTool('lista_scadenze', {})

    expect(res.troncato).toBe(false)
    expect(res.count).toBe(3)
  })

  it('il troncamento resta dichiarato anche se il filtro categoria in JS assottiglia la pagina (BUG B)', async () => {
    // Il server ha troncato (201 righe = LIMITE+1) e solo 2 sopravvivono al
    // filtro categoria: le ALTRE righe 'antincendio' oltre il cap non sono mai
    // arrivate. `troncato` deve dipendere dalla pagina SERVER, non dalle righe
    // rimaste dopo la selezione in JS, altrimenti si torna a mentire.
    const data = [
      ...righe(2, { categoria: 'antincendio' }),
      ...righe(199, { categoria: 'personale' }),
    ]
    mockHandler = (op) => (op.op === 'select' ? { data, error: null } : { data: null, error: null })

    const res = await callTool('lista_scadenze', { categoria: 'antincendio' })

    expect(res.count).toBe(2)
    expect(res.troncato).toBe(true)
  })

  it('la description di lista_scadenze istruisce l LLM sul campo troncato', async () => {
    const { SCADENZE_TOOLS } = await import('./scadenze-tools')
    const tool = SCADENZE_TOOLS.find(t => t.name === 'lista_scadenze')!
    expect(tool.description).toMatch(/troncato/)
    expect(tool.description).toMatch(/NON e completa|non e completa/i)
  })
})

/**
 * BUG C — `aggiorna_scadenza` faceva un solo UPDATE per id, senza mai
 * verificare se la nuova terna soggetto+tipo_documento+categoria (la CHIAVE DI
 * IDENTITA) andasse a sbattere su una riga gia attiva. Risultato: due righe
 * attive identiche, due promemoria dal cron, due eventi in agenda.
 *
 * DECISIONE DI DESIGN pinnata da questi test: rilevare e AVVISARE, mai
 * cancellare. Chiamare `marcaSostituite` da un UPDATE significherebbe che
 * correggere un refuso nel soggetto puo far sparire in silenzio la scadenza di
 * qualcun altro — lo stesso P0 chiuso la notte del 17 ago.
 */
describe('aggiorna_scadenza — collisione di chiave segnalata, non risolta (BUG C)', () => {
  const AGGIORNATA = {
    id: 'target', soggetto: 'Mario Rossi', categoria: 'ponteggi',
    tipo_documento: 'attestato formazione', data_scadenza: '2029-03-01', reminder_days: 5,
    recipients: [], drive_file_id: null, drive_url: null, note: null,
    stato: 'attivo', updated_at: '2026-08-17T00:00:00Z',
  }
  const GIA_ESISTENTE = {
    id: 'gia-esistente', soggetto: 'Mario Rossi',
    tipo_documento: 'attestato formazione', categoria: 'Ponteggi',
  }

  it('aggiorna_scadenza segnala la collisione quando il cambio di chiave duplica una scadenza attiva (BUG C)', async () => {
    mockHandler = (op) => {
      if (op.op === 'update') return { data: AGGIORNATA, error: null }
      if (op.op === 'select') return { data: [GIA_ESISTENTE], error: null }
      return { data: null, error: null }
    }

    const res = await callTool('aggiorna_scadenza', { id: 'target', categoria: 'ponteggi' })

    expect(res.ok).toBe(true)
    expect(res.collisione).toEqual(['gia-esistente'])
    expect(res.avviso).toBeDefined()
    expect(res.avviso).toMatch(/chiudi_scadenza/)
  })

  it('aggiorna_scadenza NON marca sostituito nessuno: la collisione si segnala, non si cancella (BUG C)', async () => {
    mockHandler = (op) => {
      if (op.op === 'update') return { data: AGGIORNATA, error: null }
      if (op.op === 'select') return { data: [GIA_ESISTENTE], error: null }
      return { data: null, error: null }
    }

    await callTool('aggiorna_scadenza', { id: 'target', categoria: 'ponteggi' })

    // nessun UPDATE con stato:'sostituito' deve essere partito
    expect(sostituzioneOps()).toHaveLength(0)
    // e l'unico UPDATE e quello sulla riga bersaglio
    expect(updateOps()).toHaveLength(1)
  })

  it('aggiorna_scadenza non cerca collisioni quando la chiave non cambia (BUG C - controprova)', async () => {
    mockHandler = (op) => {
      if (op.op === 'update') return { data: { ...AGGIORNATA, data_scadenza: '2030-01-01' }, error: null }
      return { data: [], error: null }
    }

    const res = await callTool('aggiorna_scadenza', { id: 'target', data_scadenza: '2030-01-01' })

    expect(res.ok).toBe(true)
    expect(res.collisione).toBeUndefined()
    // nessuna SELECT indipendente di ricerca chiave
    expect(mockOps.filter(op => op.op === 'select')).toHaveLength(0)
  })

  it('aggiorna_scadenza resta ok quando la nuova chiave e libera (BUG C)', async () => {
    mockHandler = (op) => {
      if (op.op === 'update') return { data: { ...AGGIORNATA, categoria: 'antincendio' }, error: null }
      if (op.op === 'select') return { data: [], error: null }
      return { data: null, error: null }
    }

    const res = await callTool('aggiorna_scadenza', { id: 'target', categoria: 'antincendio' })

    expect(res.ok).toBe(true)
    expect(res.collisione).toBeUndefined()
    expect(res.avviso).toBeUndefined()
  })

  it('la ricerca collisioni esclude la riga appena aggiornata e filtra lato server (BUG C)', async () => {
    const { ilikePattern } = await import('./scadenze-tools')
    mockHandler = (op) => {
      if (op.op === 'update') return { data: AGGIORNATA, error: null }
      if (op.op === 'select') return { data: [], error: null }
      return { data: null, error: null }
    }

    await callTool('aggiorna_scadenza', { id: 'target', categoria: 'ponteggi' })

    const select = mockOps.find(op => op.op === 'select')
    expect(select).toBeDefined()
    expect(select?.filters.find(f => f.method === 'eq' && f.args[0] === 'stato')?.args[1]).toBe('attivo')
    expect(select?.filters.find(f => f.method === 'neq' && f.args[0] === 'id')?.args[1]).toBe('target')
    expect(select?.filters.find(f => f.method === 'ilike' && f.args[0] === 'soggetto')?.args[1])
      .toBe(ilikePattern('Mario Rossi'))
  })

  it('una riga con categoria DIVERSA non e una collisione (BUG C - controprova)', async () => {
    // L'ilike lato server e un sovrainsieme e NON filtra affatto la categoria:
    // la selezione esatta sulla terna la deve fare normalizeKey in JS.
    mockHandler = (op) => {
      if (op.op === 'update') return { data: AGGIORNATA, error: null }
      if (op.op === 'select') return { data: [{ ...GIA_ESISTENTE, categoria: 'antincendio' }], error: null }
      return { data: null, error: null }
    }

    const res = await callTool('aggiorna_scadenza', { id: 'target', categoria: 'ponteggi' })

    expect(res.ok).toBe(true)
    expect(res.collisione).toBeUndefined()
  })

  // FIX 7 — nessuna fixture aveva `tipo_documento: null`, quindi il ramo
  // `query.is('tipo_documento', null)` era MORTO: mutarlo in `ilike` non
  // uccideva nessun test. In produzione una scadenza senza tipo documento
  // (`ilike '%%'` NON matcha NULL in Postgres) non avrebbe MAI avuto la
  // collisione rilevata, e il cron avrebbe mandato due promemoria identici
  // senza che nessuno lo segnalasse.
  it('con tipo_documento NULL cerca le collisioni con is(null), non con ilike (BUG C / FIX 7)', async () => {
    const SENZA_TIPO = { ...AGGIORNATA, tipo_documento: null }
    const GEMELLA_SENZA_TIPO = { id: 'gemella', soggetto: 'Mario  Rossi', tipo_documento: null, categoria: 'Ponteggi' }
    mockHandler = (op) => {
      if (op.op === 'update') return { data: SENZA_TIPO, error: null }
      if (op.op === 'select') return { data: [GEMELLA_SENZA_TIPO], error: null }
      return { data: null, error: null }
    }

    const res = await callTool('aggiorna_scadenza', { id: 'target', categoria: 'ponteggi' })

    const select = mockOps.find(op => op.op === 'select')
    expect(select).toBeDefined()
    // NULL si interroga con IS NULL: un ilike su una colonna NULL non matcha mai.
    expect(select?.filters.find(f => f.method === 'is' && f.args[0] === 'tipo_documento')?.args[1])
      .toBe(null)
    expect(select?.filters.some(f => f.method === 'ilike' && f.args[0] === 'tipo_documento')).toBe(false)

    // E la collisione va davvero rilevata, non solo interrogata bene.
    expect(res.ok).toBe(true)
    expect(res.collisione).toEqual(['gemella'])
    expect(res.avviso).toMatch(/chiudi_scadenza/)
  })

  it('con tipo_documento valorizzato resta un ilike, non un is(null) (FIX 7 - controprova)', async () => {
    mockHandler = (op) => {
      if (op.op === 'update') return { data: AGGIORNATA, error: null }
      if (op.op === 'select') return { data: [], error: null }
      return { data: null, error: null }
    }

    await callTool('aggiorna_scadenza', { id: 'target', categoria: 'ponteggi' })

    const select = mockOps.find(op => op.op === 'select')
    expect(select?.filters.some(f => f.method === 'is' && f.args[0] === 'tipo_documento')).toBe(false)
    expect(select?.filters.some(f => f.method === 'ilike' && f.args[0] === 'tipo_documento')).toBe(true)
  })

  it('la description di aggiorna_scadenza istruisce l LLM sul campo collisione', async () => {
    const { SCADENZE_TOOLS } = await import('./scadenze-tools')
    const tool = SCADENZE_TOOLS.find(t => t.name === 'aggiorna_scadenza')!
    expect(tool.description).toMatch(/collisione/)
    expect(tool.description).toMatch(/chiudi_scadenza/)
  })
})
