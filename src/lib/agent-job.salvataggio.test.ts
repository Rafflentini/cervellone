/**
 * La risposta di Telegram si salva DOPO che i link ai documenti esistono.
 *
 * Prima la scriveva il motore (`runAgentTurn`), subito dopo il loop e prima che
 * `agent-job` sostituisse i blocchi `~~~document` con «📄 titolo 👉 link».
 * Quindi in `messages` finiva l'HTML grezzo e MAI il link: il giorno dopo
 * «rimandami il link del preventivo Blasi» non trovava niente in contesto, e il
 * modello tendeva a rigenerare il documento — l'errore che il system prompt gli
 * vieta esplicitamente.
 *
 * Il salvataggio sta nel `finally` apposta: fra il loop e qui ci sono un insert
 * su Supabase, il validatore anti-allucinazione e un edit Telegram. Se uno di
 * quelli esplode, la risposta del modello NON deve sparire dalla storia — che
 * e' il motivo per cui prima stava nel motore.
 *
 * ⭐ Il test che copriva la vecchia scrittura era verde sia col fire-and-forget
 * sia con l'await, perche' i suoi mock risolvevano nel microtask successivo.
 * Qui la scrittura risolve DOPO, apposta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

const mockCallClaude = vi.fn()
vi.mock('@/lib/claude', () => ({
  callClaudeStreamTelegram: (...args: unknown[]) => mockCallClaude(...args),
}))
vi.mock('@/lib/telegram-helpers', () => ({
  sendTelegramMessageWithId: vi.fn(async () => 999),
  editTelegramMessage: vi.fn(async () => undefined),
  sendTelegramMessage: vi.fn(async () => undefined),
}))
vi.mock('@/lib/artifact-capture', () => ({ captureArtifact: async () => undefined, buildArtifactsPointer: async () => '' }))
vi.mock('@/lib/image-memory', () => ({ captureImageExtraction: async () => undefined, buildImagesPointer: async () => '' }))
vi.mock('@/lib/auto-debrief', () => ({ maybeRunDebrief: async () => undefined }))
vi.mock('@/lib/working-memory', () => ({
  isWorkingMemoryEnabled: async () => false,
  buildProcedureContext: async () => '',
  buildActiveProjectContext: async () => '',
}))
vi.mock('@/lib/template-context', () => ({ buildTemplateContext: async () => '' }))
vi.mock('@/lib/societa-attiva', () => ({ getSocietaAttiva: async () => 'restruktura', bloccoSocietaAttiva: () => '' }))
vi.mock('@/lib/prompts', () => ({ getTelegramSystemPrompt: async () => 'system' }))
vi.mock('@/lib/sent-mail-memory', () => ({ buildSentMailPointer: async () => '' }))

const righe: Array<{ role: string; testo: string; istante?: string }> = []
const embedding: string[] = []
let ritardoScrittura = 0
vi.mock('@/lib/memory', () => ({
  saveMessageWithEmbedding: async () => undefined,
  saveMessageOnly: async (_c: string, role: string, testo: string, istante?: string) => {
    if (ritardoScrittura) await new Promise((r) => setTimeout(r, ritardoScrittura))
    righe.push({ role, testo, istante })
    return true
  },
  saveEmbeddingOnly: async (_c: string, _r: string, testo: string) => { embedding.push(testo); return true },
}))

const sfondo: Promise<unknown>[] = []
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => { sfondo.push(p) } }))

// L'insert in `documents` restituisce un id: e' da li' che nasce il link.
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({}) } }))
vi.mock('@/lib/resilience', () => ({ safeSupabase: async () => ({ id: 'doc-abc-123' }) }))

import { runAgentJob } from './agent-job'

function input(): Parameters<typeof runAgentJob>[0] {
  return {
    chatId: 123456,
    userText: 'preparami il preventivo Blasi',
    conversationId: 'conv-1',
    history: [] as Anthropic.MessageParam[],
    fileBlocks: [] as unknown as Anthropic.ContentBlockParam[],
    fileDescription: '',
    attachedRecentUploadIds: [],
    requestId: 'req-1',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  righe.length = 0
  embedding.length = 0
  sfondo.length = 0
  ritardoScrittura = 0
})

describe('runAgentJob — la risposta in storia', () => {
  it('il LINK del documento entra in storia, non solo nel messaggio Telegram', async () => {
    mockCallClaude.mockResolvedValue(
      'Ecco il preventivo.\n~~~document\n<h1>Preventivo Blasi</h1><p>voci</p>\n~~~\n',
    )

    await runAgentJob(input())
    await Promise.all(sfondo)

    expect(righe).toHaveLength(1)
    expect(righe[0].role).toBe('assistant')
    expect(righe[0].testo).toContain('/doc/doc-abc-123')
    expect(righe[0].testo).toContain('Preventivo Blasi')
  })
  // Se il turno e lungo e la scrittura arriva molto dopo, la riga NON deve
  // portare l istante della scrittura: si infilerebbe dopo la domanda che
  // l Ingegnere ha intanto mandato. Un mock istantaneo non lo distingue: qui
  // il loop ci mette apposta un po.
  it('la riga porta l istante del TURNO, non quello della scrittura', async () => {
    mockCallClaude.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 120))
      return 'Fatto dopo un po.'
    })

    await runAgentJob(input())
    const fine = Date.now()

    expect(Number.isNaN(Date.parse(righe[0].istante!))).toBe(false)
    // L istante e PRIMA che il loop finisse, non dopo.
    expect(fine - Date.parse(righe[0].istante!)).toBeGreaterThanOrEqual(100)
  })

  // Fra il loop e il salvataggio ci sono un insert su Supabase, il validatore
  // anti-allucinazione e un edit Telegram. Se uno esplode, quello che il modello
  // ha prodotto non deve sparire: e per questo il salvataggio sta nel finally.
  it('se la pipeline dopo il loop esplode, la risposta resta in storia', async () => {
    mockCallClaude.mockResolvedValue('Testo prezioso del modello.')
    const helpers = await import('@/lib/telegram-helpers')
    vi.mocked(helpers.editTelegramMessage).mockRejectedValueOnce(new Error('boom'))

    await expect(runAgentJob(input())).rejects.toThrow('boom')

    expect(righe).toHaveLength(1)
    expect(righe[0].testo).toContain('Testo prezioso')
  })

  it('una scrittura lenta non tiene appeso il turno, ma non si perde', async () => {
    ritardoScrittura = 6_000
    mockCallClaude.mockResolvedValue('Risposta lenta da salvare.')

    await runAgentJob(input())
    expect(righe).toHaveLength(0)

    await Promise.all(sfondo)
    expect(righe).toHaveLength(1)
  }, 20_000)

  // CONTROLLO POSITIVO: senza, i test qui sopra passerebbero anche se
  // l'embedding non venisse mai generato per nessuno.
  it('un turno riuscito genera anche l embedding', async () => {
    mockCallClaude.mockResolvedValue('Una risposta completa e sostanziosa.')
    await runAgentJob(input())
    await Promise.all(sfondo)
    expect(embedding).toHaveLength(1)
  })
})
