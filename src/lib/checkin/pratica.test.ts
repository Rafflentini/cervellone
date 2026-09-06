/**
 * src/lib/checkin/pratica.test.ts
 *
 * `salvaPratica` e' la funzione che SCRIVE: fino al 6 settembre 2026 non aveva
 * un test, ed e' l'unico punto da cui passano le schede degli ospiti prima di
 * finire sul foglio, nel file per la Questura e nel conteggio dell'imposta.
 *
 * Qui si prova cio' che nessun test di fusione puo' provare: che una scheda
 * tolta sparisca DAVVERO dal foglio, con le sue foto, e che una scheda che
 * nessuno ha chiesto di togliere resti dov'e'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { COL_OSPITI, COL_SOGGIORNI } from './foglio-schema'

const scritture = {
  aggiornate: [] as Array<{ scheda: string; riga: number; valori: string[] }>,
  aggiunte: [] as Array<{ scheda: string; righe: string[][] }>,
  cancellate: [] as Array<{ scheda: string; righe: number[] }>,
  documenti: [] as string[],
}

let SOGGIORNI: string[][] = []
let OSPITI: string[][] = []

vi.mock('./foglio-google', () => ({
  leggiTutto: vi.fn(async (_id: string, scheda: string) =>
    scheda === 'Soggiorni' ? SOGGIORNI : OSPITI,
  ),
  aggiornaRiga: vi.fn(async (_id: string, scheda: string, riga: number, valori: string[]) => {
    scritture.aggiornate.push({ scheda, riga, valori })
  }),
  aggiungiRighe: vi.fn(async (_id: string, scheda: string, righe: string[][]) => {
    if (righe.length) scritture.aggiunte.push({ scheda, righe })
  }),
  eliminaRighe: vi.fn(async (_id: string, scheda: string, righe: number[]) => {
    scritture.cancellate.push({ scheda, righe })
  }),
}))

vi.mock('./documenti', () => ({
  eliminaDocumento: vi.fn(async (fileId: string) => {
    scritture.documenti.push(fileId)
    return true
  }),
}))

vi.mock('./foglio-lettura', () => ({
  leggiConfig: vi.fn(async () => ({})),
  regoleDaConfig: vi.fn(() => ({
    tariffa: 2.5,
    maxPernottamenti: 5,
    esenzioneEtaMax: 12,
    stagioneDal: '01/01',
    stagioneAl: '31/12',
    inVigoreDal: '01/01/2020',
  })),
}))

const { salvaPratica } = await import('./pratica')

const ID = 'SOG-20260906-120000'

/** Una riga ospite col minimo che serve a risultare "compilata". */
function rigaOspite(prog: string, cognome: string, docFronte = '', docRetro = ''): string[] {
  const m: Record<string, string> = {
    'ID Soggiorno': ID, 'Progressivo': prog, 'Tipo alloggiato': '16',
    'Cognome': cognome, 'Nome': 'MARIO', 'Sesso': 'M', 'Data nascita': '1980-01-01',
    'Comune nascita': 'ROMA', 'Prov. nascita': 'RM', 'Stato nascita': 'ITALIA',
    'Cittadinanza': 'ITALIA', 'Tipo documento': 'IDENT', 'Numero documento': 'AB' + prog,
    'Luogo rilascio': 'ROMA', 'Codice fiscale': '', 'Esente imposta': 'NO',
    'Motivo esenzione': '', 'Doc fronte': docFronte, 'Doc retro': docRetro,
  }
  return COL_OSPITI.map((c) => m[c] ?? '')
}

beforeEach(() => {
  scritture.aggiornate = []
  scritture.aggiunte = []
  scritture.cancellate = []
  scritture.documenti = []

  const s: Record<string, string> = {
    'ID Soggiorno': ID, 'Unità': 'Bloom Zone 1', 'Check-in': '2026-08-01',
    'Check-out': '2026-08-08', 'N. ospiti': '3', 'Ospiti dichiarati': '3',
    'Stato check-in': 'DA COMPILARE', 'Nazione': 'IT',
  }
  SOGGIORNI = [[...COL_SOGGIORNI], COL_SOGGIORNI.map((c) => s[c] ?? '')]
  OSPITI = [
    [...COL_OSPITI],
    rigaOspite('1', 'ROSSI', 'foto-1-fronte', 'foto-1-retro'),
    rigaOspite('2', 'BIANCHI', 'foto-2-fronte', 'foto-2-retro'),
    rigaOspite('3', 'VERDI', 'foto-3-fronte', 'foto-3-retro'),
  ]
})

