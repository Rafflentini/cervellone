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
    // Nessuna parte e' stata letta → dalla giornata non si e' estratto NULLA.
    // Non e' 'partial': una giornata di lavoro archiviata come vuota non e' un
    // esito parzialmente riuscito, ed e' quello che per mesi si e' dichiarato 'ok'.
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error_message: expect.stringContaining('illeggibili') })
    )

    // summary_giornaliero viene comunque scritto (col fallback, nessun contenuto recuperato)
    const upsertCalls = mockUpsert.mock.calls
    const summaryUpsertCall = upsertCalls.find((args: any[]) =>
      args[0] && typeof args[0] === 'object' && 'summary_text' in args[0]
    )
    expect(summaryUpsertCall).toBeDefined()
    // La riga NON puo' dire "nessuna attivita": da una giornata con messaggi non si
    // e' estratto niente, ed e' la cosa che va detta. Quella stringa e' riservata
    // alle giornate DAVVERO vuote (ramo msgList.length === 0).
    expect(summaryUpsertCall?.[0].summary_text).toContain('Estrazione non riuscita')
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

    // Quello che questo test protegge e' che un rifiuto non-Error non faccia
    // COLLASSARE la funzione: torna, scrive la riga e dichiara la perdita.
    // L'asserzione era `status !== 'error'`, usata come sinonimo di "non e'
    // collassata" — ma dal 3 set 2026 'error' ha un altro significato: "da
    // questa giornata non si e' estratto niente", che qui e' vero e va detto.
    // Quindi si verifica l'intenzione vera, non il vecchio sinonimo.
    expect(result.ok).toBe(true)
    expect(result.skipped_chunks).toBeGreaterThan(0)
    expect(result.error).toBeUndefined()
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ completed_at: expect.any(String) })
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
    // contatore SEPARATO da skipped_chunks: sono perdite di natura diversa, e
    // confonderle renderebbe falso il messaggio d'errore del run
    expect(result.entita_scartate).toBe(1)
    expect(result.skipped_chunks).toBe(0)

    // il run e comunque 'partial', e il messaggio dice QUALE perdita e avvenuta
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'partial', error_message: '1 entita scartate' })
    )
  })
})

// ── Quanto si e perso, non solo quante volte (self-audit 2026-W36) ────────────
// Il report del 31/08 diceva "1 run ha scartato contenuto illeggibile: quella
// memoria e' persa" con severita alta. Il contenuto perso erano 29 caratteri.
// Il conteggio degli EVENTI non distingue un frammento vuoto da una giornata
// intera: senza la quantita, l'allarme non e' interpretabile.

describe('runMemoriaExtract — l esito dice QUANTO e stato scartato', () => {
  function esitoScritto() {
    const call = mockUpdate.mock.calls.find((args: any[]) =>
      args[0] && typeof args[0] === 'object' && 'status' in args[0] && 'completed_at' in args[0]
    )
    return call?.[0]
  }

  it('registra i caratteri scartati quando una parte e illeggibile', async () => {
    const testo = 'x'.repeat(29)
    mockLte.mockReturnValue({
      order: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 1, conversation_id: 'conv-corta', role: 'user', content: testo, created_at: '2026-08-24T18:14:22Z' },
          ],
          error: null,
        }),
      }),
    })

    // Il modello risponde in prosa invece che in JSON: parseExtraction ritorna null.
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Non ci sono informazioni rilevanti da estrarre.' }],
      usage: { input_tokens: 40, output_tokens: 12 },
      stop_reason: 'end_turn',
    })

    const { runMemoriaExtract } = await import('./memoria-extract')
    const res = await runMemoriaExtract('2026-08-24')

    expect(res.skipped_chunks).toBe(1)
    const esito = esitoScritto()
    expect(esito?.status).toBe('error') // nulla estratto: la giornata va rielaborata
    // La riga deve dire i caratteri, altrimenti "memoria persa" e "29 caratteri"
    // si leggono allo stesso modo.
    expect(esito?.error_message).toMatch(/caratteri/)
    // Cio che si e perso e' la PARTE di trascrizione, prefisso di ruolo incluso:
    // e' il testo che il modello non e' riuscito a leggere, non il solo messaggio.
    const trascrizionePersa = `[user]: ${testo}`
    expect(esito?.error_message).toContain(String(trascrizionePersa.length))
  })

  it('le entita fuori elenco non gonfiano i caratteri scartati: il testo e stato letto', async () => {
    // Servono ENTRAMBE le perdite nello stesso run, altrimenti il numero di
    // caratteri non compare affatto nel messaggio e l'asserzione sarebbe vera
    // per il motivo sbagliato: un test che non muore quando il codice mente.
    const persa = 'x'.repeat(29)
    const letta = 'y'.repeat(500)
    mockLte.mockReturnValue({
      order: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: [
            { id: 1, conversation_id: 'conv-persa', role: 'user', content: persa, created_at: '2026-08-24T18:14:22Z' },
            { id: 2, conversation_id: 'conv-letta', role: 'user', content: letta, created_at: '2026-08-24T18:20:00Z' },
          ],
          error: null,
        }),
      }),
    })

    // conv-persa: il modello risponde in prosa → parte persa per intero.
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'Non ci sono informazioni rilevanti da estrarre.' }],
      usage: { input_tokens: 40, output_tokens: 12 },
      stop_reason: 'end_turn',
    })
    // conv-letta: JSON valido, ma con un tipo di entita fuori elenco.
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"summary":"riassunto valido","entita":[{"name":"Tizio","type":"tipo_non_ammesso","context":"c"}]}' }],
      usage: { input_tokens: 200, output_tokens: 50 },
      stop_reason: 'end_turn',
    })

    const { runMemoriaExtract } = await import('./memoria-extract')
    await runMemoriaExtract('2026-08-24')

    const esito = esitoScritto()
    expect(esito?.status).toBe('partial') // una parte E' stata letta e riassunta: perdita parziale, non totale
    expect(esito?.error_message).toContain('entita scartate')
    // I caratteri contati devono essere SOLO quelli della parte persa: il testo
    // di conv-letta e' stato letto e riassunto, non e' andato perduto.
    const soloLaParsePersa = `[user]: ${persa}`.length
    expect(esito?.error_message).toContain(`(${soloLaParsePersa} caratteri)`)
  })
})

