// src/lib/audit-collector.test.ts — TDD Task 2 audit-collector
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock Supabase ─────────────────────────────────────────────────────────────

const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockGte = vi.fn()
const mockOrder = vi.fn()
const mockIn = vi.fn()
//  serve al controllo "giornate con messaggi ma senza riassunto": la
// query filtra message_count > 0. Senza, il collector esplode nei test mentre
// in produzione funziona — una divergenza fra strumento e realta'.
const mockGt = vi.fn()

// La tabella interrogata va ricordata: collectGmailHealth fa DUE query diverse
// (gmail_processed_messages e cervellone_config) sulla stessa catena di mock, e
// senza distinguerle l'heartbeat riceverebbe le righe delle mail.
let currentTable = ''

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      currentTable = table
      return { select: mockSelect }
    }),
  },
}))

// ── Catena mock: select → eq → gte → order → resolved ────────────────────────

function resolveWith(data: unknown[], error = null) {
  // Chain terminale è sempre .order() che risolve. .in() è chainabile a .order().
  mockOrder.mockResolvedValue({ data, error })
  mockIn.mockReturnValue({ order: mockOrder })
  mockGt.mockReturnValue({ order: mockOrder })
  mockGte.mockReturnValue({ order: mockOrder, in: mockIn })
  mockEq.mockReturnValue({ gte: mockGte, order: mockOrder, in: mockIn })
  mockSelect.mockReturnValue({ gte: mockGte, gt: mockGt, eq: mockEq, in: mockIn, order: mockOrder })
}

