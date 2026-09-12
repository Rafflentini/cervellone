/**
 * I comandi di conferma funzionano anche dalla chat web.
 *
 * Fino al 3 settembre 2026 la chat web ne gestiva quattro famiglie e Telegram
 * sette. Le tre mancanti — `/sal_*`, `/regola_*`, `/condividi_ok_` — erano il
 * buco piu' insidioso dell'equipollenza, perche' era GIA' raggiungibile: i tool
 * sono gli stessi sui due canali, quindi il modello puo' proporre un SAL o una
 * regola dalla chat web, e li' quel comando era solo testo mandato all'LLM.
 * Il flusso si apriva e non si poteva chiudere.
 *
 * Ogni caso verifica due cose: che il comando arrivi alla funzione giusta, e che
 * NON arrivi al modello.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCallClaude = vi.fn()
const mockSalStep1 = vi.fn()
const mockSalStep2 = vi.fn()
const mockSalCancel = vi.fn()
const mockRegolaAnteprima = vi.fn()
const mockRegolaConferma = vi.fn()
const mockRegolaRifiuta = vi.fn()
const mockRegolaRimuovi = vi.fn()
const mockRegoleList = vi.fn()
const mockShare = vi.fn()

vi.mock('@/lib/auth', () => ({ validateAuth: () => true }))
vi.mock('@/lib/rate-limiter', () => ({ rateLimit: () => true }))
vi.mock('@/lib/claude', () => ({
  callClaudeStream: (...a: unknown[]) => mockCallClaude(...a),
  trimMessages: (m: unknown) => m,
}))
vi.mock('@/lib/sal-tools', () => ({
  confirmSalStep1: (u: string) => mockSalStep1(u),
  confirmSalStep2: (u: string) => mockSalStep2(u),
  cancelSal: (u: string) => mockSalCancel(u),
}))
vi.mock('@/lib/regole-proposte', () => ({
  anteprimaRegola: (u: string) => mockRegolaAnteprima(u),
  confermaRegola: (u: string) => mockRegolaConferma(u),
  rifiutaRegola: (u: string) => mockRegolaRifiuta(u),
  rimuoviRegola: (u: string) => mockRegolaRimuovi(u),
  formatRegoleList: () => mockRegoleList(),
}))
vi.mock('@/lib/share-proposte', () => ({ confirmShareProposal: (u: string) => mockShare(u) }))

// Contorno: serve solo che non faccia rete.
vi.mock('@/lib/fic-write-tools', () => ({
  confirmFicStep1: async () => 'fic1', confirmFicStep2: async () => 'fic2', cancelFic: async () => 'ficno',
}))
vi.mock('@/lib/prompts', () => ({ getChatSystemPrompt: async () => 'system' }))
vi.mock('@/lib/artifact-capture', () => ({ buildArtifactsPointer: async () => '', captureArtifact: async () => undefined }))
vi.mock('@/lib/image-memory', () => ({ buildImagesPointer: async () => '', captureImageExtraction: async () => undefined }))
vi.mock('@/lib/working-memory', () => ({
  isWorkingMemoryEnabled: async () => false,
  buildProcedureContext: async () => '',
  buildActiveProjectContext: async () => '',
}))
vi.mock('@/lib/template-context', () => ({ buildTemplateContext: async () => '' }))
vi.mock('@/lib/societa-attiva', () => ({ getSocietaAttiva: async () => 'restruktura', bloccoSocietaAttiva: () => '' }))
vi.mock('@/lib/societa', () => ({ getSocieta: () => ({ nome: 'Restruktura' }) }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null }) }) }) }) },
}))

/**
 * Le bozze mail in attesa, pilotabili dal singolo test. Serve al blocco sul
 * silenzio, in fondo al file: il gemello su Telegram usa lo stesso trucco.
 */
let bozzeInAttesa: Array<{ uuid: string; to_addrs: string[]; subject: string }> = []
const catenaPending: Record<string, unknown> = {}
Object.assign(catenaPending, {
  select: () => catenaPending,
  eq: () => catenaPending,
  gt: () => catenaPending,
  order: () => catenaPending,
  limit: () => catenaPending,
  gte: () => catenaPending,
  lte: () => catenaPending,
  maybeSingle: async () => ({ data: bozzeInAttesa[0] ?? null, error: null }),
  then: (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: bozzeInAttesa, error: null })),
})

