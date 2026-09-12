/**
 * Su Telegram le risposte ai comandi non le salvava nessuno.
 *
 * Nove famiglie di comandi (`/invia_`, `/conferma_`, `/accesso_ok*`, `/fic_ok*`,
 * `/sal_ok*`, `/regola_*`, `/condividi_ok_`, `/regole`, la conferma mail a
 * linguaggio naturale) facevano `sendTelegramMessage` e poi `return`: zero
 * scritture in `messages`. E nemmeno il comando dell'Ingegnere entrava, perche'
 * il `return` sta a monte di `runAgentTurn`, l'unico punto che scrive la riga
 * utente.
 *
 * Sul web la stessa cosa e' stata chiusa l'8 set (`rispostaSemplice` salva). Il
 * caso peggiore e' `/condividi_ok_`, che risponde con un LINK FIRMATO: non e'
 * ricostruibile da nessuna parte. Ed e' proprio il canale da cui l'Ingegnere
 * lavora dal cantiere.
 *
 * ⭐ Questo file e' anche il primo test in assoluto sulla route Telegram: 1175
 * righe senza una riga di copertura. Un test sul motore condiviso NON prova
 * l'adattatore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const inviati: Array<{ chatId: number; testo: string }> = []
const righe: Array<{ conv: string; role: string; testo: string }> = []
const mockShare = vi.fn()
const mockRegoleList = vi.fn()

vi.mock('@/lib/auth', () => ({ validateWebhookSecret: () => true }))
vi.mock('@/lib/rate-limiter', () => ({ rateLimit: () => true }))
vi.mock('@/lib/telegram-helpers', () => ({
  sendTelegramMessage: async (chatId: number, testo: string) => { inviati.push({ chatId, testo }); return true },
  sendTyping: async () => undefined,
  downloadTelegramFile: async () => null,
  buildContentBlocks: () => [],
  editTelegramMessage: async () => undefined,
}))
/** Quanto ci mette la scrittura a risolvere. Serve a distinguere "consegnata
 * allo sfondo" da "lanciata e dimenticata": con mock istantanei le due cose
 * sono indistinguibili, ed e' cosi' che una mutazione sopravvive. */
let ritardoScrittura = 0
vi.mock('@/lib/memory', () => ({
  saveMessageOnly: async (conv: string, role: string, testo: string) => {
    if (ritardoScrittura) await new Promise((r) => setTimeout(r, ritardoScrittura))
    righe.push({ conv, role, testo })
    return true
  },
  saveEmbeddingOnly: async () => true,
}))
vi.mock('@/lib/share-proposte', () => ({ confirmShareProposal: (u: string) => mockShare(u) }))
vi.mock('@/lib/regole-proposte', () => ({
  anteprimaRegola: async () => 'ant', confermaRegola: async () => 'conf',
  rifiutaRegola: async () => 'rif', rimuoviRegola: async () => 'rim',
  formatRegoleList: () => mockRegoleList(),
}))

// Contorno: non deve fare rete, e non deve arrivare al modello.
const mockRunAgentJob = vi.fn()
vi.mock('@/lib/agent-job', () => ({ runAgentJob: (...a: unknown[]) => mockRunAgentJob(...a) }))
const mockFicStep1 = vi.fn()
const mockFicStep2 = vi.fn()
const mockFicCancel = vi.fn()
vi.mock('@/lib/fic-write-tools', () => ({
  confirmFicStep1: (u: string) => mockFicStep1(u),
  confirmFicStep2: (u: string) => mockFicStep2(u),
  cancelFic: (u: string) => mockFicCancel(u),
}))
vi.mock('@/lib/sal-tools', () => ({
  confirmSalStep1: async () => 'sal1', confirmSalStep2: async () => 'sal2', cancelSal: async () => 'salno',
}))
vi.mock('@/lib/societa-documenti', () => ({ societaAttivaPerDocumenti: async () => undefined }))
vi.mock('@/lib/trascrizione', () => ({ transcribeAudio: async () => '' }))
vi.mock('@/lib/workflow/should-use-durable', () => ({ shouldUseDurable: () => false }))
vi.mock('@/lib/workflow/runs', () => ({ createRun: async () => ({ id: 'r' }), getActiveRunForChat: async () => null }))
vi.mock('workflow/api', () => ({ start: async () => ({ runId: 'r' }) }))
vi.mock('@/workflows/agent-task', () => ({ runAgentTask: {} }))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => { sfondo.push(p) } }))

