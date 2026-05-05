import { describe, it, expect } from 'vitest'
import { detectHallucination } from './circuit-breaker'

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
