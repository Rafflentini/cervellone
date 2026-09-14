import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
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

/**
 * ⚠️ IL TERZO RIPIEGO. La bonifica del 6 settembre 2026 tolse
 * `process.env.AUTH_SECRET || 'cervellone'` da due file e si lascio' dietro
 * `shareSecret()`, in QUESTO file, venti righe sotto un `getAuthToken()` che
 * invece si rifiuta di firmare senza segreto.
 *
 * Era il peggiore dei tre: non degradava a `undefined` ma a una costante
 * LEGGIBILE nel sorgente di un repository pubblico. Chiunque avesse letto il
 * codice poteva firmarsi il collegamento di qualunque documento di cui
 * conoscesse l'id — e gli id girano nelle chat.
 */
describe('doc-access — un AUTH_SECRET che manca CHIUDE anche i collegamenti share', () => {
  const exp = () => Math.floor(Date.now() / 1000) + 3600
  let segretoDiPrima: string | undefined
  beforeEach(() => { segretoDiPrima = process.env.AUTH_SECRET })
  afterEach(() => {
    if (segretoDiPrima === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = segretoDiPrima
  })

  it('🚨 il token calcolato col vecchio ripiego «cervellone» NON apre piu niente', () => {
    // Questa e' la prova dell'ATTACCO, non della difesa: il token qui sotto e'
    // quello che un estraneo si sarebbe firmato da solo leggendo il repo.
    // Costruito a mano con la costante letterale, cosi' resta vero anche se
    // un domani `shareSecret()` cambiasse forma.
    const e = exp()
    const tokenDellEstraneo = crypto
      .createHmac('sha256', 'cervellone:doc_share')
      .update(JSON.stringify(['doc-segreto', e]))
      .digest('hex')

    delete process.env.AUTH_SECRET
    expect(verifyShareToken('doc-segreto', tokenDellEstraneo, e)).toBe(false)
    expect(isDocAccessAllowed({ id: 'doc-segreto', shareToken: tokenDellEstraneo, exp: e })).toBe(false)

    // E nemmeno CON un segreto configurato, che e' il caso di tutti i giorni:
    // il ripiego non dev'essere una chiave di scorta.
    process.env.AUTH_SECRET = 'test-secret'
    expect(verifyShareToken('doc-segreto', tokenDellEstraneo, e)).toBe(false)
  })

  it('🚨 senza segreto non si FIRMA un collegamento indovinabile: alza', () => {
    delete process.env.AUTH_SECRET
    expect(() => signShareToken('doc1', exp())).toThrow(/AUTH_SECRET/)
  })

  it('🚨 AUTH_SECRET fatta di spazi vale come assente', () => {
    // Su Vercel una variabile «impostata a niente» esiste come stringa vuota.
    process.env.AUTH_SECRET = '   '
    expect(() => signShareToken('doc1', exp())).toThrow(/AUTH_SECRET/)
  })

  it('chi VERIFICA nega, non solleva: l ospite vede «non valido», non un 500', () => {
    // `shareSecret()` alza, ma un'eccezione che risalisse fin qui diventerebbe
    // un 500 in faccia a chi apre un collegamento legittimo mentre il server
    // e' mal configurato.
    process.env.AUTH_SECRET = 'test-secret'
    const e = exp()
    const tokenLegittimo = signShareToken('doc1', e)

    delete process.env.AUTH_SECRET
    expect(() => verifyShareToken('doc1', tokenLegittimo, e)).not.toThrow()
    expect(verifyShareToken('doc1', tokenLegittimo, e)).toBe(false)
  })

  it('CONTROLLO POSITIVO — col segreto configurato, firmare e verificare funzionano ancora', () => {
    // Senza questo, tutto il blocco resterebbe verde anche avendo spento la
    // condivisione dei documenti: negherebbe sempre, e se ne accorgerebbe solo
    // il cliente che riceve un collegamento morto.
    process.env.AUTH_SECRET = 'test-secret'
    const e = exp()
    const tok = signShareToken('doc1', e)
    expect(verifyShareToken('doc1', tok, e)).toBe(true)
    expect(isDocAccessAllowed({ id: 'doc1', shareToken: tok, exp: e })).toBe(true)
  })
})