function resolveError(message: string) {
  const err = { message }
  mockOrder.mockResolvedValue({ data: null, error: err })
  mockIn.mockReturnValue({ order: mockOrder })
  mockGt.mockReturnValue({ order: mockOrder })
  mockGte.mockReturnValue({ order: mockOrder, in: mockIn })
  mockEq.mockReturnValue({ gte: mockGte, order: mockOrder, in: mockIn })
  mockSelect.mockReturnValue({ gte: mockGte, gt: mockGt, eq: mockEq, in: mockIn, order: mockOrder })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── D1: collectModelHealth ────────────────────────────────────────────────────

describe('collectModelHealth', () => {
  it('happy path: aggrega rows per (model, outcome)', async () => {
    resolveWith([
      { model: 'claude-sonnet-4-6', outcome: 'success' },
      { model: 'claude-sonnet-4-6', outcome: 'success' },
      { model: 'claude-sonnet-4-6', outcome: 'api_error' },
      { model: 'claude-sonnet-4-6', outcome: 'empty' },
      { model: 'claude-sonnet-4-6', outcome: 'force_text' },
      { model: 'claude-sonnet-4-6', outcome: 'hallucination' },
      { model: 'claude-opus-latest', outcome: 'success' },
    ])
    const { collectModelHealth } = await import('./audit-collector')
    const result = await collectModelHealth()
    expect(result.ok).toBe(true)
    expect(result.data).toBeDefined()
    const rows = result.data!.rows
    const sonnetSuccess = rows.find(r => r.model === 'claude-sonnet-4-6' && r.outcome === 'success')
    expect(sonnetSuccess?.n).toBe(2)
    const sonnetErr = rows.find(r => r.model === 'claude-sonnet-4-6' && r.outcome === 'api_error')
    expect(sonnetErr?.n).toBe(1)
    expect(result.data!.total).toBe(7)
    expect(result.data!.mitigated_count).toBe(2)
    expect(result.data!.error_rate).toBeCloseTo(1 / 7)
    expect(result.data!.hallucination_rate).toBeCloseTo(1 / 7)
  })

  it('error: supabase failure → ok false', async () => {
    resolveError('DB connection failed')
    const { collectModelHealth } = await import('./audit-collector')
    const result = await collectModelHealth()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('DB connection failed')
  })
})

// ── D2: collectBreakerEvents ──────────────────────────────────────────────────

describe('collectBreakerEvents', () => {
  it('happy path: canary events ritornano eventi trip + recovery', async () => {
    resolveWith([
      { model: 'claude-sonnet-4-6', outcome: 'api_error', details: null, ts: '2026-05-06T10:00:00Z' },
      { model: 'claude-sonnet-4-6', outcome: 'timeout', details: null, ts: '2026-05-06T11:00:00Z' },
    ])
    const { collectBreakerEvents } = await import('./audit-collector')
    const result = await collectBreakerEvents()
    expect(result.ok).toBe(true)
    expect(result.data!.events).toHaveLength(2)
    expect(result.data!.trip_count).toBe(2)
  })

  it('error: supabase failure → ok false', async () => {
    resolveError('timeout')
    const { collectBreakerEvents } = await import('./audit-collector')
    const result = await collectBreakerEvents()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('timeout')
  })
})

// ── D3: collectGmailHealth ────────────────────────────────────────────────────

describe('collectGmailHealth', () => {
  it('happy path: aggrega per (bot_action, day)', async () => {
    resolveWith([
      { bot_action: 'notified_critical', ts: '2026-05-06T08:00:00Z' },
      { bot_action: 'notified_critical', ts: '2026-05-06T09:00:00Z' },
      { bot_action: 'in_summary', ts: '2026-05-06T08:30:00Z' },
    ])
    const { collectGmailHealth } = await import('./audit-collector')
    const result = await collectGmailHealth()
    expect(result.ok).toBe(true)
    expect(result.data!.rows.length).toBeGreaterThan(0)
    const critical = result.data!.rows.filter(r => r.bot_action === 'notified_critical')
    expect(critical[0].n).toBeGreaterThanOrEqual(2)
  })

  it('error graceful: tabella non esiste → ok false con error string', async () => {
    resolveError('relation "gmail_processed_messages" does not exist')
    const { collectGmailHealth } = await import('./audit-collector')
    const result = await collectGmailHealth()
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})

// ── D4: collectMemoriaRuns ────────────────────────────────────────────────────

describe('collectMemoriaRuns', () => {
  it('happy path: ritorna runs + missing dates calcolati', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-25T08:00:00Z'))
    resolveWith([
      { date_processed: '2026-05-06', status: 'ok', conversations_count: 5, entities_count: 3, llm_cost_estimate_usd: 0.01, error_message: null },
      { date_processed: '2026-05-05', status: 'ok', conversations_count: 2, entities_count: 1, llm_cost_estimate_usd: 0.005, error_message: null },
    ])
    const { collectMemoriaRuns } = await import('./audit-collector')
    const result = await collectMemoriaRuns()
    expect(result.ok).toBe(true)
    expect(result.data!.runs).toHaveLength(2)
    expect(Array.isArray(result.data!.missing_dates)).toBe(true)
    expect(result.data!.missing_dates).not.toContain('2026-05-24')
    expect(result.data!.missing_dates).toContain('2026-05-23')
    expect(result.data!.error_count).toBe(0)
    expect(result.data!.ok_count).toBe(2)
  })

  it('error: supabase failure → ok false', async () => {
    resolveError('permission denied')
    const { collectMemoriaRuns } = await import('./audit-collector')
    const result = await collectMemoriaRuns()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('permission denied')
  })

  // Un run 'partial' significa memoria persa. Prima non finiva in nessuno dei due
  // conteggi (ok / error), quindi spariva dalla vista dell'audit: il segnale
  // sarebbe nato cieco, come il difetto che ha lasciato la memoria vuota 3 mesi.
  it('conta i run parziali, che prima non finivano in nessun conteggio', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-25T08:00:00Z'))
    resolveWith([
      { date_processed: '2026-05-06', status: 'partial', conversations_count: 1, entities_count: 0, llm_cost_estimate_usd: 0.02, error_message: '2 parti illeggibili scartate' },
      { date_processed: '2026-05-05', status: 'ok', conversations_count: 2, entities_count: 1, llm_cost_estimate_usd: 0.005, error_message: null },
    ])
    const { collectMemoriaRuns } = await import('./audit-collector')
    const result = await collectMemoriaRuns()
    expect(result.data!.partial_count).toBe(1)
    expect(result.data!.ok_count).toBe(1)
    expect(result.data!.error_count).toBe(0)
  })
})

// ── D5: collectCostEstimate ───────────────────────────────────────────────────

describe('collectCostEstimate', () => {
  it('happy path: somma costi + aggiunge canary fisso', async () => {
    resolveWith([
      { date_processed: '2026-05-06', cost: 0.05 },
      { date_processed: '2026-05-05', cost: 0.03 },
    ])
    const { collectCostEstimate } = await import('./audit-collector')
    const result = await collectCostEstimate()
    expect(result.ok).toBe(true)
    // 0.05 + 0.03 + 0.34 (canary) = 0.42
    expect(result.data!.total_7d).toBeGreaterThan(0.05 + 0.03)
    expect(result.data!.avg_per_day).toBeGreaterThan(0)
  })

  it('error: supabase failure → ok false', async () => {
    resolveError('network error')
    const { collectCostEstimate } = await import('./audit-collector')
    const result = await collectCostEstimate()
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})

// ── Difetti dello strumento di misura (self-audit 2026-W36) ───────────────────
// Tre allarmi su quattro non descrivevano Cervellone: descrivevano l'audit.

describe('collectMemoriaRuns — la finestra chiesta e la finestra controllata', () => {
  it('non dichiara mancante un giorno che la query non ha nemmeno chiesto', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T06:00:00Z')) // lunedi, ora del self-audit

    // Il DB contiene il run di OGNI giorno dal 23 al 29 agosto: nessun buco vero.
    const righeNelDb = [
      '2026-08-29', '2026-08-28', '2026-08-27', '2026-08-26',
      '2026-08-25', '2026-08-24', '2026-08-23',
    ].map(d => ({
      date_processed: d, status: 'ok', conversations_count: 1,
      entities_count: 1, llm_cost_estimate_usd: 0.001, error_message: null,
    }))

    // Il mock applica DAVVERO il .gte passato dal codice, come farebbe Postgres.
    // Senza questo il test girerebbe su un payload che la produzione non
    // restituisce mai, e il difetto resterebbe verde.
    let sogliaGte = ''
    mockGte.mockImplementation((_col: string, val: string) => {
      sogliaGte = val
      return { order: mockOrder }
    })
    mockOrder.mockImplementation(() => Promise.resolve({
      data: righeNelDb.filter(r => r.date_processed >= sogliaGte),
      error: null,
    }))
    mockSelect.mockReturnValue({ gte: mockGte, gt: mockGt, eq: mockEq, in: mockIn, order: mockOrder })

    const { collectMemoriaRuns } = await import('./audit-collector')
    const result = await collectMemoriaRuns()

    expect(result.data!.missing_dates).toEqual([])
  })

  it('un buco vero dentro la finestra resta visibile', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T06:00:00Z'))

    const righeNelDb = ['2026-08-29', '2026-08-28', '2026-08-27', '2026-08-25', '2026-08-24', '2026-08-23']
      .map(d => ({
        date_processed: d, status: 'ok', conversations_count: 1,
        entities_count: 1, llm_cost_estimate_usd: 0.001, error_message: null,
      }))

    let sogliaGte = ''
    mockGte.mockImplementation((_col: string, val: string) => {
      sogliaGte = val
      return { order: mockOrder }
    })
    mockOrder.mockImplementation(() => Promise.resolve({
      data: righeNelDb.filter(r => r.date_processed >= sogliaGte),
      error: null,
    }))
    mockSelect.mockReturnValue({ gte: mockGte, gt: mockGt, eq: mockEq, in: mockIn, order: mockOrder })

    const { collectMemoriaRuns } = await import('./audit-collector')
    const result = await collectMemoriaRuns()

    expect(result.data!.missing_dates).toEqual(['2026-08-26'])
  })
})

describe('collectGmailHealth — heartbeat e il buco del fine settimana', () => {
  function mockDueTabelle(mailRows: unknown[], configRows: unknown[]) {
    mockOrder.mockImplementation(() => Promise.resolve({
      data: currentTable === 'cervellone_config' ? configRows : mailRows,
      error: null,
    }))
    mockIn.mockReturnValue({ order: mockOrder })
    mockGt.mockReturnValue({ order: mockOrder })
  mockGte.mockReturnValue({ order: mockOrder, in: mockIn })
    mockSelect.mockReturnValue({ gte: mockGte, gt: mockGt, eq: mockEq, in: mockIn, order: mockOrder })
  }

  it('fermo dal venerdi sera non e morto: e il fine settimana', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T06:00:00Z')) // lunedi 06:00 = ora del self-audit

    mockDueTabelle([], [
      // gmail-alerts gira */30 7-16 lun-ven: l'ultimo giro possibile e venerdi 16:30.
      // Da li al lunedi mattina passano 61,5 ore senza che nulla sia rotto.
      { key: 'gmail_alert_check_last_run', value: '2026-08-28T16:30:00.000Z' },
      // gmail-morning gira 06:00 lun-ven, stessa ora dell'audit: se l'audit lo
      // precede, l'ultimo giro e venerdi 06:00, cioe 72 ore prima.
      { key: 'gmail_summary_last_run', value: '2026-08-28T06:00:00.000Z' },
    ])

    const { collectGmailHealth } = await import('./audit-collector')
    const result = await collectGmailHealth()

    expect(result.data!.alertsCronRecent).toBe(true)
    expect(result.data!.summaryCronRecent).toBe(true)
  })

  it('un cron fermo da oltre una settimana resta rilevato', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-31T06:00:00Z'))

    mockDueTabelle([], [
      { key: 'gmail_alert_check_last_run', value: '2026-08-20T16:30:00.000Z' },
      { key: 'gmail_summary_last_run', value: '2026-08-20T06:00:00.000Z' },
    ])

    const { collectGmailHealth } = await import('./audit-collector')
    const result = await collectGmailHealth()

    expect(result.data!.alertsCronRecent).toBe(false)
    expect(result.data!.summaryCronRecent).toBe(false)
  })
})

