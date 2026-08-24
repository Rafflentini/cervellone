/**
 * Chi puo' cambiare cosa.
 *
 * Questa e' la difesa vera, e questi test sono l'unica prova che esista. Un
 * campo mostrato in sola lettura nel browser si rimanda comunque a mano:
 * chiunque abbia il link puo' inviare quello che vuole. Se il blocco vive solo
 * nella pagina non e' un blocco, e' un suggerimento.
 *
 * Il caso da non sbagliare mai: **l'importo**. Se un ospite lo cambia, quella
 * cifra finisce in fattura al posto di quella incassata, e non se ne accorge
 * nessuno fino al commercialista.
 */
import { describe, it, expect } from 'vitest'
import {
  fondiSoggiorno, fondiOspiti, aMappa, aRiga, oscuraRiservati, type Livello,
} from './merge-pratica'
import { COL_SOGGIORNI, COL_OSPITI } from './foglio-schema'

const GESTORE: Livello = { tipo: 'gestore' }
const INTESTATARIO: Livello = { tipo: 'prenotazione' }
const OSPITE2: Livello = { tipo: 'ospite', progressivo: 2 }

function soggiornoEsistente(over: Record<string, string> = {}): string[] {
  return aRiga(COL_SOGGIORNI, {
    'ID Soggiorno': 'SOG-1',
    'Unità': 'Unità 1',
    'Cod. prenotazione': 'BK-999',
    'Check-in': '2026-08-10',
    'Check-out': '2026-08-14',
    'N. ospiti': '4',
    'Importo lordo €': '800',
    'Indirizzo': '', 'CAP': '', 'Città': '',
    'Fattura emessa': 'NO',
    'Stato check-in': 'DA COMPILARE',
    ...over,
  })
}

const campo = (riga: string[], nome: string) => aMappa(COL_SOGGIORNI, riga)[nome]

describe("l'importo — il campo che non deve cedere", () => {
  it('un ospite intestatario NON puo cambiarlo', () => {
    const r = fondiSoggiorno(soggiornoEsistente(), { 'Importo lordo €': '1' }, INTESTATARIO)
    expect(campo(r.riga, 'Importo lordo €')).toBe('800')
    expect(r.rifiutati).toContain('Importo lordo €')
  })

  it('nemmeno un altro ospite', () => {
    const r = fondiSoggiorno(soggiornoEsistente(), { 'Importo lordo €': '1' }, OSPITE2)
    expect(campo(r.riga, 'Importo lordo €')).toBe('800')
  })

  it('il gestore si', () => {
    const r = fondiSoggiorno(soggiornoEsistente(), { 'Importo lordo €': '950' }, GESTORE)
    expect(campo(r.riga, 'Importo lordo €')).toBe('950')
    expect(r.rifiutati).toEqual([])
  })
})

describe('gli altri campi della prenotazione', () => {
  const bloccati = ['Unità', 'Check-in', 'Check-out', 'N. ospiti', 'Cod. prenotazione']

  for (const c of bloccati) {
    it(`"${c}" non lo cambia l ospite`, () => {
      const r = fondiSoggiorno(soggiornoEsistente(), { [c]: 'MANOMESSO' }, INTESTATARIO)
      expect(campo(r.riga, c)).not.toBe('MANOMESSO')
      expect(r.rifiutati).toContain(c)
    })
  }

  it('rimandarli INVARIATI non e un tentativo: il browser lo fa sempre', () => {
    // Se segnalassimo anche questo, ogni salvataggio normale sembrerebbe un
    // attacco e la segnalazione diventerebbe rumore da ignorare.
    const r = fondiSoggiorno(soggiornoEsistente(), { 'Unità': 'Unità 1', 'N. ospiti': '4' }, INTESTATARIO)
    expect(r.rifiutati).toEqual([])
  })
})

describe('cosa PUO cambiare l intestatario', () => {
  it('i dati della fattura, che sono i suoi', () => {
    const r = fondiSoggiorno(soggiornoEsistente(), {
      'Indirizzo': 'Via Verdi 1', 'CAP': '85046', 'Città': 'MARATEA',
    }, INTESTATARIO)
    expect(campo(r.riga, 'Indirizzo')).toBe('Via Verdi 1')
    expect(campo(r.riga, 'Città')).toBe('MARATEA')
    expect(r.rifiutati).toEqual([])
  })
})

describe('un ospite che non e l intestatario', () => {
  it('non tocca NIENTE del soggiorno, nemmeno i dati della fattura', () => {
    const r = fondiSoggiorno(soggiornoEsistente(), { 'Indirizzo': 'Via Sua 9' }, OSPITE2)
    expect(campo(r.riga, 'Indirizzo')).toBe('')
    expect(r.rifiutati).toContain('Indirizzo')
  })
})

describe('i campi che scrive il sistema', () => {
  const diSistema = ['Fattura emessa', 'N. fattura', 'Imposta soggiorno €', 'Stato check-in']

  for (const c of diSistema) {
    it(`"${c}" non lo cambia nemmeno il gestore dal form`, () => {
      // Se il form potesse riscriverli, un salvataggio tardivo cancellerebbe il
      // numero di una fattura gia emessa.
      const r = fondiSoggiorno(soggiornoEsistente({ [c]: 'VALORE VERO' }), { [c]: 'SOVRASCRITTO' }, GESTORE)
      expect(campo(r.riga, c)).toBe('VALORE VERO')
    })
  }
})

describe('robustezza', () => {
  it('ignora colonne che non esistono nello schema', () => {
    const r = fondiSoggiorno(soggiornoEsistente(), { 'Colonna Inventata': 'x' }, GESTORE)
    expect(r.riga).toHaveLength(COL_SOGGIORNI.length)
  })

  it('un salvataggio vuoto non cancella niente', () => {
    const r = fondiSoggiorno(soggiornoEsistente(), {}, INTESTATARIO)
    expect(campo(r.riga, 'Importo lordo €')).toBe('800')
    expect(campo(r.riga, 'Unità')).toBe('Unità 1')
  })
})

