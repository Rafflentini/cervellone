/**
 * src/lib/claude.perimetro.test.ts — Decollo, passo 4: il perimetro.
 *
 * ⚠️ **Il prerequisito che il disegno dava per scontato.**
 *
 * Il disegno del Decollo dice «la contabile ha in mano Fatture in Cloud» e «la
 * segretaria ha in mano la posta», come se il motore sapesse limitare gli
 * attrezzi. Verificato il 13 set 2026: **non lo sapeva**. `getToolDefinitions`
 * sapeva solo DIFFERIRE — e un tool differito resta raggiungibile con
 * `tool_search_tool_bm25`. Senza il perimetro, uno «specialista» e' il
 * coordinatore con un altro cappello.
 *
 * E c'e' una trappola dentro la trappola: **togliere un attrezzo dalla vista
 * non e' una guardia.** Un modello puo' chiedere un tool che non gli e' mai
 * stato dichiarato — gli basta indovinarne il nome, e i nomi di questo progetto
 * sono parole italiane ovvie (`send_email`, `conferma_bozza_fic`). Il test che
 * conta piu' di tutti, qui sotto, e' quello che fa indovinare il modello.
 *
 * La regola che tutto questo difende e' di Raffaele, verbatim, 13 set 2026:
 *   «Ne il coordinatore, ne la segretaria spedisce MAI una fattura, quello lo
 *    faccio solo io!»
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

const usoPerGiro = { input_tokens: 10, output_tokens: 10 }

// Il tipo di ritorno e' volutamente largo: i modelli finti di questo file
// restituiscono ora blocchi di testo, ora blocchi `tool_use`, e l'inferenza si
// bloccherebbe sulla prima forma vista.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const implementazioneBase = (): any => ({
  async *[Symbol.asyncIterator]() {
    yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }
  },
  finalMessage: async () => ({
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
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

/**
 * Le definizioni che il finto `getToolDefinitions` restituisce, registrate con
 * le opzioni ricevute: cosi' il test puo' vedere se il perimetro e' ARRIVATO
 * fin la'. Il difetto del 12 set era esattamente un cavo staccato che nessun
 * test seguiva fino in fondo.
 */
