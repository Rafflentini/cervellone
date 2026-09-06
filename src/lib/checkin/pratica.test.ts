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
      GESTORE, 'foglio', { elencoCompleto: true },
    )

    expect(esito?.ok).toBe(true)
    // Riga 3 sul foglio = secondo ospite (la 1 e' l'intestazione).
    expect(scritture.cancellate).toEqual([{ scheda: 'Ospiti', righe: [3] }])
  })

  it('ogni scheda resta con le PROPRIE foto: nessun nome coi documenti di un altro', async () => {
    await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio', { elencoCompleto: true },
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
      GESTORE, 'foglio', { elencoCompleto: true },
    )
    expect(scritture.documenti.sort()).toEqual(['foto-2-fronte', 'foto-2-retro'])
    expect(scritture.documenti).not.toContain('foto-1-fronte')
    expect(scritture.documenti).not.toContain('foto-3-fronte')
  })

  it('senza la dichiarazione esplicita non cancella NIENTE', async () => {
    // Controllo positivo: stessa chiamata, stessi dati, solo senza il flag.
    // Se questo test passasse anche cancellando, il primo non proverebbe nulla.
    await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio',
    )
    expect(scritture.cancellate).toEqual([])
    expect(scritture.documenti).toEqual([])
  })

  it('un elenco vuoto non cancella nessuno, nemmeno col flag', async () => {
    // E' cio' che manda il gestore quando cambia solo il numero di ospiti attesi.
    await salvaPratica(ID, { 'N. ospiti': '2' }, [], GESTORE, 'foglio', { elencoCompleto: true })
    expect(scritture.cancellate).toEqual([])
    expect(scritture.documenti).toEqual([])
  })

  it('un singolo ospite non puo cancellare le schede degli altri', async () => {
    await salvaPratica(
      ID, {}, [dalModulo('2', 'BIANCHI')],
      { tipo: 'ospite', progressivo: 2 }, 'foglio', { elencoCompleto: true },
    )
    expect(scritture.cancellate).toEqual([])
    expect(scritture.documenti).toEqual([])
  })

  it('cancella dal numero di riga piu alto al piu basso', async () => {
    // Altrimenti la prima cancellazione sposta in su le righe successive e la
    // seconda cancella quella sbagliata.
    await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI')],
      GESTORE, 'foglio', { elencoCompleto: true },
    )
    expect(scritture.cancellate).toEqual([{ scheda: 'Ospiti', righe: [4, 3] }])
  })
})

describe('salvaPratica — cio che non deve cambiare', () => {
  it('aggiungere una scheda non tocca le esistenti', async () => {
    await salvaPratica(
      ID, {},
      [dalModulo('1', 'ROSSI'), dalModulo('2', 'BIANCHI'), dalModulo('3', 'VERDI'), dalModulo('4', 'NERI')],
      GESTORE, 'foglio', { elencoCompleto: true },
    )
    expect(scritture.cancellate).toEqual([])
    const aggiunta = scritture.aggiunte.find((x) => x.scheda === 'Ospiti')
    expect(aggiunta?.righe).toHaveLength(1)
    expect(aggiunta?.righe[0][COL_OSPITI.indexOf('Cognome')]).toBe('NERI')
  })

  it('il conteggio delle schede compilate segue le schede rimaste', async () => {
    await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('3', 'VERDI')],
      GESTORE, 'foglio', { elencoCompleto: true },
    )
    const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')
    const m = Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, w!.valori[i] ?? '']))
    expect(m['Ospiti dichiarati']).toBe('2')
    // Il metro resta il numero PRENOTATO: 2 schede su 3 attesi non e' completo.
    expect(m['Stato check-in']).not.toBe('CHECKIN OK')
  })
})
