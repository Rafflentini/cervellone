import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { opzioniToolDaAmbiente } from './claude'

type Def = { name: string; defer_loading?: boolean; type?: string }

describe('interruttore del differimento', () => {
  afterEach(() => { delete process.env.TOOL_DEFER })

  it('spento (default): nessuna opzione, si comporta come oggi', () => {
    expect(opzioniToolDaAmbiente()).toBeUndefined()
  })

  it('acceso: nucleo e ricerca', () => {
    process.env.TOOL_DEFER = '1'
    const o = opzioniToolDaAmbiente()
    expect(o?.ricerca).toBe(true)
    expect(o?.nucleo?.has('cervellone_info')).toBe(true)
  })

  // CONTROLLO POSITIVO: prova che il test sopra saprebbe accorgersi che
  // l'interruttore non e' collegato. Un valore diverso da '1' deve spegnere.
  it('un valore qualsiasi diverso da 1 lascia spento', () => {
    process.env.TOOL_DEFER = 'true'
    expect(opzioniToolDaAmbiente()).toBeUndefined()
  })
})

// ── Il cavo: opzioniToolDaAmbiente() arriva davvero a getToolDefinitions? ──
//
// I tre test sopra chiamano opzioniToolDaAmbiente() ISOLATA: provano che la
// funzione ritorna il valore giusto, non che runAgentTurn la usi davvero.
// Mutazione trovata dal revisore: `getToolDefinitions(opzioniToolDaAmbiente())`
// -> `getToolDefinitions()` in claude.ts, e nessuno dei 2.221 test se ne
// accorgeva. Qui si esegue runAgentTurn (via callClaudeStream) per davvero e si
// ispezionano gli ARGOMENTI con cui il motore chiama getToolDefinitions.
//
// Mock minimo copiato dallo schema provato in claude.loop-parity.test.ts: SDK
// Anthropic finto a un solo turno (end_turn, nessun tool), './tools' spiata
// invece che sostituita col registro vero, contorno (memory/supabase/circuit
// breaker/telegram/cheap-routing) inerte.
const mockStream = vi.fn(() => ({
  async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } } },
  finalMessage: async () => ({
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 10 },
  }),
}))
vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { stream: (...a: unknown[]) => mockStream(...(a as [])) }
    models = { retrieve: async () => ({ id: 'claude-sonnet-5' }) }
  }
  return { default: FakeAnthropic }
})

type OpzioniToolFinte = { ricerca?: boolean; nucleo?: ReadonlySet<string> } | undefined
const mockGetToolDefinitions = vi.fn((_opzioni?: OpzioniToolFinte) => [] as unknown[])
vi.mock('./tools', () => ({
  getToolDefinitions: (opzioni?: OpzioniToolFinte) => mockGetToolDefinitions(opzioni),
  executeTool: vi.fn(async () => JSON.stringify({ ok: true })),
}))

vi.mock('./memory', () => ({
  searchMemory: async () => '',
  saveMessageWithEmbedding: async () => undefined,
  saveMessageOnly: async () => true,
  saveEmbeddingOnly: async () => true,
}))

const supabaseChain: Record<string, unknown> = {}
Object.assign(supabaseChain, {
  select: () => supabaseChain,
  eq: () => supabaseChain,
  in: async () => ({ data: [] }),
  single: () => Promise.resolve({ data: null, error: null }),
  maybeSingle: async () => ({ data: null }),
  upsert: async () => ({ error: null }),
  update: () => supabaseChain,
  insert: () => supabaseChain,
  delete: () => supabaseChain,
})
vi.mock('./supabase', () => ({ supabase: { from: () => supabaseChain } }))

vi.mock('./api-usage', async (orig) => {
  const actual = await orig<typeof import('./api-usage')>()
  return { ...actual, logApiUsage: async () => undefined }
})
vi.mock('./cheap-routing', () => ({
  shouldUseCheapModel: async () => false,
  CHEAP_MODEL: 'claude-haiku-4-5-20251001',
}))
vi.mock('./telegram-helpers', () => ({ sendTelegramMessage: async () => undefined }))
vi.mock('./circuit-breaker', async (orig) => {
  const actual = await orig<typeof import('./circuit-breaker')>()
  return { ...actual, getActiveModel: async () => 'claude-sonnet-5', recordOutcome: async () => undefined }
})

describe('il cavo: opzioniToolDaAmbiente arriva a getToolDefinitions dentro runAgentTurn', () => {
  beforeEach(() => {
    mockGetToolDefinitions.mockClear()
    mockStream.mockClear()
  })
  afterEach(() => { delete process.env.TOOL_DEFER })

  const richiesta = {
    systemPrompt: 'system',
    userQuery: 'ciao',
    messages: [{ role: 'user' as const, content: 'ciao' }],
    conversationId: 'conv-test',
  }

  it('acceso: getToolDefinitions riceve nucleo e ricerca', async () => {
    process.env.TOOL_DEFER = '1'
    const { callClaudeStream } = await import('./claude')
    await callClaudeStream(richiesta, { onText: () => {} })

    expect(mockGetToolDefinitions).toHaveBeenCalledTimes(1)
    const arg = mockGetToolDefinitions.mock.calls[0][0]
    expect(arg?.ricerca).toBe(true)
    expect(arg?.nucleo?.has('cervellone_info')).toBe(true)
  })

  it('spento (default): getToolDefinitions riceve undefined', async () => {
    const { callClaudeStream } = await import('./claude')
    await callClaudeStream(richiesta, { onText: () => {} })

    expect(mockGetToolDefinitions).toHaveBeenCalledTimes(1)
    expect(mockGetToolDefinitions.mock.calls[0][0]).toBeUndefined()
  })

  // Stessa via del cavo sopra, ma si spia la chiamata all'SDK Anthropic
  // (mockStream) invece di getToolDefinitions: e' li' che arriva davvero il
  // system prompt spedito all'API, blocchi compresi.
  type SystemBlock = { type: string; text?: string }
  async function catturaSystemPrompt(): Promise<string> {
    const { callClaudeStream } = await import('./claude')
    await callClaudeStream(richiesta, { onText: () => {} })
    expect(mockStream).toHaveBeenCalled()
    const chiamata = mockStream.mock.calls[0] as unknown as unknown[]
    const arg = chiamata[0] as { system?: SystemBlock[] }
    return (arg.system ?? []).map((b) => b.text ?? '').join('\n')
  }

  it('acceso: il prompt dice al modello che gli strumenti sono cercabili', async () => {
    process.env.TOOL_DEFER = '1'
    const inviato = await catturaSystemPrompt()
    expect(inviato).toContain('tool_search_tool_bm25')
    expect(inviato).toContain('non ti sono stati caricati')
  })

  // CONTROLLO POSITIVO: spento, l'avviso NON deve comparire — sarebbe una bugia,
  // perche' con l'interruttore spento il modello vede davvero tutti i suoi tool.
  it('spento: l avviso non compare', async () => {
    delete process.env.TOOL_DEFER
    const inviato = await catturaSystemPrompt()
    expect(inviato).not.toContain('tool_search_tool_bm25')
  })
})
