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

/** Ganci per far succedere qualcosa NEL MEZZO di un salvataggio. */
const ganci: { altroTelefono: null | (() => void) } = { altroTelefono: null }

let SOGGIORNI: string[][] = []
let OSPITI: string[][] = []

/*
  Il finto foglio SIMULA, non registra soltanto.

  Le scritture cambiano davvero gli array, e le letture restituiscono lo stato
  aggiornato. Serve perche' `salvaPratica` RILEGGE prima di scrivere la riga
  della prenotazione: con un finto foglio che ricorda le chiamate e basta,
  quella rilettura tornerebbe sempre la fotografia iniziale e i test
  passerebbero senza provare nulla — misurando lo strumento invece del dato.

  E' anche il modo in cui un audit avversariale ha trovato difetti che 1813
  test verdi non vedevano.
*/
function scheda(nome: string): string[][] {
  return nome === 'Soggiorni' ? SOGGIORNI : OSPITI
}

/**
 * Fa entrare in scena il secondo telefono, se il test ne ha messo uno.
 *
 * Si chiama dopo OGNI scrittura sulle schede ospite, aggiunta compresa: la
 * prima versione stava solo dentro `aggiornaRiga`, e con un foglio vuoto —
 * dove la prima scheda viene AGGIUNTA e non aggiornata — non scattava mai.
 * I test passavano lo stesso, misurando niente.
 */
function scattaGancio(nome: string) {
  if (nome !== 'Ospiti' || !ganci.altroTelefono) return
  const f = ganci.altroTelefono
  ganci.altroTelefono = null
  f()
}

