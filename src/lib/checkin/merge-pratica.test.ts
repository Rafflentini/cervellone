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
  fondiSoggiorno, fondiOspiti, aMappa, aRiga, oscuraRiservati, CAMPI_OSPITE_DI_SISTEMA, type Livello,
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

describe('cosa vede chi, quando riceve il link', () => {
  const soggiorno = {
    'Unità': 'Bloom Zone 1', 'Check-in': '2026-07-10', 'Check-out': '2026-07-17',
    'Notti': '7', 'N. ospiti': '4',
    'Importo lordo €': '1400,00',
    'Imposta soggiorno €': '50,00',
    'Intestatario fattura': 'Mario Rossi', 'Codice fiscale': 'RSSMRA80A01H501U',
    'P.IVA': '01234567890', 'Codice SDI / PEC': 'ABC1234',
    'Indirizzo': 'Via Roma 1', 'CAP': '00100', 'Città': 'ROMA', 'Provincia': 'RM',
    'Nazione': 'IT', 'Email': 'mario@example.com', 'Telefono': '3331234567',
    'Note': 'arriva tardi',
  }

  it('CONTROLLO POSITIVO: il singolo ospite NON riceve i dati di chi ha prenotato', () => {
    // Il terzo ospite e spesso uno sconosciuto a cui il link arriva su WhatsApp.
    // Prima riceveva codice fiscale, indirizzo, email e telefono
    // dell'intestatario: la pagina non li disegnava, ma erano nella risposta.
    const visto = oscuraRiservati(soggiorno, { tipo: 'ospite', progressivo: 3 })

    for (const campo of ['Intestatario fattura', 'Codice fiscale', 'P.IVA', 'Codice SDI / PEC',
      'Indirizzo', 'CAP', 'Città', 'Provincia', 'Nazione', 'Email', 'Telefono', 'Note']) {
      expect(visto[campo], `l'ospite non deve vedere "${campo}"`).toBeUndefined()
    }
  })

  it("CONTROLLO POSITIVO: ma l'IMPOSTA la vede, cosi arriva preparato a pagarla", () => {
    // Richiesta esplicita di Raffaele: l'ospite paga l'imposta in struttura,
    // quindi deve sapere quanto sara per preparare contanti o carta.
    const visto = oscuraRiservati(soggiorno, { tipo: 'ospite', progressivo: 3 })

    expect(visto['Imposta soggiorno €']).toBe('50,00')
    expect(visto['Unità']).toBe('Bloom Zone 1')
    expect(visto['Check-in']).toBe('2026-07-10')
    expect(visto['Notti']).toBe('7')
  })

  it("il totale della prenotazione non lo vede NESSUN ospite", () => {
    expect(oscuraRiservati(soggiorno, { tipo: 'ospite', progressivo: 1 })['Importo lordo €']).toBeUndefined()
    expect(oscuraRiservati(soggiorno, { tipo: 'prenotazione' })['Importo lordo €']).toBeUndefined()
  })

  it('CONTROPROVA: chi ha prenotato vede i PROPRI dati di fatturazione, che e lui a compilare', () => {
    // Senza questa prova, "nascondi tutto a chiunque non sia gestore"
    // passerebbe i test qui sopra e romperebbe il modulo dell'intestatario.
    const visto = oscuraRiservati(soggiorno, { tipo: 'prenotazione' })

    expect(visto['Intestatario fattura']).toBe('Mario Rossi')
    expect(visto['Codice fiscale']).toBe('RSSMRA80A01H501U')
    expect(visto['Email']).toBe('mario@example.com')
  })

  it('il gestore vede tutto, importo compreso', () => {
    expect(oscuraRiservati(soggiorno, { tipo: 'gestore' })['Importo lordo €']).toBe('1400,00')
  })
})

describe('le schede ospite hanno la stessa disciplina della prenotazione', () => {
  const esistente = aRiga(COL_OSPITI, {
    'ID Soggiorno': 'SOG-1', 'Progressivo': '1', 'Cognome': 'ROSSI', 'Nome': 'MARIO',
    'Doc fronte': 'idDrive-fronte', 'Doc retro': 'idDrive-retro',
  })

  it('CONTROLLO POSITIVO: chi compila non puo svuotare la cella della propria foto', () => {
    // Il form e PUBBLICO. Bastava una richiesta con "Doc fronte": "" per
    // svuotare la cella lasciando il file su Drive — e il lavoro notturno
    // cancella solo cio che trova nelle celle: quel documento d'identita
    // sarebbe rimasto li per sempre, invisibile. (Due audit, 6 set 2026.)
    const esito = fondiOspiti([esistente], [{ 'Progressivo': '1', 'Doc fronte': '', 'Doc retro': '' }],
      { tipo: 'ospite', progressivo: 1 }, 'SOG-1')

    const m = aMappa(COL_OSPITI, esito.righe[0])
    expect(m['Doc fronte']).toBe('idDrive-fronte')
    expect(m['Doc retro']).toBe('idDrive-retro')
    expect(esito.rifiutati.join(' ')).toContain('Doc fronte')
  })

  it('non puo nemmeno spostare la propria scheda su un altra prenotazione', () => {
    const esito = fondiOspiti([esistente], [{ 'Progressivo': '1', 'ID Soggiorno': 'SOG-ALTRO' }],
      { tipo: 'ospite', progressivo: 1 }, 'SOG-1')

    expect(aMappa(COL_OSPITI, esito.righe[0])['ID Soggiorno']).toBe('SOG-1')
  })

  it('CONTROPROVA: i campi che DEVE compilare passano come prima', () => {
    // Senza questa prova, "blocca tutto" supererebbe i test qui sopra e il
    // check-in non si potrebbe piu fare.
    const esito = fondiOspiti([esistente], [{
      'Progressivo': '1', 'Cognome': 'BIANCHI', 'Nome': 'LUCA',
      'Data nascita': '1990-02-03', 'Numero documento': 'XY9999999',
    }], { tipo: 'ospite', progressivo: 1 }, 'SOG-1')

    const m = aMappa(COL_OSPITI, esito.righe[0])
    expect(m['Cognome']).toBe('BIANCHI')
    expect(m['Nome']).toBe('LUCA')
    expect(m['Data nascita']).toBe('1990-02-03')
    expect(m['Numero documento']).toBe('XY9999999')
    // E le foto restano quelle di prima: non le ha toccate nessuno.
    expect(m['Doc fronte']).toBe('idDrive-fronte')
  })
})