describe('runMemoriaExtract — "non ho estratto niente" non puo somigliare a "non e successo niente"', () => {
  // E' la riga che ha reso il guasto indiagnosticabile per mesi:
  //   allSummaries.join(' | ') || 'Nessuna attività rilevante'
  // scriveva la STESSA stringa usata per una giornata davvero vuota. Misurato il
  // 3 set 2026: 30 giornate con messaggi, 28 con quella stringa, 927 messaggi
  // archiviati come "non e successo niente" — fra cui il 17 agosto (74 messaggi)
  // e il 5 agosto (66, il caso Blasi, col cliente nominato dieci volte).
  // Nessun controllo poteva accorgersene: la riga non era vuota, conteneva 26
  // caratteri che dicevano una cosa falsa. [[feedback_misura_non_e_dato]]
  function giornataCon(messaggi: Array<{ conversation_id: string; content: string }>) {
    mockLte.mockReturnValue({
      order: vi.fn().mockReturnValue({
        order: vi.fn().mockResolvedValue({
          data: messaggi.map((m, i) => ({
            id: i + 1, conversation_id: m.conversation_id, role: 'user',
            content: m.content, created_at: '2026-08-05T10:00:00Z',
          })),
          error: null,
        }),
      }),
    })
  }
  function esitoScritto() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockUpdate.mock.calls.find((args: any[]) =>
      args[0] && typeof args[0] === 'object' && 'status' in args[0] && 'completed_at' in args[0]
    )
    return call?.[0]
  }
  function summaryScritto() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockUpsert.mock.calls.find((args: any[]) =>
      args[0] && typeof args[0] === 'object' && 'summary_text' in args[0]
    )
    return call?.[0]
  }

  it('una giornata con messaggi da cui non si estrae nulla lo DICE, e non e "ok"', async () => {
    giornataCon([{ conversation_id: 'conv-blasi', content: 'il fabbricato di Blasi Giuseppe, controlla se ha saldato' }])
    // JSON valido ma senza riassunto: parseExtraction riesce, il contenuto no.
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ entita: [], eventi: [] }) }],
      usage: { input_tokens: 300, output_tokens: 20 },
      stop_reason: 'end_turn',
    })

    const { runMemoriaExtract } = await import('./memoria-extract')
    await runMemoriaExtract('2026-08-05')

    expect(summaryScritto()?.summary_text).toContain('Estrazione non riuscita')
    expect(summaryScritto()?.summary_text).not.toBe('Nessuna attività rilevante')
    // Il numero di messaggi va nella riga: "1 messaggi" e "74 messaggi" non sono
    // la stessa perdita, e l'audit li leggerebbe con la stessa severita'.
    expect(summaryScritto()?.summary_text).toMatch(/1 messagg/)
    expect(esitoScritto()?.status).toBe('error')
    expect(esitoScritto()?.error_message).toMatch(/NESSUN riassunto/)
  })

  it('una parte letta ma senza riassunto viene CONTATA, non buttata in silenzio', async () => {
    // Due conversazioni: una risponde, l'altra torna JSON valido senza summary.
    // Prima questo secondo caso veniva scartato senza incrementare alcun
    // contatore, quindi il run restava 'ok' e la perdita non lasciava traccia.
    giornataCon([
      { conversation_id: 'conv-a', content: 'sopralluogo eseguito da Blasi Giuseppe' },
      { conversation_id: 'conv-b', content: 'seconda conversazione della giornata' },
    ])
    mockCreate
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({ summary: 'Sopralluogo eseguito', entita: [], eventi: [] }) }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: JSON.stringify({ summary: '', entita: [], eventi: [] }) }],
        usage: { input_tokens: 100, output_tokens: 20 },
      })

    const { runMemoriaExtract } = await import('./memoria-extract')
    await runMemoriaExtract('2026-08-05')

    // Qualcosa e' stato estratto → non e' un fallimento totale, ma NON e' 'ok'.
    expect(esitoScritto()?.status).toBe('partial')
    expect(esitoScritto()?.error_message).toMatch(/senza riassunto/)
    expect(summaryScritto()?.summary_text).toContain('Sopralluogo eseguito')
  })

  it('una giornata DAVVERO vuota continua a dire "Nessuna attività rilevante"', async () => {
    // Controllo positivo: la stringa non e' stata proibita, e' stata riservata al
    // caso in cui e' vera. Senza questo test, l'unico modo di far passare i due
    // sopra sarebbe cancellarla del tutto.
    giornataCon([]) // nessun messaggio nella finestra del giorno
    const { runMemoriaExtract } = await import('./memoria-extract')
    await runMemoriaExtract('2026-05-06')

    expect(summaryScritto()?.summary_text).toBe('Nessuna attività rilevante')
    expect(esitoScritto()?.status).toBe('ok')
  })
})

