/**
 * I comandi di conferma funzionano anche dalla chat web.
 *
 * Fino al 3 settembre 2026 la chat web ne gestiva quattro famiglie e Telegram
 * sette. Le tre mancanti — `/sal_*`, `/regola_*`, `/condividi_ok_` — erano il
 * buco piu' insidioso dell'equipollenza, perche' era GIA' raggiungibile: i tool
 * sono gli stessi sui due canali, quindi il modello puo' proporre un SAL o una
 * regola dalla chat web, e li' quel comando era solo testo mandato all'LLM.
 * Il flusso si apriva e non si poteva chiudere.
 *
 * Ogni caso verifica due cose: che il comando arrivi alla funzione giusta, e che
 * NON arrivi al modello.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCallClaude = vi.fn()
const mockSalStep1 = vi.fn()
const mockSalStep2 = vi.fn()
const mockSalCancel = vi.fn()
const mockRegolaAnteprima = vi.fn()
const mockRegolaConferma = vi.fn()
const mockRegolaRifiuta = vi.fn()
const mockRegolaRimuovi = vi.fn()
const mockRegoleList = vi.fn()
const mockShare = vi.fn()

vi.mock('@/lib/auth', () => ({ validateAuth: () => true }))
vi.mock('@/lib/rate-limiter', () => ({ rateLimit: () => true }))
vi.mock('@/lib/claude', () => ({
  callClaudeStream: (...a: unknown[]) => mockCallClaude(...a),
  trimMessages: (m: unknown) => m,
}))
vi.mock('@/lib/sal-tools', () => ({
  confirmSalStep1: (u: string) => mockSalStep1(u),
  confirmSalStep2: (u: string) => mockSalStep2(u),
  cancelSal: (u: string) => mockSalCancel(u),
}))
vi.mock('@/lib/regole-proposte', () => ({
  anteprimaRegola: (u: string) => mockRegolaAnteprima(u),
  confermaRegola: (u: string) => mockRegolaConferma(u),
  rifiutaRegola: (u: string) => mockRegolaRifiuta(u),
  rimuoviRegola: (u: string) => mockRegolaRimuovi(u),
  formatRegoleList: () => mockRegoleList(),
}))
vi.mock('@/lib/share-proposte', () => ({ confirmShareProposal: (u: string) => mockShare(u) }))

// Contorno: serve solo che non faccia rete.
vi.mock('@/lib/fic-write-tools', () => ({
  confirmFicStep1: async () => 'fic1', confirmFicStep2: async () => 'fic2', cancelFic: async () => 'ficno',
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
vi.mock('@/lib/societa', () => ({ getSocieta: () => ({ nome: 'Restruktura' }) }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null }) }) }) }) },
}))

import { POST } from './route'

const UUID = '11111111-2222-3333-4444-555555555555'

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
  mockSalStep1.mockResolvedValue('SAL: anteprima')
  mockSalStep2.mockResolvedValue('SAL: creato')
  mockSalCancel.mockResolvedValue('SAL: annullato')
  mockRegolaAnteprima.mockResolvedValue({ message: 'Regola: anteprima' })
  mockRegolaConferma.mockResolvedValue({ message: 'Regola: attiva' })
  mockRegolaRifiuta.mockResolvedValue({ message: 'Regola: rifiutata' })
  mockRegolaRimuovi.mockResolvedValue({ message: 'Regola: rimossa' })
  mockRegoleList.mockResolvedValue('Elenco regole')
  mockShare.mockResolvedValue('https://drive.example/link')
  mockCallClaude.mockResolvedValue('risposta del modello')
})

describe('POST /api/chat — comandi SAL (mancavano sul web)', () => {
  it('/sal_ok_ mostra l anteprima, senza passare dal modello', async () => {
    const out = await invia(`/sal_ok_${UUID}`)

    expect(mockSalStep1).toHaveBeenCalledWith(UUID)
    expect(out).toContain('SAL: anteprima')
    expect(mockCallClaude).not.toHaveBeenCalled()
  })

  it('/sal_ok2_ conferma davvero, e non viene mangiato dal prefisso piu corto', async () => {
    const out = await invia(`/sal_ok2_${UUID}`)

    expect(mockSalStep2).toHaveBeenCalledWith(UUID)
    expect(mockSalStep1).not.toHaveBeenCalled()
    expect(out).toContain('SAL: creato')
  })

  it('/sal_no_ annulla', async () => {
    await invia(`/sal_no_${UUID}`)
    expect(mockSalCancel).toHaveBeenCalledWith(UUID)
  })
})

describe('POST /api/chat — comandi regole apprese (mancavano sul web)', () => {
  it('/regola_ok_ mostra il testo letto dal DATABASE', async () => {
    // Il primo passo e' un'anteprima, non un'attivazione: cio' che viene
    // approvato lo scrive la route leggendo il DB, non il modello che potrebbe
    // parafrasarlo.
    const out = await invia(`/regola_ok_${UUID}`)

    expect(mockRegolaAnteprima).toHaveBeenCalledWith(UUID)
    expect(mockRegolaConferma).not.toHaveBeenCalled()
    expect(out).toContain('Regola: anteprima')
  })

  it('/regola_ok2_ attiva', async () => {
    await invia(`/regola_ok2_${UUID}`)
    expect(mockRegolaConferma).toHaveBeenCalledWith(UUID)
    expect(mockRegolaAnteprima).not.toHaveBeenCalled()
  })

  it('/regola_no_ e /regola_via_ finiscono nelle funzioni giuste', async () => {
    await invia(`/regola_no_${UUID}`)
    expect(mockRegolaRifiuta).toHaveBeenCalledWith(UUID)

    vi.clearAllMocks()
    mockRegolaRimuovi.mockResolvedValue({ message: 'Regola: rimossa' })
    await invia(`/regola_via_${UUID}`)
    expect(mockRegolaRimuovi).toHaveBeenCalledWith(UUID)
  })

  it('/regole elenca le proposte in attesa', async () => {
    const out = await invia('/regole')

    expect(mockRegoleList).toHaveBeenCalled()
    expect(out).toContain('Elenco regole')
    expect(mockCallClaude).not.toHaveBeenCalled()
  })
})

describe('POST /api/chat — condivisione documento (mancava sul web)', () => {
  it('/condividi_ok_ restituisce il link firmato', async () => {
    const out = await invia(`/condividi_ok_${UUID}`)

    expect(mockShare).toHaveBeenCalledWith(UUID)
    expect(out).toContain('https://drive.example/link')
  })

  it('una proposta scaduta lo dice, invece di restituire un link vuoto', async () => {
    mockShare.mockResolvedValue(null)

    const out = await invia(`/condividi_ok_${UUID}`)

    expect(out).toContain('non trovata, già usata o scaduta')
  })
})

describe('POST /api/chat — il dispatcher non mangia le conversazioni normali', () => {
  // Controllo positivo. Senza, tutte le asserzioni "non ha chiamato il modello"
  // qui sopra sarebbero verdi anche se la route non chiamasse MAI il modello.
  it('un messaggio normale arriva al modello', async () => {
    await invia('preparami il SAL del cantiere di Paterno')

    expect(mockCallClaude).toHaveBeenCalledTimes(1)
    expect(mockSalStep1).not.toHaveBeenCalled()
    expect(mockRegoleList).not.toHaveBeenCalled()
  })

  it('un comando con uuid malformato NON viene intercettato', async () => {
    // Se il dispatcher fosse troppo largo si mangerebbe del testo legittimo.
    await invia('/sal_ok_non-un-uuid')

    expect(mockSalStep1).not.toHaveBeenCalled()
    expect(mockCallClaude).toHaveBeenCalledTimes(1)
  })
})