const opzioniViste: unknown[] = []
const mockExecuteTool = vi.fn(async () => JSON.stringify({ ok: true }))
vi.mock('./tools', () => ({
  getToolDefinitions: (opzioni?: unknown) => {
    opzioniViste.push(opzioni)
    return []
  },
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
const policy = { tag: 'web' as const, entryPoint: 'chat' as const, persistUserMessage: false }

/** Il modello finto che chiede UN tool per nome, poi chiude. */
function modelloCheChiede(nomeTool: string) {
  let primoGiro = true
  mockStream.mockImplementation(() => {
    // Il PRIMO giro chiede il tool e non scrive niente; il secondo scrive
    // davvero, con i delta. Senza i delta `fullResponse` resterebbe vuota e il
    // turno finirebbe classificato 'empty' — cioe' il banco di prova
    // racconterebbe un fallimento che il codice non ha commesso.
    const chiedeOra = primoGiro
    if (primoGiro) primoGiro = false
    return {
      async *[Symbol.asyncIterator]() {
        if (!chiedeOra) yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fatto' } }
      },
      finalMessage: async () =>
        chiedeOra
          ? {
              content: [{ type: 'tool_use', id: 'x1', name: nomeTool, input: {} }],
              stop_reason: 'tool_use',
              usage: usoPerGiro,
            }
          : { content: [{ type: 'text', text: 'fatto' }], stop_reason: 'end_turn', usage: usoPerGiro },
    }
  })
}

beforeEach(() => {
  mockStream.mockReset()
  mockStream.mockImplementation(implementazioneBase)
  mockExecuteTool.mockClear()
  opzioniViste.length = 0
  delete process.env.TOOL_DEFER
})

describe("⭐ la vista non e' una guardia: il blocco sta all'esecuzione", () => {
  it("il modello INDOVINA il nome di un attrezzo che non ha: non viene eseguito", async () => {
    // Il test che conta piu' di tutti in questo file. `soloQuesti` toglie
    // `send_email` dalle definizioni, ma il modello puo' chiederlo lo stesso —
    // il nome e' una parola ovvia. Se il blocco fosse solo nella vista,
    // `executeTool` partirebbe e la mail uscirebbe.
    modelloCheChiede('send_email')
    const { runAgentTurn } = await import('./claude')
    await runAgentTurn(richiesta, { onText: () => {} }, policy, {
      toolConsentiti: new Set(['fic_fatture_ricevute']),
    })
    expect(mockExecuteTool).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO — lo STESSO tool, dentro il perimetro, viene eseguito', async () => {
    // Senza questo, il test sopra passerebbe anche se il perimetro bloccasse
    // TUTTO, o se `executeTool` non venisse mai chiamato per un'altra ragione.
    modelloCheChiede('send_email')
    const { runAgentTurn } = await import('./claude')
    await runAgentTurn(richiesta, { onText: () => {} }, policy, {
      toolConsentiti: new Set(['send_email']),
    })
    expect(mockExecuteTool).toHaveBeenCalledWith('send_email', {}, 'conv-test')
  })

  it('il rifiuto torna al modello come tool_result, non come eccezione', async () => {
    // Deve poterlo LEGGERE e cambiare strada. Un throw ucciderebbe il turno
    // dello specialista, e il coordinatore riceverebbe «non ha risposto»
    // invece di «questo pezzo non e' mio».
    modelloCheChiede('send_email')
    const { runAgentTurn } = await import('./claude')
    const esito = await runAgentTurn(richiesta, { onText: () => {} }, policy, {
      toolConsentiti: new Set(['fic_fatture_ricevute']),
    })
    expect(esito.outcome).toBe('success')
    // Il tool rifiutato NON e' un tool eseguito: non deve comparire fra quelli
    // che lo specialista dira' di aver provato.
    expect(esito.tool_chiamati).not.toContain('send_email')
  })

  it('senza perimetro il coordinatore esegue quello che vuole: niente cambia per lui', async () => {
    modelloCheChiede('send_email')
    const { runAgentTurn } = await import('./claude')
    await runAgentTurn(richiesta, { onText: () => {} }, policy)
    expect(mockExecuteTool).toHaveBeenCalledWith('send_email', {}, 'conv-test')
  })
})

describe('il perimetro arriva fino alle definizioni (il cavo, non solo la spina)', () => {
  it('con perimetro, getToolDefinitions riceve soloQuesti', async () => {
    const { runAgentTurn } = await import('./claude')
    await runAgentTurn(richiesta, { onText: () => {} }, policy, {
      toolConsentiti: new Set(['fic_fatture_ricevute']),
    })
    expect(opzioniViste).toHaveLength(1)
    const o = opzioniViste[0] as { soloQuesti?: ReadonlySet<string>; nucleo?: unknown; ricerca?: unknown }
    expect(o?.soloQuesti).toBeDefined()
    expect([...(o!.soloQuesti as ReadonlySet<string>)]).toEqual(['fic_fatture_ricevute'])
    // Niente differimento e niente ricerca: gli attrezzi sono pochi e caricati,
    // e non c'e' nient'altro da trovare.
    expect(o?.nucleo).toBeUndefined()
    expect(o?.ricerca).toBeUndefined()
  })

  it("CONTROLLO POSITIVO — senza perimetro e con l'interruttore acceso, arriva il differimento", async () => {
    // La prova che il campo osservato e' quello vivo: cambiando le condizioni,
    // cambia. Senza, il test sopra proverebbe solo che un oggetto e' un
    // oggetto.
    process.env.TOOL_DEFER = '1'
    const { runAgentTurn } = await import('./claude')
    await runAgentTurn(richiesta, { onText: () => {} }, policy)
    const o = opzioniViste[0] as { soloQuesti?: unknown; nucleo?: unknown; ricerca?: unknown }
    expect(o?.soloQuesti).toBeUndefined()
    expect(o?.nucleo).toBeDefined()
    expect(o?.ricerca).toBe(true)
  })
})

describe("⚠️ allo specialista NON si dice di cercare attrezzi che non avra'", () => {
  /** Il testo del prompt di sistema che il modello finto ha ricevuto al primo giro. */
  const systemRicevuto = () => {
    const chiamata = mockStream.mock.calls[0] as unknown as [{ system?: { text?: string }[] }]
    return (chiamata[0].system ?? []).map((b) => b.text ?? '').join('\n')
  }

  it("con perimetro, l'avviso «cercali con tool_search_tool_bm25» NON compare", async () => {
    // Sarebbe falso due volte: non ha altri strumenti, e
    // `tool_search_tool_bm25` non gli viene nemmeno dichiarato. E sta nel
    // blocco CACHATO, quindi se lo pagherebbe intero a ogni giro.
    //
    // Stesso difetto gia' chiuso una volta sulla mappa dell'officina:
    // un'istruzione che indica uno strumento assente e' peggio di nessuna
    // istruzione.
    process.env.TOOL_DEFER = '1'
    const { runAgentTurn } = await import('./claude')
    await runAgentTurn(richiesta, { onText: () => {} }, policy, {
      toolConsentiti: new Set(['fic_fatture_ricevute']),
    })
    expect(systemRicevuto()).not.toContain('tool_search_tool_bm25')
  })

  it("CONTROLLO POSITIVO — senza perimetro, con l'interruttore acceso, l'avviso c'e'", async () => {
    process.env.TOOL_DEFER = '1'
    const { runAgentTurn } = await import('./claude')
    await runAgentTurn(richiesta, { onText: () => {} }, policy)
    expect(systemRicevuto()).toContain('tool_search_tool_bm25')
  })
})