const sfondo: Promise<unknown>[] = []
const catena: Record<string, unknown> = {}
Object.assign(catena, {
  select: () => catena, eq: () => catena, in: async () => ({ data: [] }),
  maybeSingle: async () => ({ data: null }), upsert: async () => ({ error: null }),
  insert: async () => ({ error: null }), update: () => catena, delete: () => catena,
  order: () => catena, limit: async () => ({ data: [] }), single: async () => ({ data: null }),
})
/**
 * Le bozze mail in attesa, pilotabili dal singolo test.
 *
 * Sta in uno stub DEDICATO alla sua tabella e non dentro `catena`: dare un
 * `then` a `catena` la trasformerebbe in un thenable per TUTTE le query di
 * questo file, e le altre risolverebbero il valore sbagliato. Un difetto
 * dello strumento di misura si traveste da difetto del codice.
 */
let bozzeInAttesa: Array<{ uuid: string; to_addrs: string[]; subject: string }> = []
const catenaPending: Record<string, unknown> = {}
Object.assign(catenaPending, {
  select: () => catenaPending,
  eq: () => catenaPending,
  gt: () => catenaPending,
  order: () => catenaPending,
  limit: () => catenaPending,
  maybeSingle: async () => ({ data: bozzeInAttesa[0] ?? null, error: null }),
  then: (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: bozzeInAttesa, error: null })),
})
/**
 * Le bozze FIC in attesa, viste dalla risoluzione del codice CORTO
 * (`espandiCodiceBreve`, chiamata prima di leggere qualunque comando).
 *
 * Sta in uno stub dedicato e non dentro `catena`: quella torna sempre righe
 * vuote per `limit`, e la risoluzione del prefisso ha bisogno di righe VERE
 * con la colonna `id` per decidere se risolve, è ambigua o è assente.
 */
let ficPendingIds: string[] = []
const catenaFic: Record<string, unknown> = {}
Object.assign(catenaFic, {
  select: () => catenaFic,
  gte: () => catenaFic,
  lte: () => catenaFic,
  limit: () => catenaFic,
  then: (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: ficPendingIds.map((id) => ({ id })), error: null })),
})
const instrada = (tabella: string) =>
  tabella === 'cervellone_email_pending_send' ? catenaPending
    : tabella === 'cervellone_fic_pending' ? catenaFic
      : catena

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => instrada(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({ from: (t: string) => instrada(t) }),
}))
vi.mock('@/lib/resilience', () => ({ safeSupabase: async (_f: unknown, fallback: unknown) => fallback }))

function richiesta(testo: string) {
  return {
    json: async () => ({ message: { chat: { id: 12345 }, text: testo, from: { id: 12345 } } }),
    headers: new Headers(),
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TELEGRAM_ALLOWED_IDS = '12345'
  inviati.length = 0
  righe.length = 0
  sfondo.length = 0
  ritardoScrittura = 0
  mockShare.mockResolvedValue('🔗 Ecco il link: https://esempio.it/doc/abc?firma=xyz')
  mockRegoleList.mockResolvedValue('nessuna regola')
  bozzeInAttesa = []
  ficPendingIds = []
  mockFicStep1.mockResolvedValue('fic1')
  mockFicStep2.mockResolvedValue('fic2')
  mockFicCancel.mockResolvedValue('ficno')
})

const UUID = '11111111-2222-3333-4444-555555555555'

