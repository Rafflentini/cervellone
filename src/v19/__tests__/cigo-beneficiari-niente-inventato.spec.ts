/**
 * src/v19/__tests__/cigo-beneficiari-niente-inventato.spec.ts
 *
 * Il CSV `ElencoBeneficiari.csv` va all'INPS, dentro una domanda di CIGO che il
 * legale rappresentante firma. Due colonne venivano riempite con un valore
 * inventato quando il dato mancava:
 *
 *     escapeCsv(b.tipo_contratto ?? 'CCNL Edilizia'),
 *     String(b.ore_contrattuali_settimana ?? 40),
 *
 * e `mapCigoInput` — l'unico percorso di produzione, via `compila_modello` con
 * `builtin_cigo` — non scriveva MAI quei due campi. Quindi ogni operaio usciva
 * dichiarato «CCNL Edilizia, 40 ore», sempre, senza che nessuno lo avesse detto.
 *
 * Le ore contrattuali settimanali sono il DENOMINATORE dell'integrazione
 * salariale: un operaio part-time a 20 ore dichiarato a 40 e' una dichiarazione
 * falsa su un modulo pubblico, e nessuno se ne accorge perche' il segnaposto e'
 * plausibile.
 *
 * ⭐ E' la stessa forma del sesso predefinito «M» nel check-in, che avrebbe
 * mandato ogni donna alla Questura come maschio: **un segnaposto non e' una
 * dichiarazione**. Meglio una casella vuota che l'INPS rifiuta — visibile e
 * correggibile — di un numero sbagliato che l'INPS accetta.
 */
import { describe, it, expect } from 'vitest'
import { buildBeneficiariCsv, avvisiBeneficiariIncompleti } from '../tools/cigo/build-beneficiari-csv'
import { mapCigoInput } from '@/lib/document-template-tools'
import type { Periodo } from '../tools/cigo/types'

const PERIODO: Periodo = { data_inizio: '2026-01-12', data_fine: '2026-01-16' }

describe('il CSV per l INPS non inventa nessun dato', () => {
  it('senza le ore contrattuali la casella resta VUOTA, non diventa 40', () => {
    const csv = buildBeneficiariCsv(
      [{ cognome: 'Rossi', nome: 'Mario', codice_fiscale: 'RSSMRA80A01F839X', ore_perse_settimana_1: 8 }],
      PERIODO,
    )
    const riga = csv.split('\n')[1].split(';')

    // colonne: Cognome;Nome;CodiceFiscale;DataAssunzione;TipoContratto;OreContrattuali;...
    expect(riga[4]).toBe('')   // TipoContratto
    expect(riga[5]).toBe('')   // OreContrattuali
    expect(csv).not.toContain('CCNL Edilizia')
  })

  it('con le ore contrattuali dichiarate, il CSV riporta QUELLE', () => {
    // CONTROLLO POSITIVO: senza questo, il test sopra passerebbe anche con un
    // codice che scrive sempre vuoto e ignora il dato vero.
    const csv = buildBeneficiariCsv(
      [{
        cognome: 'Bianchi', nome: 'Anna', codice_fiscale: 'BNCNNA85A41F839Y',
        ore_perse_settimana_1: 4,
        tipo_contratto: 'CCNL Metalmeccanici',
        ore_contrattuali_settimana: 20,
      }],
      PERIODO,
    )
    const riga = csv.split('\n')[1].split(';')

    expect(riga[4]).toBe('CCNL Metalmeccanici')
    expect(riga[5]).toBe('20')
  })

  it('un operaio incompleto viene DETTO, con nome e cognome', () => {
    // Una casella vuota da sola non basta: se nessuno lo dice, il pacchetto
    // parte lo stesso e il rifiuto dell'INPS arriva giorni dopo, senza spiegare
    // quale operaio.
    const avvisi = avvisiBeneficiariIncompleti([
      { cognome: 'Rossi', nome: 'Mario', codice_fiscale: 'RSSMRA80A01F839X', ore_perse_settimana_1: 8 },
      {
        cognome: 'Bianchi', nome: 'Anna', codice_fiscale: 'BNCNNA85A41F839Y',
        ore_perse_settimana_1: 4, tipo_contratto: 'CCNL Edilizia', ore_contrattuali_settimana: 40, data_assunzione: '2018-05-14',
      },
    ])

    expect(avvisi).toHaveLength(1)
    expect(avvisi[0]).toContain('Rossi')
    expect(avvisi[0]).toContain('Mario')
    expect(avvisi[0]).toContain('ore contrattuali')
  })

  it('CONTROLLO POSITIVO: se sono tutti completi non si avvisa nessuno', () => {
    const avvisi = avvisiBeneficiariIncompleti([
      {
        cognome: 'Bianchi', nome: 'Anna', codice_fiscale: 'BNCNNA85A41F839Y',
        ore_perse_settimana_1: 4, tipo_contratto: 'CCNL Edilizia', ore_contrattuali_settimana: 40, data_assunzione: '2018-05-14',
      },
    ])

    expect(avvisi).toEqual([])
  })
})

