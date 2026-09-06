import { describe, it, expect } from 'vitest'
import { numeroOspiti } from './numero-ospiti'

describe('numeroOspiti', () => {
  it('CONTROLLO POSITIVO: un numero normale passa', () => {
    expect(numeroOspiti('4')).toBe(4)
    expect(numeroOspiti(4)).toBe(4)
    expect(numeroOspiti(' 4 ')).toBe(4)
  })

  it('una cella scritta a mano ripiega, e non diventa NaN', () => {
    // Con NaN ogni confronto e' falso e non si lamenta niente: era cosi' che
    // sparivano i collegamenti degli ospiti.
    for (const sporca of ['2 adulti', 'due', '3,5', 'n.d.', '-']) {
      expect(numeroOspiti(sporca, 1)).toBe(1)
      expect(Number.isFinite(numeroOspiti(sporca, 1))).toBe(true)
    }
  })

  it('vuoto o assente vale il ripiego', () => {
    expect(numeroOspiti('', 1)).toBe(1)
    expect(numeroOspiti(null, 1)).toBe(1)
    expect(numeroOspiti(undefined)).toBe(0)
  })

  it('non indovina: un numero decimale si tronca, un negativo ripiega', () => {
    expect(numeroOspiti('3.9')).toBe(3)
    expect(numeroOspiti('-2', 1)).toBe(1)
  })
})