describe('Telegram — la risposta a un comando finisce in messages', () => {
  it('/condividi_ok_ : il link firmato entra nella storia, insieme al comando', async () => {
    const { POST } = await import('./route')
    await POST(richiesta(`/condividi_ok_${UUID}`))
    await Promise.all(sfondo)

    // E' arrivato all'Ingegnere...
    expect(inviati.map((i) => i.testo).join(' ')).toContain('firma=xyz')
    // ...e sta anche in storia, con il comando che lo ha prodotto.
    expect(righe.map((r) => r.role)).toEqual(['user', 'assistant'])
    expect(righe[0].testo).toContain('/condividi_ok_')
    expect(righe[1].testo).toContain('firma=xyz')
    // e NON e' passato dal modello
    expect(mockRunAgentJob).not.toHaveBeenCalled()
  })

  // La risposta all'Ingegnere non deve aspettare il database, ma la scrittura
  // non deve nemmeno essere lasciata cadere: va consegnata a waitUntil, che e'
  // l'unico modo perche' la function Vercel non muoia prima che arrivi.
  it('la scrittura lenta viene consegnata allo sfondo, non persa', async () => {
    ritardoScrittura = 50
    const { POST } = await import('./route')
    await POST(richiesta(`/condividi_ok_${UUID}`))

    // Il webhook ha gia' risposto, e il link e' gia' partito.
    expect(inviati.map((i) => i.testo).join(' ')).toContain('firma=xyz')
    expect(righe).toHaveLength(0)

    await Promise.all(sfondo)
    expect(righe.map((r) => r.role)).toEqual(['user', 'assistant'])
  })

  // CONTROLLO POSITIVO: senza, un test che non arriva mai al ramo dei comandi
  // passerebbe le asserzioni "non chiamato" a mani basse.
  it('un messaggio normale invece va al modello', async () => {
    const { POST } = await import('./route')
    await POST(richiesta('quanto devo versare a settembre?'))
    await Promise.all(sfondo)

    expect(mockRunAgentJob).toHaveBeenCalled()
  })
})

/**
 * Il codice dei comandi, cliccabile con UN tocco — su TELEGRAM.
 *
 * Il gemello sta in `src/app/api/chat/route.comandi.test.ts`. Due test, uno per
 * canale: il modulo `comandi-uuid` e' condiviso, ma un motore condiviso NON
 * rende equipollenti i canali, e su questo repo il web e Telegram sono
 * divergiti piu' volte proprio dandolo per scontato.
 *
 * Il difetto che chiudono: Telegram rende cliccabile un comando solo se e'
 * fatto di [A-Za-z0-9_]. Coi trattini il client si fermava al primo `-` e
 * toccando il comando mandava `/condividi_ok_11111111` — troncato e inutile.
 */
describe('Telegram — il codice accettato in ENTRAMBE le forme', () => {
  const SENZA = '11111111222233334444555555555555'

  it('la forma NUOVA senza trattini arriva alla funzione giusta', async () => {
    const { POST } = await import('./route')
    await POST(richiesta(`/condividi_ok_${SENZA}`))
    await Promise.all(sfondo)

    // e ci arriva l'uuid CANONICO: il formato del comando cambia, quello del
    // database no.
    expect(mockShare).toHaveBeenCalledWith(UUID)
    expect(mockRunAgentJob).not.toHaveBeenCalled()
  })

  it('la forma VECCHIA coi trattini continua a funzionare', async () => {
    const { POST } = await import('./route')
    await POST(richiesta(`/condividi_ok_${UUID}`))
    await Promise.all(sfondo)

    expect(mockShare).toHaveBeenCalledWith(UUID)
  })

  it('un codice TRONCATO non viene intercettato al posto di un altro', async () => {
    const { POST } = await import('./route')
    await POST(richiesta('/condividi_ok_11111111'))
    await Promise.all(sfondo)

    expect(mockShare).not.toHaveBeenCalled()
  })
})

/**
 * 🚨 IL SILENZIO — su TELEGRAM.
 *
 * Parole dell'Ingegnere, 12 set 2026: «non mi dice ne' che non lo ha fatto ne'
 * che problema ha, questa cosa non dovrebbe succedere». Con una bozza in
 * attesa, un messaggio breve non riconosciuto come conferma faceva ricominciare
 * il modello da zero, che preparava un'altra bozza. Cinque volte.
 *
 * Il gemello sta in `src/app/api/chat/route.comandi.test.ts`. Due test, uno per
 * canale: l'equipollenza si prova sugli adattatori.
 */