/** Come arriva dal modulo: solo i campi del form, MAI le foto. */
function dalModulo(prog: string, cognome: string): Record<string, string> {
  return {
    'Progressivo': prog, 'Tipo alloggiato': '16', 'Cognome': cognome, 'Nome': 'MARIO',
    'Sesso': 'M', 'Data nascita': '1980-01-01', 'Comune nascita': 'ROMA',
    'Prov. nascita': 'RM', 'Stato nascita': 'ITALIA', 'Cittadinanza': 'ITALIA',
    'Tipo documento': 'IDENT', 'Numero documento': 'AB' + prog, 'Luogo rilascio': 'ROMA',
  }
}

const GESTORE = { tipo: 'gestore' as const }

function ospiteScritto(riga: number): Record<string, string> {
  const w = scritture.aggiornate.find((x) => x.scheda === 'Ospiti' && x.riga === riga)
  if (!w) throw new Error('nessuna scrittura sulla riga ' + riga)
  return Object.fromEntries(COL_OSPITI.map((c, i) => [c, w.valori[i] ?? '']))
}

describe('salvaPratica — togliere un ospite', () => {
  it('cancella la riga giusta e lascia le altre al loro posto', async () => {
    // Il gestore toglie il secondo di tre e salva l'elenco completo.
    const esito = await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio', { tolti: ['2'] },
    )

    expect(esito?.ok).toBe(true)
    // Riga 3 sul foglio = secondo ospite (la 1 e' l'intestazione).
    expect(scritture.cancellate).toEqual([{ scheda: 'Ospiti', righe: [3] }])
  })

  it('ogni scheda resta con le PROPRIE foto: nessun nome coi documenti di un altro', async () => {
    await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio', { tolti: ['2'] },
    )

    expect(ospiteScritto(2)['Cognome']).toBe('ROSSI')
    expect(ospiteScritto(2)['Doc fronte']).toBe('foto-1-fronte')
    expect(ospiteScritto(4)['Cognome']).toBe('VERDI')
    expect(ospiteScritto(4)['Doc fronte']).toBe('foto-3-fronte')
    // Il caso che il difetto produceva davvero: VERDI scritto sulla riga di
    // BIANCHI, quindi col documento di BIANCHI.
    expect(scritture.aggiornate.some((x) => x.scheda === 'Ospiti' && x.riga === 3)).toBe(false)
  })

  it('toglie da Drive le foto di chi non c e piu', async () => {
    await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio', { tolti: ['2'] },
    )
    expect(scritture.documenti.sort()).toEqual(['foto-2-fronte', 'foto-2-retro'])
    expect(scritture.documenti).not.toContain('foto-1-fronte')
    expect(scritture.documenti).not.toContain('foto-3-fronte')
  })

  it('senza una richiesta esplicita non cancella NIENTE', async () => {
    // Controllo positivo: stessa chiamata, stessi dati, solo senza nominare
    // l'ospite 2. Se questo test passasse anche cancellando, il primo non
    // proverebbe nulla. E' anche il caso della pagina aperta da mezz'ora, che
    // non sa chi ha compilato nel frattempo.
    await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio',
    )
    expect(scritture.cancellate).toEqual([])
    expect(scritture.documenti).toEqual([])
  })

  it('un elenco vuoto non cancella nessuno', async () => {
    // E' cio' che manda il gestore quando cambia solo il numero di ospiti attesi.
    await salvaPratica(ID, { 'N. ospiti': '2' }, [], GESTORE, 'foglio')
    expect(scritture.cancellate).toEqual([])
    expect(scritture.documenti).toEqual([])
  })

  it('il sostituto NON eredita le foto di chi se n e andato', async () => {
    /*
      Si toglie il secondo e si aggiunge un sostituto nello stesso salvataggio.
      Il sostituto arriva col numero 4 — nuovo, mai usato — e la riga del
      disdetto se ne va con le sue foto. Riusando il 2 il sostituto avrebbe
      preso quella riga, cioe' i documenti d'identita' di un'altra persona.
    */
    await salvaPratica(
      ID, {},
      [dalModulo('1', 'ROSSI'), dalModulo('3', 'VERDI'), dalModulo('4', 'SOSTITUTO')],
      GESTORE, 'foglio', { tolti: ['2'] },
    )

    expect(scritture.cancellate).toEqual([{ scheda: 'Ospiti', righe: [3] }])
    expect(scritture.documenti.sort()).toEqual(['foto-2-fronte', 'foto-2-retro'])

    const aggiunta = scritture.aggiunte.find((x) => x.scheda === 'Ospiti')
    const nuova = aggiunta?.righe[0] ?? []
    expect(nuova[COL_OSPITI.indexOf('Cognome')]).toBe('SOSTITUTO')
    expect(nuova[COL_OSPITI.indexOf('Doc fronte')]).toBe('')
    expect(nuova[COL_OSPITI.indexOf('Doc retro')]).toBe('')
  })

  it('un singolo ospite non puo cancellare le schede degli altri', async () => {
    await salvaPratica(
      ID, {}, [dalModulo('2', 'BIANCHI')],
      { tipo: 'ospite', progressivo: 2 }, 'foglio', { tolti: ['1', '3'] },
    )
    expect(scritture.cancellate).toEqual([])
    expect(scritture.documenti).toEqual([])
  })

  it('cancella dal numero di riga piu alto al piu basso', async () => {
    // Altrimenti la prima cancellazione sposta in su le righe successive e la
    // seconda cancella quella sbagliata.
    await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI')],
      GESTORE, 'foglio', { tolti: ['2', '3'] },
    )
    expect(scritture.cancellate).toEqual([{ scheda: 'Ospiti', righe: [4, 3] }])
  })
})

