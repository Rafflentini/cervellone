/**
 * Il loop web deve eseguire un tool anche quando il modello NON scrive testo
 * prima di chiamarlo.
 *
 * Incidente 2026-09-02: sulla chat web il bot scriveva "Verifico le colonne del
 * Registro Cantieri..." e il turno finiva li'. Nessun tool eseguito, nessun
 * errore. Su Telegram lo stesso flusso funzionava.
 *
 * La differenza e' che il solo loop web contiene `if (!iterationHasText && i > 0) break`:
 * una iterazione che chiama un tool SENZA preambolo testuale interrompe la run in
 * silenzio. Incatenare due tool (leggi intestazione -> scrivi riga) senza narrare
 * in mezzo e' comportamento normale del modello, quindi il turno moriva a meta'.
 *
 * Prova che il difetto e' quello e non il modello: qui il modello chiede
 * ESPLICITAMENTE il secondo tool. Se il secondo tool non viene eseguito, e' il
 * loop ad averlo buttato via.
 *
 * Nessuna rete: SDK, tool, Supabase e memoria sono mockati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Anthropic SDK: uno stream finto per iterazione, guidato da `scriptedTurns` ──
type FakeEvent = Record<string, unknown>
interface FakeTurn {
  /** testo emesso in delta durante l'iterazione (vuoto = nessun text_delta) */
  text: string
  /** blocchi tool_use richiesti dal modello in questa iterazione */
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>
  /** tool eseguiti da Anthropic (web_search, code_execution) */
  serverTools?: string[]
  stopReason: string
}

let scriptedTurns: FakeTurn[] = []
let turnIndex = 0

const mockStream = vi.fn(() => {
  const turn = scriptedTurns[Math.min(turnIndex, scriptedTurns.length - 1)]
  turnIndex++

  const events: FakeEvent[] = []
  if (turn.text) {
    events.push({ type: 'content_block_delta', delta: { type: 'text_delta', text: turn.text } })
  }
  for (const t of turn.toolUses) {
    events.push({ type: 'content_block_start', content_block: { type: 'tool_use', id: t.id, name: t.name } })
  }
  // I tool server-side (web_search, code_execution) arrivano come
  // `server_tool_use` e NON passano da executeToolBlocks.
  for (const nome of turn.serverTools ?? []) {
    events.push({ type: 'content_block_start', content_block: { type: 'server_tool_use', name: nome } })
  }

  const content = [
    ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
    ...turn.toolUses.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
  ]

  return {
    async *[Symbol.asyncIterator]() { for (const e of events) yield e },
    finalMessage: async () => ({
      content,
      stop_reason: turn.stopReason,
      usage: { input_tokens: 10, output_tokens: 10 },
    }),
  }
})

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { stream: (...a: unknown[]) => mockStream(...(a as [])) }
    models = { retrieve: async () => ({ id: 'claude-sonnet-5' }) }
  }
  return { default: FakeAnthropic }
})

// ── Tool: registriamo ogni esecuzione ──
const executedTools: string[] = []
const mockExecuteTool = vi.fn(async (name: string, _input?: Record<string, unknown>, _convId?: string) => {
  executedTools.push(name)
  return JSON.stringify({ ok: true, tool: name })
})
vi.mock('@/lib/tools', () => ({
  getToolDefinitions: () => [{ name: 'leggi_intestazione_registro' }, { name: 'scrivi_riga_registro' }],
  executeTool: (name: string, input: Record<string, unknown>, convId?: string) =>
    mockExecuteTool(name, input, convId),
}))
vi.mock('./tools', () => ({
  getToolDefinitions: () => [{ name: 'leggi_intestazione_registro' }, { name: 'scrivi_riga_registro' }],
  executeTool: (name: string, input: Record<string, unknown>, convId?: string) =>
    mockExecuteTool(name, input, convId),
}))

// ── Contorno inerte ──
vi.mock('./memory', () => ({
  searchMemory: async () => '',
  saveMessageWithEmbedding: async () => undefined,
}))
vi.mock('./supabase', () => ({
  supabase: { from: () => ({ select: () => ({ in: async () => ({ data: [] }) }) }) },
}))
vi.mock('./api-usage', async (orig) => {
  const actual = await orig<typeof import('./api-usage')>()
  return { ...actual, logApiUsage: async () => undefined }
})
vi.mock('./cheap-routing', () => ({
  shouldUseCheapModel: async () => false,
  CHEAP_MODEL: 'claude-haiku-4-5-20251001',
}))
vi.mock('./telegram-helpers', () => ({ sendTelegramMessage: async () => undefined }))

