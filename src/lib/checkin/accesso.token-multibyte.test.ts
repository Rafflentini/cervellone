/**
 * Un collegamento storpiato dava 500 invece di «Collegamento non valido».
 *
 * `timingSafeEqual` pretende due Buffer della STESSA lunghezza in byte, e la
 * guardia che lo precedeva contava i CARATTERI. Otto caratteri con un accento
 * fanno nove byte: la guardia li lasciava passare e il confronto lanciava.
 *
 * Non e' un buco di sicurezza — l'accesso resta negato — ma e' la differenza
 * fra un tentativo respinto e un'eccezione: l'ospite legge «errore del
 * server» invece di «collegamento non valido», e chi guarda i log vede un
 * guasto dove c'e' un link sbagliato.
 *
 * Riprodotto PRIMA della difesa: con le tre righe di prima,
 * `RangeError: Input buffers must have the same byte length`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { risolviAccesso } from './accesso'

const ORIGINALE = process.env.CHECKIN_TOKEN

beforeEach(() => { process.env.CHECKIN_TOKEN = 'abcdefgh' })
afterEach(() => {
  if (ORIGINALE === undefined) delete process.env.CHECKIN_TOKEN
  else process.env.CHECKIN_TOKEN = ORIGINALE
})

describe('accesso — un token storpiato non fa esplodere la rotta', () => {
  it('otto caratteri con un accento: nove byte, e NON lancia', () => {
    // La stessa lunghezza in caratteri del token vero, una in piu' in byte.
    const storpiato = 'abcdefgà'
    expect(storpiato.length).toBe(8)
    expect(Buffer.from(storpiato).length).toBe(9)

    expect(() => risolviAccesso(storpiato, null, null, null)).not.toThrow()
    expect(risolviAccesso(storpiato, null, null, null).ok).toBe(false)
  })

  it('nemmeno con un emoji', () => {
    expect(() => risolviAccesso('🔑🔑', null, null, null)).not.toThrow()
    expect(risolviAccesso('🔑🔑', null, null, null).ok).toBe(false)
  })

  // CONTROLLO POSITIVO: senza, una funzione che nega SEMPRE passerebbe
  // i due test qui sopra a mani basse.
  it('il token giusto apre ancora', () => {
    const esito = risolviAccesso('abcdefgh', null, null, null)
    expect(esito.ok).toBe(true)
  })
})