/**
 * Le pratiche SAL in attesa, viste dalla risoluzione del codice CORTO.
 *
 * Sta in uno stub DEDICATO alla sua tabella e non dentro `catenaPending`:
 * quella torna righe con la colonna `uuid` (la tabella delle bozze mail), e la
 * tabella dei SAL ha la chiave `id`. Confonderle vorrebbe dire misurare la
 * risoluzione su una colonna che nel mondo vero non c'è — un difetto dello
 * strumento travestito da difetto del codice (A2 della lista tarata).
 */
let salInAttesa: Array<{ id: string }> = []
let erroreLetturaSal: { message: string } | null = null
const catenaSal: Record<string, unknown> = {}
Object.assign(catenaSal, {
  select: () => catenaSal,
  eq: () => catenaSal,
  gte: () => catenaSal,
  lte: () => catenaSal,
  order: () => catenaSal,
  limit: () => catenaSal,
  then: (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: erroreLetturaSal ? null : salInAttesa, error: erroreLetturaSal })),
})
const instrada = (tabella: string) =>
  tabella === 'cervellone_sal_pending' ? catenaSal : catenaPending
vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({ from: (t: string) => instrada(t) }),
}))

import { POST } from './route'

const UUID = '11111111-2222-3333-4444-555555555555'

function richiesta(testo: string) {
  return {
    cookies: { get: () => ({ value: 'cookie-di-prova-abbastanza-lungo' }) },
    json: async () => ({ messages: [{ role: 'user', content: testo }], conversationId: 'conv-1' }),
  } as unknown as Parameters<typeof POST>[0]
}

async function invia(testo: string): Promise<string> {
  const res = await POST(richiesta(testo))
  return await res.text()
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSalStep1.mockResolvedValue('SAL: anteprima')
  mockSalStep2.mockResolvedValue('SAL: creato')
  mockSalCancel.mockResolvedValue('SAL: annullato')
  mockRegolaAnteprima.mockResolvedValue({ message: 'Regola: anteprima' })
  mockRegolaConferma.mockResolvedValue({ message: 'Regola: attiva' })
  mockRegolaRifiuta.mockResolvedValue({ message: 'Regola: rifiutata' })
  mockRegolaRimuovi.mockResolvedValue({ message: 'Regola: rimossa' })
  mockRegoleList.mockResolvedValue('Elenco regole')
  mockShare.mockResolvedValue('https://drive.example/link')
  mockCallClaude.mockResolvedValue('risposta del modello')
  bozzeInAttesa = []
  salInAttesa = []
  erroreLetturaSal = null
})

describe('POST /api/chat — comandi SAL (mancavano sul web)', () => {
  it('/sal_ok_ mostra l anteprima, senza passare dal modello', async () => {
    const out = await invia(`/sal_ok_${UUID}`)

    expect(mockSalStep1).toHaveBeenCalledWith(UUID)
    expect(out).toContain('SAL: anteprima')
    expect(mockCallClaude).not.toHaveBeenCalled()
  })

  it('/sal_ok2_ conferma davvero, e non viene mangiato dal prefisso piu corto', async () => {
    const out = await invia(`/sal_ok2_${UUID}`)

    expect(mockSalStep2).toHaveBeenCalledWith(UUID)
    expect(mockSalStep1).not.toHaveBeenCalled()
    expect(out).toContain('SAL: creato')
  })

  it('/sal_no_ annulla', async () => {
    await invia(`/sal_no_${UUID}`)
    expect(mockSalCancel).toHaveBeenCalledWith(UUID)
  })
})

