/**
 * Parita' fra i due canali: ogni caso gira sul loop WEB e sul loop TELEGRAM,
 * con le stesse asserzioni.
 *
 * Perche' esiste questo file. Cervellone parla su due canali e fino al 3
 * settembre 2026 girava su due loop copia-incollati che divergevano: una
 * correzione valeva per un canale solo. Il 2 settembre la chat web moriva a
 * meta' turno per un `break` che Telegram si era tolto il 24 maggio — tre mesi
 * di un difetto gia' risolto, vivo su un canale solo.
 *
 * La causa non era la distrazione: era che il loop web aveva 11 test e il loop
 * Telegram non ne aveva NESSUNO sulla sua logica interna. Un canale sorvegliato,
 * l'altro no.
 *
 * Da qui in poi il verde non si puo' avere su un canale solo: `describe.each`
 * esegue lo stesso corpo su entrambi. Una fix applicata a meta' fa cadere la
 * meta' scoperta.
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
/** Argomenti completi di ogni esecuzione: serve a verificare cosa il loop passa ai tool. */
const chiamateTool: Array<{ name: string; input?: Record<string, unknown>; convId?: string }> = []
const mockExecuteTool = vi.fn(async (name: string, input?: Record<string, unknown>, convId?: string) => {
  executedTools.push(name)
  chiamateTool.push({ name, input, convId })
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
// `saveMessageWithEmbedding` e' registrata, non solo silenziata: il loop Telegram
// scrive utente+assistente a DB e il web no (li scrive il browser). E' una
// differenza VOLUTA fra i canali, e un test qui sotto la pinna — senza,
// l'unificazione potrebbe farla sparire producendo righe doppie sul web.
const savedMessages: Array<{ role: string; text: string }> = []
vi.mock('./memory', () => ({
  searchMemory: async () => '',
  saveMessageWithEmbedding: async (_convId: string, role: string, text: string) => {
    savedMessages.push({ role, text })
  },
}))
// Catena Supabase permissiva: getConfig usa .select().in(), gli helper billing
// usano .select().eq().maybeSingle() e .upsert().
/** Stato dell'allarme "crediti Anthropic esauriti" letto dagli helper billing. */
let allarmeBillingArmato = false
/** Upsert osservati su cervellone_config: e' cosi' che si vede il riarmo dell'allarme. */
const upsertEseguiti: Array<Record<string, unknown>> = []
const supabaseChain: Record<string, unknown> = {}
Object.assign(supabaseChain, {
  select: () => supabaseChain,
  eq: () => supabaseChain,
  in: async () => ({ data: [] }),
  maybeSingle: async () => ({ data: { value: allarmeBillingArmato ? 'true' : 'false' } }),
  upsert: async (riga: Record<string, unknown>) => { upsertEseguiti.push(riga); return { error: null } },
  update: () => supabaseChain,
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

import { callClaudeStream, callClaudeStreamTelegram, runAgentTurn, type ChannelSink } from './claude'

beforeEach(() => {
  turnIndex = 0
  executedTools.length = 0
  recordOutcomeCalls.length = 0
  savedMessages.length = 0
  consegne.length = 0
  chiamateTool.length = 0
  upsertEseguiti.length = 0
  allarmeBillingArmato = false
  modelloAttivo = 'claude-sonnet-5'
  mockExecuteTool.mockClear()
  mockStream.mockClear()
})

// ── I due canali, dietro la stessa firma ──
// Le differenze di consegna (il web manda i delta, Telegram riscrive il
// messaggio) restano nei due adattatori: qui interessa che il MOTORE si
// comporti allo stesso modo.
type Richiesta = Parameters<typeof callClaudeStream>[0]

function richiestaBase(entryPoint: string): Richiesta {
  return {
    systemPrompt: 'system',
    userQuery: 'crea il cantiere sul Registro',
    messages: [{ role: 'user', content: 'crea il cantiere sul Registro' }],
    entryPoint,
    // Il conversationId c'e' SEMPRE, e non e' un dettaglio: la persistenza e'
    // gated da `conversationId && ...` prima ancora che dalla policy del canale.
    // Senza, il test "il web non scrive a DB" passerebbe perche' la scrittura e'
    // spenta a monte — verde su uno scenario che non e' quello in esame.
    // (Mutation testing 3 set 2026: due mutazioni sopravvissute per questo.)
    conversationId: 'conv-test',
  } as Richiesta
}

/** Tutto quello che il canale ha consegnato all'utente, nell'ordine. */
const consegne: string[] = []

// Il quarto elemento ricompone "cosa ha letto l'utente" dalle consegne: il web
// appende delta (vanno concatenati), Telegram riscrive il messaggio (vale
// l'ultima). Senza, un test potrebbe verificare solo il valore di RITORNO — e il
// valore di ritorno e' giusto anche quando all'utente non arriva niente.
const CANALI = [
  [
    'web',
    (req: Richiesta) => callClaudeStream(req, { onText: (t) => { consegne.push(t) } }),
    'chat',
    () => consegne.join(''),
  ],
  [
    'telegram',
    (req: Richiesta) => callClaudeStreamTelegram(req, async (acc) => { consegne.push(acc) }),
    'telegram',
    () => consegne[consegne.length - 1] ?? '',
  ],
] as const

describe.each(CANALI)('loop %s', (_canale, esegui, entryPoint, lettoDallUtente) => {
  const run = () => esegui(richiestaBase(entryPoint))

  it('esegue il secondo tool anche se l iterazione non ha emesso testo', async () => {
    // Incidente 2026-09-02, chat web: il bot scriveva "Verifico le colonne del
    // Registro Cantieri..." e il turno finiva li'. Il loop web conteneva
    // `if (!iterationHasText && i > 0) break`, che interrompeva PRIMA di eseguire
    // i tool dell'iterazione corrente. Incatenare due tool senza narrare in mezzo
    // e' comportamento normale del modello.
    scriptedTurns = [
      { text: 'Verifico le colonne del Registro Cantieri per compilare la riga correttamente.',
        toolUses: [{ id: 't1', name: 'leggi_intestazione_registro', input: {} }], stopReason: 'tool_use' },
      // il caso dell'incidente: incatena la scrittura SENZA preambolo testuale
      { text: '', toolUses: [{ id: 't2', name: 'scrivi_riga_registro', input: { committente: 'La Colla Domenico' } }], stopReason: 'tool_use' },
      { text: 'Fatto: riga creata sul Registro.', toolUses: [], stopReason: 'end_turn' },
    ]

    const out = await run()

    expect(executedTools).toEqual(['leggi_intestazione_registro', 'scrivi_riga_registro'])
    expect(out).toContain('Fatto')
  })

  it('non lascia il turno muto quando il modello parte subito con un tool', async () => {
    scriptedTurns = [
      { text: '', toolUses: [{ id: 't1', name: 'leggi_intestazione_registro', input: {} }], stopReason: 'tool_use' },
      { text: '', toolUses: [{ id: 't2', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
      { text: 'Riga creata.', toolUses: [], stopReason: 'end_turn' },
    ]

    const out = await run()

    expect(executedTools).toEqual(['leggi_intestazione_registro', 'scrivi_riga_registro'])
    // Non basta "una stringa qualsiasi": il messaggio di scusa la soddisfarebbe,
    // e un fix che esegue i tool ma poi interrompe comunque passerebbe il test.
    expect(out).toContain('Riga creata')
  })

  it('un modello che si impunta su una scrittura non la esegue 10 volte', async () => {
    // Il rischio di togliere il break: un modello bloccato su scrivi_riga_registro
    // arriverebbe a 10 esecuzioni REALI. Righe duplicate sul Registro e foto
    // doppie sono guasti gia' visti in produzione.
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
    // Con un default rotto, il canale che legge solo model_default resta fermo
    // a tempo indeterminato mentre l'altro e' gia' tornato a funzionare.
    modelloAttivo = 'claude-sonnet-5-fallback'
    scriptedTurns = [{ text: 'ok', toolUses: [], stopReason: 'end_turn' }]

    await run()

    const primaChiamata = mockStream.mock.calls[0] as unknown as [{ model: string }]
    expect(primaChiamata[0]).toMatchObject({ model: 'claude-sonnet-5-fallback' })
  })

  it('registra l esito sul circuit breaker', async () => {
    // Senza, i fallimenti di quel canale non contano per far scattare il
    // rollback — quindi il canale non contribuisce nemmeno a salvarsi da solo.
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

  it('un errore API viene registrato sul breaker', async () => {
    // Senza il try attorno al loop, l'eccezione risale alla route e
    // recordOutcome non viene mai eseguito: il breaker non vede NESSUN errore
    // di quel canale, cioe' proprio il caso per cui esiste.
    mockStream.mockImplementationOnce(() => { throw new Error('404 model not found') })

    await run().catch(() => undefined)

    expect(recordOutcomeCalls).toHaveLength(1)
    expect(recordOutcomeCalls[0].outcome).toBe('api_error')
  })

  it('un errore API arriva all utente tradotto, non in gergo tecnico', async () => {
    // D5. Su Telegram l'utente leggeva "Modello AI temporaneamente non
    // disponibile"; sul web leggeva `⚠️ 404 model not found: claude-...`,
    // perche' il loop web rilanciava e la route stampava il messaggio grezzo.
    mockStream.mockImplementationOnce(() => { throw new Error('404 model not found') })

    const out = await run()

    expect(out).toContain('temporaneamente non disponibile')
    expect(out).not.toContain('404 model not found')
  })

  it('una promessa a vuoto e una promessa MANTENUTA non sono la stessa cosa', async () => {
    // D2. "Ho preparato il documento. Se vuole glielo mando" contiene un verbo
    // di azione ma il lavoro e' fatto: senza il guard isCompletedOrConditional
    // viene contato come fallimento. Misurato: 6 falsi positivi su 8.
    // Il guard c'era solo sul web.
    scriptedTurns = [{
      text: 'Ho preparato il documento. Se vuole glielo mando anche in PDF.',
      toolUses: [], stopReason: 'end_turn',
    }]

    await run()

    expect(recordOutcomeCalls[0].outcome).toBe('success')
  })

  it('una ricerca sul web conta come lavoro fatto, non come promessa a vuoto', async () => {
    // D1. web_search e code_execution girano lato Anthropic e non passano da
    // executeToolBlocks: senza contarli, un turno risolto con una ricerca ha
    // zero tool e "Verifico la normativa..." e' giudicato promessa mancata,
    // spingendo il breaker verso un rollback immotivato.
    // I server tool erano contati solo sul web.
    scriptedTurns = [{
      text: 'Verifico la normativa sui ponteggi e le riporto il riferimento.',
      toolUses: [], serverTools: ['web_search'], stopReason: 'end_turn',
    }]

    await run()

    expect(recordOutcomeCalls[0].outcome).toBe('success')
  })

  it('un turno che ha dovuto forzare la sintesi non e un successo', async () => {
    // Classificarlo 'success' inietta successi nei turni degradati, rendendo il
    // breaker piu' difficile da far scattare invece che piu' facile.
    scriptedTurns = [
      { text: 'Scrivo la riga.', toolUses: [{ id: 't0', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
      { text: '', toolUses: [{ id: 't1', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
    ]

    await run()

    expect(recordOutcomeCalls[0].outcome).toBe('force_text')
  })

  it('non restituisce mai una risposta muta: se il modello non scrive mai, lo dice', async () => {
    // Prima l'utente riceveva 0 caratteri, indistinguibile da un bot che ignora.
    scriptedTurns = [{ text: '', toolUses: [], stopReason: 'end_turn' }]

    const out = await run()

    expect(out).toContain('Non sono riuscito a sintetizzare')
  })

  it('i tool ricevono la conversazione in cui stanno girando', async () => {
    // I tool che scrivono (archivia_foto, bozze mail, proposte) usano il
    // conversationId per attaccare l'esito alla conversazione giusta. Se il loop
    // non lo passa, il lavoro finisce su una conversazione sbagliata o su
    // nessuna — e l'utente non ritrova piu' quello che ha appena chiesto.
    scriptedTurns = [
      { text: 'Scrivo.', toolUses: [{ id: 't1', name: 'scrivi_riga_registro', input: { a: 1 } }], stopReason: 'tool_use' },
      { text: 'Fatto.', toolUses: [], stopReason: 'end_turn' },
    ]

    await run()

    expect(chiamateTool).toEqual([
      { name: 'scrivi_riga_registro', input: { a: 1 }, convId: 'conv-test' },
    ])
  })

  it('il testo che aggiunge il LOOP arriva all utente, non solo al valore di ritorno', async () => {
    // Il turno muto, l'errore API e l'avviso di budget non li scrive il modello:
    // li aggiunge il loop. Su un canale che appende (il web) devono passare dal
    // sink, altrimenti restano nel valore di ritorno e l'utente non li legge mai
    // — che e' esattamente com'era l'avviso di budget prima dell'unificazione.
    scriptedTurns = [{ text: '', toolUses: [], stopReason: 'end_turn' }]

    await run()

    expect(lettoDallUtente()).toContain('Non sono riuscito a sintetizzare')
  })

  it('anche il messaggio d errore arriva all utente', async () => {
    mockStream.mockImplementationOnce(() => { throw new Error('404 model not found') })

    await run()

    expect(lettoDallUtente()).toContain('temporaneamente non disponibile')
  })

  it('anche l avviso di budget esaurito arriva all utente', async () => {
    scriptedTurns = [
      { text: 'Comincio.', toolUses: [{ id: 't0', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
    ]

    await esegui({ ...richiestaBase(entryPoint), maxRunTokens: 1 } as Richiesta)

    expect(lettoDallUtente()).toContain('budget di elaborazione')
  })

  it('onora il budget token per-run passato dal chiamante', async () => {
    // D6. `maxRunTokens` era nel tipo ClaudeRequest ma solo Telegram lo leggeva:
    // il web usava la costante fissa. Con un budget minimo il loop deve fermarsi
    // al primo giro e dirlo, invece di proseguire.
    scriptedTurns = [
      { text: 'Comincio.', toolUses: [{ id: 't0', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
      { text: 'ancora', toolUses: [{ id: 't1', name: 'scrivi_riga_registro', input: {} }], stopReason: 'tool_use' },
    ]

    const out = await esegui({ ...richiestaBase(entryPoint), maxRunTokens: 1 } as Richiesta)

    expect(out).toContain('budget di elaborazione')
    expect(executedTools).toHaveLength(0)
  })
})

// ── Differenze VOLUTE fra i canali ──
// Non tutto deve essere uguale. Queste sono le uniche asimmetrie ammesse, e
// stanno qui scritte perche' l'unificazione non le cancelli per distrazione.
describe('cio che resta diverso, di proposito', () => {
  it('Telegram scrive i messaggi a DB, il web no (li scrive il browser)', async () => {
    // Sul web la riga la scrive il browser con una POST separata: scriverla
    // anche nel loop produceva DUE righe per ogni turno.
    scriptedTurns = [{ text: 'Fatto.', toolUses: [], stopReason: 'end_turn' }]

    await callClaudeStream(richiestaBase('chat'), { onText: () => {} })
    expect(savedMessages).toEqual([])

    turnIndex = 0
    scriptedTurns = [{ text: 'Fatto.', toolUses: [], stopReason: 'end_turn' }]
    await callClaudeStreamTelegram(richiestaBase('telegram'), async () => {})
    expect(savedMessages.map(m => m.role)).toEqual(['user', 'assistant'])
  })

  it('il web riceve il testo a delta, Telegram il testo accumulato', async () => {
    // L'unica differenza di consegna: il web appende allo stream HTTP, Telegram
    // riscrive lo stesso messaggio. Un motore che mandasse l'accumulato al web
    // farebbe vedere la risposta ripetuta a ogni frammento.
    //
    // Servono DUE frammenti di testo: con uno solo delta e accumulato
    // coincidono e il test non distingue i due casi (mutation testing 3 set
    // 2026: la mutazione "manda l'accumulato al web" sopravviveva).
    const dueFrammenti = (): FakeTurn[] => [
      { text: 'Primo. ', toolUses: [{ id: 't1', name: 'leggi_intestazione_registro', input: {} }], stopReason: 'tool_use' },
      { text: 'Secondo.', toolUses: [], stopReason: 'end_turn' },
    ]

    scriptedTurns = dueFrammenti()
    const delta: string[] = []
    await callClaudeStream(richiestaBase('chat'), { onText: (t) => delta.push(t) })
    // Ogni consegna e' SOLO l'incremento: nessuna contiene la precedente.
    expect(delta).toEqual(['Primo. ', 'Secondo.'])

    turnIndex = 0
    scriptedTurns = dueFrammenti()
    const accumulato: string[] = []
    await callClaudeStreamTelegram(richiestaBase('telegram'), async (acc) => { accumulato.push(acc) })
    // L'ultima consegna Telegram e' sempre il testo COMPLETO del turno.
    expect(accumulato[accumulato.length - 1]).toBe('Primo. Secondo.')
  })

  it('un turno riuscito riarma l allarme "crediti esauriti", su entrambi i canali', async () => {
    // L'alert billing si arma una volta sola e si disarma al primo turno
    // riuscito. Finche' stava solo su Telegram, un ripristino osservato dalla
    // chat web lasciava l'allarme armato per sempre: il successivo esaurimento
    // di credito non avrebbe piu' avvisato nessuno.
    for (const [nome, esegui] of [
      ['web', () => callClaudeStream(richiestaBase('chat'), { onText: () => {} })],
      ['telegram', () => callClaudeStreamTelegram(richiestaBase('telegram'), async () => {})],
    ] as const) {
      upsertEseguiti.length = 0
      allarmeBillingArmato = true
      turnIndex = 0
      scriptedTurns = [{ text: 'Fatto, ecco il risultato.', toolUses: [], stopReason: 'end_turn' }]

      await esegui()
      // Il reset e' fire-and-forget: lasciamo girare la microtask.
      await new Promise((r) => setTimeout(r, 0))

      expect(upsertEseguiti, `canale ${nome}`).toContainEqual(
        expect.objectContaining({ key: 'anthropic_billing_alerted', value: 'false' }),
      )
    }
  })
})

// ── Le guardie del loop ──
// Trovate scoperte dal mutation testing durante l'audit del 3 set 2026:
// disattivandole i 39 test di parita' restavano tutti verdi. Sono le guardie che
// impediscono al bot di dichiarare lavoro non fatto — cioe' esattamente quelle
// che nessuno si accorge se smettono di funzionare.
describe.each(CANALI)('guardie del loop, canale %s', (_canale, esegui, entryPoint) => {
  const run = () => esegui(richiestaBase(entryPoint))

  it('non consegna un archivio dichiarato ma mai avvenuto', async () => {
    // Il modello afferma di aver archiviato le foto senza che nessuna chiamata
    // ad archivia_foto sia andata a buon fine. Il loop lo ri-promptta UNA volta
    // e SCARTA la frase falsa, invece di consegnarla all'utente.
    scriptedTurns = [
      { text: 'Ho archiviato le foto nella cartella del cantiere.', toolUses: [], stopReason: 'end_turn' },
      { text: 'Chiedo scusa: quelle foto non risultano ancora archiviate.', toolUses: [], stopReason: 'end_turn' },
    ]

    const out = await run()

    // Non basta che ci sia la ritrattazione: la bugia non deve restare nel testo.
    expect(out).not.toContain('Ho archiviato le foto')
    expect(out).toContain('non risultano ancora archiviate')
  })

  it('non consegna una promessa al posto dell azione', async () => {
    // "Ora cerco il file" senza chiamare nessun tool: l'azione NON e' stata
    // eseguita. Il loop ri-promptta perche' agisca davvero, e scarta la promessa.
    scriptedTurns = [
      { text: 'Ora cerco il file sul Drive.', toolUses: [], stopReason: 'end_turn' },
      { text: '', toolUses: [{ id: 't1', name: 'leggi_intestazione_registro', input: {} }], stopReason: 'tool_use' },
      { text: 'Trovato: si chiama Registro Cantieri.', toolUses: [], stopReason: 'end_turn' },
    ]

    const out = await run()

    expect(executedTools).toEqual(['leggi_intestazione_registro'])
    expect(out).not.toContain('Ora cerco il file')
    expect(out).toContain('Trovato')
  })

  it('un errore a meta turno non cancella quello che il bot aveva gia detto', async () => {
    // Il caso vero: il bot legge 5 mail, comincia la sintesi, poi l'API cade.
    // Prima del 24 maggio il messaggio d'errore SOVRASCRIVEVA tutto il lavoro
    // gia' fatto. Il ramo che lo preserva non era coperto da nessun test: i due
    // test d'errore fallivano alla PRIMA chiamata, quindi esercitavano solo il
    // caso "nessun testo prodotto".
    scriptedTurns = [
      { text: 'Ho letto le prime 5 mail: due sono fatture.', toolUses: [{ id: 't1', name: 'leggi_intestazione_registro', input: {} }], stopReason: 'tool_use' },
    ]
    const implNormale = mockStream.getMockImplementation()!
    mockStream.mockImplementationOnce(implNormale)
    mockStream.mockImplementationOnce(() => { throw new Error('404 model not found') })

    const out = await run()

    expect(out).toContain('Ho letto le prime 5 mail')
    expect(out).toContain('temporaneamente non disponibile')
    expect(out).toContain('risposta parziale')
    expect(recordOutcomeCalls[0].outcome).toBe('api_error')
  })
})

// ── Il contratto fra motore e canale ──
// `runAgentTurn` e' il motore nudo: qui si verifica che avvisi il canale nei
// momenti in cui il canale DEVE saperlo. Senza queste notifiche il chiamante web
// archivia come lavoro finito una risposta troncata da un errore.
describe('runAgentTurn — cosa il motore promette al canale', () => {
  function sinkSpia() {
    const eventi: string[] = []
    const sink: ChannelSink = {
      onText: () => { eventi.push('text') },
      onAttemptStart: () => { eventi.push('attemptStart') },
      onApiError: () => { eventi.push('apiError') },
      onFinal: () => { eventi.push('final') },
      onServerTool: () => { eventi.push('serverTool') },
    }
    return { sink, eventi }
  }

  const policyProva = { tag: 'prova', entryPoint: 'chat', persistUserMessage: false, persistAssistantMessage: false }

  it('avvisa il canale quando il turno e fallito per un errore API', async () => {
    // E' il segnale che sostituisce l'eccezione che il web rilanciava fino al
    // 3 set 2026. Senza, la route salva bozze e documenti da una risposta
    // troncata a meta': "Gentile Ing. ... ⚠️ Errore temporaneo del servizio AI"
    // finisce archiviata come lettera pronta.
    mockStream.mockImplementationOnce(() => { throw new Error('404 model not found') })
    const { sink, eventi } = sinkSpia()

    await runAgentTurn(richiestaBase('chat'), sink, policyProva)

    expect(eventi).toContain('apiError')
  })

  it('NON avvisa di errore un turno riuscito', async () => {
    scriptedTurns = [{ text: 'Fatto.', toolUses: [], stopReason: 'end_turn' }]
    const { sink, eventi } = sinkSpia()

    await runAgentTurn(richiestaBase('chat'), sink, policyProva)

    expect(eventi).not.toContain('apiError')
    expect(eventi).toContain('final')
  })

  it('avvisa il canale a ogni ri-tentativo dello stream', async () => {
    // Telegram ci azzera i timer di consegna: senza, dopo un blip di rete il
    // messaggio resta fermo sul parziale gia' buttato via.
    scriptedTurns = [{ text: 'Fatto.', toolUses: [], stopReason: 'end_turn' }]
    mockStream.mockImplementationOnce(() => { throw new Error('overloaded') })
    const { sink, eventi } = sinkSpia()

    await runAgentTurn(richiestaBase('chat'), sink, policyProva)

    // Uno per il primo tentativo, uno per il ri-tentativo dopo il 529.
    expect(eventi.filter(e => e === 'attemptStart').length).toBeGreaterThanOrEqual(2)
  })

  it('una consegna che fallisce non impedisce di registrare l esito', async () => {
    // Sul web il sink scrive su uno stream HTTP che, quando l'utente chiude la
    // scheda, e' gia' chiuso e lancia. Se quel throw sfuggisse, salterebbe
    // recordOutcome: il circuit breaker resterebbe cieco proprio sui turni
    // finiti male, che sono l'unico motivo per cui esiste.
    mockStream.mockImplementationOnce(() => { throw new Error('404 model not found') })
    const sinkRotto: ChannelSink = {
      onText: () => { throw new Error('Invalid state: Controller is already closed') },
      onFinal: () => { throw new Error('Invalid state: Controller is already closed') },
    }

    await runAgentTurn(richiestaBase('chat'), sinkRotto, policyProva)

    expect(recordOutcomeCalls).toHaveLength(1)
    expect(recordOutcomeCalls[0].outcome).toBe('api_error')
  })
})