vi.mock('./foglio-google', () => ({
  // Una copia, non il riferimento: chi legge non deve poter modificare il
  // foglio per sbaglio, come non puo' farlo Google.
  leggiTutto: vi.fn(async (_id: string, nome: string) => scheda(nome).map((r) => [...r])),

  aggiornaRiga: vi.fn(async (_id: string, nome: string, riga: number, valori: string[]) => {
    scritture.aggiornate.push({ scheda: nome, riga, valori })
    scheda(nome)[riga - 1] = [...valori]
    scattaGancio(nome)
  }),

  aggiungiRighe: vi.fn(async (_id: string, nome: string, righe: string[][]) => {
    if (!righe.length) return
    scritture.aggiunte.push({ scheda: nome, righe })
    for (const r of righe) scheda(nome).push([...r])
    scattaGancio(nome)
  }),

  eliminaRighe: vi.fn(async (_id: string, nome: string, righe: number[]) => {
    scritture.cancellate.push({ scheda: nome, righe })
    // Dal basso verso l'alto, come fa Google: togliendo prima la riga 3, la 5
    // diventa la 4 e si cancellerebbe quella sbagliata.
    for (const n of [...new Set(righe)].sort((a, b) => b - a)) scheda(nome).splice(n - 1, 1)
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
  ganci.altroTelefono = null

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

describe('salvaPratica — i tre difetti che 1813 test verdi non vedevano', () => {
  it('uno spazio nella cella Progressivo non duplica l ospite a ogni salvataggio', async () => {
    /*
      Il foglio lo si apre e lo si ritocca: "2 " con lo spazio esiste davvero.
      Senza `trim` la riga non corrispondeva a nessun progressivo noto e la
      scheda veniva AGGIUNTA invece che aggiornata: un ospite in piu' a ogni
      salvataggio, due volte nel file per la Questura e due volte nell'imposta.
    */
    OSPITI = [
      [...COL_OSPITI],
      rigaOspite('1', 'ROSSI', 'f1', 'r1'),
      COL_OSPITI.map((c) => (c === 'Progressivo' ? '2 ' : rigaOspite('2', 'BIANCHI', 'f2', 'r2')[COL_OSPITI.indexOf(c)])),
    ]

    // Si salva SOLO la scheda 1: la riga con "2 " resta intoccata, e in
    // quel caso il suo progressivo e' ancora quello sporco della cella.
    await salvaPratica(ID, {}, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio')

    expect(scritture.aggiunte).toEqual([])
    expect(scritture.aggiornate.filter((x) => x.scheda === 'Ospiti').map((x) => x.riga).sort())
      .toEqual([2, 3])
  })

  it('una scheda che arriva NON viene cancellata, anche se era stata tolta', async () => {
    /*
      Si toglie l'ospite 2, il salvataggio fallisce, la richiesta resta in
      attesa — e intanto quella scheda viene ricompilata. Senza guardia la
      riga veniva scritta e subito dopo cancellata, con le foto del documento
      su Drive, e la risposta era `ok: true`.
    */
    const esito = await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('2', 'BIANCHI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio', { tolti: ['2'] },
    )

    expect(esito?.tolti).toEqual([])
    expect(scritture.cancellate).toEqual([])
    expect(scritture.documenti).toEqual([])
    expect(ospiteScritto(3)['Cognome']).toBe('BIANCHI')
    expect(ospiteScritto(3)['Doc fronte']).toBe('foto-2-fronte')
  })

  it('CONTROLLO POSITIVO: se la scheda NON arriva, la rimozione avviene', async () => {
    // Senza questo, il test qui sopra passerebbe anche con la cancellazione
    // rotta del tutto.
    const esito = await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio', { tolti: ['2'] },
    )

    expect(esito?.tolti).toEqual(['2'])
    expect(scritture.cancellate).toEqual([{ scheda: 'Ospiti', righe: [3] }])
    expect(scritture.documenti.sort()).toEqual(['foto-2-fronte', 'foto-2-retro'])
  })
})

describe('salvaPratica — due telefoni nello stesso minuto', () => {
  /*
    Il foglio non ha transazioni e la riga della prenotazione si riscrive
    intera. Prima della rilettura, chi salvava per secondo calcolava
    `Ospiti dichiarati`, `Stato check-in` e soprattutto `Imposta soggiorno €`
    SENZA la scheda che l'altro aveva appena scritto, e li imprimeva sopra.
    Nessuno dei due si accorgeva di niente: entrambi rispondevano "ok".
    E quella cifra si versa a un Comune.
  */

  /** La scheda che arriva da un altro telefono mentre stiamo salvando. */
  function scriveUnAltroTelefono(prog: string, cognome: string) {
    ganci.altroTelefono = () => { OSPITI.push(rigaOspite(prog, cognome, 'fx', 'rx')) }
  }

  it('la scheda arrivata nel frattempo NON viene cancellata dai numeri', async () => {
    // Partenza: nessuna scheda, 3 ospiti attesi.
    OSPITI = [[...COL_OSPITI]]

    scriveUnAltroTelefono('2', 'BIANCHI')
    const esito = await salvaPratica(ID, {}, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio')

    // Sul foglio ci sono DUE schede: la nostra e quella dell'altro telefono.
    const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, w!.valori[i] ?? '']))
    expect(m['Ospiti dichiarati']).toBe('2')
    expect(esito?.ok).toBe(true)
  })

  it('lo stato tiene conto anche della scheda dell altro telefono', async () => {
    // 3 attesi: con la nostra piu' la sua siamo a 2, non a 1.
    OSPITI = [[...COL_OSPITI]]
    scriveUnAltroTelefono('2', 'BIANCHI')
    await salvaPratica(ID, {}, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio')

    const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, w!.valori[i] ?? '']))
    expect(m['Da completare']).toContain('Manca 1 scheda ospite su 3')
  })

  it('CONTROLLO POSITIVO: senza l altro telefono il conteggio e 1', async () => {
    // Senza questo, i due test qui sopra passerebbero anche se il gancio non
    // scattasse mai: direbbero "2" per un motivo qualsiasi.
    OSPITI = [[...COL_OSPITI]]
    await salvaPratica(ID, {}, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio')

    const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, w!.valori[i] ?? '']))
    expect(m['Ospiti dichiarati']).toBe('1')
  })

  it('l imposta non scende per una scheda scritta da un altro nel frattempo', async () => {
    // L'imposta si calcola sui PRENOTATI, quindi non cambia: ma il conto deve
    // restare quello giusto anche vedendo due schede invece di una.
    OSPITI = [[...COL_OSPITI]]
    scriveUnAltroTelefono('2', 'BIANCHI')
    await salvaPratica(ID, {}, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio')

    const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, w!.valori[i] ?? '']))
    // 3 prenotati x 5 pernottamenti tassati x 2,50.
    expect(Number(m['Imposta soggiorno €'])).toBe(37.5)
  })

  it('se qualcuno riordina il foglio nel frattempo, la riga giusta e quella riletta', async () => {
    // Una riga inserita sopra sposta in giu' tutte le altre: scrivendo sul
    // numero di riga di prima si scriverebbe su un'altra prenotazione.
    ganci.altroTelefono = () => {
      SOGGIORNI.splice(1, 0, COL_SOGGIORNI.map((c) => (c === 'ID Soggiorno' ? 'SOG-ALTRA' : '')))
    }
    await salvaPratica(ID, {}, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio')

    const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')
    // La nostra prenotazione ora e' alla riga 3, non piu' alla 2.
    expect(w?.riga).toBe(3)
    // E la riga della prenotazione altrui e rimasta intatta.
    expect(SOGGIORNI[1][COL_SOGGIORNI.indexOf('ID Soggiorno')]).toBe('SOG-ALTRA')
  })

  it('se la prenotazione sparisce mentre si salva, lo dice invece di scrivere a caso', async () => {
    ganci.altroTelefono = () => { SOGGIORNI.splice(1, 1) }
    const esito = await salvaPratica(ID, {}, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio')

    expect(esito?.ok).toBe(false)
    expect(esito?.errore).toMatch(/cancellata mentre salvavi/i)
    // E soprattutto: NON ha scritto nessuna riga soggiorno.
    expect(scritture.aggiornate.some((x) => x.scheda === 'Soggiorni')).toBe(false)
  })
})

