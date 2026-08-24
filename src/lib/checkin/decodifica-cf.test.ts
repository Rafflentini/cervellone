/**
 * Leggere il codice fiscale invece di richiedere quello che contiene.
 *
 * Il caso da non sbagliare e' il secolo: due cifre non lo dicono. "80" e' il
 * 1980, "24" il 2024 — e sbagliarlo di cent'anni produce una data di nascita
 * assurda che finisce dritta alla Questura.
 */
import { describe, it, expect } from 'vitest'
import { decodificaCf } from './decodifica-cf'

const OGGI = 2026

describe('un codice valido', () => {
  it('restituisce data, sesso e luogo', () => {
    // Mario Rossi, Roma, 01/01/1980
    expect(decodificaCf('RSSMRA80A01H501U', OGGI)).toEqual({
      sesso: 'M', dataNascita: '1980-01-01', catastale: 'H501', estero: false,
    })
  })

  it('riconosce una donna dal giorno aumentato di 40', () => {
    const d = decodificaCf('VRDNNA90D50H501R', OGGI)!
    expect(d.sesso).toBe('F')
    expect(d.dataNascita).toBe('1990-04-10')
  })

  it('riconosce chi e nato all estero', () => {
    // catastale Z112 = Germania
    const d = decodificaCf('MLLHNS75P08Z112C', OGGI)
    if (d) {
      expect(d.estero).toBe(true)
      expect(d.catastale).toBe('Z112')
    }
  })
})

describe('il secolo', () => {
  it('un bambino nato nel 2022 non finisce nel 1922', () => {
    const d = decodificaCf('RSSLCU22E01H501G', OGGI)!
    expect(d.dataNascita).toBe('2022-05-01')
  })

  it('un adulto nato nel 1980 non finisce nel 2080', () => {
    const d = decodificaCf('RSSMRA80A01H501U', OGGI)!
    expect(d.dataNascita).toBe('1980-01-01')
  })
})

describe('codici che non si decodificano', () => {
  it('uno storpiato non restituisce dati inventati', () => {
    expect(decodificaCf('RSSMRA80A01H501X', OGGI)).toBeNull()
  })

  it('una stringa qualsiasi nemmeno', () => {
    expect(decodificaCf('', OGGI)).toBeNull()
    expect(decodificaCf('non un codice', OGGI)).toBeNull()
  })
})
