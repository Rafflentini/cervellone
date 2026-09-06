/**
 * I dati letti da una foto sono un SUGGERIMENTO, e questo file prova che il
 * suggerimento non si permette di indovinare.
 *
 * La regola: cio' che non si legge con chiarezza torna vuoto. Un campo vuoto
 * si nota, un campo pieno e sbagliato no — e questi campi vanno alla Questura.
 */

import { describe, it, expect } from 'vitest'
import { interpretaRisposta, dataIso } from './lettura-documento'

/** Una risposta come la manda il modello. */
function risposta(campi: Record<string, unknown>): string {
  return JSON.stringify({
    cognome: '', nome: '', sesso: '', dataNascita: '', comuneNascita: '', provNascita: '',
    statoNascita: '', cittadinanza: '', tipoDocumento: '', numeroDocumento: '',
    luogoRilascio: '', codiceFiscale: '', illeggibile: [], ...campi,
  })
}

describe('dataIso', () => {
  it('CONTROLLO POSITIVO: le forme che stanno sui documenti passano', () => {
    expect(dataIso('12.04.1985')).toBe('1985-04-12')
    expect(dataIso('12/04/1985')).toBe('1985-04-12')
    expect(dataIso('12-04-1985')).toBe('1985-04-12')
    expect(dataIso('1985-04-12')).toBe('1985-04-12')
    expect(dataIso('5.4.1985')).toBe('1985-04-05')
  })

  it('una data che non esiste non passa', () => {
    // Il 31 febbraio si legge benissimo su una foto sfocata.
    expect(dataIso('31.02.1985')).toBe('')
    expect(dataIso('1985-13-01')).toBe('')
  })

  it('quello che non e una data torna vuoto, non si indovina', () => {
    for (const x of ['circa 1985', '04.1985', '12 aprile 1985', 'boh', '']) {
      expect(dataIso(x)).toBe('')
    }
  })
})

describe('interpretaRisposta', () => {
  it('CONTROLLO POSITIVO: una lettura pulita arriva intera', () => {
    const e = interpretaRisposta(risposta({
      cognome: 'rossi', nome: 'maria', sesso: 'F', dataNascita: '12.04.1985',
      comuneNascita: 'maratea', provNascita: 'pz', cittadinanza: 'italia',
      tipoDocumento: 'IDENT', numeroDocumento: 'CA 12345 AB', luogoRilascio: 'maratea',
    }))
    expect(e.ok).toBe(true)
    expect(e.dati.cognome).toBe('ROSSI')
    expect(e.dati.nome).toBe('MARIA')
    expect(e.dati.sesso).toBe('F')
    expect(e.dati.dataNascita).toBe('1985-04-12')
    expect(e.dati.provNascita).toBe('PZ')
    // Il numero come stampato ma senza spazi: e' cosi' che va nel tracciato.
    expect(e.dati.numeroDocumento).toBe('CA12345AB')
  })

  it('⭐ un codice fiscale che non regge NON entra nel modulo, e lo dice', () => {
    // Sedici caratteri che somigliano a un codice sono quello che esce da una
    // foto sfocata. Farlo comparire nel campo vorrebbe dire che nessuno lo
    // ricontrolla piu'.
    const e = interpretaRisposta(risposta({
      cognome: 'ROSSI', codiceFiscale: 'RSSMRA85D52XXXXX',
    }))
    expect(e.dati.codiceFiscale).toBe('')
    expect(e.avvisi.join(' ')).toMatch(/codice fiscale.*non e valido/i)
  })

  it('CONTROLLO POSITIVO: un codice fiscale valido invece entra', () => {
    const e = interpretaRisposta(risposta({ codiceFiscale: 'rssmra85d52e919x' }))
    expect(e.dati.codiceFiscale).toBe('RSSMRA85D52E919X')
    expect(e.avvisi.join(' ')).not.toMatch(/non e valido/i)
  })

  it('un tipo di documento che il modulo non conosce resta vuoto', () => {
    // "ALTRO" non esiste fra i tipi del Portale Alloggiati: proporlo
    // significherebbe far generare un file che il Portale rifiuta.
    for (const t of ['ALTRO', 'TESSERA', 'CIE', '']) {
      expect(interpretaRisposta(risposta({ tipoDocumento: t })).dati.tipoDocumento).toBe('')
    }
    expect(interpretaRisposta(risposta({ tipoDocumento: 'PASOR' })).dati.tipoDocumento).toBe('PASOR')
  })

  it('il sesso si accetta solo se dichiarato, e nelle forme che i documenti usano', () => {
    expect(interpretaRisposta(risposta({ sesso: 'femminile' })).dati.sesso).toBe('F')
    expect(interpretaRisposta(risposta({ sesso: 'MASCHIO' })).dati.sesso).toBe('M')
    // Qualunque altra cosa: vuoto. Il modulo parte da M, e un sesso sbagliato
    // va alla Questura senza che nessuno se ne accorga.
    expect(interpretaRisposta(risposta({ sesso: 'probabilmente F' })).dati.sesso).toBe('')
    expect(interpretaRisposta(risposta({ sesso: 'X' })).dati.sesso).toBe('')
  })

  it('i campi che il modello dichiara illeggibili diventano un avviso', () => {
    const e = interpretaRisposta(risposta({
      cognome: 'ROSSI', illeggibile: ['numeroDocumento', 'dataNascita'],
    }))
    expect(e.avvisi.join(' ')).toContain('numeroDocumento')
    expect(e.avvisi.join(' ')).toContain('Scrivili a mano')
  })

  it('una data illeggibile non diventa una data a caso, e viene detto', () => {
    const e = interpretaRisposta(risposta({ cognome: 'ROSSI', dataNascita: 'circa 1985' }))
    expect(e.dati.dataNascita).toBe('')
    expect(e.avvisi.join(' ')).toMatch(/data di nascita.*non e una data valida/i)
  })

  it('se non si legge NIENTE lo dice, invece di restituire un modulo vuoto', () => {
    const e = interpretaRisposta(risposta({}))
    expect(e.ok).toBe(false)
    expect(e.errore).toMatch(/non sono riuscito a leggere niente/i)
    expect(e.errore).toMatch(/luce|riflessi|fuoco/i)
  })

  it('una risposta incorniciata da altro testo si legge lo stesso', () => {
    const e = interpretaRisposta('Ecco i dati:\n```json\n' + risposta({ cognome: 'ROSSI' }) + '\n```\nSpero vada bene.')
    expect(e.ok).toBe(true)
    expect(e.dati.cognome).toBe('ROSSI')
  })

  it('una risposta che non e JSON non fa esplodere niente', () => {
    const e = interpretaRisposta('Mi dispiace, non posso aiutarti con questo.')
    expect(e.ok).toBe(false)
    expect(e.errore).toBeTruthy()
    expect(e.dati.cognome).toBe('')
  })

  it('nessun campo esce con spazi o minuscole: il foglio li vuole cosi', () => {
    const e = interpretaRisposta(risposta({
      cognome: '  de   luca  ', nome: 'anna maria', comuneNascita: ' roma ',
    }))
    expect(e.dati.cognome).toBe('DE LUCA')
    expect(e.dati.nome).toBe('ANNA MARIA')
    expect(e.dati.comuneNascita).toBe('ROMA')
  })
})
