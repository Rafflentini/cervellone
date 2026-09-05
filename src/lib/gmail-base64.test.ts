import { describe, it, expect } from 'vitest'
import { base64UrlAStandard } from './gmail-tools'

describe('allegati Gmail: da base64url a base64', () => {
  // Gmail consegna gli allegati in base64url ('-' e '_' al posto di '+' e '/',
  // e senza riempimento). Passato cosi' com'e' a nodemailer produce un PDF
  // corrotto — che e' peggio di un PDF mancante: sembra arrivato.
  // Questa funzione decide se la fattura si apre. Non aveva nessun test.

  it("rimette '+' e '/' al posto dei caratteri sicuri per gli indirizzi", () => {
    expect(base64UrlAStandard('ab-cd_ef')).toBe('ab+cd/ef')
  })

  it('rimette il riempimento quando avanzano due caratteri', () => {
    // 6 caratteri: 6 % 4 = 2, servono due '='
    expect(base64UrlAStandard('QUJDREVG')).toBe('QUJDREVG') // 8: multiplo di 4, nessun riempimento
    expect(base64UrlAStandard('QUJDRA')).toBe('QUJDRA==')
  })

  it('rimette il riempimento quando avanza un carattere', () => {
    // 7 caratteri: serve un solo '='
    expect(base64UrlAStandard('QUJDREVH')).toHaveLength(8)
    expect(base64UrlAStandard('QUJDREU')).toBe('QUJDREU=')
  })

  it('CONTROLLO POSITIVO: quello che esce si decodifica davvero', () => {
    // Il test che conta: non la forma della stringa, ma che il contenuto torni.
    const originale = Buffer.from('%PDF-1.7 fattura di prova ~~~ \xff\xfe', 'binary')
    const inBase64Url = originale.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

    const tornato = Buffer.from(base64UrlAStandard(inBase64Url), 'base64')

    expect(tornato.equals(originale)).toBe(true)
  })

  it('una stringa gia in forma standard non viene rovinata', () => {
    const gia = Buffer.from('prova').toString('base64')
    expect(Buffer.from(base64UrlAStandard(gia), 'base64').toString()).toBe('prova')
  })
})
