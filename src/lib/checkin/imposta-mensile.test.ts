import { describe, it, expect } from 'vitest'
import { nottiTassatePerMese, ripartisciImposta, scadenzaDichiarazione } from './imposta-mensile'
import { REGOLE_MARATEA } from './imposta-soggiorno'

const R = REGOLE_MARATEA // 2,50 € · max 5 notti · esenti fino a 12 · 01/05-31/10 · dal 01/05/2026

describe('le notti tassate, mese per mese', () => {
  it('un soggiorno dentro un mese solo resta tutto li', () => {
    expect(nottiTassatePerMese('2026-07-10', '2026-07-13', R)).toEqual([{ mese: '2026-07', notti: 3 }])
  })

  it('CONTROLLO POSITIVO: un soggiorno A CAVALLO si spezza sui due mesi', () => {
    // E il caso che rende sbagliata la dichiarazione: 29/09 → 02/10 sono tre
    // notti, DUE di settembre (29, 30) e UNA di ottobre (1).
    expect(nottiTassatePerMese('2026-09-29', '2026-10-02', R)).toEqual([
      { mese: '2026-09', notti: 2 },
      { mese: '2026-10', notti: 1 },
    ])
  })

  it('oltre il quinto pernottamento non si conta piu nulla', () => {
    // Art. 5 lett. a). Due settimane = 14 notti, ma tassate solo le prime 5.
    const mesi = nottiTassatePerMese('2026-07-01', '2026-07-15', R)
    expect(mesi.reduce((s, m) => s + m.notti, 0)).toBe(5)
  })

  it('e il tetto delle cinque notti si applica PRIMA di spezzare i mesi', () => {
    // 28/09 → 08/10 sono 10 notti: tassate solo le prime 5 (28,29,30 sett +
    // 1,2 ott). Se il tetto si applicasse dopo, ottobre prenderebbe notti che
    // non si pagano.
    expect(nottiTassatePerMese('2026-09-28', '2026-10-08', R)).toEqual([
      { mese: '2026-09', notti: 3 },
      { mese: '2026-10', notti: 2 },
    ])
  })

  it('le notti FUORI stagione non si contano, nemmeno a cavallo', () => {
    // Stagione fino al 31/10: un soggiorno 30/10 → 03/11 paga solo due notti.
    expect(nottiTassatePerMese('2026-10-30', '2026-11-03', R)).toEqual([{ mese: '2026-10', notti: 2 }])
  })

  it('prima della data di prima applicazione non si tassa niente', () => {
    expect(nottiTassatePerMese('2026-04-10', '2026-04-14', R)).toEqual([])
  })

  it('date mancanti o girate non producono un numero inventato', () => {
    expect(nottiTassatePerMese('', '2026-07-13', R)).toEqual([])
    expect(nottiTassatePerMese('2026-07-13', '2026-07-10', R)).toEqual([])
    expect(nottiTassatePerMese('2026-07-10', '2026-07-10', R)).toEqual([])
  })
})

describe('l imposta ripartita fra i mesi', () => {
  it('CONTROLLO POSITIVO: 15 € su tre notti a cavallo diventano 10 + 5', () => {
    // 2 ospiti x 3 notti x 2,50 = 15 €. Due notti a settembre, una a ottobre.
    expect(ripartisciImposta(15, '2026-09-29', '2026-10-02', R)).toEqual([
      { mese: '2026-09', notti: 2, importo: 10 },
      { mese: '2026-10', notti: 1, importo: 5 },
    ])
  })

  it('un soggiorno dentro un mese solo non viene toccato', () => {
    expect(ripartisciImposta(7.5, '2026-07-10', '2026-07-13', R)).toEqual([
      { mese: '2026-07', notti: 3, importo: 7.5 },
    ])
  })

  it('la somma delle parti fa ESATTAMENTE il totale, anche coi centesimi', () => {
    // 10 € su 3 notti darebbe 6,666.. + 3,333..: arrotondando si perderebbe un
    // centesimo, e dichiarazione e versamento non tornerebbero fra loro.
    const parti = ripartisciImposta(10, '2026-09-29', '2026-10-02', R)
    const somma = parti.reduce((s, p) => s + p.importo, 0)
    expect(Math.round(somma * 100) / 100).toBe(10)
  })

  it('un soggiorno che non tassa nulla non produce righe fantasma', () => {
    expect(ripartisciImposta(0, '2026-04-10', '2026-04-14', R)).toEqual([])
  })

  it('CONTROLLO NEGATIVO: non si ricalcola l imposta, si ripartisce quella data', () => {
    // Se una prenotazione ha imposta 0 perche gli ospiti erano tutti minori,
    // la ripartizione deve restare 0 e non "riscoprire" un importo dalle notti.
    const parti = ripartisciImposta(0, '2026-09-29', '2026-10-02', R)
    // `every` su un array vuoto e sempre vero: senza questa riga il test
    // passerebbe anche se la ripartizione non restituisse nulla (asserzione
    // vacua trovata da un audit il 5 set 2026).
    expect(parti).toHaveLength(2)
    expect(parti.every((p) => p.importo === 0)).toBe(true)
  })
})

describe('il termine di dichiarazione', () => {
  it('e il 16 del mese SUCCESSIVO', () => {
    expect(scadenzaDichiarazione('2026-09')).toBe('2026-10-16')
    expect(scadenzaDichiarazione('2026-07')).toBe('2026-08-16')
  })

  it('a dicembre passa all anno dopo', () => {
    expect(scadenzaDichiarazione('2026-12')).toBe('2027-01-16')
  })
})

describe('il centesimo che si perde negli arrotondamenti', () => {
  it('viene recuperato: la somma delle parti torna al totale anche quando entrambe arrotondano in su', () => {
    // Con due notti e un totale di 0,03 € ogni parte vale 0,015 e arrotonda a
    // 0,02: sommate farebbero 0,04, un centesimo IN PIU del dovuto.
    // Con le tariffe di oggi (2,50 € a notte) il caso non capita — ma la
    // tariffa la cambia una delibera, e l'importo sulla riga puo essere
    // corretto a mano. Una difesa che non si prova non e una difesa: senza
    // questo test, togliere il recupero non farebbe fallire nulla (mutazione
    // sopravvissuta il 5 set 2026).
    const parti = ripartisciImposta(0.03, '2026-09-30', '2026-10-02', R)

    expect(parti).toHaveLength(2)
    const somma = parti.reduce((s, p) => s + p.importo, 0)
    expect(Math.round(somma * 100) / 100).toBe(0.03)
  })
})
