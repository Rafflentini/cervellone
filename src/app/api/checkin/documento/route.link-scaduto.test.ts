/**
 * Un collegamento scaduto non apriva piu' la pratica, ma caricava ancora le
 * foto dei documenti d'identita' su Drive.
 *
 * Stesso difetto della POST su `pratica`, e qui pesa di piu': si tratta di
 * documenti d'identita' di persone vere, che finiscono su un Drive condiviso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockAccesso = vi.fn()
vi.mock('@/lib/checkin/accesso', () => ({ risolviAccesso: (...a: unknown[]) => mockAccesso(...a) }))
vi.mock('@/lib/rate-limiter', () => ({ rateLimit: () => true }))

const mockLeggi = vi.fn()
vi.mock('@/lib/checkin/pratica', () => ({ leggiPratica: (...a: unknown[]) => mockLeggi(...a) }))

const mockCarica = vi.fn()
const mockElimina = vi.fn()
vi.mock('@/lib/checkin/documenti', () => ({
  salvaDocumento: (...a: unknown[]) => mockCarica(...a),
  eliminaDocumento: (...a: unknown[]) => mockElimina(...a),
  tipoAmmesso: () => true,
  MAX_BYTE: 10_000_000,
}))
const mockAggiorna = vi.fn()
vi.mock('@/lib/checkin/foglio-google', () => ({ aggiornaRiga: (...a: unknown[]) => mockAggiorna(...a) }))
vi.mock('@/lib/checkin/merge-pratica', () => ({ aRiga: () => ({}), CAMPI_DELLA_PRENOTAZIONE: [], oscuraRiservati: (x: unknown) => x }))

import { POST } from './route'

function richiesta(): never {
  return {
    nextUrl: { searchParams: new URLSearchParams('p=PREN-1&t=token&prog=1&lato=fronte') },
    headers: new Headers({ 'content-type': 'image/jpeg', 'x-forwarded-for': '1.2.3.4' }),
    arrayBuffer: async () => new ArrayBuffer(64),
  } as never
}

const SCHEDA = [{ dati: { Progressivo: '1' } }]
const VECCHIA = { soggiorno: { 'Check-out': '2026-03-01' }, ospiti: SCHEDA }
const RECENTE = { soggiorno: { 'Check-out': '2099-01-01' }, ospiti: SCHEDA }

beforeEach(() => {
  vi.clearAllMocks()
  mockCarica.mockResolvedValue({ fileId: 'file-1' })
  mockAggiorna.mockResolvedValue({ ok: true })
  mockElimina.mockResolvedValue(true)
  mockAccesso.mockReturnValue({ ok: true, id: 'PREN-1', livello: { tipo: 'ospite', progressivo: 1 } })
})

describe('POST documento — un collegamento scaduto non carica piu foto', () => {
  it('con il check-out di mesi fa il caricamento viene RIFIUTATO', async () => {
    mockLeggi.mockResolvedValue(VECCHIA)

    const res = await POST(richiesta())

    expect(res.status).toBe(410)
    expect(mockCarica).not.toHaveBeenCalled()
  })

  // CONTROLLO POSITIVO: senza, una rotta che rifiuta sempre passerebbe
  // il test qui sopra a mani basse.
  it('durante il soggiorno la foto si carica', async () => {
    mockLeggi.mockResolvedValue(RECENTE)

    const res = await POST(richiesta())

    expect(res.status).not.toBe(410)
    expect(mockCarica).toHaveBeenCalled()
  })
})

/**
 * Se cade la rete FRA la creazione del file su Drive e la scrittura della
 * cella, il file resta su Drive e non lo nomina piu' nessuno. La pulizia
 * notturna cancella solo cio' che trova NELLE CELLE: un documento d'identita'
 * di una persona vera resta li' per sempre, e nessuno sa che c'e'.
 *
 * Non e' un caso di laboratorio: e' un ospite che carica la foto della carta
 * d'identita' dal telefono, in un appartamento a Maratea, con la linea che va
 * e viene.
 */
describe('POST documento — nessuna foto orfana su Drive', () => {
  it('se la cella non si scrive, il file appena caricato viene TOLTO', async () => {
    mockLeggi.mockResolvedValue(RECENTE)
    mockAggiorna.mockRejectedValue(new Error('Google Sheets non raggiungibile'))

    const res = await POST(richiesta())

    expect(res.status).toBe(500)
    expect(mockElimina).toHaveBeenCalledWith('file-1')
  })

  // CONTROLLO POSITIVO: senza, una rotta che cancella SEMPRE passerebbe
  // il test qui sopra e butterebbe via ogni documento caricato.
  it('quando la cella si scrive, il file resta dov e', async () => {
    mockLeggi.mockResolvedValue(RECENTE)

    const res = await POST(richiesta())

    expect(res.status).not.toBe(500)
    expect(mockElimina).not.toHaveBeenCalled()
  })

  // Se anche la cancellazione fallisce non si puo' fare altro che DIRLO, con
  // l'id: e' l'unico modo per ritrovarlo a mano.
  it('se nemmeno la cancellazione riesce, l id finisce nei log', async () => {
    mockLeggi.mockResolvedValue(RECENTE)
    mockAggiorna.mockRejectedValue(new Error('Sheets giu'))
    mockElimina.mockRejectedValue(new Error('Drive giu'))
    const errori: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a) => { errori.push(a.join(' ')) })

    await POST(richiesta())

    expect(errori.join(' ')).toContain('file-1')
  })
})
