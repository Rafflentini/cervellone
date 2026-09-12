/**
 * src/app/api/telegram/route.guardia-autorizza.test.ts — la via d'uscita dal
 * blocco sui dati societari (Task 12), su TELEGRAM.
 *
 * Il gemello sta in `src/app/api/chat/route.guardia-autorizza.test.ts`. Per
 * il PERCORSO DELLA GUARDIA i due file mockano LO STESSO insieme di moduli —
 * `@/lib/guardia-autorizzazioni` (con la stessa forma) e
 * `@/lib/supabase-server` (con la stessa tabella finta
 * `cervellone_guardia_autorizzazioni`) — cosi' quello che provano e' davvero
 * confrontabile (vedi note-task-6.md: due test che mockano insiemi diversi
 * non sono un test di equipollenza). Il resto e' impalcatura specifica del
 * canale (qui: webhook/agent-job/sendTelegramMessage; sul web:
 * auth/rate-limit/claude-stream) — dichiarata anche nel rapporto del Task 12.
 *
 * Cosa provano, dal brief (Step 6): identico al gemello sulla chat web.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

const inviati: Array<{ chatId: number; testo: string }> = []
const mockRunAgentJob = vi.fn()

vi.mock('@/lib/auth', () => ({ validateWebhookSecret: () => true }))
vi.mock('@/lib/rate-limiter', () => ({ rateLimit: () => true }))
vi.mock('@/lib/telegram-helpers', () => ({
  sendTelegramMessage: async (chatId: number, testo: string) => { inviati.push({ chatId, testo }); return true },
  sendTyping: async () => undefined,
  downloadTelegramFile: async () => null,
  buildContentBlocks: () => [],
  editTelegramMessage: async () => undefined,
}))
vi.mock('@/lib/memory', () => ({
  saveMessageOnly: async () => true,
  saveEmbeddingOnly: async () => true,
}))
vi.mock('@/lib/agent-job', () => ({ runAgentJob: (...a: unknown[]) => mockRunAgentJob(...a) }))
vi.mock('@/lib/societa-documenti', () => ({ societaAttivaPerDocumenti: async () => undefined }))
vi.mock('@/lib/trascrizione', () => ({ transcribeAudio: async () => '' }))
vi.mock('@/lib/workflow/should-use-durable', () => ({ shouldUseDurable: () => false }))
vi.mock('@/lib/workflow/runs', () => ({ createRun: async () => ({ id: 'r' }), getActiveRunForChat: async () => null }))
vi.mock('workflow/api', () => ({ start: async () => ({ runId: 'r' }) }))
vi.mock('@/workflows/agent-task', () => ({ runAgentTask: {} }))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => { sfondo.push(p) } }))
// ⚠️ Il mock e' COMPLETO di proposito (tutti e cinque gli export), non ridotto
// a quello che serve oggi.
//
// Un mock parziale non e' una scorciatoia: e' una mina che scoppia il giorno in
// cui qualcuno chiama l'export che manca — ed e' scoppiata due volte il 12 set
// 2026, con `leggiSocietaAttiva` e con `societaPerDocumento`, in test che
// sembravano rotti dal codice nuovo e invece erano rotti dal proprio mock.
//
// NOTA sull'onesta' di questo commento: nella prima stesura qui c'era scritto
// che `withRetry` mancante causava i 2 secondi del primo test. **Era falso.**
// L'esperimento (completare il mock e rimisurare) ha lasciato il test a 2.002ms:
// la causa era la compilazione del modulo, vedi il `beforeAll` piu' sotto. Il
// mock resta completo perche' e' giusto cosi', non perche' risolveva quello.
vi.mock('@/lib/resilience', () => ({
  safeSupabase: async (_f: unknown, fallback: unknown) => fallback,
  withRetry: async (f: () => unknown) => f(),
  trackEmbeddingFailure: () => {},
  resetEmbeddingFailure: () => {},
  getHealthStatus: () => ({ ok: true }),
}))

const sfondo: Promise<unknown>[] = []
/** Tabelle di contorno non toccate da questi test: righe vuote, non rete. */
const catenaGenerica: Record<string, unknown> = {}
Object.assign(catenaGenerica, {
  select: () => catenaGenerica, eq: () => catenaGenerica, in: async () => ({ data: [] }),
  maybeSingle: async () => ({ data: null }), upsert: async () => ({ error: null }),
  insert: async () => ({ error: null }), update: () => catenaGenerica, delete: () => catenaGenerica,
  order: () => catenaGenerica, limit: async () => ({ data: [] }), single: async () => ({ data: null }),
  gte: () => catenaGenerica, lte: () => catenaGenerica,
  then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: [], error: null })),
})

// ── Da qui in giù: il percorso della guardia, IDENTICO al gemello web ──

const mockConcedi = vi.fn()
vi.mock('@/lib/guardia-autorizzazioni', () => ({
  concediAutorizzazione: (u: string) => mockConcedi(u),
}))