// Circuit breaker: `getActiveModel` e `recordOutcome` sono i due pezzi che il
// path web NON aveva. Il resto del modulo resta quello vero — mockare
// detectHallucination renderebbe vacuo il test sull'outcome.
const recordOutcomeCalls: Array<{ model: string; outcome: string }> = []
let modelloAttivo = 'claude-sonnet-5'
vi.mock('./circuit-breaker', async (orig) => {
  const actual = await orig<typeof import('./circuit-breaker')>()
  return {
    ...actual,
    getActiveModel: async () => modelloAttivo,
    recordOutcome: async (model: string, outcome: string) => {
      recordOutcomeCalls.push({ model, outcome })
    },
  }
})

import { callClaudeStream } from './claude'

beforeEach(() => {
  turnIndex = 0
  executedTools.length = 0
  recordOutcomeCalls.length = 0
  modelloAttivo = 'claude-sonnet-5'
  mockExecuteTool.mockClear()
  mockStream.mockClear()
})

function run() {
  return callClaudeStream(
    {
      systemPrompt: 'system',
      userQuery: 'crea il cantiere sul Registro',
      messages: [{ role: 'user', content: 'crea il cantiere sul Registro' }],
      entryPoint: 'chat',
    } as Parameters<typeof callClaudeStream>[0],
    { onText: () => {} },
  )
}

