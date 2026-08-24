/**
 * La traduzione fra i nomi del form e le intestazioni del foglio.
 *
 * E' il punto in cui un sistema del genere si rompe di solito: il form chiama
 * un campo `citta`, il foglio lo chiama `Città`, e chi scrive mescola le due
 * forme finche' un campo smette di arrivare a destinazione. Senza errori: solo
 * una cella vuota, che nessuno nota finche' non serve.
 *
 * Percio' il test piu' importante non e' su un campo: e' che OGNI colonna
 * nominata qui esista davvero nello schema del foglio.
 */
import { describe, it, expect } from 'vitest'
import {
  COLONNA_SOGGIORNO, COLONNA_OSPITE, soggiornoDaColonne, soggiornoAColonne,
  ospiteDaColonne, ospiteAColonne, campoBloccato,
} from './mappa-form'
import { COL_SOGGIORNI, COL_OSPITI } from './foglio-schema'

describe('le colonne nominate esistono davvero', () => {
  it('quelle del soggiorno', () => {
    for (const colonna of Object.values(COLONNA_SOGGIORNO)) {
      expect(COL_SOGGIORNI, `colonna inesistente: ${colonna}`).toContain(colonna)
    }
  })

  it('quelle degli ospiti', () => {
    for (const colonna of Object.values(COLONNA_OSPITE)) {
      expect(COL_OSPITI, `colonna inesistente: ${colonna}`).toContain(colonna)
    }
  })

  it("l'esenzione ha la sua colonna, anche se non e nella tabella", () => {
    expect(COL_OSPITI).toContain('Esente imposta')
  })
})

describe('andata e ritorno del soggiorno', () => {
  it('non perde niente per strada', () => {
    const partenza = {
      unita: 'Unità 2', portale: 'Booking', codPrenotazione: 'BK-1',
      checkin: '2026-09-10', checkout: '2026-09-14', ospitiAttesi: '3',
      importoLordo: '640', intestatario: 'ROSSI MARIO', codiceFiscale: 'RSSMRA80A01H501U',
      piva: '', sdi: '0000000', indirizzo: 'Via Roma 1', cap: '85046',
      citta: 'MARATEA', provincia: 'PZ', nazione: 'IT',
      email: 'x@y.it', telefono: '333', note: 'nota',
    }
    expect(soggiornoDaColonne(soggiornoAColonne(partenza))).toEqual(partenza)
  })

  it('una colonna mancante diventa stringa vuota, non undefined', () => {
    // undefined finirebbe nel foglio come la parola "undefined".
    const f = soggiornoDaColonne({})
    expect(f.citta).toBe('')
    expect(Object.values(f).every((v) => typeof v === 'string')).toBe(true)
  })

  it('inviando solo alcuni campi non ne inventa altri', () => {
    // Se mandasse anche i campi non toccati, un salvataggio parziale
    // sovrascriverebbe con stringhe vuote quello che ha scritto un altro.
    const c = soggiornoAColonne({ citta: 'MARATEA' })
    expect(c).toEqual({ 'Città': 'MARATEA' })
  })
})

describe('andata e ritorno di un ospite', () => {
  it('non perde niente per strada', () => {
    const partenza = {
      progressivo: '2', tipoAlloggiato: '19', cognome: 'MULLER', nome: 'GRETA',
      sesso: 'F', dataNascita: '1985-03-12', comuneNascita: '', provNascita: '',
      statoNascita: 'GERMANIA', cittadinanza: 'GERMANIA', tipoDocumento: 'PASOR',
      numeroDocumento: 'P998877', luogoRilascio: 'GERMANIA', codiceFiscale: '',
      esente: false, motivoEsenzione: '',
    }
    expect(ospiteDaColonne(ospiteAColonne(partenza))).toEqual(partenza)
  })

  it('traduce l esenzione fra casella e parola SI', () => {
    expect(ospiteAColonne({ esente: true })['Esente imposta']).toBe('SI')
    expect(ospiteAColonne({ esente: false })['Esente imposta']).toBe('NO')
    expect(ospiteDaColonne({ 'Esente imposta': 'SI' }).esente).toBe(true)
    expect(ospiteDaColonne({ 'Esente imposta': 'si' }).esente).toBe(true)
    expect(ospiteDaColonne({ 'Esente imposta': 'NO' }).esente).toBe(false)
    expect(ospiteDaColonne({ 'Esente imposta': '' }).esente).toBe(false)
  })
})

describe('campi bloccati', () => {
  it('riconosce quelli della prenotazione dal loro nome di colonna', () => {
    const bloccate = ['Unità', 'Importo lordo €', 'Check-in']
    expect(campoBloccato('unita', bloccate)).toBe(true)
    expect(campoBloccato('importoLordo', bloccate)).toBe(true)
    expect(campoBloccato('indirizzo', bloccate)).toBe(false)
  })

  it('senza blocchi non blocca niente', () => {
    expect(campoBloccato('importoLordo', [])).toBe(false)
  })
})