// ────────────────────────────────────────────── ospiti

function ospiteRiga(prog: string, cognome: string): string[] {
  return aRiga(COL_OSPITI, {
    'ID Soggiorno': 'SOG-1', 'Progressivo': prog, 'Cognome': cognome, 'Nome': 'X',
  })
}

const cognomeDi = (righe: string[][], prog: string) =>
  aMappa(COL_OSPITI, righe.find((r) => aMappa(COL_OSPITI, r)['Progressivo'] === prog)!)['Cognome']

describe('schede ospiti', () => {
  it('aggiorna la propria e lascia stare le altre', () => {
    const esistenti = [ospiteRiga('1', 'ROSSI'), ospiteRiga('2', 'VERDI')]
    const r = fondiOspiti(esistenti, [{ Progressivo: '2', Cognome: 'BIANCHI' }], OSPITE2, 'SOG-1')
    expect(cognomeDi(r.righe, '2')).toBe('BIANCHI')
    expect(cognomeDi(r.righe, '1')).toBe('ROSSI')
  })

  it('un ospite NON puo scrivere nella scheda di un altro', () => {
    const esistenti = [ospiteRiga('1', 'ROSSI'), ospiteRiga('2', 'VERDI')]
    const r = fondiOspiti(esistenti, [{ Progressivo: '1', Cognome: 'MANOMESSO' }], OSPITE2, 'SOG-1')
    expect(cognomeDi(r.righe, '1')).toBe('ROSSI')
    expect(r.rifiutati).toContain('Ospite 1')
  })

  it('aggiunge una scheda che non c era', () => {
    const r = fondiOspiti([ospiteRiga('1', 'ROSSI')], [{ Progressivo: '2', Cognome: 'NUOVO' }], INTESTATARIO, 'SOG-1')
    expect(r.righe).toHaveLength(2)
    expect(cognomeDi(r.righe, '2')).toBe('NUOVO')
  })

  it('non cancella il lavoro di chi sta compilando in contemporanea', () => {
    // Due ospiti da due telefoni: riscrivere il blocco intero significherebbe
    // che l ultimo dei due cancella quello che ha appena scritto il primo.
    const esistenti = [ospiteRiga('1', 'ROSSI'), ospiteRiga('2', 'VERDI')]
    const r = fondiOspiti(esistenti, [{ Progressivo: '2', Nome: 'ANNA' }], INTESTATARIO, 'SOG-1')
    expect(r.righe).toHaveLength(2)
    expect(cognomeDi(r.righe, '1')).toBe('ROSSI')
    expect(cognomeDi(r.righe, '2')).toBe('VERDI')
  })

  it('non sposta un ospite su un altra prenotazione', () => {
    const r = fondiOspiti([ospiteRiga('1', 'ROSSI')], [
      { Progressivo: '1', 'ID Soggiorno': 'SOG-ALTRUI' },
    ], GESTORE, 'SOG-1')
    expect(aMappa(COL_OSPITI, r.righe[0])['ID Soggiorno']).toBe('SOG-1')
  })

  it('tiene le schede in ordine di progressivo', () => {
    const r = fondiOspiti([], [
      { Progressivo: '3', Cognome: 'C' }, { Progressivo: '1', Cognome: 'A' },
    ], GESTORE, 'SOG-1')
    expect(r.righe.map((x) => aMappa(COL_OSPITI, x)['Progressivo'])).toEqual(['1', '3'])
  })

  it('scarta una scheda senza progressivo invece di inventarne uno', () => {
    const r = fondiOspiti([], [{ Cognome: 'SENZA' }], GESTORE, 'SOG-1')
    expect(r.righe).toHaveLength(0)
  })
})

describe('cosa l ospite non deve nemmeno vedere', () => {
  it("l'importo sparisce dalla risposta, non solo dalla pagina", () => {
    // Nasconderlo nell'interfaccia lo lascerebbe leggibile dagli strumenti del
    // browser: e lo stesso errore del blocco in scrittura, ma in lettura.
    const m = aMappa(COL_SOGGIORNI, soggiornoEsistente())
    const visto = oscuraRiservati(m, INTESTATARIO)
    expect('Importo lordo €' in visto).toBe(false)
  })

  it('sparisce anche per un ospite qualsiasi', () => {
    const m = aMappa(COL_SOGGIORNI, soggiornoEsistente())
    expect('Importo lordo €' in oscuraRiservati(m, OSPITE2)).toBe(false)
  })

  it('il gestore invece lo vede: gli serve', () => {
    const m = aMappa(COL_SOGGIORNI, soggiornoEsistente())
    expect(oscuraRiservati(m, GESTORE)['Importo lordo €']).toBe('800')
  })

  it('le date del soggiorno restano visibili a tutti', () => {
    // Servono all ospite per riconoscere la propria prenotazione.
    const visto = oscuraRiservati(aMappa(COL_SOGGIORNI, soggiornoEsistente()), INTESTATARIO)
    expect(visto['Check-in']).toBe('2026-08-10')
    expect(visto['Check-out']).toBe('2026-08-14')
    expect(visto['Unità']).toBe('Unità 1')
  })

  it('non modifica la mappa che ha ricevuto', () => {
    // Se la modificasse, il valore sparirebbe anche per chi lo deve salvare.
    const m = aMappa(COL_SOGGIORNI, soggiornoEsistente())
    oscuraRiservati(m, OSPITE2)
    expect(m['Importo lordo €']).toBe('800')
  })
})
