// src/lib/memoria-extract.test.ts — TDD Task 6 memoria-extract orchestrator
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Anthropic SDK ────────────────────────────────────────────────────────

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

// ── Mock Circuit Breaker (getActiveModel) ─────────────────────────────────────

vi.mock('@/lib/circuit-breaker', () => ({
  getActiveModel: vi.fn().mockResolvedValue('claude-opus-latest'),
}))

// ── Mock Supabase ─────────────────────────────────────────────────────────────

const mockInsert = vi.fn()
const mockUpdate = vi.fn()
const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockGte = vi.fn()
const mockLte = vi.fn()
const mockOrder = vi.fn()
const mockUpsert = vi.fn()
const mockMaybeSingle = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => ({
      insert: mockInsert,
      update: mockUpdate,
      select: mockSelect,
      upsert: mockUpsert,
    })),
  },
}))

// ── Default mock setup ────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()

  // Catena select → eq → maybeSingle (per idempotency + config reads)
  mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  mockEq.mockReturnValue({
    maybeSingle: mockMaybeSingle,
    order: mockOrder,
    eq: mockEq,
  })
  mockGte.mockReturnValue({ lte: mockLte })
  mockLte.mockReturnValue({ order: mockOrder })
  mockOrder.mockReturnValue({ order: mockOrder })
  // Default: nessun messaggio
  mockOrder.mockResolvedValue({ data: [], error: null })

  mockSelect.mockReturnValue({
    eq: mockEq,
    gte: mockGte,
    maybeSingle: mockMaybeSingle,
  })

  // INSERT run → torna run_id
  mockInsert.mockReturnValue({
    select: vi.fn().mockResolvedValue({ data: [{ run_id: 'run-uuid-123' }], error: null }),
  })

  // UPDATE → ok
  mockUpdate.mockReturnValue({
    eq: vi.fn().mockResolvedValue({ error: null }),
  })

  // UPSERT → ok
  mockUpsert.mockResolvedValue({ error: null })

  // Default Anthropic response con JSON valido
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({
      summary: 'Test summary giornata',
      entita: [
        { name: 'Bianchi Srl', type: 'cliente', context: 'preventivo €10k' },
        { name: 'Cantiere Via Roma', type: 'cantiere', context: 'sopralluogo eseguito' },
      ],
      eventi: [{ data_iso: '2026-05-06', descrizione: 'Inviato preventivo' }],
    }) }],
    usage: { input_tokens: 500, output_tokens: 100 },
  })
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runMemoriaExtract', () => {

  // ── Test 1: Happy path ────────────────────────────────────────────────────

  it('happy path: processa 1 conversazione con messaggi e ritorna ok con conteggi corretti', async () => {
    // Simula gte/lte/order che ritorna messaggi
    mockLte.mockReturnValue({
      order: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 1, conversation_id: 'conv-1', role: 'user', content: 'Ho mandato preventivo a Bianchi Srl', created_at: '2026-05-06T10:00:00Z' },
            { id: 2, conversation_id: 'conv-1', role: 'assistant', content: 'Ok, ricevuto', created_at: '2026-05-06T10:01:00Z' },
            { id: 3, conversation_id: 'conv-1', role: 'user', content: 'Il cantiere Via Roma è pronto', created_at: '2026-05-06T10:02:00Z' },
            { id: 4, conversation_id: 'conv-1', role: 'assistant', content: 'Perfetto', created_at: '2026-05-06T10:03:00Z' },
            { id: 5, conversation_id: 'conv-1', role: 'user', content: 'Domani sopralluogo', created_at: '2026-05-06T10:04:00Z' },
          ],
          error: null,
        }),
      }),
    })

    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06')

    expect(result.ok).toBe(true)
    expect(result.conversations).toBe(1)
    expect(result.entities).toBe(2)  // Bianchi Srl + Cantiere Via Roma
    expect(result.tokens).toBe(600)  // 500 input + 100 output
    expect(result.cost_usd).toBeCloseTo(
      (500 * 0.000003) + (100 * 0.000015),
      5
    )
    // summary e upsert entità devono essere stati chiamati
    expect(mockUpsert).toHaveBeenCalled()
  })

  // ── Test 2: Idempotency ───────────────────────────────────────────────────

  it('idempotency: se last_run === target, skip immediatamente senza chiamare Anthropic', async () => {
    // Simula che il config key "memoria_extract_last_run" = "2026-05-06"
    mockMaybeSingle.mockResolvedValue({
      data: { value: '2026-05-06' },
      error: null,
    })

    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06')

    expect(result.ok).toBe(true)
    expect(result.skipped).toBe(true)
    expect(result.conversations).toBe(0)
    // Anthropic NON deve essere stato chiamato
    expect(mockCreate).not.toHaveBeenCalled()
    // INSERT run NON deve essere stato chiamato
    expect(mockInsert).not.toHaveBeenCalled()
  })

  // ── Test 3: Errore Anthropic API ──────────────────────────────────────────

  it('errore Anthropic API: status="error" sul runs row, ok=false, nessun summary inserito', async () => {
    // Simula messaggi presenti
    mockLte.mockReturnValue({
      order: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 1, conversation_id: 'conv-err', role: 'user', content: 'Test message', created_at: '2026-05-06T10:00:00Z' },
          ],
          error: null,
        }),
      }),
    })

    // Anthropic fallisce
    mockCreate.mockRejectedValue(new Error('Anthropic API overloaded'))

    const mockUpdateEq = vi.fn().mockResolvedValue({ error: null })
    mockUpdate.mockReturnValue({ eq: mockUpdateEq })

    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Anthropic API overloaded')

    // UPDATE runs con status='error' deve essere stato chiamato
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' })
    )
    // summary_giornaliero NON deve essere stato upsert-ato
    // (upsert chiamato solo se tutto ok — non nel catch path)
    const upsertCalls = mockUpsert.mock.calls
    const summaryUpsertCalls = upsertCalls.filter((args: any[]) =>
      args[0] && typeof args[0] === 'object' && 'summary_text' in args[0]
    )
    expect(summaryUpsertCalls).toHaveLength(0)
  })

  // ── Test 4: Giornata vuota ────────────────────────────────────────────────

  it('giornata vuota: ok=true, conversations=0, summary_text="Nessuna attività rilevante", entita=[]', async () => {
    // Nessun messaggio per quel giorno
    mockLte.mockReturnValue({
      order: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
      }),
    })

    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06')

    expect(result.ok).toBe(true)
    expect(result.conversations).toBe(0)
    expect(result.entities).toBe(0)
    expect(result.tokens).toBe(0)
    expect(result.cost_usd).toBe(0)

    // Anthropic NON deve essere stato chiamato
    expect(mockCreate).not.toHaveBeenCalled()

    // upsert summary con "Nessuna attività rilevante"
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ summary_text: 'Nessuna attività rilevante' })
    )
  })
})
