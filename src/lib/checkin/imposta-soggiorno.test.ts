/**
 * Imposta di soggiorno — Comune di Maratea.
 *
 * Fonte: Regolamento sull'Imposta di soggiorno, da ultimo modificato con
 * D.C.C. n. 03 del 24/02/2026. Letto integralmente, non riassunto.
 *
 * Questi test esistono perche' il calcolo di agosto (Codice.gs) e' sbagliato in
 * un modo che non si vede: conta come paganti i bambini, e il totale resta
 * plausibile. Un errore che si nota si ripara; uno che resta plausibile viene
 * versato al Comune per anni.
 */
import { describe, it, expect } from 'vitest'
import { calcolaImpostaSoggiorno, type OspiteImposta, REGOLE_MARATEA } from './imposta-soggiorno'

/** Ospite pagante di riferimento: adulto, non esente, nato nel 1980. */
function adulto(over: Partial<OspiteImposta> = {}): OspiteImposta {
  return { dataNascita: '1980-06-15', esente: false, ...over }
}

describe('misura dell imposta (art. 4 c.1)', () => {
  it('conta per persona E per pernottamento, non a forfait per soggiorno', () => {
    // 2 adulti x 3 notti x 2,50 = 15,00 — non 2,50
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-01', checkout: '2026-07-04',
      ospiti: [adulto(), adulto()], regole: REGOLE_MARATEA,
    })
    expect(r.importo).toBe(15)
    expect(r.pernottamentiTassati).toBe(6)
  })
})

describe('esenzione art. 5 lettera a — oltre il quinto giorno', () => {
  it('addebita al massimo 5 pernottamenti per persona', () => {
    // 1 adulto x 10 notti -> solo 5 tassate
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-01', checkout: '2026-07-11',
      ospiti: [adulto()], regole: REGOLE_MARATEA,
    })
    expect(r.pernottamentiTassati).toBe(5)
    expect(r.importo).toBe(12.5)
  })
})

describe('esenzione art. 5 lettera c — minori', () => {
  it('NON addebita un bambino di 3 anni, anche se nessuno ha spuntato "esente"', () => {
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-01', checkout: '2026-07-04',
      ospiti: [adulto(), { dataNascita: '2023-01-10', esente: false }],
      regole: REGOLE_MARATEA,
    })
    expect(r.importo).toBe(7.5) // solo l adulto
    expect(r.esenti).toContainEqual({ indice: 1, motivo: 'minore (art. 5 lett. c)' })
  })

  it('l eta si valuta alla data di CHECK-IN, non a oggi', () => {
    // Compie 13 anni il 2026-07-10: al check-in del 1 luglio ne ha ancora 12 -> esente
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-01', checkout: '2026-07-02',
      ospiti: [{ dataNascita: '2013-07-10', esente: false }],
      regole: REGOLE_MARATEA,
    })
    expect(r.importo).toBe(0)
  })

  it('a 13 anni compiuti paga', () => {
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-11', checkout: '2026-07-12',
      ospiti: [{ dataNascita: '2013-07-10', esente: false }],
      regole: REGOLE_MARATEA,
    })
    expect(r.importo).toBe(2.5)
  })

  it('il limite di eta e un parametro, non una costante nel codice', () => {
    // Se il Comune chiarisse "esente fino a 11", si cambia un numero.
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-01', checkout: '2026-07-02',
      ospiti: [{ dataNascita: '2014-01-01', esente: false }], // 12 anni al check-in
      regole: { ...REGOLE_MARATEA, esenzioneEtaMax: 11 },
    })
    expect(r.importo).toBe(2.5) // con la soglia a 11, un dodicenne paga
  })
})

describe('arrotondamento', () => {
  it('non lascia passare la deriva dei decimali con tariffe non esatte', () => {
    // 2,50 e' esatto in binario e non mette mai alla prova l arrotondamento.
    // Una delibera futura puo' fissare qualunque cifra: 0,10 x 3 in virgola
    // mobile fa 0.30000000000000004, e quello finirebbe in una fattura.
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-01', checkout: '2026-07-04',
      ospiti: [adulto()], regole: { ...REGOLE_MARATEA, tariffa: 0.1 },
    })
    expect(r.importo).toBe(0.3)
  })
})