describe('callClaudeStream — tool concatenati senza testo in mezzo', () => {
  it('esegue il secondo tool anche se l iterazione non ha emesso testo', async () => {
    scriptedTurns = [
      // it.1: il modello annuncia e legge l'intestazione
      {
        text: 'Verifico le colonne del Registro Cantieri per compilare la riga correttamente.',
        toolUses: [{ id: 't1', name: 'leggi_intestazione_registro', input: {} }],
        stopReason: 'tool_use',
      },
      // it.2: incatena la scrittura SENZA preambolo testuale — il caso dell'incidente
      {
        text: '',
        toolUses: [{ id: 't2', name: 'scrivi_riga_registro', input: { committente: 'La Colla Domenico' } }],
        stopReason: 'tool_use',
      },
      // it.3: riferisce l'esito
      { text: 'Fatto: riga creata sul Registro.', toolUses: [], stopReason: 'end_turn' },
    ]

    const out = await run()

    expect(executedTools).toEqual(['leggi_intestazione_registro', 'scrivi_riga_registro'])
    expect(out).toContain('Fatto')
  })

  it('non lascia il turno muto quando il modello parte subito con un tool', async () => {
    scriptedTurns = [
      // it.1: nessun testo, va dritto al tool
      { text: '', toolUses: [{ id: 't1', name: 'leggi_intestazione_registro', input: {} }], stopReason: 'tool_use' },
      // it.2: ancora nessun testo, secondo tool
      { text: '', toolUses: [{ id: 't2', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
      // it.3: finalmente risponde
      { text: 'Riga creata.', toolUses: [], stopReason: 'end_turn' },
    ]

    const out = await run()

    expect(executedTools).toEqual(['leggi_intestazione_registro', 'scrivi_riga_registro'])
    // Non basta "una stringa qualsiasi": il messaggio di scusa la soddisfarebbe,
    // e un fix che esegue i tool ma poi interrompe comunque passerebbe il test.
    expect(out).toContain('Riga creata')
  })

  it('un modello che si impunta su una scrittura non la esegue 10 volte', async () => {
    // Il rischio introdotto togliendo il break: prima il loop si fermava al primo
    // giro muto, quindi un modello bloccato su scrivi_riga_registro scriveva UNA
    // riga. Senza la sintesi forzata ne scriverebbe dieci. Righe duplicate sul
    // Registro e foto doppie sono guasti gia' visti in produzione.
    scriptedTurns = [
      { text: 'Scrivo la riga.', toolUses: [{ id: 't0', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
      // da qui in poi il fake stream ripete l'ultimo turno all'infinito
      { text: '', toolUses: [{ id: 't1', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
    ]

    await run()

    // 1 con testo + NO_TEXT_LIMIT (5) muti, poi scatta tool_choice=none.
    // Il numero e' volutamente esatto: se qualcuno alza il tetto, questo test cade.
    expect(executedTools).toHaveLength(6)
    expect(new Set(executedTools)).toEqual(new Set(['scrivi_riga_registro']))
  })

  it('usa il modello ATTIVO, non quello di default, se il breaker ha fatto rollback', async () => {
    // Il path Telegram lo fa da sempre. Il web leggeva solo model_default:
    // con un default rotto, Telegram tornava a funzionare dopo il rollback e la
    // chat web restava sul modello rotto a tempo indeterminato.
    modelloAttivo = 'claude-sonnet-5-fallback'
    scriptedTurns = [{ text: 'ok', toolUses: [], stopReason: 'end_turn' }]

    await run()

    const primaChiamata = mockStream.mock.calls[0] as unknown as [{ model: string }]
    expect(primaChiamata[0]).toMatchObject({ model: 'claude-sonnet-5-fallback' })
  })

  it('registra l esito sul circuit breaker, come fa Telegram', async () => {
    // Senza, i fallimenti della chat web non contavano per far scattare il
    // rollback — quindi il web non contribuiva nemmeno a salvarsi da solo.
    scriptedTurns = [{ text: 'Fatto, ecco il risultato.', toolUses: [], stopReason: 'end_turn' }]

    await run()

    expect(recordOutcomeCalls).toHaveLength(1)
    expect(recordOutcomeCalls[0].outcome).toBe('success')
  })

  it('un turno muto viene registrato come "empty", non come riuscito', async () => {
    scriptedTurns = [{ text: '', toolUses: [], stopReason: 'end_turn' }]

    await run()

    expect(recordOutcomeCalls[0].outcome).toBe('empty')
  })

  it('registra sul modello DAVVERO usato', async () => {
    // La finestra del breaker e' chiavata sul modello: registrare sotto l'id
    // sbagliato lo disattiverebbe in silenzio.
    modelloAttivo = 'claude-opus-5'
    scriptedTurns = [{ text: 'ok', toolUses: [], stopReason: 'end_turn' }]

    await run()

    expect(recordOutcomeCalls[0].model).toBe('claude-opus-5')
  })

  it('un errore API viene registrato PRIMA di essere rilanciato', async () => {
    // Senza il try attorno al loop, l'eccezione risaliva alla route e
    // recordOutcome non veniva mai eseguito: il breaker non vedeva NESSUN
    // errore della chat web, cioe' proprio il caso per cui esiste.
    mockStream.mockImplementationOnce(() => { throw new Error('404 model not found') })

    await expect(run()).rejects.toThrow(/404/)

    expect(recordOutcomeCalls).toHaveLength(1)
    expect(recordOutcomeCalls[0].outcome).toBe('api_error')
  })

  it('una promessa a vuoto e una promessa MANTENUTA non sono la stessa cosa', async () => {
    // "Ho preparato il documento. Se vuole glielo mando" contiene un verbo di
    // azione ma il lavoro e' fatto: senza il guard veniva contato come
    // fallimento. Sui messaggi web veri erano 6 falsi positivi su 8.
    scriptedTurns = [{
      text: 'Ho preparato il documento. Se vuole glielo mando anche in PDF.',
      toolUses: [], stopReason: 'end_turn',
    }]

    await run()

    expect(recordOutcomeCalls[0].outcome).toBe('success')
  })

  it('una ricerca sul web conta come lavoro fatto, non come promessa a vuoto', async () => {
    // web_search e code_execution girano lato Anthropic e non passano da
    // executeToolBlocks: senza contarli, un turno risolto con una ricerca
    // avrebbe zero tool e "Verifico la normativa..." sarebbe giudicato una
    // promessa mancata.
    scriptedTurns = [{
      text: 'Verifico la normativa sui ponteggi e le riporto il riferimento.',
      toolUses: [], serverTools: ['web_search'], stopReason: 'end_turn',
    }]

    await run()

    expect(recordOutcomeCalls[0].outcome).toBe('success')
  })

  it('un turno che ha dovuto forzare la sintesi non e un successo', async () => {
    // Classificarlo 'success' iniettava successi nei turni degradati, rendendo
    // il breaker piu' difficile da far scattare invece che piu' facile.
    scriptedTurns = [
      { text: 'Scrivo la riga.', toolUses: [{ id: 't0', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
      { text: '', toolUses: [{ id: 't1', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
    ]

    await run()

    expect(recordOutcomeCalls[0].outcome).toBe('force_text')
  })

  it('non restituisce mai una risposta muta: se il modello non scrive mai, lo dice', async () => {
    // Il modello chiude il turno senza produrre un solo blocco di testo.
    // Prima l'utente riceveva 0 caratteri, indistinguibile da un bot che ignora.
    scriptedTurns = [{ text: '', toolUses: [], stopReason: 'end_turn' }]

    const out = await run()

    expect(out).toContain('Non sono riuscito a sintetizzare')
  })
})
