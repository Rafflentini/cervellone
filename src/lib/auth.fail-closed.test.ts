import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { validateAuth, segretoSessione } from './auth'
import { getAuthToken } from './doc-access'
import crypto from 'crypto'

/**
 * Fino al 6 settembre 2026 il segreto di sessione aveva un ripiego cablato —
 * `process.env.AUTH_SECRET || 'cervellone'` — in un repository PUBBLICO.
 * Bastava che la variabile mancasse (un deploy nuovo, un ambiente di prova, una
 * svista) perche il cookie diventasse calcolabile da chiunque avesse letto il
 * codice. E l'app continuava a funzionare: il degrado era invisibile.
 */

const ORIGINALE = process.env.AUTH_SECRET

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => {
  if (ORIGINALE === undefined) delete process.env.AUTH_SECRET
  else process.env.AUTH_SECRET = ORIGINALE
  vi.restoreAllMocks()
})

function cookieCol(segreto: string): string {
  return crypto.createHmac('sha256', segreto).update('cervellone_v2').digest('hex')
}

describe('il segreto di sessione non ha piu un ripiego', () => {
  it('CONTROLLO POSITIVO: senza AUTH_SECRET nessun cookie viene accettato', () => {
    delete process.env.AUTH_SECRET
    // Il valore che chiunque avrebbe potuto calcolare leggendo il repo.
    expect(validateAuth(cookieCol('cervellone'))).toBe(false)
  })

  it('e nemmeno un cookie qualsiasi passa, ovviamente', () => {
    delete process.env.AUTH_SECRET
    expect(validateAuth('qualunquecosa')).toBe(false)
  })

  it('il login NON emette un token indovinabile: alza, invece', () => {
    // I due lati devono comportarsi allo stesso modo. Se il login emettesse un
    // cookie mentre validateAuth nega, tornerebbe il 401 perpetuo di maggio:
    // login riuscito e ogni richiesta successiva rifiutata.
    delete process.env.AUTH_SECRET
    expect(() => getAuthToken()).toThrow(/AUTH_SECRET/)
  })

  it('una variabile fatta di soli spazi vale come mancante', () => {
    process.env.AUTH_SECRET = '   '
    expect(segretoSessione()).toBeNull()
    expect(validateAuth(cookieCol('cervellone'))).toBe(false)
  })

  it('CONTROPROVA: col segreto configurato, login e verifica combaciano', () => {
    // Senza questa prova, "nega sempre" passerebbe tutti i test qui sopra.
    process.env.AUTH_SECRET = 'un-segreto-vero-e-lungo-abbastanza'
    const token = getAuthToken()
    expect(validateAuth(token)).toBe(true)
    // E un cookie calcolato col vecchio ripiego non vale piu nulla.
    expect(validateAuth(cookieCol('cervellone'))).toBe(false)
  })
})
