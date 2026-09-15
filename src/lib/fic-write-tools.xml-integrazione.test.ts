/**
 * src/lib/fic-write-tools.xml-integrazione.test.ts — cosa deve esserci
 * nell'XML di una TD17, e cosa NON deve esserci.
 *
 * 🚨 Questo file nasce da un difetto MIO che ha bloccato l'invio allo SdI di
 * quattro autofatture, il 15 settembre 2026.
 *
 * Avevo aggiunto `DatiFattureCollegate` dopo averlo visto nell'XML di una TD17
 * valida. Contenuto giusto, FORMA sbagliata: passato dentro `ei_raw`, Fatture
 * in Cloud lo serializza come attributi SCIOLTI `2.1.6.x` e produce blocchi
 * `DatiFattureCollegate` SENZA `IdDocumento`. La Verifica formale dava due
 * errori su ogni documento — «dovrebbe esserci l'elemento IdDocumento» — e lo
 * SdI li avrebbe scartati. E una volta scritti via API, quegli attributi
 * dall'interfaccia di FIC non si possono ne' modificare ne' togliere.
 *
 * ⚠️ La lezione: avere il DATO giusto non basta, serve la FORMA che il
 * destinatario accetta. L'XML valido mostrava il blocco, ma quell'XML non era
 * stato prodotto da questa API.
 *
 * All'opposto, `RegimeFiscale RF18` NON l'avevo messo «per prudenza», e il
 * controllo sul gestionale ha detto che il campo restava VUOTO ed e'
 * obbligatorio. La prudenza senza verifica e' un'altra forma di indovinare.
 */
import { describe, it, expect } from 'vitest'
import { eiRawIntegrazionePerTest } from './fic-write-tools'

const ei = eiRawIntegrazionePerTest('TD17') as Record<string, Record<string, Record<string, Record<string, unknown>>>>

describe('l ei_raw di una integrazione TD17', () => {
  it('🚨 porta il tipo documento TD17', () => {
    expect(ei.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento).toEqual({ TipoDocumento: 'TD17' })
  })

  it('🚨 porta il REGIME FISCALE del cedente estero: RF18, campo obbligatorio che FIC non deriva', () => {
    expect(ei.FatturaElettronicaHeader.CedentePrestatore.DatiAnagrafici).toEqual({ RegimeFiscale: 'RF18' })
  })

  it('🚨 NON porta DatiFattureCollegate: passato di qui produce XML non valido', () => {
    // La prova che il difetto non torna. Se qualcuno lo rimette qui dentro, lo
    // SdI scarta i documenti e l Ingegnere se ne accorge dalla Verifica
    // formale, cioe' dopo averli creati tutti.
    expect(JSON.stringify(ei)).not.toContain('DatiFattureCollegate')
    expect(JSON.stringify(ei)).not.toContain('IdDocumento')
  })

  it('CONTROLLO POSITIVO: la struttura resta quella che FIC si aspetta, non un oggetto vuoto', () => {
    // Senza questo, una funzione che torna `{}` passerebbe il test qui sopra —
    // e il documento non sarebbe piu' un TD17.
    expect(Object.keys(ei).sort()).toEqual(['FatturaElettronicaBody', 'FatturaElettronicaHeader'])
  })
})