describe('togliere un ospite: si dichiara, non si deduce', () => {
  /**
   * Il difetto piu' grave trovato negli audit del 6 settembre 2026.
   * "rimuovi" non cancellava: RINUMERAVA. Tre schede A, B, C; tolta la B, il
   * browser rimandava "1=A, 2=C" e la riga 3 restava dov'era. Sul foglio
   * finivano A, C, C — un ospite duplicato e uno sparito — e siccome le foto
   * del documento non viaggiano col modulo, la riga fusa teneva IL NOME DI UNO
   * E I DOCUMENTI DI UN ALTRO. E andava cosi alla Questura.
   */
  const A = aRiga(COL_OSPITI, { 'ID Soggiorno': 'S1', 'Progressivo': '1', 'Cognome': 'ALFA', 'Doc fronte': 'foto-A' })
  const B = aRiga(COL_OSPITI, { 'ID Soggiorno': 'S1', 'Progressivo': '2', 'Cognome': 'BETA', 'Doc fronte': 'foto-B' })
  const C = aRiga(COL_OSPITI, { 'ID Soggiorno': 'S1', 'Progressivo': '3', 'Cognome': 'GAMMA', 'Doc fronte': 'foto-C' })

  function cognomi(righe: string[][]) {
    return righe.map((r) => aMappa(COL_OSPITI, r)['Cognome'])
  }

  it('CONTROLLO POSITIVO: tolto l ospite 2, restano DUE schede e sono quelle giuste', () => {
    const esito = fondiOspiti([A, B, C], [
      { 'Progressivo': '1', 'Cognome': 'ALFA' },
      { 'Progressivo': '3', 'Cognome': 'GAMMA' },
    ], { tipo: 'prenotazione' }, 'S1', { elencoCompleto: true })

    expect(cognomi(esito.righe)).toEqual(['ALFA', 'GAMMA'])
    expect(esito.tolti).toEqual(['2'])
  })

  it('e ogni scheda tiene le PROPRIE foto: nessuno eredita i documenti di un altro', () => {
    const esito = fondiOspiti([A, B, C], [
      { 'Progressivo': '1', 'Cognome': 'ALFA' },
      { 'Progressivo': '3', 'Cognome': 'GAMMA' },
    ], { tipo: 'prenotazione' }, 'S1', { elencoCompleto: true })

    const foto = esito.righe.map((r) => aMappa(COL_OSPITI, r)['Doc fronte'])
    expect(foto).toEqual(['foto-A', 'foto-C'])
  })

  it('SENZA la dichiarazione esplicita non si cancella niente', () => {
    // Il gestore che cambia solo il numero di ospiti attesi manda `ospiti: []`.
    // Interpretarlo come "cancella tutti" sarebbe un disastro peggiore del
    // difetto che stiamo curando.
    const esito = fondiOspiti([A, B, C], [], { tipo: 'gestore' }, 'S1')

    expect(cognomi(esito.righe)).toEqual(['ALFA', 'BETA', 'GAMMA'])
    expect(esito.tolti).toEqual([])
  })

  it('un elenco VUOTO non cancella nemmeno quando e dichiarato completo', () => {
    // Cancellare tutte le schede non e un gesto che si compie per sbaglio, e
    // quindi non deve poter accadere per sbaglio.
    const esito = fondiOspiti([A, B, C], [], { tipo: 'gestore' }, 'S1', { elencoCompleto: true })

    expect(cognomi(esito.righe)).toEqual(['ALFA', 'BETA', 'GAMMA'])
  })

  it('CONTROLLO POSITIVO: un singolo OSPITE non puo cancellare le schede degli altri', () => {
    // Stessa regola per cui non puo nemmeno leggerle.
    const esito = fondiOspiti([A, B, C], [
      { 'Progressivo': '2', 'Cognome': 'BETA' },
    ], { tipo: 'ospite', progressivo: 2 }, 'S1', { elencoCompleto: true })

    expect(cognomi(esito.righe)).toEqual(['ALFA', 'BETA', 'GAMMA'])
    expect(esito.tolti).toEqual([])
  })

  it('aggiungere un ospite continua a funzionare come prima', () => {
    const esito = fondiOspiti([A, B], [
      { 'Progressivo': '1', 'Cognome': 'ALFA' },
      { 'Progressivo': '2', 'Cognome': 'BETA' },
      { 'Progressivo': '3', 'Cognome': 'DELTA' },
    ], { tipo: 'prenotazione' }, 'S1', { elencoCompleto: true })

    expect(cognomi(esito.righe)).toEqual(['ALFA', 'BETA', 'DELTA'])
    expect(esito.tolti).toEqual([])
  })
})
