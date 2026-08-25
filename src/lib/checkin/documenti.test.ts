/**
 * Le regole sui documenti d'identita'.
 *
 * Qui non si prova la rete: si provano le decisioni. Cosa si accetta, come si
 * chiama quello che si salva, e quando si e' certi di poterlo cancellare.
 */
import { describe, it, expect } from 'vitest'
import { tipoAmmesso, nomeFile, nomeCartellaPrenotazione, MAX_BYTE } from './documenti'
import { scadutiDaCancellare } from './conservazione'

describe('cosa si accetta', () => {
  it('le foto e i PDF, che sono quello che manda un telefono', () => {
    for (const m of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
      expect(tipoAmmesso(m), m).toBe(true)
    }
  })

  it('nient altro: un caricamento e un ingresso da cui passa un estraneo', () => {
    for (const m of ['text/html', 'application/javascript', 'image/svg+xml', '', 'application/zip']) {
      expect(tipoAmmesso(m), m).toBe(false)
    }
  })

  it('il tetto e sul file gia ridotto dal telefono', () => {
    // Una foto di documento a 1600px pesa qualche centinaio di kB: l'originale
    // da 12 megapixel non aggiunge leggibilita e supera il limite della
    // piattaforma.
    expect(MAX_BYTE).toBeLessThanOrEqual(4_000_000)
    expect(MAX_BYTE).toBeGreaterThan(1_000_000)
  })
})

describe('il nome del file', () => {
  it('dice di chi e e cosa e senza doverlo aprire', () => {
    expect(nomeFile('SOG-1', 2, 'fronte', 'image/jpeg')).toBe('SOG-1_ospite2_fronte.jpg')
    expect(nomeFile('SOG-1', 3, 'retro', 'application/pdf')).toBe('SOG-1_ospite3_retro.pdf')
  })
})

describe('quando le foto si cancellano', () => {
  const oggi = new Date('2026-09-20T03:00:00Z')

  it('dopo i giorni indicati dal check-out', () => {
    const scaduti = scadutiDaCancellare(
      [{ id: 'A', checkout: '2026-09-01', fileIds: ['f1', 'f2'] }],
      oggi, 7,
    )
    expect(scaduti.map((s) => s.id)).toEqual(['A'])
  })

  it('NON prima: durante il soggiorno servono ancora', () => {
    const scaduti = scadutiDaCancellare(
      [{ id: 'A', checkout: '2026-09-18', fileIds: ['f1'] }],
      oggi, 7,
    )
    expect(scaduti).toEqual([])
  })

  it('il giorno esatto della scadenza non e ancora scaduto', () => {
    // Il confronto e sul giorno, non sull ora: chi cancella gira di notte.
    const scaduti = scadutiDaCancellare(
      [{ id: 'A', checkout: '2026-09-13', fileIds: ['f1'] }],
      oggi, 7,
    )
    expect(scaduti).toEqual([])
  })

  it('salta le pratiche che non hanno foto: niente da cancellare', () => {
    const scaduti = scadutiDaCancellare(
      [{ id: 'A', checkout: '2026-01-01', fileIds: [] }],
      oggi, 7,
    )
    expect(scaduti).toEqual([])
  })

  it('salta quelle senza data di check-out invece di cancellarle', () => {
    // Senza data non si puo dire se sono scadute: nel dubbio non si distrugge
    // niente. Restera da guardare a mano, ed e il male minore.
    const scaduti = scadutiDaCancellare(
      [{ id: 'A', checkout: '', fileIds: ['f1'] }],
      oggi, 7,
    )
    expect(scaduti).toEqual([])
  })

  it('con zero giorni cancella subito dopo il check-out', () => {
    const scaduti = scadutiDaCancellare(
      [{ id: 'A', checkout: '2026-09-19', fileIds: ['f1'] }],
      oggi, 0,
    )
    expect(scaduti.map((s) => s.id)).toEqual(['A'])
  })

  it('con un numero di giorni assurdo non si blocca ne cancella tutto', () => {
    expect(scadutiDaCancellare([{ id: 'A', checkout: '2026-09-01', fileIds: ['f'] }], oggi, -5))
      .toHaveLength(1)
    expect(scadutiDaCancellare([{ id: 'A', checkout: '2026-09-01', fileIds: ['f'] }], oggi, 9999))
      .toHaveLength(0)
  })
})

describe('dove finiscono le foto su Drive', () => {
  it('data davanti, cosi dentro l appartamento sono in ordine', () => {
    expect(nomeCartellaPrenotazione({
      idSoggiorno: 'SOG-20260825-080248', checkin: '2026-09-20', codPrenotazione: 'BK-4471182',
    })).toBe('2026-09-20 · BK-4471182')
  })

  it('senza codice di prenotazione usa l ID, che c e sempre', () => {
    // Una prenotazione diretta puo non avere un codice del portale.
    expect(nomeCartellaPrenotazione({
      idSoggiorno: 'SOG-20260825-080248', checkin: '2026-09-20', codPrenotazione: '',
    })).toBe('2026-09-20 · SOG-20260825-080248')
  })

  it('senza data non lascia il nome monco', () => {
    expect(nomeCartellaPrenotazione({
      idSoggiorno: 'SOG-1', checkin: '', codPrenotazione: 'BK-9',
    })).toBe('BK-9')
  })

  it('toglie le barre, che su Drive spezzerebbero il percorso', () => {
    expect(nomeCartellaPrenotazione({
      idSoggiorno: 'SOG-1', checkin: '2026-09-20', codPrenotazione: 'BK/12\\34',
    })).toBe('2026-09-20 · BK 12 34')
  })

  it('un codice fatto di soli spazi vale come assente', () => {
    expect(nomeCartellaPrenotazione({
      idSoggiorno: 'SOG-1', checkin: '2026-09-20', codPrenotazione: '   ',
    })).toBe('2026-09-20 · SOG-1')
  })

  it('il nome del FILE porta comunque l ID per esteso', () => {
    // Cosi anche se due cartelle finissero per chiamarsi uguale, le foto
    // restano distinguibili una per una.
    expect(nomeFile('SOG-20260825-080248', 1, 'fronte', 'image/jpeg'))
      .toContain('SOG-20260825-080248')
  })
})
