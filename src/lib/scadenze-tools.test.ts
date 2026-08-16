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

// Nessun test deve toccare Google Calendar.
vi.mock('./calendar-tools', () => ({
  executeCalendarTool: vi.fn(async () => '✅ Evento creato'),
  CALENDAR_TOOLS: [],
}))

interface ParsedResult {
  ok: boolean
  error?: string
  id?: string
  sostituite?: string[]
  calendar?: string
}

async function registra(input: Record<string, unknown>): Promise<ParsedResult> {
  const { executeScadenzeTool } = await import('./scadenze-tools')
  const raw = await executeScadenzeTool('registra_scadenza', input)
  return JSON.parse(raw ?? '{}') as ParsedResult
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

const BASE = {
  soggetto: 'Mario Rossi',
  data_scadenza: '2027-06-17',
}

beforeEach(() => {
  mockOps.length = 0
  mockHandler = mockDefaultHandler
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

  it('filtra il soggetto lato server (niente scan+filtro JS oltre il row-cap PostgREST)', async () => {
    const res = await registra({ ...BASE, tipo_documento: 'DURC' })
    expect(res.ok).toBe(true)
    const select = mockOps.find(op => op.op === 'select')
    expect(select).toBeDefined()
    const filterCols = (select?.filters ?? []).map(f => String(f.args[0]))
    expect(filterCols).toContain('soggetto')
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
