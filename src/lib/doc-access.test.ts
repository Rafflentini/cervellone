import { describe, it, expect, beforeAll } from 'vitest'
import { getAuthToken, isAuthedCookie, signShareToken, verifyShareToken, isDocAccessAllowed } from './doc-access'

beforeAll(() => { process.env.AUTH_SECRET = 'test-secret' })

describe('doc-access', () => {
  it('isAuthedCookie: solo il token di sessione corretto passa', () => {
    expect(isAuthedCookie(getAuthToken())).toBe(true)
    expect(isAuthedCookie('sbagliato')).toBe(false)
    expect(isAuthedCookie(undefined)).toBe(false)
  })

  it('verifyShareToken: valido entro scadenza, no se scaduto o manomesso', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const tok = signShareToken('doc1', exp)
    expect(verifyShareToken('doc1', tok, exp)).toBe(true)
    expect(verifyShareToken('doc1', tok, Math.floor(Date.now() / 1000) - 1)).toBe(false) // scaduto
    expect(verifyShareToken('doc2', tok, exp)).toBe(false) // id diverso
    expect(verifyShareToken('doc1', 'deadbeef', exp)).toBe(false) // token finto
  })

  it('isAuthedCookie: coerente con validateAuth — la variante case dell-hex NON passa (audit r2 P2)', () => {
    const valid = getAuthToken()
    expect(isAuthedCookie(valid)).toBe(true)
    expect(isAuthedCookie(valid.toUpperCase())).toBe(false) // solo il token canonico (lowercase) è valido
  })

  it('signShareToken: nessuna collisione di concatenazione (audit r2 P3)', () => {
    // Col vecchio `${docId}.${expSec}`: sign("foo",1.2) === sign("foo.1",2). Ora devono differire.
    expect(signShareToken('foo', 1.2)).not.toBe(signShareToken('foo.1', 2))
    expect(signShareToken('a', 12)).not.toBe(signShareToken('a.1', 2))
  })

  it('isDocAccessAllowed: cookie OPPURE share token', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const tok = signShareToken('d', exp)
    expect(isDocAccessAllowed({ id: 'd', cookieToken: getAuthToken() })).toBe(true)
    expect(isDocAccessAllowed({ id: 'd', shareToken: tok, exp })).toBe(true)
    expect(isDocAccessAllowed({ id: 'd' })).toBe(false)
  })
})
