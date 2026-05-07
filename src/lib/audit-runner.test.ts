// src/lib/audit-runner.test.ts — TDD Task 4 audit-runner
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Anthropic SDK ────────────────────────────────────────────────────────

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

// ── Mock Supabase ─────────────────────────────────────────────────────────────

const mockInsert = vi.fn()
const mockUpdate = vi.fn()
const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockMaybeSingle = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: mockInsert,
      update: mockUpdate,
      select: mockSelect,
    })),
  },
}))

// ── Mock audit-collector ──────────────────────────────────────────────────────

const mockCollectModelHealth = vi.fn()
const mockCollectBreakerEvents = vi.fn()
const mockCollectGmailHealth = vi.fn()
const mockCollectMemoriaRuns = vi.fn()
const mockCollectCostEstimate = vi.fn()

vi.mock('./audit-collector', () => ({
  collectModelHealth: mockCollectModelHealth,
  collectBreakerEvents: mockCollectBreakerEvents,
  collectGmailHealth: mockCollectGmailHealth,
  collectMemoriaRuns: mockCollectMemoriaRuns,
  collectCostEstimate: mockCollectCostEstimate,
}))

// ── Mock telegram-helpers ─────────────────────────────────────────────────────

const mockSendTelegramMessage = vi.fn()

vi.mock('./telegram-helpers', () => ({
  sendTelegramMessage: mockSendTelegramMessage,
}))

// ── Default mock values ───────────────────────────────────────────────────────

function setCleanCollectors() {
  mockCollectModelHealth.mockResolvedValue({
    ok: true,
    data: { rows: [], total: 50, error_rate: 0.01, hallucination_rate: 0.005 },
  })
  mockCollectBreakerEvents.mockResolvedValue({
    ok: true,
    data: { events: [], trip_count: 0, recovery_count: 0 },
  })
  mockCollectGmailHealth.mockResolvedValue({
    ok: true,
    data: {
      rows: [
        { bot_action: 'notified_critical', day: '2026-05-06', n: 2 },
        { bot_action: 'notified_critical', day: '2026-05-05', n: 1 },
        { bot_action: 'notified_critical', day: '2026-05-04', n: 3 },
        { bot_action: 'notified_critical', day: '2026-05-03', n: 1 },
        { bot_action: 'notified_critical', day: '2026-05-02', n: 2 },
        { bot_action: 'in_summary', day: '2026-05-06', n: 5 },
        { bot_action: 'in_summary', day: '2026-05-05', n: 4 },
        { bot_action: 'in_summary', day: '2026-05-04', n: 3 },
        { bot_action: 'in_summary', day: '2026-05-03', n: 2 },
        { bot_action: 'in_summary', day: '2026-05-02', n: 6 },
      ],
    },
  })
  mockCollectMemoriaRuns.mockResolvedValue({
    ok: true,
    data: { runs: [], ok_count: 5, error_count: 0, missing_dates: [] },
  })
  mockCollectCostEstimate.mockResolvedValue({
    ok: true,
    data: { memoria_7d: 0.10, canary_fixed: 0.34, total_7d: 0.44, avg_per_day: 0.063 },
  })
}

beforeEach(() => {
  vi.clearAllMocks()

  // Supabase INSERT audit_runs → run_id
  mockInsert.mockReturnValue({
    select: vi.fn().mockResolvedValue({ data: [{ run_id: 'test-run-uuid' }], error: null }),
  })

  // Supabase UPDATE → ok
  mockUpdate.mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  })

  // Supabase SELECT (per audit_model config)
  mockMaybeSingle.mockResolvedValue({
    data: { value: '"claude-sonnet-4-6"' },
    error: null,
  })
  mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle })
  mockSelect.mockReturnValue({ eq: mockEq })

  // Anthropic narrative ok
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: 'Settimana stabile, nessuna anomalia critica rilevata.' }],
    usage: { input_tokens: 200, output_tokens: 50 },
  })

  // Telegram ok
  mockSendTelegramMessage.mockResolvedValue(undefined)

  // Collectors puliti di default
  setCleanCollectors()

  // Set env
  process.env.TELEGRAM_ALLOWED_IDS = '12345678,87654321'
})

// ── Happy path: 0 anomalie ────────────────────────────────────────────────────

describe('runAudit — happy path 0 anomalie', () => {
  it('ritorna ok + run_id, Telegram inviato con "Nessuna anomalia"', async () => {
    const { runAudit } = await import('./audit-runner')
    const result = await runAudit()
    expect(result.ok).toBe(true)
    expect(result.run_id).toBe('test-run-uuid')
    expect(result.anomalies_count).toBe(0)
    expect(mockSendTelegramMessage).toHaveBeenCalledOnce()
    const msg = mockSendTelegramMessage.mock.calls[0][1] as string
    expect(msg).toContain('Nessuna anomalia rilevata')
  })
})

// ── Happy path: 2 anomalie ────────────────────────────────────────────────────

describe('runAudit — 2 anomalie', () => {
  it('report contiene anomalie, status ok', async () => {
    // Configura error_rate alto
    mockCollectModelHealth.mockResolvedValue({
      ok: true,
      data: { rows: [], total: 100, error_rate: 0.10, hallucination_rate: 0.03 },
    })

    const { runAudit } = await import('./audit-runner')
    const result = await runAudit()
    expect(result.ok).toBe(true)
    expect(result.anomalies_count).toBeGreaterThanOrEqual(2)
    const msg = mockSendTelegramMessage.mock.calls[0][1] as string
    expect(msg).toContain('MODEL_ERROR_HIGH')
  })
})

// ── LLM error: fallback narrative ────────────────────────────────────────────

describe('runAudit — LLM down → fallback narrative', () => {
  it('Anthropic throw → usa narrative statico, status ok, telegram inviato', async () => {
    mockCreate.mockRejectedValue(new Error('Anthropic API unavailable'))

    const { runAudit } = await import('./audit-runner')
    const result = await runAudit()
    expect(result.ok).toBe(true)
    expect(mockSendTelegramMessage).toHaveBeenCalledOnce()
    const msg = mockSendTelegramMessage.mock.calls[0][1] as string
    // Fallback narrative per 0 anomalie
    expect(msg).toContain('Settimana stabile')
  })
})

// ── Collector error: 1 dim fail → procede ─────────────────────────────────────

describe('runAudit — 1 collector fallisce', () => {
  it('1 dim ok:false → log warn + procede con le altre 4', async () => {
    mockCollectModelHealth.mockResolvedValue({ ok: false, error: 'DB timeout' })

    const { runAudit } = await import('./audit-runner')
    const result = await runAudit()
    // Non abortisce
    expect(result.ok).toBe(true)
    expect(mockSendTelegramMessage).toHaveBeenCalledOnce()
  })
})

// ── getISOWeek helper ─────────────────────────────────────────────────────────

describe('getISOWeek', () => {
  it('lunedì 2026-05-04 → 2026-W19', async () => {
    const { getISOWeek } = await import('./audit-runner')
    expect(getISOWeek(new Date('2026-05-04T12:00:00Z'))).toBe('2026-W19')
  })

  it('domenica 2026-01-04 → 2026-W01', async () => {
    const { getISOWeek } = await import('./audit-runner')
    expect(getISOWeek(new Date('2026-01-04T12:00:00Z'))).toBe('2026-W01')
  })

  it('primo gennaio 2026 (giovedì) → 2026-W01', async () => {
    const { getISOWeek } = await import('./audit-runner')
    expect(getISOWeek(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01')
  })
})
