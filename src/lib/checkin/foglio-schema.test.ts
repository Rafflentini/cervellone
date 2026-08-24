/**
 * Le intestazioni del foglio sono un contratto con codice che non le vede.
 *
 * La selezione dei soggiorni da fatturare legge per NOME di colonna. Se
 * un'intestazione cambia, la lettura non fallisce: restituisce vuoto. Il
 * soggiorno smette di essere fatturato e nessuno se ne accorge, perche' un
 * elenco vuoto sembra "nessuna fattura da fare".
 *
 * Questi test non verificano che il codice funzioni: verificano che nessuno
 * cambi un'intestazione per distrazione.
 */
import { describe, it, expect } from 'vitest'
import {
  COL_SOGGIORNI, COL_OSPITI, CONFIG_DEFAULT, schedeDelFoglio, FOGLIO_CHECKIN_ID,
} from './foglio-schema'

describe('colonne dei Soggiorni', () => {
  it('mantiene, nell ordine, le 25 colonne dell app di agosto', () => {
    expect(COL_SOGGIORNI.slice(0, 25)).toEqual([
      'ID Soggiorno', 'Data registrazione', 'Unità', 'Portale', 'Cod. prenotazione',
      'Check-in', 'Check-out', 'Notti', 'N. ospiti', 'Importo lordo €',
      'Intestatario fattura', 'Codice fiscale', 'P.IVA', 'Codice SDI / PEC',
      'Indirizzo', 'CAP', 'Città', 'Provincia', 'Nazione', 'Email', 'Telefono',
      'Imposta soggiorno €', 'Inviato Alloggiati', 'Fattura emessa', 'Note',
    ])
  })

  it('aggiunge in coda le colonne che servono a chiudere il giro della fattura', () => {
    // La spec prevede di annotare numero e data dopo l emissione: in Codice.gs
    // non esisteva la cella dove scriverli.
    expect(COL_SOGGIORNI.slice(25)).toEqual(['N. fattura', 'Data fattura', 'ID documento FIC'])
  })

  it('non ha colonne duplicate: la lettura per nome diventerebbe ambigua', () => {
    expect(new Set(COL_SOGGIORNI).size).toBe(COL_SOGGIORNI.length)
    expect(new Set(COL_OSPITI).size).toBe(COL_OSPITI.length)
  })
})

describe('Config', () => {
  const valore = (chiave: string) => CONFIG_DEFAULT.find((r) => r[0] === chiave)?.[1]

  it('espone le cinque unita chieste, come segnaposto', () => {
    expect(valore('unita')).toBe('Unità 1|Unità 2|Unità 3|Unità 4|Unità 5')
    expect(String(valore('unita')).split('|')).toHaveLength(5)
  })

  it('tiene fuori dal codice tutto cio che cambia per delibera', () => {
    expect(valore('tassa_importo')).toBe('2.5')
    expect(valore('tassa_max_notti')).toBe('5')
    expect(valore('esenzione_eta_max')).toBe('12')
    expect(valore('aliquota_iva')).toBe('10')
  })

  it('porta con se la scadenza del 16, che nessuno stava seguendo', () => {
    expect(valore('scadenza_dichiarazione_giorno')).toBe('16')
  })

  it('non contiene segreti: la WebServiceKey nasce vuota', () => {
    expect(valore('alloggiati_wskey')).toBe('')
  })
})

describe('schede da creare', () => {
  it('sono quattro, con i nomi attesi dal resto del sistema', () => {
    expect(schedeDelFoglio().map((s) => s.nome)).toEqual(['Soggiorni', 'Ospiti', 'Config', 'Tabelle'])
  })

  it('Soggiorni e Ospiti nascono vuoti sotto l intestazione', () => {
    const s = schedeDelFoglio()
    expect(s[0].righe ?? []).toHaveLength(0)
    expect(s[1].righe ?? []).toHaveLength(0)
  })

  it('ogni riga di Config ha la stessa larghezza dell intestazione', () => {
    const cfg = schedeDelFoglio()[2]
    for (const r of cfg.righe ?? []) expect(r).toHaveLength(cfg.intestazioni.length)
  })
})

describe('foglio adottato', () => {
  it('e il Gestionale Check-in, non la copia nella cartella dei sorgenti', () => {
    expect(FOGLIO_CHECKIN_ID).toBe('19UeD_Soy_zqTxxg1p6ZkQrOW4_0uct4vftQzy9iLmE4')
    expect(FOGLIO_CHECKIN_ID).not.toBe('1vaq_fJo3l17Jl0_PcV5aih1q1O9qZisPvU2KrBdTX7I')
  })
})
