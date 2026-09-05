import { describe, it, expect } from 'vitest'
import { situazione, COL, type PraticaLetta } from './lettura-pratiche'
import { COL_SOGGIORNI } from './foglio-schema'

function p(over: Partial<PraticaLetta>): PraticaLetta {
  return {
    id: 'SOG-1', unita: 'Unità 1', intestatario: 'Rossi', portale: '',
    checkin: '2026-09-10', checkout: '2026-09-17', notti: 7, ospitiAttesi: 2,
    importo: 700, imposta: 25, statoCheckin: 'CHECKIN OK', checkinCompleto: true,
    inviatoAlloggiati: true, statoFattura: 'EMESSA', ...over,
  }
}

const OGGI = '2026-09-12'

describe('la fotografia di oggi', () => {
  it('CONTROLLO POSITIVO: distingue chi deve arrivare da chi e gia in casa', () => {
    const s = situazione([
      p({ id: 'arriva', checkin: '2026-09-14', checkout: '2026-09-20' }),
      p({ id: 'in-casa', checkin: '2026-09-10', checkout: '2026-09-17' }),
    ], OGGI)

    expect(s.inArrivo.map((x) => x.id)).toEqual(['arriva'])
    expect(s.inCasa.map((x) => x.id)).toEqual(['in-casa'])
  })

  it('gli arrivi guardano avanti di una settimana, non all intera stagione', () => {
    // Senza finestra, a meta stagione "chi arriva" restituirebbe tutta l estate
    // e la risposta diventerebbe illeggibile proprio quando serve.
    const s = situazione([
      p({ id: 'vicino', checkin: '2026-09-15', checkout: '2026-09-22' }),
      p({ id: 'lontano', checkin: '2026-10-20', checkout: '2026-10-27' }),
    ], OGGI)

    expect(s.inArrivo.map((x) => x.id)).toEqual(['vicino'])
  })

  it("l'ultimo giorno conta ancora come 'in casa': il check-out e quel giorno", () => {
    const s = situazione([p({ id: 'parte-oggi', checkin: '2026-09-08', checkout: OGGI })], OGGI)
    expect(s.inCasa.map((x) => x.id)).toEqual(['parte-oggi'])
  })

  it('CONTROLLO POSITIVO: un soggiorno di luglio senza Alloggiati resta un adempimento SCOPERTO', () => {
    // La prima versione di questo test asseriva il contrario, e passava solo
    // perche la fixture aveva `inviatoAlloggiati: true`: un'asserzione vacua che
    // per giunta affermava una cosa falsa (audit del 5 set 2026).
    // La verita e questa: una comunicazione mancata di luglio NON si sana col
    // passare del tempo, e a settembre deve ancora comparire.
    const s = situazione([
      p({ id: 'vecchia-scoperta', checkin: '2026-07-01', checkout: '2026-07-08', checkinCompleto: false, inviatoAlloggiati: false }),
    ], OGGI)

    expect(s.alloggiatiDaInviare.map((x) => x.id)).toEqual(['vecchia-scoperta'])
    // Fra i "check-in incompleti" invece no: quelli sono i soggiorni ancora
    // aperti, su cui si puo ancora chiedere le schede all'ospite.
    expect(s.checkinIncompleti).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: Alloggiati non inviato su un soggiorno gia iniziato e un adempimento scoperto', () => {
    // Art. 109 T.U.L.P.S.: 24 ore dall arrivo, il ritardo non si recupera.
    const s = situazione([
      p({ id: 'scoperta', checkin: '2026-09-11', checkout: '2026-09-18', inviatoAlloggiati: false }),
    ], OGGI)

    expect(s.alloggiatiDaInviare.map((x) => x.id)).toEqual(['scoperta'])
  })

  it('CONTROPROVA: chi deve ancora arrivare NON risulta in ritardo con la Questura', () => {
    // Prima dell arrivo non c e nulla da comunicare. Un elenco che grida sempre
    // smette di essere letto.
    const s = situazione([
      p({ id: 'futura', checkin: '2026-09-16', checkout: '2026-09-23', inviatoAlloggiati: false }),
    ], OGGI)

    expect(s.alloggiatiDaInviare).toHaveLength(0)
  })

  it('separa cio che tocca a Cervellone da cio che tocca all Ingegnere', () => {
    // "5 cose da fare" non direbbe di CHI sono.
    const s = situazione([
      p({ id: 'da-fare', checkout: '2026-09-05', statoFattura: 'DA FARE' }),
      p({ id: 'da-inviare', checkout: '2026-09-05', statoFattura: 'COMPILATA' }),
    ], OGGI)

    expect(s.daFatturare.map((x) => x.id)).toEqual(['da-fare'])
    expect(s.daInviareInFattura.map((x) => x.id)).toEqual(['da-inviare'])
  })

  it('una prenotazione ancora in corso non risulta gia da fatturare', () => {
    const s = situazione([
      p({ id: 'in-corso', checkin: '2026-09-10', checkout: '2026-09-17', statoFattura: 'DA FARE' }),
    ], OGGI)

    expect(s.daFatturare).toHaveLength(0)
  })
})

