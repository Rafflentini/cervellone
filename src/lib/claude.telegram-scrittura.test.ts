/**
 * Su Telegram la risposta si salvava «sparando e sperando».
 *
 *   const salva = turnoNonConsegnato ? saveMessageOnly(...) : saveMessageWithEmbedding(...)
 *   salva.catch(() => {})
 *
 * Quattro difetti in tre righe, tutti gia' chiusi sul canale web e nessuno qui:
 *
 * 1. la promessa NON e' attesa. La function Vercel resta viva finche' risolve
 *    `bgProcess`, non finche' risolve questa: un fire-and-forget lanciato un
 *    istante prima puo' essere congelato con la function. E' esattamente il
 *    modo in cui la memoria persistente e' rimasta vuota per mesi.
 * 2. l'embedding sta DENTRO la stessa promessa e DOPO l'insert, cioe' una
 *    chiamata di rete oltre il punto in cui bgProcess puo' gia' essere finito.
 * 3. `saveMessageOnly` non rigetta MAI: torna `false`. Quindi `.catch(() => {})`
 *    e' codice morto e una riga non scritta non lo dice a nessuno — la stessa
 *    forma di errore di `sendTelegramMessage`.
 * 4. nessun `creatoIl`: il timestamp del turno esisteva ed era usato solo dal web.
 *
 * ⭐ Il test che sembrava coprirlo (`claude.loop-parity.test.ts`) e' VERDE sia
 * col fire-and-forget sia con l'await, perche' i suoi mock risolvono nel
 * microtask successivo: misura che la chiamata parte, non che arriva.
 * Qui la scrittura risolve DOPO, apposta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockStream = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class { messages = { stream: mockStream } },
}))

const scritture: Array<{ role: string; text: string; embeddato: boolean }> = []
/** Quanti tick di attesa prima che la scrittura risolva. */
let ritardoScrittura = 0
let esitoScrittura = true
const attendi = (n: number) => new Promise<void>((r) => { setTimeout(r, n) })

vi.mock('./memory', () => ({
  saveMessageWithEmbedding: async (_c: string, role: string, text: string) => {
    await attendi(ritardoScrittura)
    scritture.push({ role, text, embeddato: true })
    return esitoScrittura
  },
  saveMessageOnly: async (_c: string, role: string, text: string) => {
    await attendi(ritardoScrittura)
    scritture.push({ role, text, embeddato: false })
    return esitoScrittura
  },
  saveEmbeddingOnly: async () => true,
  searchMemory: async () => '',
  getRecentContext: async () => '',
}))

const daSfondo: Promise<unknown>[] = []
vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => { daSfondo.push(p) },
}))

vi.mock('./tools', () => ({
  getToolDefinitions: () => [],
  executeTool: async () => 'ok',
}))
const catena: Record<string, unknown> = {}
Object.assign(catena, {
  select: () => catena,
  eq: () => catena,
  in: async () => ({ data: [] }),
  maybeSingle: async () => ({ data: { value: 'false' } }),
  upsert: async () => ({ error: null }),
  update: () => catena,
  delete: () => catena,
})
vi.mock('./supabase', () => ({ supabase: { from: () => catena } }))
vi.mock('./api-usage', async (orig) => {
  const vero = await orig<typeof import('./api-usage')>()
  return { ...vero, logApiUsage: async () => undefined }
})
vi.mock('./cheap-routing', () => ({
  shouldUseCheapModel: async () => false,
  CHEAP_MODEL: 'claude-haiku-4-5-20251001',
}))
vi.mock('./telegram-helpers', () => ({ sendTelegramMessage: async () => undefined }))
vi.mock('./circuit-breaker', async (orig) => {
  const vero = await orig<typeof import('./circuit-breaker')>()
  return { ...vero, getActiveModel: async () => 'claude-sonnet-5', recordOutcome: async () => undefined }
})

function richiesta() {
  return {
    systemPrompt: 'system',
    userQuery: 'ciao',
    messages: [{ role: 'user', content: 'ciao' }],
    entryPoint: 'telegram',
    conversationId: 'conv-tg',
  } as never
}

function streamFinto(testo: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: testo } }
    },
    finalMessage: async () => ({
      content: [{ type: 'text', text: testo }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  scritture.length = 0
  daSfondo.length = 0
  ritardoScrittura = 0
  esitoScrittura = true
  process.env.ANTHROPIC_API_KEY = 'x'
  mockStream.mockImplementation(() => streamFinto('Risposta del bot'))
})

describe('Telegram — la risposta si scrive davvero prima di lasciare il turno', () => {
  it('la riga assistant c e QUANDO il turno finisce, non un tick dopo', async () => {
    // 30ms: molto piu' di un microtask. Col fire-and-forget qui non c'e' niente.
    ritardoScrittura = 30

    const { callClaudeStreamTelegram } = await import('./claude')
    await callClaudeStreamTelegram(richiesta(), async () => {})

    const assistente = scritture.filter((s) => s.role === 'assistant')
    expect(assistente).toHaveLength(1)
    expect(assistente[0].text).toContain('Risposta del bot')
  })

  // Se la scrittura e' LENTA il turno non deve restare appeso: si consegna a
  // waitUntil, che e' l'unico modo perche' la function non venga congelata.
  it('una scrittura lentissima finisce in waitUntil, non nel vuoto', async () => {
    ritardoScrittura = 6_000 // oltre il tetto di 5s

    const { callClaudeStreamTelegram } = await import('./claude')
    await callClaudeStreamTelegram(richiesta(), async () => {})

    // Il turno non resta appeso: qui la riga non c'e' ancora.
    expect(scritture.filter((s) => s.role === 'assistant')).toHaveLength(0)

    // Ma e' stata CONSEGNATA allo sfondo, non lasciata cadere. Contare le
    // promesse non basterebbe: ce ne finisce dentro anche l'embedding, e la
    // mutazione che toglie proprio `waitUntil(scrittura)` sopravviveva.
    await Promise.all(daSfondo)
    const assistente = scritture.filter((s) => s.role === 'assistant')
    expect(assistente).toHaveLength(1)
    expect(assistente[0].text).toContain('Risposta del bot')
  }, 20_000)
})