describe('stagione (art. 2 / delibera tariffaria)', () => {
  it('non tassa le notti fuori stagione', () => {
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-12-20', checkout: '2026-12-23',
      ospiti: [adulto()], regole: REGOLE_MARATEA,
    })
    expect(r.importo).toBe(0)
  })

  it('a cavallo della chiusura di stagione tassa solo le notti dentro', () => {
    // 29,30,31 ottobre dentro; 1,2 novembre fuori
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-10-29', checkout: '2026-11-03',
      ospiti: [adulto()], regole: REGOLE_MARATEA,
    })
    expect(r.pernottamentiTassati).toBe(3)
    expect(r.importo).toBe(7.5)
  })

  it('non tassa prima della data di prima applicazione del regolamento', () => {
    const r = calcolaImpostaSoggiorno({
      checkin: '2025-07-01', checkout: '2025-07-04',
      ospiti: [adulto()], regole: REGOLE_MARATEA,
    })
    expect(r.importo).toBe(0)
  })
})

describe('esenzione manuale (art. 5 lettere d-j)', () => {
  it('rispetta la spunta e ne registra il motivo', () => {
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-01', checkout: '2026-07-03',
      ospiti: [adulto(), adulto({ esente: true, motivoEsenzione: 'residente a Maratea' })],
      regole: REGOLE_MARATEA,
    })
    expect(r.importo).toBe(5)
    expect(r.esenti).toContainEqual({ indice: 1, motivo: 'residente a Maratea' })
  })

  it('segnala l esenzione senza motivo invece di accettarla in silenzio', () => {
    // Art. 3 c.4: il gestore deve CONSERVARE la dichiarazione di esenzione.
    // Un esente senza motivo e' un ammanco in sede di controllo.
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-01', checkout: '2026-07-03',
      ospiti: [adulto({ esente: true })],
      regole: REGOLE_MARATEA,
    })
    expect(r.anomalie).toContain('Ospite 1: esenzione senza motivo dichiarato (art. 3 c.4).')
  })
})

describe('casi che non devono far esplodere il calcolo', () => {
  it('check-out uguale al check-in vale zero notti', () => {
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-01', checkout: '2026-07-01',
      ospiti: [adulto()], regole: REGOLE_MARATEA,
    })
    expect(r.importo).toBe(0)
    expect(r.notti).toBe(0)
  })

  it('check-out precedente al check-in non produce un importo negativo', () => {
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-05', checkout: '2026-07-01',
      ospiti: [adulto()], regole: REGOLE_MARATEA,
    })
    expect(r.importo).toBe(0)
    // Il numero di notti finisce sul foglio e nella descrizione della fattura:
    // '-4 notti' non e' un importo sbagliato, e' un documento sbagliato.
    expect(r.notti).toBe(0)
    expect(r.anomalie).toContain('Check-out precedente al check-in.')
  })

  it('data di nascita mancante non fa sparire l ospite dal conteggio', () => {
    // Nel dubbio si addebita e si segnala: un ospite non conteggiato e' imposta
    // non versata, e il responsabile del versamento e' il gestore.
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-01', checkout: '2026-07-02',
      ospiti: [{ dataNascita: '', esente: false }],
      regole: REGOLE_MARATEA,
    })
    expect(r.importo).toBe(2.5)
    expect(r.anomalie).toContain('Ospite 1: data di nascita mancante, esenzione per eta non verificabile.')
  })

  it('nessun ospite vale zero, non NaN', () => {
    const r = calcolaImpostaSoggiorno({
      checkin: '2026-07-01', checkout: '2026-07-05',
      ospiti: [], regole: REGOLE_MARATEA,
    })
    expect(r.importo).toBe(0)
  })
})
