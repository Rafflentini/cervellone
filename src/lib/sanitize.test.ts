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
})
