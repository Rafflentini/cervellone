/**
 * Un file analizzato dalla chat web non entrava in memoria.
 *
 * Su Telegram, dopo un turno con allegati, la risposta veniva salvata anche
 * come `knowledge` con embedding. Sul web no — benche' il web accetti PDF fino
 * a 25 MB. `searchMemory` e' comune ai due canali, quindi il web CONSUMAVA una
 * memoria che non contribuiva mai ad alimentare.
 *
 * Lo scenario: l'Ingegnere carica il capitolato dalla chat web e ne discute
 * mezz'ora; una settimana dopo, da Telegram, chiede «cosa diceva il capitolato
 * Blasi sugli oneri della sicurezza?» e non c'e' niente. Se lo avesse caricato
 * da Telegram, l'avrebbe trovato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSaveKnowledge = vi.fn()
vi.mock('@/lib/memory', () => ({
  saveMessageOnly: async () => true,
  saveEmbeddingOnly: async () => true,
  saveMessageWithEmbedding: (...a: unknown[]) => mockSaveKnowledge(...a),
}))

const mockCallClaude = vi.fn()
vi.mock('@/lib/auth', () => ({ validateAuth: () => true }))
vi.mock('@/lib/rate-limiter', () => ({ rateLimit: () => true }))
vi.mock('@/lib/claude', () => ({
  callClaudeStream: (...a: unknown[]) => mockCallClaude(...a),
  trimMessages: (m: unknown) => m,
  messaggioErroreUtente: () => '⚠️ errore',
}))
vi.mock('@/lib/link-allucinati', () => ({ annotateHallucinatedLinks: async (t: string) => t }))
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
vi.mock('@/lib/auto-debrief', () => ({ maybeRunDebrief: async () => undefined }))
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => { sfondo.push(p) } }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null }) }) }) }) } }))
vi.mock('@/lib/foto-ingest', () => ({ ingestPhotoUpload: async () => ({ salvate: [], mancate: [] }) }))

const sfondo: Promise<unknown>[] = []

import { POST } from './route'

const RISPOSTA_LUNGA = 'Il capitolato prevede oneri della sicurezza non soggetti a ribasso. '.repeat(8)

function richiesta(conAllegato: boolean) {
  const contenuto = conAllegato
    ? [
        { type: 'document', title: 'Capitolato_Blasi.pdf', source: { type: 'base64', data: 'x' } },
        { type: 'text', text: 'cosa dice sugli oneri della sicurezza?' },
      ]
    : 'cosa dice sugli oneri della sicurezza?'
  return {
    cookies: { get: () => ({ value: 'cookie-di-prova-abbastanza-lungo' }) },
    json: async () => ({ messages: [{ role: 'user', content: contenuto }], conversationId: 'conv-1' }),
  } as unknown as Parameters<typeof POST>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  sfondo.length = 0
  mockSaveKnowledge.mockResolvedValue(undefined)
  mockCallClaude.mockImplementation(async (_r: unknown, sink: { onText: (t: string) => void }) => {
    sink.onText(RISPOSTA_LUNGA)
    return RISPOSTA_LUNGA
  })
})

describe('chat web — la conoscenza dei file analizzati', () => {
  it('un turno con allegato finisce in memoria come knowledge', async () => {
    await (await POST(richiesta(true))).text()
    await Promise.all(sfondo)

    expect(mockSaveKnowledge).toHaveBeenCalledTimes(1)
    const [, ruolo, testo] = mockSaveKnowledge.mock.calls[0]
    expect(ruolo).toBe('knowledge')
    expect(testo).toContain('Capitolato_Blasi.pdf')
    expect(testo).toContain('oneri della sicurezza')
  })

  // CONTROLLO POSITIVO: senza, un salvataggio incondizionato passerebbe
  // il test qui sopra e riempirebbe la memoria di ogni chiacchierata.
  it('un turno SENZA allegati non produce nessuna knowledge', async () => {
    await (await POST(richiesta(false))).text()
    await Promise.all(sfondo)

    expect(mockSaveKnowledge).not.toHaveBeenCalled()
  })

  it('una risposta troppo corta non vale come conoscenza', async () => {
    mockCallClaude.mockImplementation(async (_r: unknown, sink: { onText: (t: string) => void }) => {
      sink.onText('Non lo dice.')
      return 'Non lo dice.'
    })

    await (await POST(richiesta(true))).text()
    await Promise.all(sfondo)

    expect(mockSaveKnowledge).not.toHaveBeenCalled()
  })
})
