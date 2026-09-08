/**
 * `salva_documento_su_drive` crea un Google Doc, che NON puo' contenere
 * immagini. L'avviso che lo dice all'Ingegnere e' l'unica cosa che lui vede —
 * e non era coperto da nessun test: mutare la condizione in `false` lasciava
 * 1825 prove verdi. Adattatore non provato, motore si': la regola del progetto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSalva = vi.fn()
vi.mock('./document-saver', () => ({
  saveDocumentToDrive: (...a: unknown[]) => mockSalva(...a),
  inferDocumentType: () => 'preventivo',
}))
vi.mock('./google-oauth', () => ({ getAuthorizedClient: async () => null }))
vi.mock('googleapis', () => ({
  google: { auth: { GoogleAuth: vi.fn() }, drive: vi.fn(), sheets: vi.fn() },
}))
vi.mock('./supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }) },
}))

const esitoBase = {
  driveUrl: 'https://drive.google.com/file/d/abc/view',
  folderPath: '/STUDIO TECNICO/',
  isFallback: false,
  fileName: 'Preventivo.gdoc',
  fileId: 'abc',
  registroAppended: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = '{}'
})

describe('salva_documento_su_drive — le foto che il Google Doc non puo tenere', () => {
  it('quando una foto resta fuori, lo DICE', async () => {
    mockSalva.mockResolvedValue({ ...esitoBase, immaginiPerse: ['1Zg97_TDKOoUWeAAYs'] })
    const { executeDriveTool } = await import('./drive')

    const risposta = await executeDriveTool('salva_documento_su_drive', {
      html_content: '<p>x</p>', title: 'Preventivo',
    })

    expect(risposta).toContain('⚠️')
    expect(risposta).toContain('non puo')
    expect(risposta).toContain('PDF')
  })

  it('al plurale conta bene', async () => {
    mockSalva.mockResolvedValue({ ...esitoBase, immaginiPerse: ['a', 'b', 'c'] })
    const { executeDriveTool } = await import('./drive')

    const risposta = await executeDriveTool('salva_documento_su_drive', {
      html_content: '<p>x</p>', title: 'Preventivo',
    })

    expect(risposta).toContain('3 foto')
  })

  // CONTROLLO POSITIVO: senza, un avviso emesso SEMPRE passerebbe i test qui
  // sopra e infilerebbe un allarme in fondo a ogni documento senza foto.
  it('un documento senza foto non riceve nessun allarme', async () => {
    mockSalva.mockResolvedValue({ ...esitoBase, immaginiPerse: [] })
    const { executeDriveTool } = await import('./drive')

    const risposta = await executeDriveTool('salva_documento_su_drive', {
      html_content: '<p>x</p>', title: 'Preventivo',
    })

    expect(risposta).toContain('✅')
    expect(risposta).not.toContain('⚠️')
  })
})