/** Le autorizzazioni in attesa, viste dalla risoluzione del codice CORTO. */
let autorizzazioniInAttesa: string[] = []
const catenaAutorizzazioni: Record<string, unknown> = {}
Object.assign(catenaAutorizzazioni, {
  select: () => catenaAutorizzazioni,
  gte: () => catenaAutorizzazioni,
  lte: () => catenaAutorizzazioni,
  limit: () => catenaAutorizzazioni,
  then: (resolve: (v: unknown) => unknown) =>
    Promise.resolve(resolve({ data: autorizzazioniInAttesa.map((uuid) => ({ uuid })), error: null })),
})
const instrada = (tabella: string) =>
  tabella === 'cervellone_guardia_autorizzazioni' ? catenaAutorizzazioni : catenaGenerica

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => instrada(t) } }))
vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({ from: (t: string) => instrada(t) }),
}))

function richiesta(testo: string) {
  return {
    json: async () => ({ message: { chat: { id: 12345 }, text: testo, from: { id: 12345 } } }),
    headers: new Headers(),
  } as never
}

/**
 * ⚠️ Il modulo della route si carica QUI, non dentro il primo test.
 *
 * Misurato il 13 set 2026: i sei test fanno tutti `await import('./route')`, ma
 * il primo impiegava **1.990 ms** e gli altri 1-16 ms. Non era un'attesa
 * nascosta: erano due secondi di **compilazione** della route e di tutto il suo
 * albero di dipendenze, pagati una volta sola e poi serviti dalla cache.
 *
 * Sotto carico pieno (197 file di test in parallelo) quei due secondi
 * sforavano il tetto di 5s per singolo test, e la suite falliva **una volta su
 * due** — un rosso che non era una regressione, cioe' la cosa che insegna a
 * ignorare il rosso.
 *
 * Pagando il costo in un hook, il tetto che conta e' quello degli hook e i test
 * restano dentro i loro millisecondi. Non si alza nessun limite: si sposta il
 * lavoro dove non finge di essere lento.
 */
beforeAll(async () => {
  await import('./route')
}, 60_000)

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TELEGRAM_ALLOWED_IDS = '12345'
  inviati.length = 0
  sfondo.length = 0
  autorizzazioniInAttesa = []
  mockConcedi.mockResolvedValue({ ok: true })
})

const UUID = '3f3fc82f-4daa-408e-9308-78effecc338e'
const CORTO = UUID.replace(/-/g, '').slice(0, 16)

describe('Telegram — /doc_ok_ e /doc_no_ (Task 12: la via d\'uscita)', () => {
  it('il codice CORTO si risolve: arriva ed e\' tappabile, e chiama concediAutorizzazione con l\'uuid INTERO', async () => {
    autorizzazioniInAttesa = [UUID]
    const { POST } = await import('./route')
    await POST(richiesta(`/doc_ok_${CORTO}`))
    await Promise.all(sfondo)

    expect(mockConcedi).toHaveBeenCalledWith(UUID)
    expect(inviati.map((i) => i.testo).join(' ')).not.toMatch(/NON ho fatto niente/)
    expect(mockRunAgentJob).not.toHaveBeenCalled()
  })

  it('tapparlo (/doc_ok_) concede l\'autorizzazione e lo dice, senza passare dal modello', async () => {
    autorizzazioniInAttesa = [UUID]
    mockConcedi.mockResolvedValue({ ok: true })
    const { POST } = await import('./route')
    await POST(richiesta(`/doc_ok_${CORTO}`))
    await Promise.all(sfondo)

    expect(mockConcedi).toHaveBeenCalledWith(UUID)
    expect(inviati.map((i) => i.testo).join(' ')).toMatch(/autorizzat/i)
    expect(mockRunAgentJob).not.toHaveBeenCalled()
  })

  it('un\'autorizzazione scaduta o gia\' usata lo DICE, non finge un successo', async () => {
    autorizzazioniInAttesa = [UUID]
    mockConcedi.mockResolvedValue({ ok: false, motivo: 'questo codice e\' scaduto' })
    const { POST } = await import('./route')
    await POST(richiesta(`/doc_ok_${CORTO}`))
    await Promise.all(sfondo)

    expect(inviati.map((i) => i.testo).join(' ')).toMatch(/scadut/i)
    expect(mockRunAgentJob).not.toHaveBeenCalled()
  })

  it('/doc_no_ rifiuta SENZA chiamare concediAutorizzazione', async () => {
    autorizzazioniInAttesa = [UUID]
    const { POST } = await import('./route')
    await POST(richiesta(`/doc_no_${CORTO}`))
    await Promise.all(sfondo)

    expect(mockConcedi).not.toHaveBeenCalled()
    expect(mockRunAgentJob).not.toHaveBeenCalled()
    expect(inviati.length).toBeGreaterThan(0)
  })

  it('la forma LUNGA (coi trattini) continua a funzionare, non solo quella corta', async () => {
    const { POST } = await import('./route')
    await POST(richiesta(`/doc_ok_${UUID}`))
    await Promise.all(sfondo)

    expect(mockConcedi).toHaveBeenCalledWith(UUID)
  })

  // CONTROLLO POSITIVO — senza, tutte le asserzioni "non ha chiamato il
  // modello" qui sopra sarebbero verdi anche se il dispatcher si mangiasse
  // OGNI messaggio: il documento non "esce" da solo, senza tappare nulla.
  it('CONTROLLO POSITIVO: senza tappare, un messaggio normale va al modello', async () => {
    const { POST } = await import('./route')
    await POST(richiesta('genera il preventivo per Mario Rossi'))
    await Promise.all(sfondo)

    expect(mockRunAgentJob).toHaveBeenCalled()
    expect(mockConcedi).not.toHaveBeenCalled()
  })
})