describe('POST /api/chat — comandi regole apprese (mancavano sul web)', () => {
  it('/regola_ok_ mostra il testo letto dal DATABASE', async () => {
    // Il primo passo e' un'anteprima, non un'attivazione: cio' che viene
    // approvato lo scrive la route leggendo il DB, non il modello che potrebbe
    // parafrasarlo.
    const out = await invia(`/regola_ok_${UUID}`)

    expect(mockRegolaAnteprima).toHaveBeenCalledWith(UUID)
    expect(mockRegolaConferma).not.toHaveBeenCalled()
    expect(out).toContain('Regola: anteprima')
  })

  it('/regola_ok2_ attiva', async () => {
    await invia(`/regola_ok2_${UUID}`)
    expect(mockRegolaConferma).toHaveBeenCalledWith(UUID)
    expect(mockRegolaAnteprima).not.toHaveBeenCalled()
  })

  it('/regola_no_ e /regola_via_ finiscono nelle funzioni giuste', async () => {
    await invia(`/regola_no_${UUID}`)
    expect(mockRegolaRifiuta).toHaveBeenCalledWith(UUID)

    vi.clearAllMocks()
    mockRegolaRimuovi.mockResolvedValue({ message: 'Regola: rimossa' })
    await invia(`/regola_via_${UUID}`)
    expect(mockRegolaRimuovi).toHaveBeenCalledWith(UUID)
  })

  it('/regole elenca le proposte in attesa', async () => {
    const out = await invia('/regole')

    expect(mockRegoleList).toHaveBeenCalled()
    expect(out).toContain('Elenco regole')
    expect(mockCallClaude).not.toHaveBeenCalled()
  })
})

describe('POST /api/chat — condivisione documento (mancava sul web)', () => {
  it('/condividi_ok_ restituisce il link firmato', async () => {
    const out = await invia(`/condividi_ok_${UUID}`)

    expect(mockShare).toHaveBeenCalledWith(UUID)
    expect(out).toContain('https://drive.example/link')
  })

  it('una proposta scaduta lo dice, invece di restituire un link vuoto', async () => {
    mockShare.mockResolvedValue(null)

    const out = await invia(`/condividi_ok_${UUID}`)

    expect(out).toContain('non trovata, già usata o scaduta')
  })
})

describe('POST /api/chat — il dispatcher non mangia le conversazioni normali', () => {
  // Controllo positivo. Senza, tutte le asserzioni "non ha chiamato il modello"
  // qui sopra sarebbero verdi anche se la route non chiamasse MAI il modello.
  it('un messaggio normale arriva al modello', async () => {
    await invia('preparami il SAL del cantiere di Paterno')

    expect(mockCallClaude).toHaveBeenCalledTimes(1)
    expect(mockSalStep1).not.toHaveBeenCalled()
    expect(mockRegoleList).not.toHaveBeenCalled()
  })

  it('un comando con uuid malformato non esegue NIENTE...', async () => {
    // Se il dispatcher fosse troppo largo si mangerebbe del testo legittimo:
    // questa meta' della garanzia resta intatta.
    const out = await invia('/sal_ok_non-un-uuid')

    expect(mockSalStep1).not.toHaveBeenCalled()
    expect(mockSalStep2).not.toHaveBeenCalled()

    // ...E DAL 12 SET 2026 NON FINISCE PIU' AL MODELLO IN SILENZIO.
    // Prima questo test pretendeva `mockCallClaude` chiamato una volta: era il
    // contratto vecchio, e dentro c'era il difetto. Un codice troncato letto
    // come richiesta nuova e' esattamente cio' che ha prodotto cinque bozze
    // identiche, e l'Ingegnere non veniva avvisato di niente. Ora glielo si
    // dice.
    expect(mockCallClaude).not.toHaveBeenCalled()
    expect(out).toMatch(/senza il codice completo/i)
    expect(out).toMatch(/NON ho fatto niente/i)
  })
})

/**
 * Il codice dei comandi, cliccabile con UN tocco — sulla CHAT WEB.
 *
 * Il gemello di questo blocco sta in `src/app/api/telegram/route.comandi.test.ts`.
 * Sono due, uno per canale, perche' l'equipollenza si prova sugli ADATTATORI:
 * il modulo condiviso `comandi-uuid` e' lo stesso, ma «lo stesso motore» non
 * rende equipollenti i canali — e' proprio l'errore per cui su questo repo il
 * web e Telegram sono divergiti piu' volte.
 */
