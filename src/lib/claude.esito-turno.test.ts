/**
 * src/lib/claude.esito-turno.test.ts — Decollo, passo 2.
 *
 * ⚠️ **Il difetto che questo passo chiude.**
 *
 * `runAgentTurn` restituiva `Promise<string>`: **solo il testo**. Ma a
 * `claude.ts:1040` il motore calcola un `ModelOutcome` che distingue
 * `success | empty | force_text | hallucination | api_error | timeout |
 * run_aborted` — e lo passava **solo** a `recordOutcome`, telemetria che
 * nessuno legge.
 *
 * Con gli specialisti quello diventa grave: **uno specialista fermato dal
 * budget restituirebbe una stringa troncata senza nessun segnale di
 * fallimento**, e il coordinatore la riporterebbe all'Ingegnere come se fosse
 * una risposta. È il difetto peggiore che questo progetto conosce — l'errore
 * travestito da risultato — ricreato dentro la difesa costruita per chiuderlo.
 *
 * ⚠️ **E il vincolo che vale più di ogni altro:** `callClaudeStream` e
 * `callClaudeStreamTelegram` sono in PRODUZIONE e il loro comportamento non
 * cambia di un carattere. Continuano a restituire la stringa. Il test qui sotto
 * lo prova: se un giorno qualcuno gli fa restituire l'oggetto, i due canali si
 * romperebbero in silenzio.
 *
 * Banco di prova: lo schema già collaudato in `claude.differimento.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

/** Quanti token dichiara di aver consumato ogni giro: serve a sfondare il budget. */
let usoPerGiro = { input_tokens: 10, output_tokens: 10 }
/** I blocchi che il modello finto restituisce: testo, oppure una chiamata a un tool. */
let contenutoFinale: unknown[] = [{ type: 'text', text: 'ok' }]
let stopReason = 'end_turn'

/**
 * Il modello finto di default: scrive «ok» e chiude.
 *
 * ⚠️ Va RIMESSO a ogni test con `mockReset` + `mockImplementation`:
 * `mockClear()` azzera solo le chiamate, non l'implementazione, e i due test
 * che qui sotto la sostituiscono la lasciavano in eredita' ai successivi. Il
 * sintomo era muto — i test di produzione leggevano il fallback per risposta
 * vuota invece di «ok» — ed e' esattamente il modo in cui un banco di prova
 * mente.
 */
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

const richiesta = {
  systemPrompt: 'system',
  userQuery: 'ciao',
  messages: [{ role: 'user' as const, content: 'ciao' }],
  conversationId: 'conv-test',
}

const sinkInerte = { onText: () => {} }
const policy = { tag: 'web' as const, entryPoint: 'chat' as const, persistUserMessage: false }

beforeEach(() => {
  mockStream.mockReset()
  mockStream.mockImplementation(implementazioneBase)
  mockExecuteTool.mockClear()
  usoPerGiro = { input_tokens: 10, output_tokens: 10 }
  contenutoFinale = [{ type: 'text', text: 'ok' }]
  stopReason = 'end_turn'
})
afterEach(() => {
  delete process.env.TOOL_DEFER
})

describe("il motore dice anche COM'E' andata", () => {
  it('un turno riuscito restituisce il testo e outcome success', async () => {
    const { runAgentTurn } = await import('./claude')
    const esito = await runAgentTurn(richiesta, sinkInerte, policy)
    expect(esito.testo).toContain('ok')
    expect(esito.outcome).toBe('success')
    expect(esito.troncato).toBe(false)
    expect(esito.iterazioni).toBeGreaterThanOrEqual(1)
  })

  it('tool_chiamati viene dal CICLO, non dal testo del modello', async () => {
    // Il modello chiede un tool al primo giro, poi chiude. Il nome deve
    // comparire in `tool_chiamati` perche' il CICLO l'ha eseguito — non perche'
    // il modello l'abbia raccontato. Un modello che racconta cosa ha provato e'
    // la stessa autoaccusa che il 12 set 2026 ha fatto contare un difetto
    // inesistente.
    let primoGiro = true
    mockStream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: async () => {
        if (primoGiro) {
          primoGiro = false
          return {
            content: [{ type: 'tool_use', id: 't1', name: 'cerca_documenti', input: {} }],
            stop_reason: 'tool_use',
            usage: usoPerGiro,
          }
        }
        return { content: [{ type: 'text', text: 'fatto' }], stop_reason: 'end_turn', usage: usoPerGiro }
      },
    }))
    const { runAgentTurn } = await import('./claude')
    const esito = await runAgentTurn(richiesta, sinkInerte, policy)
    expect(esito.tool_chiamati).toContain('cerca_documenti')
  })

  it('CONTROLLO POSITIVO — un turno fermato dal budget dice troncato: true', async () => {
    // E' il difetto che questo passo chiude: oggi il chiamante non puo'
    // distinguere questo da una risposta completa.
    usoPerGiro = { input_tokens: 5_000_000, output_tokens: 5_000_000 }
    let primoGiro = true
    mockStream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: async () => {
        if (primoGiro) {
          primoGiro = false
          return {
            content: [{ type: 'tool_use', id: 't1', name: 'cerca_documenti', input: {} }],
            stop_reason: 'tool_use',
            usage: usoPerGiro,
          }
        }
        return {
          content: [{ type: 'tool_use', id: 't2', name: 'cerca_documenti', input: {} }],
          stop_reason: 'tool_use',
          usage: usoPerGiro,
        }
      },
    }))
    const { runAgentTurn } = await import('./claude')
    const esito = await runAgentTurn(richiesta, sinkInerte, policy)
    expect(esito.troncato).toBe(true)
    expect(esito.outcome).toBe('run_aborted')
  })

  it('CONTROLLO POSITIVO — il tetto di iterazioni dice troncato: true, e quello nessuno lo annunciava', async () => {
    // Budget intatto: a fermarlo e' solo il tetto di 10 giri. Il modello scrive
    // testo ogni giro (cosi' non scatta la sintesi forzata) e chiede sempre un
    // altro tool. E' l'unica delle tre fermate che non emetteva NESSUNA frase:
    // il chiamante leggeva una risposta che sembrava finita.
    mockStream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'passo. ' } }
      },
      finalMessage: async () => ({
        content: [
          { type: 'text', text: 'passo. ' },
          { type: 'tool_use', id: 't', name: 'cerca_documenti', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: usoPerGiro,
      }),
    }))
    const { runAgentTurn } = await import('./claude')
    const esito = await runAgentTurn(richiesta, sinkInerte, policy)
    expect(esito.iterazioni).toBe(10)
    expect(esito.troncato).toBe(true)
    expect(esito.tool_chiamati).toHaveLength(10)
  })
})

