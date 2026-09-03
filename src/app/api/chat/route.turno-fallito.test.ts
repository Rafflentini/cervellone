/**
 * Anche la chat WEB deve smettere di archiviare quando il turno e' fallito.
 *
 * Gemello di `src/lib/agent-job.turno-fallito.test.ts`, che copre Telegram.
 * Esistono entrambi per una ragione precisa: il 3 settembre 2026 il segnale
 * "questo turno non e' lavoro compiuto" e' stato cablato prima su un canale
 * solo, e poi corretto — ma il consumo lato web e' rimasto senza test. Una
 * mutazione che cancellava le due guardie in `chat/route.ts` lasciava la suite
 * completamente verde: il difetto era di nuovo possibile, nella stessa forma, in
 * direzione opposta.
 *
 * Finche' Cervellone parla su due canali, le guardie vanno provate su due
 * canali. Vedi [[feedback_due_canali_equipollenti]].
 *
 * Nessuna rete: tutto mockato.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCallClaude = vi.fn()
const mockCaptureArtifact = vi.fn()
const mockCaptureImageExtraction = vi.fn()
const mockInsertDocumento = vi.fn()

vi.mock('@/lib/auth', () => ({ validateAuth: () => true }))
vi.mock('@/lib/rate-limiter', () => ({ rateLimit: () => true }))
vi.mock('@/lib/claude', () => ({
  callClaudeStream: (...args: unknown[]) => mockCallClaude(...args),
  trimMessages: (m: unknown) => m,
}))
vi.mock('@/lib/prompts', () => ({ getChatSystemPrompt: async () => 'system' }))
vi.mock('@/lib/artifact-capture', () => ({
  buildArtifactsPointer: async () => '',
  captureArtifact: (...args: unknown[]) => mockCaptureArtifact(...args),
}))
vi.mock('@/lib/image-memory', () => ({
  buildImagesPointer: async () => '',
  captureImageExtraction: (...args: unknown[]) => mockCaptureImageExtraction(...args),
}))
vi.mock('@/lib/working-memory', () => ({
  isWorkingMemoryEnabled: async () => false,
  buildProcedureContext: async () => '',
  buildActiveProjectContext: async () => '',
}))
vi.mock('@/lib/template-context', () => ({ buildTemplateContext: async () => '' }))
vi.mock('@/lib/fic-write-tools', () => ({
  confirmFicStep1: async () => null,
  confirmFicStep2: async () => null,
  cancelFic: async () => null,
}))
vi.mock('@/lib/societa-attiva', () => ({
  getSocietaAttiva: async () => 'restruktura',
  bloccoSocietaAttiva: () => '',
}))
vi.mock('@/lib/societa', () => ({ getSocieta: () => ({ nome: 'Restruktura' }) }))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: (riga: Record<string, unknown>) => {
        mockInsertDocumento(riga)
        return { select: () => ({ single: async () => ({ data: { id: 'doc-1' } }) }) }
      },
    }),
  },
}))

import { POST } from './route'

/** Una richiesta autenticata minima. */
function richiesta() {
  return {
    cookies: { get: () => ({ value: 'cookie-di-prova-abbastanza-lungo' }) },
    json: async () => ({
      messages: [{ role: 'user', content: 'preparami la lettera al committente' }],
      conversationId: 'conv-1',
    }),
  } as unknown as Parameters<typeof POST>[0]
}

/** Consuma lo stream fino in fondo: e' li' che gira il codice sotto esame. */
async function eseguiELeggi(): Promise<string> {
  const res = await POST(richiesta())
  return await res.text()
}

/** Il loop consegna `testo` e, se `motivo` c'e', dichiara il turno fallito. */
function loopChe(testo: string, motivo?: string) {
  mockCallClaude.mockImplementation(async (
    _req: unknown,
    callbacks: { onText: (t: string) => void; onTurnFailed?: (m: string) => void },
  ) => {
    if (motivo) callbacks.onTurnFailed?.(motivo)
    callbacks.onText(testo)
    return testo
  })
}

const LETTERA =
  '~~~document\n<h1>Lettera al committente</h1><p>Gentile Ing. Lentini.</p>\n~~~'
const ERRORE =
  '\n\n⚠️ Modello AI temporaneamente non disponibile. Il sistema sta cercando di recuperare automaticamente, riprovi tra un momento.'

beforeEach(() => {
  vi.clearAllMocks()
  // La route fa `.catch()` su queste due: un mock che torna undefined fa
  // esplodere il cammino RIUSCITO, e il controllo positivo diventa muto.
  mockCaptureArtifact.mockResolvedValue(undefined)
  mockCaptureImageExtraction.mockResolvedValue(undefined)
})

describe('POST /api/chat — quando il turno non e lavoro compiuto', () => {
  // Controllo positivo: senza, tutte le asserzioni "non chiamato" sarebbero
  // verdi anche se la pipeline non partisse mai.
  it('un turno riuscito archivia e restituisce il link al documento', async () => {
    loopChe(LETTERA + '\nEcco la lettera pronta.')

    const uscita = await eseguiELeggi()

    expect(mockCaptureArtifact).toHaveBeenCalledTimes(1)
    expect(mockCaptureImageExtraction).toHaveBeenCalledTimes(1)
    expect(mockInsertDocumento).toHaveBeenCalledTimes(1)
    expect(uscita).toContain('Apri documento')
  })

  it('un turno fallito non archivia niente e non promette un documento', async () => {
    loopChe(LETTERA + ERRORE, 'api_error')

    const uscita = await eseguiELeggi()

    expect(mockCaptureArtifact).not.toHaveBeenCalled()
    expect(mockCaptureImageExtraction).not.toHaveBeenCalled()
    expect(mockInsertDocumento).not.toHaveBeenCalled()
    expect(uscita).not.toContain('Apri documento')
    // Non archiviare non vuol dire tacere: l'utente legge comunque.
    expect(uscita).toContain('temporaneamente non disponibile')
  })

  it('vale per tutti e tre i motivi, non solo per l errore API', async () => {
    for (const motivo of ['api_error', 'empty', 'budget']) {
      vi.clearAllMocks()
      loopChe(LETTERA + ERRORE, motivo)

      await eseguiELeggi()

      expect(mockCaptureArtifact, `motivo ${motivo}`).not.toHaveBeenCalled()
      expect(mockInsertDocumento, `motivo ${motivo}`).not.toHaveBeenCalled()
    }
  })
})
