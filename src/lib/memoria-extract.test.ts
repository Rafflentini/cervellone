// src/lib/memoria-extract.test.ts — TDD Task 6 memoria-extract orchestrator
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock Anthropic SDK ────────────────────────────────────────────────────────

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
  },
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

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: vi.fn(() => ({
    from: vi.fn((_table: string) => ({
      insert: mockInsert,
      update: mockUpdate,
      select: mockSelect,
      upsert: mockUpsert,
    })),
  })),
}))

vi.mock('./claude', () => ({
  getConfig: vi.fn().mockResolvedValue({ modelAudit: 'claude-sonnet-4-6' }),
}))

vi.mock('@/lib/api-usage', () => ({
  logApiUsage: vi.fn().mockResolvedValue(undefined),
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

  // ── Test 3: Errore Anthropic API su una conversazione ─────────────────────

  it('errore Anthropic API su una conversazione: non fa fallire la giornata, status="partial"', async () => {
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

    // Un errore su una singola conversazione non fa piu fallire l'intera giornata
    expect(result.ok).toBe(true)
    expect(result.skipped_chunks).toBeGreaterThan(0)

    // UPDATE runs con status='partial' deve essere stato chiamato
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'partial', error_message: expect.stringContaining('illeggibili') })
    )

    // summary_giornaliero viene comunque scritto (col fallback, nessun contenuto recuperato)
    const upsertCalls = mockUpsert.mock.calls
    const summaryUpsertCall = upsertCalls.find((args: any[]) =>
      args[0] && typeof args[0] === 'object' && 'summary_text' in args[0]
    )
    expect(summaryUpsertCall).toBeDefined()
    expect(summaryUpsertCall?.[0].summary_text).toBe('Nessuna attività rilevante')
  })

  // ── Test 3a: Errore non-Error lanciato da una parte ────────────────────────

  it('un rifiuto non-Error (es. null) su una parte non fa collassare la giornata', async () => {
    mockLte.mockReturnValue({
      order: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 1, conversation_id: 'conv-nonerror', role: 'user', content: 'Test message', created_at: '2026-05-06T10:00:00Z' },
          ],
          error: null,
        }),
      }),
    })

    // Rifiuto con un valore che non è un'istanza di Error: un cast
    // incondizionato a Error (senza instanceof-check) esploderebbe qui
    // dentro, fuori dal continue, facendo collassare l'intera giornata.
    mockCreate.mockRejectedValueOnce(null)

    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06')

    expect(result.ok).toBe(true)
    expect(result.skipped_chunks).toBeGreaterThan(0)
    expect(mockUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error' })
    )
  })

  // ── Test 3b: Risposta troncata (max_tokens) non fa sparire la giornata ────

  it('una risposta troncata non fa sparire la giornata', async () => {
    const bigContent = 'A'.repeat(50_000)
    mockLte.mockReturnValue({
      order: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 1, conversation_id: 'conv-big', role: 'user', content: bigContent, created_at: '2026-08-05T10:00:00Z' },
          ],
          error: null,
        }),
      }),
    })

    // Prima "parte" del chunk: risposta troncata (JSON incompleto, come in produzione)
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"summary":"Contenzioso Blasi, calcolo del 15%","entita":[{"name":"Blasi Giuse' }],
      usage: { input_tokens: 28825, output_tokens: 1024 },
      stop_reason: 'max_tokens',
    })

    const { runMemoriaExtract } = await import('./memoria-extract')
    const res = await runMemoriaExtract('2026-08-05')

    expect(res.skipped_chunks).toBeGreaterThan(0)

    const upsertCalls = mockUpsert.mock.calls
    const summaryUpsertCall = upsertCalls.find((args: any[]) =>
      args[0] && typeof args[0] === 'object' && 'summary_text' in args[0]
    )
    expect(summaryUpsertCall).toBeDefined()
    expect(summaryUpsertCall?.[0].summary_text).not.toBe('Nessuna attività rilevante')
  })

  // ── Test 3c: entita con forma sbagliata non sparisce in silenzio ──────────

  it('entita non-array nella risposta non sparisce in silenzio: incrementa skipped_chunks', async () => {
    mockLte.mockReturnValue({
      order: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 1, conversation_id: 'conv-badshape', role: 'user', content: 'Test message', created_at: '2026-05-06T10:00:00Z' },
          ],
          error: null,
        }),
      }),
    })

    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({
        summary: 'Giornata regolare',
        entita: 'Bianchi Srl', // forma sbagliata: non è un array
      }) }],
      usage: { input_tokens: 400, output_tokens: 80 },
    })

    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06')

    expect(result.skipped_chunks).toBeGreaterThan(0)
    expect(result.entities).toBe(0)
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

