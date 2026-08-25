/**
 * Le segnature sulla riga di un soggiorno: stato della fattura e file Questura.
 *
 * Sono i campi che dicono "questo adempimento e' fatto". Sbagliarli non produce
 * un errore: produce una riga che dichiara compiuto qualcosa che nessuno ha
 * compiuto — e non c'e' niente, a valle, che possa accorgersene.
 */
import { describe, it, expect } from 'vitest'
import { conStatoFattura, idNelFile } from './segnature'
import { statoFatturaDi } from './archivio'

describe('lo stato della fattura si scrive in due celle insieme', () => {
  it('EMESSA porta anche il vecchio SI/NO a SI', () => {
    const r = conStatoFattura({ 'Stato fattura': 'DA FARE', 'Fattura emessa': 'NO' }, 'EMESSA')
    expect(r['Stato fattura']).toBe('EMESSA')
    expect(r['Fattura emessa']).toBe('SI')
  })

  it('COMPILATA NON e emessa: il vecchio campo resta NO', () => {
    /*
      Il punto di tutta la distinzione. COMPILATA vuol dire che Cervellone ha
      preparato la fattura su Fatture in Cloud; inviata non lo e'. Se questa
      portasse `Fattura emessa` a SI, la prenotazione diventerebbe
      incancellabile e risulterebbe fatturata al commercialista — per un
      documento che non e' mai partito.
    */
    const r = conStatoFattura({ 'Fattura emessa': 'NO' }, 'COMPILATA')
    expect(r['Stato fattura']).toBe('COMPILATA')
    expect(r['Fattura emessa']).toBe('NO')
  })

  it('tornando indietro a DA FARE riporta anche il SI/NO a NO', () => {
    // Una fattura annullata con nota di credito torna da fare. Se il vecchio
    // campo restasse a SI, le due celle direbbero due cose diverse — ed e'
    // esattamente cosi' che nasce un dato che nessuno sa piu' spiegare.
    const r = conStatoFattura({ 'Stato fattura': 'EMESSA', 'Fattura emessa': 'SI' }, 'DA FARE')
    expect(r['Stato fattura']).toBe('DA FARE')
    expect(r['Fattura emessa']).toBe('NO')
  })

  it('non tocca nient altro della riga', () => {
    const prima = { 'ID Soggiorno': 'SOG-1', 'N. fattura': '12', 'Fattura emessa': 'NO' }
    const dopo = conStatoFattura(prima, 'EMESSA')
    expect(dopo['ID Soggiorno']).toBe('SOG-1')
    expect(dopo['N. fattura']).toBe('12')
  })

  it('non modifica la riga che riceve, ne restituisce una nuova', () => {
    // Modificarla sul posto vorrebbe dire che chi l ha letta si ritrova il
    // dato cambiato sotto le mani senza averlo chiesto.
    const prima = { 'Fattura emessa': 'NO' }
    conStatoFattura(prima, 'EMESSA')
    expect(prima['Fattura emessa']).toBe('NO')
  })

  it('quello che scrive si rilegge uguale', () => {
    // La prova che conta: scrittura e lettura sono due funzioni diverse, in due
    // file diversi. Se divergessero, la riga direbbe una cosa e il programma ne
    // capirebbe un altra.
    for (const stato of ['DA FARE', 'COMPILATA', 'EMESSA'] as const) {
      expect(statoFatturaDi(conStatoFattura({}, stato))).toBe(stato)
    }
  })
})

describe('quali prenotazioni finiscono nel file scaricato', () => {
  const idPerOspite = ['SOG-1', 'SOG-1', 'SOG-2', 'SOG-3']
  const strutture = ['CIN-A', 'CIN-A', 'CIN-A', 'CIN-B']

  it('senza filtro sono tutte quelle nel file', () => {
    expect(idNelFile(idPerOspite, strutture, '')).toEqual(['SOG-1', 'SOG-2', 'SOG-3'])
  })

  it('scaricando una sola struttura si segnano SOLO le sue', () => {
    /*
      Il caso che rovinerebbe l'adempimento: tre CIN, tre file da caricare. Se
      scaricando il file del primo si segnassero anche gli altri due, quelle
      prenotazioni risulterebbero a posto senza che nessuno abbia generato
      niente — e il ritardo di 24 ore lo si scoprirebbe dopo.
    */
    expect(idNelFile(idPerOspite, strutture, 'CIN-B')).toEqual(['SOG-3'])
  })

  it('non ripete due volte la stessa prenotazione', () => {
    // Due ospiti della stessa prenotazione sono due righe nel file, ma una
    // riga sola da segnare.
    expect(idNelFile(idPerOspite, strutture, 'CIN-A')).toEqual(['SOG-1', 'SOG-2'])
  })

  it('una struttura che non c e non segna niente', () => {
    expect(idNelFile(idPerOspite, strutture, 'CIN-Z')).toEqual([])
  })

  it('salta gli identificativi vuoti', () => {
    expect(idNelFile(['SOG-1', '', 'SOG-2'], ['A', 'A', 'A'], '')).toEqual(['SOG-1', 'SOG-2'])
  })
})
