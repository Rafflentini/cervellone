import { describe, it, expect } from 'vitest'
import { sanitizeForStorage } from './sanitize'

describe('sanitizeForStorage', () => {
  it('NON tocca i numeri di protocollo tecnici', () => {
    const s = 'Ass.Blasi_50%_ASID 00326273-00376303-3K881C.pdf'
    expect(sanitizeForStorage(s)).toBe(s)
  })

  it('NON tocca una partita IVA o un protocollo CILA', () => {
    const s = 'CILA-S prot. 0050230 del 23/09/2021, P.IVA 01234567890'
    expect(sanitizeForStorage(s)).toBe(s)
  })

  it('redige una vera carta di credito', () => {
    expect(sanitizeForStorage('carta 4539 1488 0343 6467')).toContain('[REDACTED]')
  })

  it('continua a redigere le chiavi API', () => {
    expect(sanitizeForStorage('sk-ant-api03-abcdefghij1234567890xyz')).toContain('[REDACTED]')
  })

  it('redige la carta anche se seguita da altre cifre non pertinenti, lasciando intatto il separatore (CR-1)', () => {
    const out = sanitizeForStorage('carta 4539148803436467-01 scad 12/27')
    expect(out).toContain('[REDACTED]-01')
    expect(out).not.toContain('4539148803436467')
  })

  it('NON tocca una riga di computo metrico con codice articolo e superficie (CR-2)', () => {
    const s = '01.A01.001 12345678-9012345 mq 120,50 Euro 3456,78'
    expect(sanitizeForStorage(s)).toBe(s)
  })

  it('redige la carta scritta con spazi, trattini o senza separatori', () => {
    expect(sanitizeForStorage('4539 1488 0343 6467')).toContain('[REDACTED]')
    expect(sanitizeForStorage('4539-1488-0343-6467')).toContain('[REDACTED]')
    expect(sanitizeForStorage('4539148803436467')).toContain('[REDACTED]')
  })

  it('NON tocca un IBAN italiano realistico', () => {
    const s = 'IT60X0542811101000000123456'
    expect(sanitizeForStorage(s)).toBe(s)
  })

  it('NON tocca una sequenza di importi: la finestra non puo iniziare a meta di un numero', () => {
    const s = 'importi 1234 5678 9012 3456 7890 in euro'
    expect(sanitizeForStorage(s)).toBe(s)
  })

  it('nessuna redazione lascia mai cifre orfane attaccate a [REDACTED]', () => {
    const samples = [
      'importi 1234 5678 9012 3456 7890 in euro',
      'carta 4539148803436467-01 scad 12/27',
      'ordine 12-4539148803436467 confermato',
      'a 4539148803436467 b 5555555555554444',
      'rif.4539148803436467/2026 protocollo',
    ]
    for (const s of samples) {
      const out = sanitizeForStorage(s)
      expect(out).not.toMatch(/\d\[REDACTED\]/)
      expect(out).not.toMatch(/\[REDACTED\]\d/)
    }
  })

  it('redige la carta preceduta da un trattino (confine non-cifra a sinistra)', () => {
    const out = sanitizeForStorage('ordine 12-4539148803436467 confermato')
    expect(out).toBe('ordine 12-[REDACTED] confermato')
  })

  it('redige due carte distinte nello stesso testo', () => {
    const out = sanitizeForStorage('a 4539148803436467 b 5555555555554444')
    expect(out).toContain('a [REDACTED] b [REDACTED]')
  })

  it('redige la carta anche subito dopo un punto, prima di uno slash', () => {
    const out = sanitizeForStorage('rif.4539148803436467/2026 protocollo')
    expect(out).toBe('rif.[REDACTED]/2026 protocollo')
  })

  it('redige un Visa di test valido anche se sembra una matricola (in dubbio, si protegge)', () => {
    const out = sanitizeForStorage('matricola 4532015112830366 apparecchio')
    expect(out).toContain('[REDACTED]')
  })
})