describe('Telegram — con una bozza in attesa, il silenzio e\' vietato', () => {
  const BOZZA = {
    uuid: '11111111-2222-3333-4444-555555555555',
    to_addrs: ['destinataria@esterno.it'],
    subject: 'Due contratti',
  }

  it('un messaggio breve non riconosciuto viene DETTO, non passato al modello', async () => {
    bozzeInAttesa = [BOZZA]
    const { POST } = await import('./route')
    await POST(richiesta('India.'))
    await Promise.all(sfondo)

    const detto = inviati.map((i) => i.testo).join('\n')
    expect(detto).toMatch(/non ho inviato niente/i)
    // gli da' la frase esatta che funziona...
    expect(detto).toMatch(/invia/i)
    // ...e il comando toccabile, senza trattini
    // 16 cifre, non 32: Telegram rende cliccabile un comando solo se sta in 32
    // caratteri dopo la barra, e `invia_` + 32 = 38. L'asserzione resta sul
    // testo esatto, così un cambio silenzioso del formato rompe il test.
    expect(detto).toContain('/invia_1111111122223333')
    // e soprattutto NON ricomincia da zero
    expect(mockRunAgentJob).not.toHaveBeenCalled()
  })

  it('lo dice anche per l\'assenso generico, che non conferma piu\'', async () => {
    bozzeInAttesa = [BOZZA]
    const { POST } = await import('./route')
    await POST(richiesta('ok'))
    await Promise.all(sfondo)

    expect(inviati.map((i) => i.testo).join('\n')).toMatch(/non ho capito/i)
    expect(mockRunAgentJob).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO: SENZA bozze in attesa il messaggio breve va al modello', async () => {
    // Senza questo, il blocco potrebbe mangiarsi ogni messaggio corto della
    // giornata — «ciao», «grazie» — e il test sopra sarebbe verde comunque.
    bozzeInAttesa = []
    const { POST } = await import('./route')
    await POST(richiesta('ok'))
    await Promise.all(sfondo)

    expect(mockRunAgentJob).toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO: un messaggio LUNGO va al modello anche con una bozza in attesa', async () => {
    bozzeInAttesa = [BOZZA]
    const { POST } = await import('./route')
    await POST(richiesta('preparami il computo del cantiere di Paterno per domani mattina'))
    await Promise.all(sfondo)

    expect(mockRunAgentJob).toHaveBeenCalled()
  })

  it('un comando col codice TRONCATO viene detto, non passato al modello', async () => {
    const { POST } = await import('./route')
    await POST(richiesta('/invia_11111111'))
    await Promise.all(sfondo)

    const detto = inviati.map((i) => i.testo).join('\n')
    expect(detto).toMatch(/senza il codice completo/i)
    expect(detto).toMatch(/NON ho fatto niente/i)
    expect(mockRunAgentJob).not.toHaveBeenCalled()
  })
})

/**
 * Task 16 — su TELEGRAM, i comandi di conferma FIC diventano toccabili.
 *
 * Fino al 12 set `fic_ok`/`fic_ok2`/`fic_no` erano le uniche famiglie scritte
 * a mano, con l'uuid intero: 39 caratteri, oltre il limite di Telegram, e
 * comunque troncati al primo trattino. Il gemello sta in
 * `src/app/api/chat/route.comandi.test.ts`.
 */
describe('Telegram — comandi FIC via codice CORTO (il buco del 12 set)', () => {
  const UUID_FIC = '3f3fc82f-4daa-408e-9308-78effecc338e'
  const CORTO = UUID_FIC.replace(/-/g, '').slice(0, 16)

  it('un fic_ok corto si espande, trova il pending e procede', async () => {
    ficPendingIds = [UUID_FIC]
    const { POST } = await import('./route')
    await POST(richiesta(`/fic_ok_${CORTO}`))
    await Promise.all(sfondo)

    expect(mockFicStep1).toHaveBeenCalledWith(UUID_FIC)
    expect(inviati.map((i) => i.testo).join(' ')).toContain('fic1')
    expect(mockRunAgentJob).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO: un prefisso ambiguo NON viene risolto a caso', async () => {
    const GEMELLO = '3f3fc82f-4daa-408e-0000-000000000001'
    ficPendingIds = [UUID_FIC, GEMELLO]
    const { POST } = await import('./route')
    await POST(richiesta(`/fic_ok_${CORTO}`))
    await Promise.all(sfondo)

    expect(mockFicStep1).not.toHaveBeenCalled()
    expect(inviati.map((i) => i.testo).join(' ')).toMatch(/NON ho fatto niente/)
  })
})
