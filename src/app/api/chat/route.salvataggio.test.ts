/**
 * La risposta della chat web la salva il SERVER.
 *
 * Fino all'8 settembre 2026 la scriveva il browser a streaming finito. Misurato
 * in produzione quel giorno: due turni conclusi con `success` (199 e 2.961
 * token, $0,27 in tutto) non sono mai arrivati in `messages`, perche' era
 * caduta la connessione mentre la risposta veniva consegnata. Lavoro fatto,
 * pagato e buttato via — e nessun modo di recuperarlo.
 *
 * Si salva nel route e non dentro il loop perche' qui il testo e' COMPLETO: i
 * link ai documenti archiviati nascono dopo il loop. Il test sui link sta qui
 * apposta, perche' salvarli nel posto sbagliato non romperebbe niente di
 * visibile: il link si vedrebbe durante il turno e sparirebbe riaprendo la
 * conversazione, cioe' proprio quando serve.
 *
 * Nessuna rete: tutto mockato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCallClaude = vi.fn()
const mockSaveSolaRiga = vi.fn()
const mockEmbedding = vi.fn()

vi.mock('@/lib/auth', () => ({ validateAuth: () => true }))
vi.mock('@/lib/rate-limiter', () => ({ rateLimit: () => true }))
vi.mock('@/lib/claude', () => ({
  callClaudeStream: (...args: unknown[]) => mockCallClaude(...args),
  trimMessages: (m: unknown) => m,
}))
vi.mock('@/lib/prompts', () => ({ getChatSystemPrompt: async () => 'system' }))
vi.mock('@/lib/memory', () => ({
  saveMessageOnly: (...args: unknown[]) => mockSaveSolaRiga(...args),
  saveEmbeddingOnly: (...args: unknown[]) => mockEmbedding(...args),
}))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => p }))
vi.mock('@/lib/artifact-capture', () => ({
  buildArtifactsPointer: async () => '',
  captureArtifact: async () => undefined,
}))
vi.mock('@/lib/image-memory', () => ({
  buildImagesPointer: async () => '',
  captureImageExtraction: async () => undefined,
}))
vi.mock('@/lib/working-memory', () => ({
  isWorkingMemoryEnabled: async () => false,
  buildProcedureContext: async () => '',
  buildActiveProjectContext: async () => '',
}))
vi.mock('@/lib/template-context', () => ({ buildTemplateContext: async () => '' }))
const mockFicStep2 = vi.fn()
vi.mock('@/lib/fic-write-tools', () => ({
  confirmFicStep1: async () => null,
  confirmFicStep2: (...args: unknown[]) => mockFicStep2(...args),
  cancelFic: async () => null,
}))
vi.mock('@/lib/sal-tools', () => ({
  confirmSalStep1: async () => null, confirmSalStep2: async () => null, cancelSal: async () => null,
}))
vi.mock('@/lib/societa-attiva', () => ({
  getSocietaAttiva: async () => 'restruktura', bloccoSocietaAttiva: () => '',
}))
vi.mock('@/lib/societa', () => ({ getSocieta: () => ({ nome: 'Restruktura' }) }))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'doc-1' } }) }) }),
    }),
  },
}))

import { POST } from './route'

function richiesta(testo = 'preparami la lettera al committente') {
  return {
    cookies: { get: () => ({ value: 'cookie-di-prova-abbastanza-lungo' }) },
    json: async () => ({
      messages: [{ role: 'user', content: testo }],
      conversationId: 'conv-1',
    }),
  } as unknown as Parameters<typeof POST>[0]
}

async function eseguiELeggi(testo?: string): Promise<string> {
  const res = await POST(richiesta(testo))
  return await res.text()
}

function loopChe(testo: string, motivo?: string) {
  mockCallClaude.mockImplementation(async (
    _req: unknown,
    callbacks: { onText: (t: string) => void; onTurnFailed?: (m: string) => void },
  ) => {
    if (motivo) callbacks.onTurnFailed?.(motivo)
    callbacks.onText(testo)
    return testo
  })
}

const LETTERA = '~~~document\n<h1>Lettera al committente</h1><p>Gentile Ing. Lentini.</p>\n~~~'

beforeEach(() => {
  vi.clearAllMocks()
  mockSaveSolaRiga.mockResolvedValue(true)
  mockFicStep2.mockResolvedValue(null)
  mockEmbedding.mockResolvedValue(undefined)
})

describe('POST /api/chat — la risposta la salva il server', () => {
  it('salva la risposta senza aspettare il browser', async () => {
    loopChe('Ecco la lettera pronta.')

    await eseguiELeggi()

    expect(mockSaveSolaRiga).toHaveBeenCalledTimes(1)
    const [convId, ruolo, testo] = mockSaveSolaRiga.mock.calls[0]
    expect(convId).toBe('conv-1')
    expect(ruolo).toBe('assistant')
    expect(testo).toContain('Ecco la lettera pronta.')
    // L'embedding parte, ma NON trattiene lo stream.
    expect(mockEmbedding).toHaveBeenCalledTimes(1)
  })

  it('salva ANCHE il link al documento, non solo il testo del modello', async () => {
    // Il link nasce nel route dopo il loop: se si salvasse dentro il loop,
    // l'Ingegnere lo vedrebbe durante il turno e non lo ritroverebbe piu'.
    loopChe(LETTERA + '\nEcco la lettera pronta.')

    const uscita = await eseguiELeggi()

    expect(uscita).toContain('Apri documento')
    const [, , testoSalvato] = mockSaveSolaRiga.mock.calls[0]
    expect(testoSalvato).toContain('Apri documento')
    expect(testoSalvato).toContain('/doc/doc-1')
  })

  it('un turno fallito entra nella storia ma NON nella memoria semantica', async () => {
    // Embeddare "non sono riuscito a sintetizzare" lo renderebbe recuperabile
    // da searchMemory come se fosse conoscenza.
    loopChe('Risposta troncata a meta', 'api_error')

    await eseguiELeggi()

    expect(mockSaveSolaRiga).toHaveBeenCalledTimes(1)
    expect(mockEmbedding).not.toHaveBeenCalled()
  })

  it('non scrive una riga vuota quando il modello non ha detto niente', async () => {
    loopChe('')

    await eseguiELeggi()

    expect(mockSaveSolaRiga).not.toHaveBeenCalled()
    expect(mockEmbedding).not.toHaveBeenCalled()
  })
})

describe('POST /api/chat — anche le risposte ai comandi vanno salvate', () => {
  // Trovato dall'audit dell'8 set 2026: i nove rami `return rispostaSemplice(...)`
  // escono PRIMA del salvataggio. Finche' a salvare era il browser non si
  // notava; da quando salva il server, la risposta a un comando sparirebbe.
  //
  // Il caso peggiore e' `/condividi_ok_`, che risponde con un link firmato: non
  // e' ricostruibile da nessuna parte. Ma vale anche per la conferma di una
  // fattura emessa e per "Mail inviata a...": riaprendo la conversazione si
  // troverebbe il comando e sotto il vuoto, e al turno dopo il modello
  // potrebbe ri-proporre un'operazione gia' fatta.
  it('la conferma di un comando finisce in messages', async () => {
    mockFicStep2.mockResolvedValue('✅ Fattura 2026/123 emessa.')

    const uscita = await eseguiELeggi('/fic_ok2_11111111-2222-3333-4444-555555555555')

    expect(uscita).toContain('Fattura 2026/123 emessa')
    expect(mockSaveSolaRiga).toHaveBeenCalledTimes(1)
    const [convId, ruolo, testo] = mockSaveSolaRiga.mock.calls[0]
    expect(convId).toBe('conv-1')
    expect(ruolo).toBe('assistant')
    expect(testo).toContain('Fattura 2026/123 emessa')
  })
})

describe('POST /api/chat — quello che il route deve passare al motore', () => {
  // L'audit sui test (8 set 2026): toglierE il 4o argomento a saveMessageOnly
  // lasciava la suite VERDE. `memory.salvataggio.test.ts` prova che il MOTORE
  // onora `creatoIl`; niente provava che il ROUTE glielo passasse. E' il
  // difetto della riga che si infila dopo la domanda successiva, e sarebbe
  // tornato senza un rosso.
  it('scrive la riga con l ISTANTE DEL TURNO, non con quello della scrittura', async () => {
    // Il turno DURA: il loop impiega tempo prima che si arrivi a salvare. Senza
    // questo ritardo l'istante del turno e quello della scrittura coincidono al
    // millisecondo e il test non distingue i due casi — era vacuo.
    mockCallClaude.mockImplementation(async (
      _req: unknown,
      callbacks: { onText: (t: string) => void },
    ) => {
      await new Promise((r) => setTimeout(r, 60))
      callbacks.onText('Ecco la risposta.')
      return 'Ecco la risposta.'
    })

    await eseguiELeggi()
    const dopoLaScrittura = new Date().toISOString()

    const [, , , creatoIl] = mockSaveSolaRiga.mock.calls[0]
    expect(typeof creatoIl).toBe('string')
    // L'istante deve essere PRECEDENTE alla fine del turno di almeno il tempo
    // che il loop ha impiegato: se fosse quello della scrittura, sarebbe qui.
    expect(new Date(dopoLaScrittura).getTime() - new Date(creatoIl).getTime())
      .toBeGreaterThanOrEqual(50)
  })

  // Stessa famiglia: togliere il tetto (`await scrittura` secco) lasciava tutto
  // verde, perche' il mock risolve sempre subito. Lo spinner bloccato fino a
  // 800 secondi sarebbe tornato in silenzio.
  it('se la scrittura non risponde, chiude lo stream invece di aspettarla', async () => {
    loopChe('Ecco la risposta.')
    // Una scrittura che non si risolve MAI: senza tetto, `controller.close()`
    // resterebbe dietro questa promessa.
    mockSaveSolaRiga.mockImplementation(() => new Promise(() => {}))

    const esito = await Promise.race([
      eseguiELeggi().then(() => 'stream chiuso'),
      new Promise((r) => setTimeout(() => r('APPESO'), 8_000)),
    ])

    expect(esito).toBe('stream chiuso')
  }, 15_000)
})

describe('POST /api/chat — anche i comandi hanno il tetto sullo stream', () => {
  // Il tetto era provato su UNO dei due `controller.close()`. I nove rami
  // `rispostaSemplice` (conferme FIC, SAL, mail, /condividi_ok_) potevano
  // restare appesi fino a `maxDuration` = 800 secondi senza un rosso.
  it('un comando non resta appeso se la scrittura non risponde', async () => {
    mockFicStep2.mockResolvedValue('✅ Fattura 2026/123 emessa.')
    mockSaveSolaRiga.mockImplementation(() => new Promise(() => {}))

    const esito = await Promise.race([
      eseguiELeggi('/fic_ok2_11111111-2222-3333-4444-555555555555').then(() => 'stream chiuso'),
      new Promise((r) => setTimeout(() => r('APPESO'), 8_000)),
    ])

    expect(esito).toBe('stream chiuso')
  }, 15_000)
})
