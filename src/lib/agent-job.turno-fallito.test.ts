/**
 * Un turno fallito non si archivia.
 *
 * Il 3 settembre 2026, dentro il lavoro che doveva togliere le divergenze fra
 * Telegram e chat web, e' stata introdotta una divergenza nuova: il segnale
 * "questo turno non e' lavoro compiuto" era cablato solo sul web. Su Telegram la
 * pipeline di fine turno continuava ad archiviare una risposta troncata da un
 * errore come se fosse finita — documento, conoscenza file, auto-bozza, memoria
 * immagini, e perfino un debrief che distillava una "lezione" da un messaggio di
 * scusa.
 *
 * Il caso peggiore e' la memoria immagini: lega i `drive_file_id` VERI delle
 * foto al testo estratto nel turno. Con un turno fallito il bot, per 24 ore,
 * "sa" di aver estratto da quelle foto un "non sono riuscito a sintetizzare" —
 * e il pointer gli dice esplicitamente di fidarsi di quei dati invece di
 * rileggere le foto.
 *
 * Qui si verifica il cablaggio nel path Telegram di PRODUZIONE. La parita' del
 * segnale sui due adattatori sta in claude.loop-parity.test.ts.
 *
 * Nessuna rete: Claude, Telegram, Supabase e Google sono mockati.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'

const mockFilesGet = vi.fn()
const mockGetAuthorizedClient = vi.fn()
vi.mock('googleapis', () => ({ google: { drive: () => ({ files: { get: mockFilesGet } }) } }))
vi.mock('@/lib/google-oauth', () => ({ getAuthorizedClient: () => mockGetAuthorizedClient() }))

// Il loop: qui lo pilotiamo noi, per riprodurre il turno fallito.
const mockCallClaude = vi.fn()
vi.mock('@/lib/claude', () => ({
  callClaudeStreamTelegram: (...args: unknown[]) => mockCallClaude(...args),
}))

const mockSendWithId = vi.fn()
const mockEdit = vi.fn()
const mockSend = vi.fn()
vi.mock('@/lib/telegram-helpers', () => ({
  sendTelegramMessageWithId: (...args: unknown[]) => mockSendWithId(...args),
  editTelegramMessage: (...args: unknown[]) => mockEdit(...args),
  sendTelegramMessage: (...args: unknown[]) => mockSend(...args),
}))

// ── I quattro punti che archiviano: sono spie, non no-op ──
const mockCaptureArtifact = vi.fn()
const mockCaptureImageExtraction = vi.fn()
const mockMaybeRunDebrief = vi.fn()
const mockSaveMessage = vi.fn()
vi.mock('@/lib/artifact-capture', () => ({
  captureArtifact: (...args: unknown[]) => mockCaptureArtifact(...args),
  buildArtifactsPointer: async () => '',
}))
vi.mock('@/lib/image-memory', () => ({
  captureImageExtraction: (...args: unknown[]) => mockCaptureImageExtraction(...args),
  buildImagesPointer: async () => '',
}))
vi.mock('@/lib/auto-debrief', () => ({
  maybeRunDebrief: (...args: unknown[]) => mockMaybeRunDebrief(...args),
}))
vi.mock('@/lib/memory', () => ({
  saveMessageWithEmbedding: (...args: unknown[]) => mockSaveMessage(...args),
}))

vi.mock('@/lib/working-memory', () => ({
  isWorkingMemoryEnabled: async () => false,
  buildProcedureContext: async () => '',
  buildActiveProjectContext: async () => '',
}))
vi.mock('@/lib/template-context', () => ({ buildTemplateContext: async () => '' }))
vi.mock('@/lib/sent-mail', () => ({ buildSentMailPointer: async () => '' }))
vi.mock('@/lib/prompts', () => ({ getTelegramSystemPrompt: async () => 'system' }))
vi.mock('@/lib/supabase', () => ({ supabase: { from: () => ({}) } }))
vi.mock('@/lib/resilience', () => ({ safeSupabase: async () => null }))

import { runAgentJob } from './agent-job'

/** Una risposta a meta': il bot aveva cominciato, poi l'API e' caduta. */
const PARZIALE_PIU_ERRORE =
  'Gentile Ing. Lentini,\nin riferimento alla Sua del 2 settembre, Le comunico quanto segue.' +
  '\n\n⚠️ Modello AI temporaneamente non disponibile. Il sistema sta cercando di recuperare automaticamente, riprovi tra un momento.' +
  '\n_(quanto sopra è la risposta parziale prima dell\'errore; riprovi per completarla)_'

function baseInput(): Parameters<typeof runAgentJob>[0] {
  return {
    chatId: 123456,
    userText: 'guarda queste foto del cantiere e preparami la lettera',
    conversationId: 'conv-1',
    history: [] as Anthropic.MessageParam[],
    // fileBlocks non vuoto: e' la condizione che abilita il salvataggio della
    // "conoscenza file". Senza, quel ramo non verrebbe nemmeno percorso e il
    // test sarebbe verde per il motivo sbagliato.
    fileBlocks: [{ type: 'text', text: 'finta foto' }] as unknown as Anthropic.ContentBlockParam[],
    fileDescription: 'foto-cantiere.jpg',
    attachedRecentUploadIds: [],
    requestId: 'req-1',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetAuthorizedClient.mockResolvedValue({ __fakeOAuthClient: true })
  mockSendWithId.mockResolvedValue(999)
  mockEdit.mockResolvedValue(undefined)
  mockSend.mockResolvedValue(undefined)
  mockCaptureArtifact.mockResolvedValue(undefined)
  mockCaptureImageExtraction.mockResolvedValue(undefined)
  mockMaybeRunDebrief.mockResolvedValue(undefined)
  mockSaveMessage.mockResolvedValue(undefined)
})

