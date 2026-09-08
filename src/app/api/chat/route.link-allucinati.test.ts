/**
 * Il validatore anti-link-inventati girava solo su Telegram.
 *
 * `agent-job.ts` diceva che il validatore era cablato solo in
 * `v19/agent/loop.ts`, «che non e' il path di produzione». La correzione lo
 * cablo' su Telegram e lascio' fuori l'ALTRO path di produzione: questa route.
 *
 * Dalla chat web il bot poteva rispondere «ho salvato il POS qui:
 * drive.google.com/file/d/...» con un id inventato; l'Ingegnere cliccava,
 * prendeva un 404, e non aveva modo di sapere se il file c'e' con un altro nome
 * o non c'e' affatto. Su Telegram, stessa risposta, con l'avviso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAnnota = vi.fn()
vi.mock('@/lib/link-allucinati', () => ({
  annotateHallucinatedLinks: (t: string) => mockAnnota(t),
}))

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
vi.mock('@/lib/societa-attiva', () => ({ getSocietaAttiva: async () => 'restruktura', bloccoSocietaAttiva: () => '' }))
vi.mock('@/lib/memory', () => ({ saveMessageOnly: async () => true, saveEmbeddingOnly: async () => true }))
vi.mock('@vercel/functions', () => ({ waitUntil: () => undefined }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null }) }) }) }) } }))
vi.mock('@/lib/foto-ingest', () => ({ ingestPhotoUpload: async () => ({ salvate: [], mancate: [] }) }))

import { POST } from './route'

async function leggiRisposta(r: Response): Promise<string> {
  return await r.text()
}

function richiesta(testo: string) {
  return {
    cookies: { get: () => ({ value: 'cookie-di-prova-abbastanza-lungo' }) },
    json: async () => ({
      messages: [{ role: 'user', content: testo }],
      conversationId: '11111111-2222-3333-4444-555555555555',
    }),
  } as unknown as Parameters<typeof POST>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCallClaude.mockImplementation(async (_req: unknown, sink: { onText: (t: string) => void }) => {
    sink.onText('Ho salvato il POS qui: https://drive.google.com/file/d/INVENTATOXYZ/view')
    return 'Ho salvato il POS qui: https://drive.google.com/file/d/INVENTATOXYZ/view'
  })
})

describe('chat web — i link Drive inventati', () => {
  it('un link che non esiste produce un avviso nella risposta', async () => {
    mockAnnota.mockImplementation(async (t: string) => `⚠️ Attenzione: un link a un file Drive citato in questo messaggio non risulta esistente.\n\n${t}`)

    const testo = await leggiRisposta(await POST(richiesta('dove hai messo il POS?')))

    expect(mockAnnota).toHaveBeenCalled()
    expect(testo).toContain('non risulta esistente')
  })

  // CONTROLLO POSITIVO: senza, un test che aggiunge sempre l'avviso
  // passerebbe quello sopra e sarebbe inutile.
  it('un link valido non produce nessun avviso', async () => {
    mockAnnota.mockImplementation(async (t: string) => t)

    const testo = await leggiRisposta(await POST(richiesta('dove hai messo il POS?')))

    expect(mockAnnota).toHaveBeenCalled()
    expect(testo).not.toContain('non risulta esistente')
  })
})
