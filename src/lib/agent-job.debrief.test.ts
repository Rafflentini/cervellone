/**
 * Cablaggio di auto-debrief nel path di PRODUZIONE.
 *
 * `maybeRunDebrief` era scritto e testato ma senza un solo chiamante: la
 * distillazione delle decisioni non e' mai avvenuta. E' il pezzo che avrebbe
 * conservato il PERCHE' di un lavoro, non solo i nomi che vi compaiono.
 *
 * Questi test pinnano il cablaggio, non la logica del debrief (quella sta in
 * auto-debrief.test.ts). Il flag resta fail-closed: l'accensione e' una
 * decisione separata.
 *
 * Nessuna rete: Claude, Telegram, Supabase e Google sono tutti mockati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

// ── Google ──
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

// ── Il protagonista ──
const mockMaybeRunDebrief = vi.fn()
vi.mock('@/lib/auto-debrief', () => ({
  maybeRunDebrief: (...args: unknown[]) => mockMaybeRunDebrief(...args),
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

function baseInput(): Parameters<typeof runAgentJob>[0] {
  return {
    chatId: 123456,
    userText: 'ok procedi con la controreplica',
    conversationId: 'conv-1',
    history: [
      { role: 'user', content: 'prepara la risposta a Blasi' },
      { role: 'assistant', content: 'ecco la bozza, poggia sull articolo 5.1' },
    ] as Anthropic.MessageParam[],
    fileBlocks: [] as Anthropic.ContentBlockParam[],
    fileDescription: '',
    attachedRecentUploadIds: [],
    requestId: 'req-1',
  }
}

beforeEach(() => {
  mockFilesGet.mockReset()
  mockGetAuthorizedClient.mockReset()
  mockCallClaude.mockReset()
  mockSendWithId.mockReset()
  mockEdit.mockReset()
  mockSend.mockReset()
  mockMaybeRunDebrief.mockReset()
  mockGetAuthorizedClient.mockResolvedValue({ __fakeOAuthClient: true })
  mockSendWithId.mockResolvedValue(999)
  mockEdit.mockResolvedValue(undefined)
  mockSend.mockResolvedValue(undefined)
  mockMaybeRunDebrief.mockResolvedValue(undefined)
  mockCallClaude.mockResolvedValue('Fatto, ho aggiornato la bozza.')
})

describe('runAgentJob — auto-debrief cablato', () => {
  it('a fine turno invoca maybeRunDebrief con conversazione e testo utente', async () => {
    await runAgentJob(baseInput())

    expect(mockMaybeRunDebrief).toHaveBeenCalledTimes(1)
    const ctx = mockMaybeRunDebrief.mock.calls[0][0] as Record<string, unknown>
    expect(ctx.conversationId).toBe('conv-1')
    expect(ctx.userText).toBe('ok procedi con la controreplica')
    expect(String(ctx.transcript)).toContain('Blasi')
  })

  it('un errore del debrief non fa fallire il turno gia consegnato', async () => {
    mockMaybeRunDebrief.mockRejectedValueOnce(new Error('boom'))

    await expect(runAgentJob(baseInput())).resolves.not.toThrow()
  })
})
