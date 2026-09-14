import { describe, it, expect } from 'vitest'
import { chiaveTokenMorto } from './google-oauth'

describe('la bandierina del token morto e per account', () => {
  it('🚨 due account NON condividono la stessa bandierina', () => {
    const a = chiaveTokenMorto('restruktura.drive@gmail.com')
    const b = chiaveTokenMorto('larealestate.amministrazione@gmail.com')
    expect(a).not.toBe(b)
  })

  it('la chiave nomina l account, cosi si legge nel database senza decifrarla', () => {
    expect(chiaveTokenMorto('larealestate.amministrazione@gmail.com'))
      .toBe('google_token_dead:larealestate.amministrazione@gmail.com')
  })
})