describe('riassuntoSenzaContenuto — guarda il CONTENUTO, non il vuoto', () => {
  it('riconosce la stringa che dice "non e successo niente"', async () => {
    const { riassuntoSenzaContenuto } = await import('./audit-collector')
    expect(riassuntoSenzaContenuto('Nessuna attività rilevante')).toBe(true)
    // Le parti vengono unite con " | ": una giornata puo' esserne fatta di N.
    expect(riassuntoSenzaContenuto('Nessuna attività rilevante | Nessuna attività rilevante')).toBe(true)
    expect(riassuntoSenzaContenuto('Nessuna attività rilevante | Nessuna attività rilevante | Nessuna attività rilevante')).toBe(true)
  })

  it('riconosce il marcatore di estrazione fallita', async () => {
    const { riassuntoSenzaContenuto } = await import('./audit-collector')
    expect(riassuntoSenzaContenuto('⚠️ Estrazione non riuscita: 74 messaggi in 1 conversazioni, nessun riassunto prodotto. Da rielaborare.')).toBe(true)
  })

  it('riconosce vuoto e null', async () => {
    const { riassuntoSenzaContenuto } = await import('./audit-collector')
    expect(riassuntoSenzaContenuto('')).toBe(true)
    expect(riassuntoSenzaContenuto(null)).toBe(true)
    expect(riassuntoSenzaContenuto(undefined)).toBe(true)
  })

  it('NON scarta un riassunto vero, nemmeno se contiene quella frase in mezzo', async () => {
    // Controllo positivo. Una giornata reale puo' avere una conversazione vuota
    // e una piena: quella giornata NON e' da rielaborare.
    const { riassuntoSenzaContenuto } = await import('./audit-collector')
    expect(riassuntoSenzaContenuto('L\'ingegnere ha chiesto del caso Blasi Giuseppe.')).toBe(false)
    expect(riassuntoSenzaContenuto('Nessuna attività rilevante | Recovery automatico del cantiere Paterno')).toBe(false)
  })
})
