/**
 * Codice fiscale.
 *
 * Un CF sbagliato non da' errore: entra in fattura, arriva allo SdI e torna
 * indietro come scarto giorni dopo, quando l'ospite se n'e' andato. Per questo
 * i test partono da un valore verificabile dall'esterno e non da uno che ho
 * calcolato io con lo stesso codice che sto provando.
 *
 * Riferimento pubblico: Mario Rossi, nato a Roma il 01/01/1980 -> RSSMRA80A01H501U.
 */
import { describe, it, expect } from 'vitest'
import { calcolaCodiceFiscale, treLettereCognome, treLettereNome } from './codice-fiscale'

/** Tabella catastale finta: nella realta' arriva dalla scheda "Tabelle". */
const catastale = (luogo: string): string => ({
  ROMA: 'H501', MARATEA: 'E919', MILANO: 'F205', GERMANIA: 'Z112',
}[luogo.toUpperCase()] ?? '')

describe('caso di riferimento', () => {
  it('Mario Rossi, Roma, 01/01/1980 -> RSSMRA80A01H501U', () => {
    const r = calcolaCodiceFiscale({
      cognome: 'Rossi', nome: 'Mario', sesso: 'M',
      dataNascita: '1980-01-01', comuneNascita: 'Roma',
    }, catastale)
    expect(r.ok).toBe(true)
    expect(r.cf).toBe('RSSMRA80A01H501U')
  })
})

describe('le tre lettere del cognome', () => {
  it('prende le consonanti in ordine', () => {
    expect(treLettereCognome('Rossi')).toBe('RSS')
    expect(treLettereCognome('Bianchi')).toBe('BNC')
  })
  it('completa con le vocali quando le consonanti non bastano', () => {
    expect(treLettereCognome('Aiello')).toBe('LLA')
  })
  it('riempie con X i cognomi troppo corti', () => {
    expect(treLettereCognome('Fo')).toBe('FOX')
  })
  it('ignora accenti, spazi e apostrofi', () => {
    expect(treLettereCognome("D'Addario")).toBe('DDD')
    expect(treLettereCognome('Dà Sìlva')).toBe('DSL')
  })
})

describe('le tre lettere del nome', () => {
  it('con quattro o piu consonanti prende la 1a, 3a e 4a', () => {
    // La regola che quasi tutte le implementazioni sbagliate ignorano.
    expect(treLettereNome('Francesco')).toBe('FNC')
    expect(treLettereNome('Giovanni')).toBe('GNN')
  })
  it('con meno di quattro consonanti le prende in ordine', () => {
    expect(treLettereNome('Mario')).toBe('MRA')
    expect(treLettereNome('Luca')).toBe('LCU')
  })
  it('tratta il doppio nome come un nome solo', () => {
    expect(treLettereNome('Anna Maria')).toBe('NMR')
  })
})

describe('data e sesso', () => {
  it('usa la lettera del mese giusta', () => {
    const mesi = ['A', 'B', 'C', 'D', 'E', 'H', 'L', 'M', 'P', 'R', 'S', 'T']
    mesi.forEach((lettera, i) => {
      const mm = String(i + 1).padStart(2, '0')
      const r = calcolaCodiceFiscale({
        cognome: 'Rossi', nome: 'Mario', sesso: 'M',
        dataNascita: `1980-${mm}-01`, comuneNascita: 'Roma',
      }, catastale)
      expect(r.cf.substring(8, 9)).toBe(lettera)
    })
  })

  it('somma 40 al giorno per le donne', () => {
    const uomo = calcolaCodiceFiscale({
      cognome: 'Rossi', nome: 'Mario', sesso: 'M',
      dataNascita: '1980-01-01', comuneNascita: 'Roma',
    }, catastale)
    const donna = calcolaCodiceFiscale({
      cognome: 'Rossi', nome: 'Mario', sesso: 'F',
      dataNascita: '1980-01-01', comuneNascita: 'Roma',
    }, catastale)
    expect(uomo.cf.substring(9, 11)).toBe('01')
    expect(donna.cf.substring(9, 11)).toBe('41')
  })
})

describe('nati all estero', () => {
  it('usa il codice dello stato al posto del comune', () => {
    const r = calcolaCodiceFiscale({
      cognome: 'Rossi', nome: 'Mario', sesso: 'M',
      dataNascita: '1980-01-01', comuneNascita: '', statoNascita: 'Germania',
    }, catastale)
    expect(r.ok).toBe(true)
    expect(r.cf.substring(11, 15)).toBe('Z112')
  })
})

describe('quando non si puo calcolare', () => {
  it('dice cosa manca invece di restituire un codice inventato', () => {
    const r = calcolaCodiceFiscale({
      cognome: 'Rossi', nome: '', sesso: 'M',
      dataNascita: '1980-01-01', comuneNascita: 'Roma',
    }, catastale)
    expect(r.ok).toBe(false)
    expect(r.cf).toBe('')
    expect(r.errore).toContain('incompleti')
  })

  it('nomina il luogo mancante dalla tabella, cosi si sa cosa aggiungere', () => {
    const r = calcolaCodiceFiscale({
      cognome: 'Rossi', nome: 'Mario', sesso: 'M',
      dataNascita: '1980-01-01', comuneNascita: 'Vattelapesca',
    }, catastale)
    expect(r.ok).toBe(false)
    expect(r.errore).toContain('Vattelapesca')
  })

  it('rifiuta una data non valida invece di produrre un CF storto', () => {
    const r = calcolaCodiceFiscale({
      cognome: 'Rossi', nome: 'Mario', sesso: 'M',
      dataNascita: '01/01/1980', comuneNascita: 'Roma',
    }, catastale)
    expect(r.ok).toBe(false)
  })

  it('rifiuta un mese fuori scala invece di leggere oltre la tabella dei mesi', () => {
    const r = calcolaCodiceFiscale({
      cognome: 'Rossi', nome: 'Mario', sesso: 'M',
      dataNascita: '1980-13-01', comuneNascita: 'Roma',
    }, catastale)
    expect(r.ok).toBe(false)
  })
})

describe('forma del risultato', () => {
  it('sono sempre 16 caratteri maiuscoli', () => {
    const r = calcolaCodiceFiscale({
      cognome: 'bianchi', nome: 'anna maria', sesso: 'F',
      dataNascita: '1975-06-15', comuneNascita: 'maratea',
    }, catastale)
    expect(r.cf).toMatch(/^[A-Z0-9]{16}$/)
  })
})
