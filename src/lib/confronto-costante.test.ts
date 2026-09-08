/**
 * `timingSafeEqual` lancia se i due Buffer hanno lunghezze diverse.
 *
 * La guardia c'era, in otto copie identiche, e confrontava i CARATTERI:
 *
 *   if (ricevuto.length !== atteso.length) return false
 *   return crypto.timingSafeEqual(Buffer.from(ricevuto), Buffer.from(atteso))
 *
 * Ma `Buffer.from` conta i BYTE. Una stringa di 8 caratteri con un accento ne
 * occupa 9, quindi supera la guardia e fa esplodere il confronto: l'ospite che
 * apre un collegamento storpiato riceve un **500** invece di «Collegamento non
 * valido», e nei log resta un'eccezione al posto di un tentativo respinto.
 */
import { describe, it, expect } from 'vitest'
import { confrontoCostante } from './confronto-costante'

describe('confrontoCostante', () => {
  it('due stringhe uguali combaciano', () => {
    expect(confrontoCostante('token-segreto', 'token-segreto')).toBe(true)
  })

  it('due stringhe diverse no', () => {
    expect(confrontoCostante('token-segreto', 'token-sbagliato')).toBe(false)
  })

  // IL DIFETTO: 8 caratteri contro 8 caratteri, ma 9 byte contro 8.
  it('un token con un accento NON lancia: risponde false', () => {
    expect(() => confrontoCostante('abcdefgà', 'abcdefgh')).not.toThrow()
    expect(confrontoCostante('abcdefgà', 'abcdefgh')).toBe(false)
  })

  it('nemmeno con emoji, che occupano quattro byte', () => {
    expect(() => confrontoCostante('🔑', 'ab')).not.toThrow()
    expect(confrontoCostante('🔑', 'ab')).toBe(false)
  })

  it('vuoto, null e undefined non combaciano mai — nemmeno fra loro', () => {
    expect(confrontoCostante(null, 'x')).toBe(false)
    expect(confrontoCostante('x', undefined)).toBe(false)
    expect(confrontoCostante('', '')).toBe(false)
    expect(confrontoCostante(null, null)).toBe(false)
  })

  it('lunghezze diverse: false, senza lanciare', () => {
    expect(() => confrontoCostante('corto', 'molto piu lungo')).not.toThrow()
    expect(confrontoCostante('corto', 'molto piu lungo')).toBe(false)
  })

  // `doc-access` confronta firme esadecimali: un carattere non-hex viene
  // scartato da Buffer.from, quindi due stringhe della stessa lunghezza
  // possono dare byte di lunghezza diversa.
  // ⭐ Trovato dal mutation testing: `Buffer.from('zzzz', 'hex')` non lancia,
  // restituisce ZERO byte. Senza la guardia sul buffer vuoto, due firme
  // entrambe non valide avrebbero la stessa lunghezza (0) e `timingSafeEqual`
  // le direbbe UGUALI. Una firma spazzatura che ne valida un'altra spazzatura.
  it('due firme esadecimali entrambe invalide NON combaciano', () => {
    expect(confrontoCostante('zzzz', 'wwww', 'hex')).toBe(false)
    expect(confrontoCostante('non-esadecimale', 'nemmeno-questa', 'hex')).toBe(false)
  })

  it('in esadecimale, un carattere non valido non lancia', () => {
    expect(() => confrontoCostante('zzzz', 'abcd', 'hex')).not.toThrow()
    expect(confrontoCostante('zzzz', 'abcd', 'hex')).toBe(false)
    expect(confrontoCostante('abcd', 'abcd', 'hex')).toBe(true)
  })
})