describe('salvaPratica — la riga della prenotazione non si riporta indietro', () => {
  /*
    Il caso vero: chi gestisce alza gli ospiti attesi da 3 a 5 dall'elenco,
    mentre un ospite sta salvando la propria scheda dal telefono. Il
    salvataggio dell'ospite riscrive la riga INTERA: fondendola sulla copia
    vecchia, riportava `N. ospiti` a 3 e nessuno se ne accorgeva — e con lui
    tornavano indietro l'imposta e lo stato del check-in.
  */
  function altroTelefonoAlza(a: string) {
    ganci.altroTelefono = () => {
      SOGGIORNI[1][COL_SOGGIORNI.indexOf('N. ospiti')] = a
    }
  }

  it('un cambio fatto da un altro nel frattempo non viene sovrascritto', async () => {
    altroTelefonoAlza('5')
    await salvaPratica(ID, {}, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio')

    const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, w!.valori[i] ?? '']))
    expect(m['N. ospiti']).toBe('5')
    // E i numeri che ne dipendono seguono il valore NUOVO, non quello vecchio:
    // 5 persone x 5 pernottamenti tassati x 2,50.
    expect(Number(m['Imposta soggiorno €'])).toBe(62.5)
  })

  it('CONTROLLO POSITIVO: senza interferenze resta 3, e l imposta e quella di 3', async () => {
    await salvaPratica(ID, {}, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio')

    const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, w!.valori[i] ?? '']))
    expect(m['N. ospiti']).toBe('3')
    expect(Number(m['Imposta soggiorno €'])).toBe(37.5)
  })

  it('ma quello che sta salvando LUI vince comunque sulla riga fresca', async () => {
    // La rilettura non deve annullare le modifiche di chi salva: si posano
    // sopra la fotografia fresca, non al posto suo.
    altroTelefonoAlza('5')
    await salvaPratica(ID, { 'Note': 'arrivano tardi' }, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio')

    const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, w!.valori[i] ?? '']))
    expect(m['Note']).toBe('arrivano tardi')
    expect(m['N. ospiti']).toBe('5')
  })
})