describe('mapCigoInput porta fino al CSV i dati che l Ingegnere ha dichiarato', () => {
  it('tipo di contratto, ore contrattuali e data di assunzione non si perdono per strada', () => {
    // Erano gia' nello schema del tool (`index.ts:159-161`): il modello poteva
    // passarli, ma `mapCigoInput` non li leggeva e finivano nel nulla.
    const input = mapCigoInput({
      azienda_denominazione: 'RESTRUKTURA S.R.L.',
      azienda_cf: '02087420762',
      azienda_matricola_inps: '1234567890',
      lr_nome_cognome: 'Raffaele Lentini',
      beneficiari: [{
        cognome: 'Rossi', nome: 'Mario', codice_fiscale: 'RSSMRA80A01F839X', ore: 8,
        tipo_contratto: 'CCNL Metalmeccanici',
        ore_contrattuali_settimana: 20,
        data_assunzione: '2019-03-01',
      }],
    })

    expect(input.beneficiari[0].tipo_contratto).toBe('CCNL Metalmeccanici')
    expect(input.beneficiari[0].ore_contrattuali_settimana).toBe(20)
    expect(input.beneficiari[0].data_assunzione).toBe('2019-03-01')
  })

  it('quando non sono dichiarati restano NON dichiarati, non diventano un valore', () => {
    const input = mapCigoInput({
      azienda_denominazione: 'RESTRUKTURA S.R.L.',
      lr_nome_cognome: 'Raffaele Lentini',
      beneficiari: [{ cognome: 'Rossi', nome: 'Mario', codice_fiscale: 'RSSMRA80A01F839X', ore: 8 }],
    })

    expect(input.beneficiari[0].tipo_contratto).toBeUndefined()
    expect(input.beneficiari[0].ore_contrattuali_settimana).toBeUndefined()
  })
})

/**
 * L'Allegato 10 e' una DICHIARAZIONE SOSTITUTIVA DELL'ATTO DI NOTORIETA'
 * (art. 47 D.P.R. 445/2000): il legale rappresentante la timbra e la firma.
 *
 * Dichiarava «Si allega bollettino meteo ufficiale del CFD…» e lo elencava fra
 * gli ALLEGATI in modo INCONDIZIONATO — anche quando lo scaricamento era
 * fallito e il PDF nel pacchetto non c'era. L'avvertenza finiva in chat, non
 * sul foglio che si firma e si manda all'INPS.
 *
 * Attestare un allegato assente su una dichiarazione ex art. 47 non e' un
 * dettaglio di forma.
 */
import JSZip from 'jszip'
import { renderAllegato10 } from '../tools/cigo/build-allegato10'
import type { Allegato10Input } from '../tools/cigo/types'

/**
 * ⭐ Un DOCX e' uno zip: letto come testo grezzo non contiene NIENTE di
 * leggibile. La prima versione di questi test lo leggeva con
 * `toString('latin1')`, e il caso negativo passava sempre — non perche' il
 * codice fosse giusto, ma perche' la frase non era trovabile in nessuno dei due
 * casi. L'ha smascherato il CONTROLLO POSITIVO, che falliva mentre l'altro
 * passava: senza quello avrei creduto a una difesa inesistente.
 */
async function testoDelDocx(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  return await zip.file('word/document.xml')!.async('string')
}

const INPUT_CIGO: Allegato10Input = {
  azienda: { denominazione: 'RESTRUKTURA S.R.L.', codice_fiscale: '02087420762', matricola_inps: '1234567890' },
  legale_rappresentante: { nome_cognome: 'Raffaele Lentini' },
  periodo: PERIODO,
  attivita_svolta: 'Rifacimento facciata',
  evento_meteo: 'Pioggia intensa per tutta la giornata',
  conseguenze: 'Impossibile operare sul ponteggio',
  beneficiari: [{ cognome: 'Rossi', nome: 'Mario', codice_fiscale: 'RSSMRA80A01F839X', ore_perse_settimana_1: 8 }],
}

describe('l Allegato 10 non dichiara allegati che non ci sono', () => {
  it('senza il bollettino nel pacchetto, NON scrive che lo si allega', async () => {
    const testo = await testoDelDocx(await renderAllegato10(INPUT_CIGO, { bollettinoAllegato: false }))

    expect(testo).not.toContain('Si allega bollettino meteo ufficiale')
  })

  it('chi NON dice niente non fa dichiarare niente: il predefinito non attesta', async () => {
    // Il caso piu' insidioso, e quello che un primo giro di mutazioni ha
    // trovato scoperto: un chiamante che dimentica l'opzione. Se il predefinito
    // fosse "dichiara", una svista in un file lontano farebbe attestare al
    // firmatario un allegato che non c'e', e nessun test se ne accorgerebbe.
    // Il valore predefinito e' esso stesso una dichiarazione.
    const testo = await testoDelDocx(await renderAllegato10(INPUT_CIGO))

    expect(testo).not.toContain('Si allega bollettino meteo ufficiale')
    expect(testo).not.toContain('Bollettino di criticità CFD')
  })

  it('CONTROLLO POSITIVO: col bollettino nel pacchetto lo dichiara', async () => {
    // Senza questo, il test sopra passerebbe anche con un codice che ha
    // semplicemente smesso di scrivere quella frase.
    const testo = await testoDelDocx(await renderAllegato10(INPUT_CIGO, { bollettinoAllegato: true }))

    expect(testo).toContain('Si allega bollettino meteo ufficiale')
  })
})