describe('i nomi delle colonne devono combaciare col foglio VERO', () => {
  it('CONTROLLO POSITIVO: ogni colonna letta esiste in COL_SOGGIORNI', () => {
    // Senza questo test, cambiare 'Unità' in 'Unita' non faceva fallire NIENTE
    // (371 test verdi, dimostrato da un audit il 5 set 2026): `aMappa` indicizza
    // per intestazione, quindi un nome sbagliato non da errore — da undefined.
    // Il tool avrebbe risposto "nessuna prenotazione" su un foglio pieno.
    const mancanti = Object.values(COL).filter((c) => !COL_SOGGIORNI.includes(c))
    expect(mancanti, `colonne lette ma inesistenti nel foglio: ${mancanti.join(', ')}`).toEqual([])
  })

  it('e sono davvero tutte quelle che il lettore usa', () => {
    // Controprova del controllo: se COL si svuotasse, il test sopra passerebbe
    // per vacuita.
    expect(Object.keys(COL).length).toBeGreaterThanOrEqual(12)
  })
})

describe('le date scritte male non fanno gridare l allarme', () => {
  it('CONTROLLO POSITIVO: una riga con le date vuote resta FUORI da ogni elenco, e viene dichiarata', () => {
    // Prima: un check-in vuoto finiva insieme in "in casa", "check-in
    // incompleti" E "Alloggiati da inviare" — un allarme di legge fatto
    // scattare da una cella non compilata.
    const s = situazione([p({ id: 'senza-date', checkin: '', checkout: '', inviatoAlloggiati: false, checkinCompleto: false })], OGGI)

    expect(s.inCasa).toHaveLength(0)
    expect(s.checkinIncompleti).toHaveLength(0)
    expect(s.alloggiatiDaInviare).toHaveLength(0)
    expect(s.daFatturare).toHaveLength(0)
    expect(s.dateNonValide.map((x) => x.id)).toEqual(['senza-date'])
  })

  it('anche una data scritta all italiana e fuori dai conti, non dentro per sbaglio', () => {
    const s = situazione([p({ id: 'italiana', checkin: '10/09/2026', checkout: '17/09/2026', inviatoAlloggiati: false })], OGGI)

    expect(s.alloggiatiDaInviare).toHaveLength(0)
    expect(s.dateNonValide.map((x) => x.id)).toEqual(['italiana'])
  })

  it('CONTROPROVA: le date buone NON finiscono fra quelle non valide', () => {
    const s = situazione([p({ id: 'regolare', checkin: '2026-09-10', checkout: '2026-09-17' })], OGGI)

    expect(s.dateNonValide).toHaveLength(0)
    expect(s.inCasa.map((x) => x.id)).toEqual(['regolare'])
  })

  it('una data inesistente come il 31 febbraio viene scartata', () => {
    const s = situazione([p({ id: 'impossibile', checkin: '2026-02-31', checkout: '2026-03-05' })], OGGI)
    expect(s.dateNonValide.map((x) => x.id)).toEqual(['impossibile'])
  })
})
