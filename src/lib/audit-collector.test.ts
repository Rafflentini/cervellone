// src/lib/audit-collector.test.ts — TDD Task 2 audit-collector
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Supabase ─────────────────────────────────────────────────────────────

const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockGte = vi.fn()
const mockOrder = vi.fn()
const mockIn = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: mockSelect,
    })),
  },
}))

// ── Catena mock: select → eq → gte → order → resolved ────────────────────────

function resolveWith(data: unknown[], error = null) {
  mockOrder.mockResolvedValue({ data, error })
  mockIn.mockResolvedValue({ data, error })
  mockGte.mockReturnValue({ order: mockOrder, in: mockIn })
  mockEq.mockReturnValue({ gte: mockGte, order: mockOrder, in: mockIn })
  mockSelect.mockReturnValue({ gte: mockGte, eq: mockEq, in: mockIn, order: mockOrder })
}

function resolveError(message: string) {
  const err = { message }
  mockOrder.mockResolvedValue({ data: null, error: err })
  mockIn.mockResolvedValue({ data: null, error: err })
  mockGte.mockReturnValue({ order: mockOrder, in: mockIn })
  mockEq.mockReturnValue({ gte: mockGte, order: mockOrder, in: mockIn })
  mockSelect.mockReturnValue({ gte: mockGte, eq: mockEq, in: mockIn, order: mockOrder })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── D1: collectModelHealth ────────────────────────────────────────────────────

describe('collectModelHealth', () => {
  it('happy path: aggrega rows per (model, outcome)', async () => {
    resolveWith([
      { model: 'claude-sonnet-4-6', outcome: 'success' },
      { model: 'claude-sonnet-4-6', outcome: 'success' },
      { model: 'claude-sonnet-4-6', outcome: 'api_error' },
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
    expect(result.data!.total).toBe(4)
    expect(typeof result.data!.error_rate).toBe('number')
    expect(typeof result.data!.hallucination_rate).toBe('number')
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
    resolveWith([
      { date_processed: '2026-05-06', status: 'ok', conversations_count: 5, entities_count: 3, llm_cost_estimate_usd: 0.01, error_message: null },
      { date_processed: '2026-05-05', status: 'ok', conversations_count: 2, entities_count: 1, llm_cost_estimate_usd: 0.005, error_message: null },
    ])
    const { collectMemoriaRuns } = await import('./audit-collector')
    const result = await collectMemoriaRuns()
    expect(result.ok).toBe(true)
    expect(result.data!.runs).toHaveLength(2)
    expect(Array.isArray(result.data!.missing_dates)).toBe(true)
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
