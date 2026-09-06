/** SONDA TEMPORANEA DI AUDIT - da cancellare. Non e' codice di produzione. */
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
  leggiTutto: vi.fn(async (_id: string, scheda: string) => (scheda === 'Soggiorni' ? SOGGIORNI : OSPITI)),
  aggiornaRiga: vi.fn(async (_i: string, scheda: string, riga: number, valori: string[]) => {
    scritture.aggiornate.push({ scheda, riga, valori })
  }),
  aggiungiRighe: vi.fn(async (_i: string, scheda: string, righe: string[][]) => {
    if (righe.length) scritture.aggiunte.push({ scheda, righe })
  }),
  eliminaRighe: vi.fn(async (_i: string, scheda: string, righe: number[]) => {
    scritture.cancellate.push({ scheda, righe })
  }),
}))
vi.mock('./documenti', () => ({
  eliminaDocumento: vi.fn(async (f: string) => { scritture.documenti.push(f); return true }),
}))
vi.mock('./foglio-lettura', () => ({
  leggiConfig: vi.fn(async () => ({})),
  regoleDaConfig: vi.fn(() => ({
    tariffa: 2.5, maxPernottamenti: 5, esenzioneEtaMax: 12,
    stagioneDal: '01/01', stagioneAl: '31/12', inVigoreDal: '01/01/2020',
  })),
}))

const { salvaPratica } = await import('./pratica')
const ID = 'SOG-20260906-120000'
const GESTORE = { tipo: 'gestore' as const }

function rigaOspite(prog: string, cognome: string, f = '', r = ''): string[] {
  const m: Record<string, string> = {
    'ID Soggiorno': ID, 'Progressivo': prog, 'Tipo alloggiato': '16',
    'Cognome': cognome, 'Nome': 'MARIO', 'Sesso': 'M', 'Data nascita': '1980-01-01',
    'Comune nascita': 'ROMA', 'Prov. nascita': 'RM', 'Stato nascita': 'ITALIA',
    'Cittadinanza': 'ITALIA', 'Tipo documento': 'IDENT', 'Numero documento': 'AB' + prog.trim(),
    'Luogo rilascio': 'ROMA', 'Codice fiscale': '', 'Esente imposta': 'NO',
    'Motivo esenzione': '', 'Doc fronte': f, 'Doc retro': r,
  }
  return COL_OSPITI.map((c) => m[c] ?? '')
}
function dalModulo(prog: string, cognome: string): Record<string, string> {
  return {
    'Progressivo': prog, 'Tipo alloggiato': '16', 'Cognome': cognome, 'Nome': 'MARIO',
    'Sesso': 'M', 'Data nascita': '1980-01-01', 'Comune nascita': 'ROMA',
    'Prov. nascita': 'RM', 'Stato nascita': 'ITALIA', 'Cittadinanza': 'ITALIA',
    'Tipo documento': 'IDENT', 'Numero documento': 'AB' + prog, 'Luogo rilascio': 'ROMA',
  }
}
function soggiornoBase(nOspiti: string) {
  const s: Record<string, string> = {
    'ID Soggiorno': ID, 'Unità': 'Bloom Zone 1', 'Check-in': '2026-08-01',
    'Check-out': '2026-08-08', 'N. ospiti': nOspiti, 'Ospiti dichiarati': nOspiti,
    'Stato check-in': 'DA COMPILARE', 'Nazione': 'IT',
    'Indirizzo': 'VIA ROMA 1', 'CAP': '85046', 'Città': 'MARATEA',
  }
  return [[...COL_SOGGIORNI], COL_SOGGIORNI.map((c) => s[c] ?? '')]
}
const sogScritto = () => {
  const w = scritture.aggiornate.find((x) => x.scheda === 'Soggiorni')!
  return Object.fromEntries(COL_SOGGIORNI.map((c, i) => [c, w.valori[i] ?? '']))
}

beforeEach(() => {
  scritture.aggiornate = []; scritture.aggiunte = []
  scritture.cancellate = []; scritture.documenti = []
})