/**
 * La memoria ricostruita a mano non si cancella da sola.
 *
 * Quattro giornate di giugno hanno un riassunto ricostruito e ZERO messaggi
 * ancora in tabella: rielaborandole, il ramo "giornata vuota" avrebbe riscritto
 * "Nessuna attivita rilevante" e azzerato message_count — togliendo la riga
 * anche dal raggio dell'audit, che guarda solo message_count > 0. Non ci sono
 * backup. (audit avversariale 3 set 2026)
 */
describe('runMemoriaExtract — 0 messaggi non cancella un riassunto che ha contenuto', () => {
  const mockMaybeSingleLocale = vi.fn()

  function summaryScritto() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = mockUpsert.mock.calls.find((args: any[]) =>
      args[0] && typeof args[0] === 'object' && 'summary_text' in args[0]
    )
    return call?.[0]
  }

  /** La riga gia' presente per quella data, come la vedrebbe il server. */
  function riassuntoEsistente(riga: { summary_text: string; message_count: number } | null) {
    mockMaybeSingleLocale.mockResolvedValue({ data: riga, error: null })
    mockEq.mockReturnValue({
      maybeSingle: mockMaybeSingleLocale,
      order: mockOrder,
      eq: mockEq,
    })
    // Nessun messaggio nella finestra del giorno.
    mockLte.mockReturnValue({
      order: vi.fn().mockReturnValue({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }),
    })
  }

  it('NON sovrascrive quando la riga esistente dichiara messaggi e ha un riassunto vero', async () => {
    riassuntoEsistente({
      summary_text: 'DISASTRO POS: il bot ha perso i documenti e li ha rigenerati a modo suo.',
      message_count: 60,
    })
    const { runMemoriaExtract } = await import('./memoria-extract')

    const esito = await runMemoriaExtract('2026-06-03')

    expect(esito.ok).toBe(true)
    expect(summaryScritto()).toBeUndefined() // nessun upsert di summary
  })

  it('sovrascrive una giornata mai vista — controllo positivo', async () => {
    // Senza questo, una guardia che rifiuta SEMPRE passerebbe il test sopra e
    // bloccherebbe l estrazione notturna di ogni giornata vuota.
    riassuntoEsistente(null)
    const { runMemoriaExtract } = await import('./memoria-extract')

    await runMemoriaExtract('2026-05-06')

    expect(summaryScritto()?.summary_text).toBe('Nessuna attività rilevante')
  })

  it('sovrascrive il segnaposto anche se il conteggio dice che i messaggi c erano', async () => {
    // La riga che mentiva: 927 messaggi archiviati come "nessuna attivita".
    riassuntoEsistente({ summary_text: 'Nessuna attività rilevante', message_count: 74 })
    const { runMemoriaExtract } = await import('./memoria-extract')

    await runMemoriaExtract('2026-08-17')

    expect(summaryScritto()?.summary_text).toBe('Nessuna attività rilevante')
  })
})
