/**
 * src/app/api/chat/route.guardia-autorizza.test.ts — la via d'uscita dal
 * blocco sui dati societari (Task 12), sulla CHAT WEB.
 *
 * Il gemello sta in `src/app/api/telegram/route.guardia-autorizza.test.ts`.
 * Per il PERCORSO DELLA GUARDIA i due file mockano LO STESSO insieme di
 * moduli — `@/lib/guardia-autorizzazioni` (con la stessa forma) e
 * `@/lib/supabase-server` (con la stessa tabella finta
 * `cervellone_guardia_autorizzazioni`) — cosi' quello che provano e' davvero
 * confrontabile (vedi note-task-6.md: due test che mockano insiemi diversi
 * non sono un test di equipollenza). Il resto e' impalcatura specifica del
 * canale (qui: auth/rate-limit/claude-stream in streaming; su Telegram:
 * webhook/agent-job/sendTelegramMessage) — dichiarata anche nel rapporto del
 * Task 12.
 *
 * Cosa provano, dal brief (Step 6):
 *  - il codice arriva ed e' TAPPABILE: la forma CORTA (16 cifre) di
 *    /doc_ok_ e /doc_no_ si risolve contro la tabella vera;
 *  - tapparlo (/doc_ok_) chiama `concediAutorizzazione` con l'uuid giusto,
 *    SENZA passare dal modello — la stessa garanzia di ogni altro comando
 *    con codice;
 *  - /doc_no_ rifiuta senza concedere niente;
 *  - CONTROLLO POSITIVO: senza tappare nulla, un messaggio normale va al
 *    modello — il documento non "esce" da solo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCallClaude = vi.fn()

vi.mock('@/lib/auth', () => ({ validateAuth: () => true }))
vi.mock('@/lib/rate-limiter', () => ({ rateLimit: () => true }))
vi.mock('@/lib/claude', () => ({
  callClaudeStream: (...a: unknown[]) => mockCallClaude(...a),
  trimMessages: (m: unknown) => m,
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
vi.mock('@/lib/societa-attiva', () => ({
  getSocietaAttiva: async () => 'restruktura',
  bloccoSocietaAttiva: () => '',
  leggiSocietaAttiva: async () => ({ ok: true, codice: 'restruktura', esplicita: false }),
}))
vi.mock('@/lib/societa', () => ({
  getSocieta: () => ({ nome: 'Restruktura', denominazione: 'Restruktura', piva: '00000000000' }),
  listaSocieta: () => [
    { codice: 'restruktura', denominazione: 'Restruktura', piva: '00000000000' },
    { codice: 'larealestate', denominazione: 'LA REAL ESTATE SRLS', piva: '02232730768' },
  ],
}))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null }) }) }) }) },
}))

// ── Da qui in giù: il percorso della guardia, IDENTICO al gemello Telegram ──

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
const catenaVuota: Record<string, unknown> = {}
Object.assign(catenaVuota, {
  select: () => catenaVuota,
  gte: () => catenaVuota,
  lte: () => catenaVuota,
  limit: () => catenaVuota,
  then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: [], error: null })),
})
const instrada = (tabella: string) =>
  tabella === 'cervellone_guardia_autorizzazioni' ? catenaAutorizzazioni : catenaVuota
vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({ from: (t: string) => instrada(t) }),
}))

import { POST } from './route'

const UUID = '3f3fc82f-4daa-408e-9308-78effecc338e'
const CORTO = UUID.replace(/-/g, '').slice(0, 16)

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
  mockCallClaude.mockResolvedValue('risposta del modello')
  autorizzazioniInAttesa = []
  mockConcedi.mockResolvedValue({ ok: true })
})

describe('POST /api/chat — /doc_ok_ e /doc_no_ (Task 12: la via d\'uscita)', () => {
  it('il codice CORTO si risolve: arriva ed e\' tappabile, e chiama concediAutorizzazione con l\'uuid INTERO', async () => {
    autorizzazioniInAttesa = [UUID]
    const out = await invia(`/doc_ok_${CORTO}`)

    expect(mockConcedi).toHaveBeenCalledWith(UUID)
    expect(out).not.toMatch(/NON ho fatto niente/)
    expect(mockCallClaude).not.toHaveBeenCalled()
  })

  it('tapparlo (/doc_ok_) concede l\'autorizzazione e lo dice, senza passare dal modello', async () => {
    autorizzazioniInAttesa = [UUID]
    mockConcedi.mockResolvedValue({ ok: true })

    const out = await invia(`/doc_ok_${CORTO}`)

    expect(mockConcedi).toHaveBeenCalledWith(UUID)
    expect(out).toMatch(/autorizzat/i)
    expect(mockCallClaude).not.toHaveBeenCalled()
  })

  it('un\'autorizzazione scaduta o gia\' usata lo DICE, non finge un successo', async () => {
    autorizzazioniInAttesa = [UUID]
    mockConcedi.mockResolvedValue({ ok: false, motivo: 'questo codice e\' scaduto' })

    const out = await invia(`/doc_ok_${CORTO}`)

    expect(out).toMatch(/scadut/i)
    expect(mockCallClaude).not.toHaveBeenCalled()
  })

  it('/doc_no_ rifiuta SENZA chiamare concediAutorizzazione', async () => {
    autorizzazioniInAttesa = [UUID]
    const out = await invia(`/doc_no_${CORTO}`)

    expect(mockConcedi).not.toHaveBeenCalled()
    expect(mockCallClaude).not.toHaveBeenCalled()
    expect(out.length).toBeGreaterThan(0)
  })

  it('la forma LUNGA (coi trattini) continua a funzionare, non solo quella corta', async () => {
    const out = await invia(`/doc_ok_${UUID}`)

    expect(mockConcedi).toHaveBeenCalledWith(UUID)
    void out
  })

  // CONTROLLO POSITIVO — senza, tutte le asserzioni "non ha chiamato il
  // modello" qui sopra sarebbero verdi anche se il dispatcher si mangiasse
  // OGNI messaggio: il documento non "esce" da solo, senza tappare nulla.
  it('CONTROLLO POSITIVO: senza tappare, un messaggio normale va al modello', async () => {
    const out = await invia('genera il preventivo per Mario Rossi')

    expect(mockCallClaude).toHaveBeenCalledTimes(1)
    expect(mockConcedi).not.toHaveBeenCalled()
    void out
  })
})