describe('SONDA A - Progressivo con spazio in coda su una riga NON toccata', () => {
  it('la riga viene DUPLICATA in coda al foglio invece di restare dov era', async () => {
    SOGGIORNI = soggiornoBase('2')
    OSPITI = [[...COL_OSPITI], rigaOspite('1', 'ROSSI'), rigaOspite('2 ', 'BIANCHI', 'foto-2-f')]

    await salvaPratica(ID, {}, [dalModulo('1', 'ROSSI')], GESTORE, 'foglio', {})

    const iC = COL_OSPITI.indexOf('Cognome')
    const iP = COL_OSPITI.indexOf('Progressivo')
    console.log('AGGIUNTE:', JSON.stringify(scritture.aggiunte.map((a) => a.righe.map((r) => r[iC] + '/prog=' + JSON.stringify(r[iP])))))
    console.log('AGGIORNATE righe ospiti:', JSON.stringify(scritture.aggiornate.filter((a) => a.scheda === 'Ospiti').map((a) => a.riga)))
    expect(scritture.aggiunte.filter((a) => a.scheda === 'Ospiti')).toEqual([])
  })
})

describe('SONDA B - 4 attesi, 0 schede compilate', () => {
  it('cosa scrive il sistema', async () => {
    SOGGIORNI = soggiornoBase('4')
    OSPITI = [[...COL_OSPITI]]
    const esito = await salvaPratica(ID, {}, [], GESTORE, 'foglio', {})
    const m = sogScritto()
    console.log('Ospiti dichiarati =', JSON.stringify(m['Ospiti dichiarati']))
    console.log('Stato check-in    =', JSON.stringify(m['Stato check-in']))
    console.log('Imposta soggiorno =', JSON.stringify(m['Imposta soggiorno €']))
    console.log('Notti             =', JSON.stringify(m['Notti']))
    console.log('Da completare     =', JSON.stringify(m['Da completare']))
    console.log('segnalazioni      =', JSON.stringify(esito?.segnalazioni))
    expect(esito?.ok).toBe(true)
  })
})

describe('SONDA C - 4 attesi, 2 schede compilate: cosa vede chi compila', () => {
  it('segnalazioni mostrate all ospite', async () => {
    SOGGIORNI = soggiornoBase('4')
    OSPITI = [[...COL_OSPITI], rigaOspite('1', 'ROSSI'), rigaOspite('2', 'BIANCHI')]
    const esito = await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('2', 'BIANCHI')],
      { tipo: 'prenotazione' }, 'foglio', {},
    )
    console.log('Imposta =', sogScritto()['Imposta soggiorno €'])
    console.log('segnalazioni =', JSON.stringify(esito?.segnalazioni, null, 1))
    expect(esito?.ok).toBe(true)
  })
})

describe('SONDA D - N. ospiti non numerico e generazione dei link', () => {
  it('riproduce il ciclo di api/checkin/pratica GET', () => {
    for (const valore of ['4', '', '2 adulti', 'due', '0', '3,5']) {
      const esistenti: number[] = []
      const numeri = new Set(esistenti)
      const attesi = Math.max(Number(valore || 0), 1)
      for (let n = 1; numeri.size < attesi && n < attesi + esistenti.length + 1; n++) numeri.add(n)
      console.log('N. ospiti=' + JSON.stringify(valore) + ' -> attesi=' + attesi + ' -> link generati=' + numeri.size)
    }
    expect(true).toBe(true)
  })
})

describe('SONDA E - tolti + scheda dello stesso numero nella STESSA richiesta', () => {
  it('la scheda appena scritta viene poi cancellata con le sue foto', async () => {
    SOGGIORNI = soggiornoBase('3')
    OSPITI = [[...COL_OSPITI], rigaOspite('1', 'ROSSI'), rigaOspite('2', 'NUOVO-OSPITE', 'foto-nuova-f')]
    await salvaPratica(
      ID, {}, [dalModulo('1', 'ROSSI'), dalModulo('2', 'NUOVO-OSPITE')],
      GESTORE, 'foglio', { tolti: ['2'] },
    )
    console.log('righe ospiti cancellate:', JSON.stringify(scritture.cancellate))
    console.log('foto cancellate da Drive:', JSON.stringify(scritture.documenti))
    expect(scritture.cancellate.filter((c) => c.scheda === 'Ospiti')).toEqual([])
  })
})
