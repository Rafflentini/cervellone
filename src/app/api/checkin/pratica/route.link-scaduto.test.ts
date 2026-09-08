/**
 * Un collegamento scaduto non leggeva piu', ma SCRIVEVA ancora.
 *
 * `linkScaduto` era controllato solo nella `GET`. Sulla `POST` no: il link
 * dimenticato in una chat di WhatsApp mesi prima non apriva piu' la pratica —
 * dava 410 — ma se qualcuno mandava direttamente i dati, quelli entravano.
 * Stessa cosa per il caricamento dei documenti d'identita'.
 *
 * Il commento della funzione lo dice chiaro: non e' una difesa forte, e'
 * riduzione di superficie. Ma una riduzione di superficie applicata alla sola
 * lettura non riduce niente: cio' che conta e' proprio la scrittura.
 *
 * Il gestore resta fuori dalla regola: a lui puo' servire riaprire una pratica.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockLeggi = vi.fn()
const mockSalva = vi.fn()
vi.mock('@/lib/checkin/pratica', () => ({
  leggiPratica: (...a: unknown[]) => mockLeggi(...a),
  salvaPratica: (...a: unknown[]) => mockSalva(...a),
  eliminaPratica: async () => ({ ok: true }),
}))
vi.mock('@/lib/rate-limiter', () => ({ rateLimit: () => true }))

const mockAccesso = vi.fn()
vi.mock('@/lib/checkin/accesso', () => ({ risolviAccesso: (...a: unknown[]) => mockAccesso(...a) }))

import { POST } from './route'

function richiesta(corpo: Record<string, unknown> = {}) {
  return {
    nextUrl: { searchParams: new URLSearchParams('p=PREN-1&t=token') },
    headers: new Headers(),
    json: async () => corpo,
  } as never
}

/** Check-out di sei mesi fa: il link e' scaduto da un pezzo. */
const VECCHIA = { soggiorno: { 'Check-out': '2026-03-01' }, ospiti: [] }
const RECENTE = { soggiorno: { 'Check-out': '2099-01-01' }, ospiti: [] }

beforeEach(() => {
  vi.clearAllMocks()
  mockSalva.mockResolvedValue({ ok: true, ospiti: [] })
  mockAccesso.mockReturnValue({ ok: true, id: 'PREN-1', livello: { tipo: 'prenotazione' } })
})

describe('POST pratica — un collegamento scaduto non scrive piu', () => {
  it('con il check-out di mesi fa il salvataggio viene RIFIUTATO', async () => {
    mockLeggi.mockResolvedValue(VECCHIA)

    const res = await POST(richiesta({ soggiorno: { Note: 'entro lo stesso' } }))

    expect(res.status).toBe(410)
    expect(mockSalva).not.toHaveBeenCalled()
  })

  it('il GESTORE puo ancora riaprire una pratica vecchia', async () => {
    mockLeggi.mockResolvedValue(VECCHIA)
    mockAccesso.mockReturnValue({ ok: true, id: 'PREN-1', livello: { tipo: 'gestore' } })

    const res = await POST(richiesta({ soggiorno: { Note: 'correzione' } }))

    expect(res.status).not.toBe(410)
    expect(mockSalva).toHaveBeenCalled()
  })

  // CONTROLLO POSITIVO: senza, una POST che rifiuta sempre passerebbe
  // il primo test a mani basse.
  it('un soggiorno in corso si salva normalmente', async () => {
    mockLeggi.mockResolvedValue(RECENTE)

    const res = await POST(richiesta({ soggiorno: { Note: 'ok' } }))

    expect(res.status).not.toBe(410)
    expect(mockSalva).toHaveBeenCalled()
  })

  // Senza data di check-out non si puo' dire: non si blocca. E' la stessa
  // scelta gia' fatta dentro `linkScaduto`, e va tenuta ferma.
  it('senza data di check-out non si blocca', async () => {
    mockLeggi.mockResolvedValue({ soggiorno: {}, ospiti: [] })

    const res = await POST(richiesta({ soggiorno: { Note: 'ok' } }))

    expect(res.status).not.toBe(410)
    expect(mockSalva).toHaveBeenCalled()
  })
})
