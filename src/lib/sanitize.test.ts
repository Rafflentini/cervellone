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
})