describe('POST /api/chat — il codice accettato in ENTRAMBE le forme', () => {
  const SENZA = '11111111222233334444555555555555'

  it('la forma NUOVA senza trattini arriva alla funzione giusta', async () => {
    await invia(`/sal_ok_${SENZA}`)
    // e ci arriva l'uuid CANONICO, coi trattini: il database non cambia formato
    expect(mockSalStep1).toHaveBeenCalledWith(UUID)
  })

  it('la forma VECCHIA coi trattini continua a funzionare', async () => {
    // I comandi gia' mandati in chat devono restare validi: una bozza in attesa
    // non si annulla perche' abbiamo cambiato il formato del codice.
    await invia(`/sal_ok_${UUID}`)
    expect(mockSalStep1).toHaveBeenCalledWith(UUID)
  })

  it('le due forme portano allo STESSO uuid', async () => {
    await invia(`/regola_ok_${SENZA}`)
    await invia(`/regola_ok_${UUID}`)
    const chiamate = mockRegolaAnteprima.mock.calls.map((c) => c[0])
    expect(chiamate).toEqual([UUID, UUID])
  })

  it('un codice TRONCATO non viene intercettato al posto di un altro', async () => {
    // Il troncamento di Telegram (`/sal_ok_11111111`) non deve diventare un
    // uuid plausibile che punta a un'altra pratica.
    await invia('/sal_ok_11111111')
    expect(mockSalStep1).not.toHaveBeenCalled()
  })
})

/**
 * 🚨 IL SILENZIO — sulla CHAT WEB.
 *
 * Gemello del blocco in `src/app/api/telegram/route.comandi.test.ts`. Due
 * test, uno per canale: l'equipollenza si prova sugli ADATTATORI, e su questo
 * repo e' proprio dandola per scontata che web e Telegram sono divergiti piu'
 * volte.
 */
describe('POST /api/chat — con una bozza in attesa, il silenzio e\' vietato', () => {
  const BOZZA = {
    uuid: '11111111-2222-3333-4444-555555555555',
    to_addrs: ['destinataria@esterno.it'],
    subject: 'Due contratti',
  }

  it('un messaggio breve non riconosciuto viene DETTO, non passato al modello', async () => {
    bozzeInAttesa = [BOZZA]
    const out = await invia('India.')

    expect(out).toMatch(/non ho inviato niente/i)
    // 16 cifre, non 32: gemello dell'asserzione in `telegram/route.comandi.test.ts`.
    // Il formato del comando è lo stesso sui due canali — l'equipollenza si
    // prova qui, non si deduce dal modulo condiviso.
    expect(out).toContain('/invia_1111111122223333')
    expect(mockCallClaude).not.toHaveBeenCalled()
  })

  it('lo dice anche per l\'assenso generico, che non conferma piu\'', async () => {
    bozzeInAttesa = [BOZZA]
    const out = await invia('ok')

    expect(out).toMatch(/non ho capito/i)
    expect(mockCallClaude).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO: SENZA bozze in attesa il messaggio breve va al modello', async () => {
    // Senza questo, il blocco potrebbe mangiarsi ogni messaggio corto — «ciao»,
    // «grazie» — e il test sopra sarebbe verde comunque.
    bozzeInAttesa = []
    await invia('ok')

    expect(mockCallClaude).toHaveBeenCalledTimes(1)
  })

  it('CONTROLLO POSITIVO: un messaggio LUNGO va al modello anche con una bozza in attesa', async () => {
    bozzeInAttesa = [BOZZA]
    await invia('preparami il computo del cantiere di Paterno per domani mattina')

    expect(mockCallClaude).toHaveBeenCalledTimes(1)
  })

  it('una conferma VERA invia, non viene scambiata per un messaggio da segnalare', async () => {
    // Il controllo positivo che conta di piu': se il blocco del silenzio
    // intercettasse anche le conferme buone, nessuna mail partirebbe mai piu'.
    bozzeInAttesa = [BOZZA]
    const out = await invia('invia')

    expect(out).not.toMatch(/non ho capito/i)
    expect(mockCallClaude).not.toHaveBeenCalled()
  })

  it('un comando col codice TRONCATO viene detto, non passato al modello', async () => {
    const out = await invia('/invia_11111111')

    expect(out).toMatch(/senza il codice completo/i)
    expect(mockCallClaude).not.toHaveBeenCalled()
  })
})