/**
 * Il modello finto che sfonda il budget al primo giro: chiede un tool e dichiara
 * 10 milioni di token. E' lo scenario in cui il loop scrive al posto del
 * modello.
 */
function modelloCheSfondaIlBudget() {
  usoPerGiro = { input_tokens: 5_000_000, output_tokens: 5_000_000 }
  mockStream.mockImplementation(() => ({
    async *[Symbol.asyncIterator]() {},
    finalMessage: async () => ({
      content: [{ type: 'tool_use', id: 't1', name: 'cerca_documenti', input: {} }],
      stop_reason: 'tool_use',
      usage: usoPerGiro,
    }),
  }))
}

describe('uno specialista lavora in silenzio', () => {
  it('CONTROLLO POSITIVO — con un sink NORMALE la frase sul budget esce davvero', async () => {
    // Senza questo, il test qui sotto («col sink muto non esce») passerebbe
    // anche se la frase non uscisse MAI, da nessun sink: proverebbe zero.
    modelloCheSfondaIlBudget()
    const detto: string[] = []
    const { runAgentTurn } = await import('./claude')
    await runAgentTurn(richiesta, { onText: (d) => { detto.push(d) } }, policy)
    expect(detto.join('')).toContain('superato il budget')
  })

  it('col sink muto la frase NON esce, ma troncato resta true', async () => {
    // Le due meta' contano tutte e due. Se uscisse, l'Ingegnere leggerebbe il
    // monologo interno della contabile e poi la risposta del coordinatore: due
    // messaggi per un evento. Se sparisse e basta, il coordinatore riceverebbe
    // una stringa troncata senza alcun segnale di fallimento — il difetto
    // peggiore che questo progetto conosce, ricreato dentro la difesa.
    modelloCheSfondaIlBudget()
    const { runAgentTurn, sinkMuto } = await import('./claude')
    const spia = vi.fn()
    // `muto` viene da sinkMuto(), ma `onText` e' una spia: cosi' il test prova
    // che a zittire e' il FLAG, non il fatto che sinkMuto non faccia niente.
    const esito = await runAgentTurn(richiesta, { ...sinkMuto(), onText: spia }, policy)
    expect(spia).not.toHaveBeenCalled()
    expect(esito.troncato).toBe(true)
    expect(esito.outcome).toBe('run_aborted')
    expect(esito.testo).not.toContain('budget')
  })

  it('col sink muto il fallback per risposta vuota non esce, ma outcome resta empty', async () => {
    // Stessa sostanza, altro punto: il testo di scusa e' scritto per un umano.
    // Chi delega legge `outcome`.
    mockStream.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {},
      finalMessage: async () => ({ content: [], stop_reason: 'end_turn', usage: usoPerGiro }),
    }))
    const { runAgentTurn, sinkMuto } = await import('./claude')
    const esito = await runAgentTurn(richiesta, sinkMuto(), policy)
    expect(esito.testo).toBe('')
    expect(esito.outcome).toBe('empty')
  })
})

describe('i chiamanti di produzione NON cambiano comportamento', () => {
  it('callClaudeStream restituisce ancora la STRINGA', async () => {
    const { callClaudeStream } = await import('./claude')
    const r = await callClaudeStream(richiesta, { onText: () => {} })
    expect(typeof r).toBe('string')
    expect(r).toContain('ok')
  })

  it('callClaudeStreamTelegram restituisce ancora la STRINGA', async () => {
    const { callClaudeStreamTelegram } = await import('./claude')
    const r = await callClaudeStreamTelegram(richiesta, () => {})
    expect(typeof r).toBe('string')
    expect(r).toContain('ok')
  })
})