/** Il loop consegna `testo` e, se `motivo` c'e', dichiara il turno fallito. */
function loopChe(testo: string, motivo?: string) {
  mockCallClaude.mockImplementation(async (
    _req: unknown,
    _onChunk: unknown,
    callbacks?: { onTurnFailed?: (m: string) => void },
  ) => {
    if (motivo) callbacks?.onTurnFailed?.(motivo)
    return testo
  })
}

describe('runAgentJob — quando il turno non e lavoro compiuto', () => {
  // Controllo positivo. Senza, tutte le asserzioni "non chiamato" qui sotto
  // sarebbero verdi anche se la pipeline non partisse MAI.
  it('un turno riuscito archivia normalmente', async () => {
    // Oltre 200 caratteri: sotto quella soglia il ramo "conoscenza file" non
    // parte nemmeno, e il controllo positivo sarebbe verde per il motivo
    // sbagliato (l'ha scoperto questo test al primo giro).
    loopChe(
      'Ecco la lettera pronta per il committente. Le foto mostrano il ponteggio ' +
      'montato sul prospetto nord, con parapetti regolari e tavole fermapiede in ' +
      'opera. Ho richiamato i riferimenti al PSC e alla nota del 2 settembre, e ' +
      'indicato le lavorazioni residue sul lato est del fabbricato.',
    )

    await runAgentJob(baseInput())

    expect(mockCaptureArtifact).toHaveBeenCalledTimes(1)
    expect(mockCaptureImageExtraction).toHaveBeenCalledTimes(1)
    expect(mockMaybeRunDebrief).toHaveBeenCalledTimes(1)
    expect(mockSaveMessage.mock.calls.some((c) => c[1] === 'knowledge')).toBe(true)
  })

  it('un turno fallito non lascia traccia in nessuno dei quattro archivi', async () => {
    loopChe(PARZIALE_PIU_ERRORE, 'api_error')

    await runAgentJob(baseInput())

    expect(mockCaptureArtifact).not.toHaveBeenCalled()
    expect(mockCaptureImageExtraction).not.toHaveBeenCalled()
    expect(mockMaybeRunDebrief).not.toHaveBeenCalled()
    expect(mockSaveMessage.mock.calls.some((c) => c[1] === 'knowledge')).toBe(false)
  })

  it('vale anche per un turno muto e per il budget esaurito', async () => {
    for (const motivo of ['empty', 'budget']) {
      vi.clearAllMocks()
      mockSendWithId.mockResolvedValue(999)
      loopChe('⚠️ Non sono riuscito a sintetizzare una risposta.', motivo)

      await runAgentJob(baseInput())

      expect(mockCaptureImageExtraction, `motivo ${motivo}`).not.toHaveBeenCalled()
      expect(mockMaybeRunDebrief, `motivo ${motivo}`).not.toHaveBeenCalled()
    }
  })

  it('un documento COMPLETO dentro un turno fallito non diventa un link "documento pronto"', async () => {
    // Il caso che rende il difetto concreto: il modello chiude davvero il blocco
    // documento all'iterazione 1, e all'iterazione 2 l'API cade. Il testo
    // parziale contiene un documento valido, quindi parseDocumentBlocks lo
    // trova, lo salva in `documents` e manda "📄 Apri documento" — una lettera
    // presentata come pronta dentro un turno morto a meta'.
    //
    // Senza questo caso la guardia sui documenti resta scoperta: un turno
    // fallito senza blocchi documento non distingue il codice giusto da quello
    // sbagliato (mutation testing 3 set 2026, M24 sopravvissuta).
    loopChe(
      '~~~document\n<h1>Lettera al committente</h1><p>Gentile Ing. Lentini, in riferimento alla Sua del 2 settembre.</p>\n~~~\n' +
      '\n⚠️ Modello AI temporaneamente non disponibile. Il sistema sta cercando di recuperare automaticamente, riprovi tra un momento.',
      'api_error',
    )

    await runAgentJob(baseInput())

    const consegnato = [
      ...mockEdit.mock.calls.map((c) => String(c[2] ?? '')),
      ...mockSend.mock.calls.map((c) => String(c[1] ?? '')),
    ].join('\n')
    expect(consegnato).not.toContain('📄')
    expect(consegnato).toContain('temporaneamente non disponibile')
  })

  it('l utente riceve comunque il testo: non archiviare non vuol dire tacere', async () => {
    loopChe(PARZIALE_PIU_ERRORE, 'api_error')

    await runAgentJob(baseInput())

    const consegnato = [
      ...mockEdit.mock.calls.map((c) => String(c[2] ?? '')),
      ...mockSend.mock.calls.map((c) => String(c[1] ?? '')),
    ].join('\n')
    expect(consegnato).toContain('Gentile Ing. Lentini')
    expect(consegnato).toContain('temporaneamente non disponibile')
  })
})
