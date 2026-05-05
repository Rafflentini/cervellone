import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectHallucination, getActiveModel, invalidateCache } from './circuit-breaker'

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

import { supabase } from './supabase'

describe('detectHallucination', () => {
  describe('promise pattern + 0 tool → true (hallucination)', () => {
    const cases = [
      'Ora lo cerco subito!',
      'Lo controllo per Lei.',
      'Ora cerco il DURC.',
      'Faccio subito.',
      'Vado a leggere il file.',
      'Verifico subito.',
      'La leggo e Le dico.',
      'Adesso cerco nelle cartelle.',
      'Ora verifico.',
      'Lo trovo io.',
    ]
    cases.forEach(text => {
      it(`"${text.slice(0, 30)}..." → true`, () => {
        expect(detectHallucination(text, 0)).toBe(true)
      })
    })
  })

  describe('promise pattern + ≥1 tool → false (legitimate)', () => {
    it('promise con tool chiamato non è hallucination', () => {
      expect(detectHallucination('Ora lo cerco subito!', 1)).toBe(false)
    })
  })

  describe('no promise pattern → false', () => {
    const cases = [
      'Ho letto il file. Il DURC è regolare.',
      'Non ho trovato il documento richiesto.',
      'Le rispondo a momenti.',
      'Buongiorno Ingegnere.',
      'Il preventivo è pronto.',
      'Ho elaborato la richiesta.',
    ]
    cases.forEach(text => {
      it(`"${text.slice(0, 30)}..." → false`, () => {
        expect(detectHallucination(text, 0)).toBe(false)
      })
    })
  })
})

describe('getActiveModel', () => {
  beforeEach(() => {
    invalidateCache()
    vi.clearAllMocks()
  })

  it('legge model_active dalla config', async () => {
    const fromMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({
          data: [
            { key: 'model_active', value: '"claude-opus-latest"' },
            { key: 'circuit_state', value: '{"state":"NORMAL","tripped_at":null,"reason":null,"canary_consecutive_ok":0}' },
          ],
          error: null,
        }),
      }),
    })
    ;(supabase.from as any).mockImplementation(fromMock)

    const model = await getActiveModel()
    expect(model).toBe('claude-opus-latest')
  })

  it('usa fallback se Supabase ritorna errore', async () => {
    const fromMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({
          data: null,
          error: new Error('connection lost'),
        }),
      }),
    })
    ;(supabase.from as any).mockImplementation(fromMock)

    const model = await getActiveModel()
    expect(model).toBe('claude-opus-4-7')
  })

  it('cache la seconda chiamata entro 60s', async () => {
    const inMock = vi.fn().mockResolvedValue({
      data: [{ key: 'model_active', value: '"test-model"' }],
      error: null,
    })
    const fromMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ in: inMock }),
    })
    ;(supabase.from as any).mockImplementation(fromMock)

    await getActiveModel()
    await getActiveModel()
    expect(inMock).toHaveBeenCalledTimes(1)
  })
})
