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
vi.mock('@/lib/fic-write-tools', () => ({
  confirmFicStep1: async () => 'fic1', confirmFicStep2: async () => 'fic2', cancelFic: async () => 'ficno',
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
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => catena } }))
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer: () => ({ from: () => catena }) }))
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
