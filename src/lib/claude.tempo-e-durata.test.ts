/**
 * src/lib/claude.tempo-e-durata.test.ts — il muro dei 800 secondi.
 *
 * ⚠️ **Il difetto che questo file chiude**, trovato il 14 settembre 2026
 * rispondendo a una domanda di Raffaele: *«con la delega agli specialisti i
 * giri si allungano — rischiamo che si blocchi tutto?»*.
 *
 * Non si poteva rispondere. Tre cose, tutte e tre rotte:
 *
 * 1. **La durata di un giro non veniva registrata da nessuna parte.**
 *    `api_usage.meta` aveva iterazioni, chiamate a tool ed esito — non i
 *    secondi. Non è che nessuno guardasse: non era guardabile.
 * 2. **Il numero che c'era INGANNAVA proprio lì.** Delegando, le iterazioni del
 *    coordinatore SCENDONO (misurato: 3,7 prima del Decollo, 2,2 dopo) mentre
 *    il lavoro dello specialista gira dentro quel giro senza comparire nel
 *    contatore. Il numero cala mentre il tempo sale.
 * 3. **`runAborted` mentiva**: era ricalcolato a fine giro con
 *    `isRunOverBudget(...)`, quindi un turno finito BENISSIMO ma costoso
 *    risultava «abortito» — e mentiva proprio sui giri riusciti più grossi,
 *    che con la delega sono diventati la norma.
 *
 * E il guasto vero che nessuno vedeva: `api/chat` e `api/telegram` hanno
 * `maxDuration = 800`. Al secondo 800 Vercel **uccide la funzione**: l'Ingegnere
 * non riceve un errore, riceve il NIENTE, e il lavoro fatto fin lì è perso.
 * Ora il ciclo si ferma prima e **lo dice**.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

let usoPerGiro = { input_tokens: 10, output_tokens: 10 }
let contenutoFinale: unknown[] = [{ type: 'text', text: 'ok' }]
let stopReason = 'end_turn'

const implementazioneBase = () => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }
  },
  finalMessage: async () => ({
    content: contenutoFinale,
    stop_reason: stopReason,
    usage: usoPerGiro,
  }),
})

const mockStream = vi.fn(implementazioneBase)

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { stream: (...a: unknown[]) => mockStream(...(a as [])) }
    models = { retrieve: async () => ({ id: 'claude-sonnet-5' }) }
  }
  return { default: FakeAnthropic }
})

const mockExecuteTool = vi.fn(async () => JSON.stringify({ ok: true }))
vi.mock('./tools', () => ({
  getToolDefinitions: () => [],
  executeTool: (...a: unknown[]) => mockExecuteTool(...(a as [])),
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

/** ⚠️ `vi.hoisted`: una `const` normale finirebbe in TDZ sotto la factory issata. */
const { usoRegistrato } = vi.hoisted(() => ({ usoRegistrato: vi.fn() }))
vi.mock('./api-usage', async (orig) => {
  const actual = await orig<typeof import('./api-usage')>()
  return { ...actual, logApiUsage: async (a: unknown) => { usoRegistrato(a) } }
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

import { runAgentTurn, SOGLIA_TEMPO_MS } from './claude'

const richiesta = {
  systemPrompt: 'system',
  userQuery: 'ciao',
  messages: [{ role: 'user' as const, content: 'ciao' }],
  conversationId: 'conv-test',
}
const policy = { tag: 'web' as const, entryPoint: 'chat' as const, persistUserMessage: false }

/** Raccoglie quello che il ciclo scrive all'utente, per leggere la frase di fermata. */
function sinkCheRaccoglie() {
  const pezzi: string[] = []
  return { sink: { onText: (t: string) => { pezzi.push(t) } }, testo: () => pezzi.join('') }
}

/** Il `meta` dell'ultima riga di telemetria scritta. */
function metaRegistrato(): Record<string, unknown> {
  const ultima = usoRegistrato.mock.calls.at(-1)?.[0] as { meta?: Record<string, unknown> } | undefined
  return ultima?.meta ?? {}
}

/**
 * Fa credere al ciclo che il tempo passi, senza farlo passare davvero.
 *
 * ⚠️ NON si usano i timer finti di vitest: il ciclo `await`-a lo stream e i
 * tool, e con `useFakeTimers` quelle attese non si risolverebbero mai. Qui si
 * sposta solo la lancetta che il ciclo LEGGE.
 */
function lancettaCheAvanza(passoMs: number) {
  const vero = Date.now()
  let chiamate = 0
  return vi.spyOn(Date, 'now').mockImplementation(() => vero + (chiamate++ * passoMs))
}

let lancetta: { mockRestore: () => void } | null = null

beforeEach(() => {
  mockStream.mockReset()
  mockStream.mockImplementation(implementazioneBase)
  mockExecuteTool.mockClear()
  usoRegistrato.mockReset()
  usoPerGiro = { input_tokens: 10, output_tokens: 10 }
  contenutoFinale = [{ type: 'text', text: 'ok' }]
  stopReason = 'end_turn'
})

afterEach(() => {
  if (lancetta) { lancetta.mockRestore(); lancetta = null }
})

describe('la durata di un giro viene registrata', () => {
  it('🚨 `durataMs` finisce nella telemetria', async () => {
    // Senza questo numero la domanda «con la delega rischiamo di sbattere
    // contro i 800 secondi?» non ha risposta: non e' che non la si guarda, non
    // e' guardabile. E `iterations` non e' un sostituto — delegando SCENDE
    // mentre il tempo sale.
    await runAgentTurn(richiesta, { onText: () => {} }, policy)

    const meta = metaRegistrato()
    expect(meta).toHaveProperty('durataMs')
    expect(typeof meta.durataMs).toBe('number')
    expect(meta.durataMs as number).toBeGreaterThanOrEqual(0)
  })
})

describe('runAborted dice la verita', () => {
  it('🚨 un giro finito BENE non e abortito, nemmeno se e costato tanto', async () => {
    // Il difetto: `runAborted` era ricalcolato a fine giro con
    // `isRunOverBudget(...)`, quindi mentiva proprio sui turni riusciti piu'
    // grossi — quelli che con la delega sono diventati la norma.
    usoPerGiro = { input_tokens: 5_000_000, output_tokens: 5_000_000 }
    contenutoFinale = [{ type: 'text', text: 'fatto' }]
    stopReason = 'end_turn'

    await runAgentTurn(richiesta, { onText: () => {} }, policy)

    expect(metaRegistrato().runAborted).toBe(false)
  })

  it('CONTROLLO POSITIVO: quando il ciclo si ferma DAVVERO per budget, lo dice', async () => {
    // Senza questo, un `runAborted` cablato a `false` passerebbe il test qui
    // sopra e avrebbe spento la segnalazione invece di ripararla.
    usoPerGiro = { input_tokens: 5_000_000, output_tokens: 5_000_000 }
    contenutoFinale = [{ type: 'tool_use', id: 't1', name: 'qualcosa', input: {} }]
    stopReason = 'tool_use'

    await runAgentTurn(richiesta, { onText: () => {} }, policy)

    expect(metaRegistrato().runAborted).toBe(true)
  })
})

describe('il muro dei 800 secondi: il ciclo si ferma PRIMA, e lo dice', () => {
  it('🚨 oltre la soglia si ferma, lo scrive all Ingegnere, e non e un fallimento del modello', async () => {
    // Al secondo 800 Vercel uccide la funzione: l'Ingegnere non riceve un
    // errore, riceve il NIENTE. Meglio un lavoro troncato che SI SA di aver
    // troncato.
    lancetta = lancettaCheAvanza(SOGLIA_TEMPO_MS)
    contenutoFinale = [{ type: 'tool_use', id: 't1', name: 'qualcosa', input: {} }]
    stopReason = 'tool_use'
    const { sink, testo } = sinkCheRaccoglie()

    const esito = await runAgentTurn(richiesta, sink, policy)

    expect(testo()).toContain('Mi fermo qui')
    expect(testo()).toContain('secondi')
    // 'run_aborted' e NON 'empty': la richiesta era lunga, il modello non e'
    // guasto. Contarlo fra i fallimenti farebbe scattare il rollback su un
    // modello sano dopo tre richieste lente di fila.
    expect(esito.outcome).toBe('run_aborted')
  })

  it('CONTROLLO POSITIVO: un giro veloce NON viene fermato', async () => {
    // Senza questo, una guardia che si ferma SEMPRE passerebbe il test qui
    // sopra — e avremmo murato ogni richiesta lunga invece di salvarla.
    contenutoFinale = [{ type: 'text', text: 'fatto subito' }]
    stopReason = 'end_turn'
    const { sink, testo } = sinkCheRaccoglie()

    const esito = await runAgentTurn(richiesta, sink, policy)

    expect(testo()).not.toContain('Mi fermo qui')
    expect(esito.outcome).not.toBe('run_aborted')
  })

  it('la soglia lascia un margine vero sotto il tetto della funzione', () => {
    // `maxDuration = 800` in vercel.json per api/chat e api/telegram. Se la
    // soglia fosse >= 800 non servirebbe a niente: si verrebbe uccisi prima di
    // accorgersene. Il margine serve a chiudere la frase e a consegnare.
    expect(SOGLIA_TEMPO_MS).toBeLessThan(800_000)
    expect(SOGLIA_TEMPO_MS).toBeGreaterThan(300_000)
  })
})