// ── chunkTranscript ───────────────────────────────────────────────────────────

describe('chunkTranscript', () => {
  it('non supera il budget e non perde caratteri', async () => {
    const { chunkTranscript } = await import('./memoria-extract')
    const t = Array.from({ length: 5000 }, (_, i) => `[user]: riga numero ${i}`).join('\n')
    const chunks = chunkTranscript(t, 10_000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10_000)
    expect(chunks.join('\n').replace(/\n/g, '')).toBe(t.replace(/\n/g, ''))
  })
})

// ── parseExtraction ────────────────────────────────────────────────────────────

describe('parseExtraction', () => {
  it('recupera JSON incorniciato o preceduto da testo', async () => {
    const { parseExtraction } = await import('./memoria-extract')
    expect(parseExtraction('```json\n{"summary":"ok"}\n```')?.summary).toBe('ok')
    expect(parseExtraction('Ecco il risultato:\n{"summary":"ok"}')?.summary).toBe('ok')
    expect(parseExtraction('{"summary":"tronc')).toBeNull()
  })
})

// ── Esito del run e rielaborazione manuale ────────────────────────────────────

/**
 * Il vincolo CHECK del DB accettava solo 'started','ok','error': scrivere
 * 'partial' veniva RIFIUTATO, supabase-js non lancia, e l'errore non veniva
 * letto. La riga restava 'started' per sempre e l'audit non vedeva nulla —
 * la stessa malattia che questo file cura, un piano piu' in basso.
 */
describe('runMemoriaExtract — l esito del run non puo fallire in silenzio', () => {
  function messaggiDelGiorno() {
    mockLte.mockReturnValue({
      order: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 1, conversation_id: 'conv-1', role: 'user', content: 'Ho mandato il preventivo a Bianchi Srl', created_at: '2026-05-06T10:00:00Z' },
          ],
          error: null,
        }),
      }),
    })
    mockGte.mockReturnValue({ lte: mockLte })
  }

  it('se la scrittura dell esito viene rifiutata, il run NON si dichiara riuscito', async () => {
    messaggiDelGiorno()
    mockUpdate.mockReturnValue({
      eq: vi.fn().mockResolvedValue({ error: { message: 'violates check constraint' } }),
    })

    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('esito non registrabile')
  })

  it('una rielaborazione forzata non sposta il segnaposto del cron', async () => {
    messaggiDelGiorno()
    mockMaybeSingle.mockResolvedValue({ data: { value: '2026-05-06' }, error: null })

    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06', true)

    // non ha skippato per idempotenza, nonostante last_run coincida
    expect(result.skipped).toBeFalsy()
    // e non ha riscritto il segnaposto
    const scritturaSegnaposto = mockUpsert.mock.calls.find((args: unknown[]) => {
      const primo = args[0] as Record<string, unknown> | undefined
      return primo?.key === 'memoria_extract_last_run'
    })
    expect(scritturaSegnaposto).toBeUndefined()
  })

  it('senza forzatura, last_run coincidente fa saltare il giro', async () => {
    messaggiDelGiorno()
    mockMaybeSingle.mockResolvedValue({ data: { value: '2026-05-06' }, error: null })

    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06')

    expect(result.skipped).toBe(true)
  })

  it('un entita con tipo non ammesso non viene contata fra quelle salvate', async () => {
    messaggiDelGiorno()
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({
        summary: 'giornata di lavoro',
        entita: [
          { name: 'Bianchi Srl', type: 'cliente', context: 'preventivo' },
          { name: 'Blasi Giuseppe', type: 'committente', context: 'contenzioso' },
        ],
        eventi: [],
      }) }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })

    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06')

    // solo 'cliente' e ammesso dal vincolo del DB: 'committente' viene scartato
    expect(result.entities).toBe(1)
    expect(result.skipped_chunks).toBeGreaterThan(0)
  })
})
