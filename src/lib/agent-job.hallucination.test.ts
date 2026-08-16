/**
 * Cablaggio del validatore anti-allucinazione nel path di PRODUZIONE.
 *
 * Telegram non passa da `src/v19/agent/loop.ts` ma da `runAgentJob`: finché la
 * validazione non vive qui, non protegge nessuno. Questi test pinnano il
 * cablaggio, non la logica del validatore (quella sta in
 * src/v19/__tests__/hallucination-validator.spec.ts).
 *
 * Nessuna rete: Claude, Telegram, Supabase e Google sono tutti mockati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

// ── Google (usato dal checker Drive vero) ──
const mockFilesGet = vi.fn()
const mockGetAuthorizedClient = vi.fn()

vi.mock('googleapis', () => ({
  google: { drive: () => ({ files: { get: mockFilesGet } }) },
}))
vi.mock('@/lib/google-oauth', () => ({
  getAuthorizedClient: () => mockGetAuthorizedClient(),
}))

// ── Claude ──
const mockCallClaude = vi.fn()
vi.mock('@/lib/claude', () => ({
  callClaudeStreamTelegram: (...args: unknown[]) => mockCallClaude(...args),
}))

// ── Telegram ──
const mockSendWithId = vi.fn()
const mockEdit = vi.fn()
const mockSend = vi.fn()
vi.mock('@/lib/telegram-helpers', () => ({
  sendTelegramMessageWithId: (...args: unknown[]) => mockSendWithId(...args),
  editTelegramMessage: (...args: unknown[]) => mockEdit(...args),
  sendTelegramMessage: (...args: unknown[]) => mockSend(...args),
}))

// ── Contesto / memoria: tutto inerte ──
vi.mock('@/lib/working-memory', () => ({
  isWorkingMemoryEnabled: async () => false,
  buildProcedureContext: async () => '',
  buildActiveProjectContext: async () => '',
}))
vi.mock('@/lib/template-context', () => ({ buildTemplateContext: async () => '' }))
vi.mock('@/lib/artifact-capture', () => ({
  captureArtifact: async () => undefined,
  buildArtifactsPointer: async () => '',
}))
vi.mock('@/lib/image-memory', () => ({
  captureImageExtraction: async () => undefined,
  buildImagesPointer: async () => '',
}))
vi.mock('@/lib/sent-mail', () => ({ buildSentMailPointer: async () => '' }))
vi.mock('@/lib/prompts', () => ({ getTelegramSystemPrompt: async () => 'system' }))
vi.mock('@/lib/memory', () => ({ saveMessageWithEmbedding: async () => undefined }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({}) } }))
vi.mock('@/lib/resilience', () => ({ safeSupabase: async () => null }))

import { runAgentJob } from './agent-job'

const WARNING_MARKER = 'non risulta esistente'

function baseInput(): Parameters<typeof runAgentJob>[0] {
  return {
    chatId: 123456,
    userText: 'fammi il preventivo',
    conversationId: 'conv-1',
    history: [] as Anthropic.MessageParam[],
    fileBlocks: [] as Anthropic.ContentBlockParam[],
    fileDescription: '',
    attachedRecentUploadIds: [],
    requestId: 'req-1',
  }
}

/** Tutto il testo davvero recapitato all'utente (edit del placeholder + send). */
function deliveredText(): string {
  const fromEdits = mockEdit.mock.calls.map((c) => String(c[2] ?? ''))
  const fromSends = mockSend.mock.calls.map((c) => String(c[1] ?? ''))
  return [...fromEdits, ...fromSends].join('\n')
}

function gaxiosError(status: number): Error {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    status: number
    response: { status: number }
  }
  err.status = status
  err.response = { status }
  return err
}

beforeEach(() => {
  mockFilesGet.mockReset()
  mockGetAuthorizedClient.mockReset()
  mockCallClaude.mockReset()
  mockSendWithId.mockReset()
  mockEdit.mockReset()
  mockSend.mockReset()
  mockGetAuthorizedClient.mockResolvedValue({ __fakeOAuthClient: true })
  mockSendWithId.mockResolvedValue(999)
  mockEdit.mockResolvedValue(undefined)
  mockSend.mockResolvedValue(undefined)
})

describe('runAgentJob — validatore anti-allucinazione cablato', () => {
  it('link Drive inesistente ⇒ il testo recapitato contiene l\'avviso', async () => {
    mockFilesGet.mockRejectedValue(gaxiosError(404))
    mockCallClaude.mockResolvedValue(
      'Ecco il PDF: https://drive.google.com/file/d/GHOST_ID_0001/view',
    )

    await runAgentJob(baseInput())

    expect(deliveredText()).toContain(WARNING_MARKER)
  })

  it('link Drive valido ⇒ nessun avviso', async () => {
    mockFilesGet.mockResolvedValue({ data: { id: 'REAL_ID_0001' } })
    mockCallClaude.mockResolvedValue(
      'Ecco il PDF: https://drive.google.com/file/d/REAL_ID_0001/view',
    )

    await runAgentJob(baseInput())

    const delivered = deliveredText()
    expect(delivered).toContain('REAL_ID_0001')
    expect(delivered).not.toContain(WARNING_MARKER)
  })

  it('checker non verificabile (401) ⇒ nessun avviso: niente falsi positivi', async () => {
    mockFilesGet.mockRejectedValue(gaxiosError(401))
    mockCallClaude.mockResolvedValue(
      'Ecco il PDF: https://drive.google.com/file/d/SOME_ID_0001/view',
    )

    await runAgentJob(baseInput())

    expect(deliveredText()).not.toContain(WARNING_MARKER)
  })

  it('nessun link Drive ⇒ costo zero: Drive non viene mai interrogato', async () => {
    mockCallClaude.mockResolvedValue('Nessun allegato, solo testo di risposta.')

    await runAgentJob(baseInput())

    expect(mockGetAuthorizedClient).not.toHaveBeenCalled()
    expect(mockFilesGet).not.toHaveBeenCalled()
    expect(deliveredText()).toContain('Nessun allegato')
  })

  it('messaggio lungo (>4000) con link inesistente ⇒ l\'avviso arriva comunque', async () => {
    mockFilesGet.mockRejectedValue(gaxiosError(404))
    const filler = 'x'.repeat(5000)
    mockCallClaude.mockResolvedValue(
      `${filler}\n\nEcco il PDF: https://drive.google.com/file/d/GHOST_ID_0002/view`,
    )

    await runAgentJob(baseInput())

    // Deve stare nel PRIMO pezzo recapitato (l'edit del placeholder): è il
    // messaggio che l'utente legge davvero, la coda finisce in un messaggio a parte.
    const firstEdit = String(mockEdit.mock.calls[0]?.[2] ?? '')
    expect(firstEdit).toContain(WARNING_MARKER)
  })

  it("un'esplosione inattesa del validatore non fa fallire il turno", async () => {
    mockGetAuthorizedClient.mockImplementation(() => {
      throw new Error('boom inatteso')
    })
    mockCallClaude.mockResolvedValue(
      'Ecco il PDF: https://drive.google.com/file/d/SOME_ID_0002/view',
    )

    await expect(runAgentJob(baseInput())).resolves.toBeUndefined()
    expect(deliveredText()).toContain('SOME_ID_0002')
  })
})