describe('salvaPratica — cio che non deve cambiare', () => {
  it('aggiungere una scheda non tocca le esistenti', async () => {
    await salvaPratica(
      ID, {},
      [dalModulo('1', 'ROSSI'), dalModulo('2', 'BIANCHI'), dalModulo('3', 'VERDI'), dalModulo('4', 'NERI')],
      GESTORE, 'foglio',
    )
    expect(scritture.cancellate).toEqual([])
    const aggiunta = scritture.aggiunte.find((x) => x.scheda === 'Ospiti')
    expect(aggiunta?.righe).toHaveLength(1)
    expect(aggiunta?.righe[0][COL_OSPITI.indexOf('Cognome')]).toBe('NERI')
  })

  it('il conteggio delle schede compilate segue le schede rimaste', async () => {
    await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio', { tolti: ['2'] },
    )
    const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, w!.valori[i] ?? '']))
    expect(m['Ospiti dichiarati']).toBe('2')
    // Il metro resta il numero PRENOTATO: 2 schede su 3 attesi non e' completo.
    expect(m['Stato check-in']).not.toBe('CHECKIN OK')
  })
})

describe('salvaPratica — l imposta si calcola sugli ospiti PRENOTATI', () => {
  /*
    Il Comune non chiede quante schede sono state compilate: chiede quante
    persone hanno dormito qui. Con 3 prenotati e 1 sola scheda compilata
    l'imposta deve restare quella di 3 persone.

    Prima il conto tornava per caso, perche' il modulo mandava anche le schede
    bianche e una data di nascita vuota veniva contata come pagante. Smettendo
    di scrivere quelle righe — che sporcavano il file per la Questura —
    l'imposta sarebbe calata in silenzio del 66%.
  */
  function impostaScritta(): number {
    const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, w!.valori[i] ?? '']))
    return Number(m['Imposta soggiorno €'])
  }

  it('una sola scheda su tre prenotati: l imposta e per tre', async () => {
    await salvaPratica(ID, {}, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio', { tolti: ['2', '3'] })
    // 3 persone x 5 pernottamenti tassati (il soggiorno e di 7 notti,
    // il tetto e 5) x 2,50 euro.
    expect(impostaScritta()).toBe(37.5)
  })

  it('CONTROLLO POSITIVO: con tutte e tre le schede l imposta e la stessa', async () => {
    await salvaPratica(
      ID, {},
      [dalModulo('1', 'ROSSI'), dalModulo('2', 'BIANCHI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio',
    )
    expect(impostaScritta()).toBe(37.5)
  })

  it('se le schede sono PIU degli attesi valgono le schede, mai al ribasso', async () => {
    await salvaPratica(
      ID, { 'N. ospiti': '1' },
      [dalModulo('1', 'ROSSI'), dalModulo('2', 'BIANCHI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio',
    )
    expect(impostaScritta()).toBe(37.5)
  })
})

describe('salvaPratica — le anomalie dell imposta non spariscono', () => {
  /*
    `imposta-soggiorno.ts` dichiara che "in questo sottosistema niente puo'
    fallire in silenzio". Ma il risultato veniva letto solo per l'importo, e le
    anomalie non arrivavano a nessuno: un'esenzione senza motivo dichiarato —
    che in sede di controllo e' un ammanco, perche' la dichiarazione scritta va
    conservata — non veniva detta ne' a chi compila ne' a chi gestisce.
  */
  it('un esente senza motivo dichiarato viene segnalato a chi salva', async () => {
    OSPITI = [
      [...COL_OSPITI],
      COL_OSPITI.map((c) => ({
        'ID Soggiorno': ID, 'Progressivo': '1', 'Cognome': 'ROSSI', 'Nome': 'MARIO',
        'Data nascita': '1980-01-01', 'Esente imposta': 'SI', 'Motivo esenzione': '',
      } as Record<string, string>)[c] ?? ''),
    ]

    const esito = await salvaPratica(
      ID, {},
      [{ ...dalModulo('1', 'ROSSI'), 'Esente imposta': 'SI', 'Motivo esenzione': '' }],
      GESTORE, 'foglio',
    )

    expect(esito?.segnalazioni.join(' · ')).toMatch(/esenzione senza motivo/i)
  })

  it('CONTROLLO POSITIVO: col motivo dichiarato non si segnala niente sull esenzione', async () => {
    OSPITI = [
      [...COL_OSPITI],
      COL_OSPITI.map((c) => ({
        'ID Soggiorno': ID, 'Progressivo': '1', 'Cognome': 'ROSSI', 'Nome': 'MARIO',
        'Data nascita': '1980-01-01', 'Esente imposta': 'SI', 'Motivo esenzione': 'disabile',
      } as Record<string, string>)[c] ?? ''),
    ]

    const esito = await salvaPratica(
      ID, {},
      [{ ...dalModulo('1', 'ROSSI'), 'Esente imposta': 'SI', 'Motivo esenzione': 'disabile' }],
      GESTORE, 'foglio',
    )

    expect(esito?.segnalazioni.join(' · ')).not.toMatch(/esenzione senza motivo/i)
  })
})

describe('creaPrenotazione — l imposta non nasce a zero', () => {
  /*
    Registrando gli arretrati di agosto — venti prenotazioni, nessuna scheda
    ancora compilata — il riquadro "Imposta di soggiorno" diceva
    "0 notti · € 0,00": notti e importo restavano vuoti fino al primo
    salvataggio delle schede. Il totale da versare al Comune entro il 16 era
    quindi zero, e nessuna riga a schermo lo diceva.

    Trovato provando in produzione la sequenza vera, non leggendo il codice.
  */
  it('una prenotazione appena creata porta gia notti e imposta', async () => {
    const { creaPrenotazione } = await import('./pratica')
    scritture.aggiunte = []

    await creaPrenotazione({
      unita: 'Bloom Zone 1', portale: 'Diretto', codPrenotazione: 'X',
      checkin: '2026-08-05', checkout: '2026-08-12', ospitiAttesi: '4',
      importoLordo: '', intestatario: 'ROSSI', note: '',
    }, new Date('2026-09-06T10:00:00Z'), 'foglio')

    const riga = scritture.aggiunte.find((x) => x.scheda === 'Soggiorni')?.righe[0] ?? []
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, riga[i] ?? '']))
    expect(m['Notti']).toBe('7')
    // 4 persone x 5 pernottamenti tassati (tetto) x 2,50 euro.
    expect(m['Imposta soggiorno €']).toBe('50')
  })

  it('CONTROLLO POSITIVO: senza ospiti l imposta e zero, e non per un errore', async () => {
    const { creaPrenotazione } = await import('./pratica')
    scritture.aggiunte = []

    await creaPrenotazione({
      unita: 'Bloom Zone 1', portale: 'Diretto', codPrenotazione: 'X',
      checkin: '2026-08-05', checkout: '2026-08-12', ospitiAttesi: '0',
      importoLordo: '', intestatario: 'ROSSI', note: '',
    }, new Date('2026-09-06T10:00:00Z'), 'foglio')

    const riga = scritture.aggiunte.find((x) => x.scheda === 'Soggiorni')?.righe[0] ?? []
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, riga[i] ?? '']))
    expect(m['Notti']).toBe('7')
    expect(m['Imposta soggiorno €']).toBe('0')
  })
})
