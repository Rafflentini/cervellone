import { describe, it, expect } from 'vitest'
import { giorniDaComunicare, type SoggiornoDaContare } from './giorni-da-comunicare'

const s = (p: Partial<SoggiornoDaContare>): SoggiornoDaContare => ({
  id: 'SOG-1', checkin: '2026-08-05', schede: 0, inviato: false, ...p,
})

describe('giorniDaComunicare', () => {
  it('CONTROLLO POSITIVO: una data valida NON comunicata esce nell elenco', () => {
    // Se questo test non passasse, tutti gli altri direbbero "nessun giorno"
    // per la ragione sbagliata — che e' esattamente com'e' andata in
    // produzione con la regex sbagliata.
    const r = giorniDaComunicare([s({ id: 'A', checkin: '2026-08-05' })])
    expect(r.giorni.map((g) => g.giorno)).toEqual(['2026-08-05'])
  })

  it('un giorno con prenotazioni e ZERO schede resta da fare', () => {
    // E' il caso di tutti gli arretrati: le persone hanno dormito li', ma
    // nessuno ha ancora compilato. Contando solo le righe ospite spariva.
    const r = giorniDaComunicare([s({ id: 'A', schede: 0 })])
    expect(r.giorni).toHaveLength(1)
    expect(r.giorni[0].senzaSchede).toBe(1)
    expect(r.giorni[0].schede).toBe(0)
  })

  it('un giorno gia comunicato per intero sparisce', () => {
    const r = giorniDaComunicare([
      s({ id: 'A', checkin: '2026-08-05', schede: 2, inviato: true }),
      s({ id: 'B', checkin: '2026-08-05', schede: 3, inviato: true }),
    ])
    expect(r.giorni).toEqual([])
  })

  it('basta UNA prenotazione non comunicata perche il giorno resti', () => {
    const r = giorniDaComunicare([
      s({ id: 'A', checkin: '2026-08-05', schede: 2, inviato: true }),
      s({ id: 'B', checkin: '2026-08-05', schede: 3, inviato: false }),
    ])
    expect(r.giorni).toHaveLength(1)
    expect(r.giorni[0]).toMatchObject({ totali: 2, inviate: 1, schede: 5 })
  })

  it('i giorni escono in ordine di data', () => {
    const r = giorniDaComunicare([
      s({ id: 'C', checkin: '2026-08-20' }),
      s({ id: 'A', checkin: '2026-08-01' }),
      s({ id: 'B', checkin: '2026-08-12' }),
    ])
    expect(r.giorni.map((g) => g.giorno)).toEqual(['2026-08-01', '2026-08-12', '2026-08-20'])
  })

  it('una data scritta a mano non sparisce in silenzio: viene dichiarata', () => {
    // Una cella ritoccata su Google Sheets diventa '15/08/2026'. Non si puo'
    // interrogare la rotta con quella forma, ma nemmeno far finta che quella
    // prenotazione non esista.
    const r = giorniDaComunicare([
      s({ id: 'A', checkin: '15/08/2026' }),
      s({ id: 'B', checkin: '2026-08-05' }),
    ])
    expect(r.giorni.map((g) => g.giorno)).toEqual(['2026-08-05'])
    expect(r.dateNonValide).toEqual([{ id: 'A', checkin: '15/08/2026' }])
  })

  it('una riga senza identificativo non conta come giorno', () => {
    const r = giorniDaComunicare([s({ id: '', checkin: '2026-08-05' })])
    expect(r.giorni).toEqual([])
    expect(r.dateNonValide).toEqual([])
  })
})
