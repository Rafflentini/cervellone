import { describe, it, expect, vi, beforeEach } from 'vitest'

const insert = vi.fn()
vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      insert: (row: unknown) => { insert(row); return { select: () => ({ single: () => Promise.resolve({ data: { id: 'doc-1' }, error: null }) }) } },
      update: (row: unknown) => ({ eq: () => { insert(row); return Promise.resolve({ error: null }) } }),
    }),
  }),
}))
const societaPerDocumento = vi.fn()
vi.mock('./societa-documenti', () => ({ societaPerDocumento: (...a: unknown[]) => societaPerDocumento(...a) }))

import { salvaDocumento, aggiornaContenutoDocumento } from './salva-documento'

const RESTRUKTURA = { denominazione: 'RESTRUKTURA S.r.l.', piva: '02087420762' }
const LAREALESTATE = { denominazione: 'LA REAL ESTATE SRLS', piva: '02232730768' }

beforeEach(() => { insert.mockClear(); societaPerDocumento.mockReset() })

describe('salvaDocumento — la guardia sta dentro, non nei chiamanti', () => {
  it('CONTROLLO POSITIVO: La Real Estate attiva, contenuto con la P.IVA di Restruktura → NON scrive', async () => {
    societaPerDocumento.mockResolvedValue({ ok: true, societa: LAREALESTATE, esplicita: true })
    const r = await salvaDocumento({
      nome: 'Preventivo', tipo: 'html', conversationId: 'c1',
      contenuto: '<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p>',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('ha salvato un documento con la partita IVA sbagliata')
    expect(r.motivo).toBe('dati_societari')
    expect(r.messaggio).toContain('02087420762')
    expect(r.messaggio).toContain('02232730768')
    // la prova che conta: NESSUNA scrittura
    expect(insert).not.toHaveBeenCalled()
  })

  it('CONTROLLO NEGATIVO: societa\' coerente → scrive, e scrive il contenuto vero', async () => {
    societaPerDocumento.mockResolvedValue({ ok: true, societa: RESTRUKTURA, esplicita: true })
    const r = await salvaDocumento({
      nome: 'Preventivo', tipo: 'html', conversationId: 'c1',
      contenuto: '<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p><p>Committente P.IVA 01234567890</p>',
    })
    expect(r).toEqual({ ok: true, id: 'doc-1' })
    expect(insert).toHaveBeenCalledTimes(1)
    expect((insert.mock.calls[0][0] as Record<string, unknown>).content).toContain('02087420762')
  })

  it('societa\' non leggibile → NON scrive, e lo dice: non indovina Restruktura', async () => {
    societaPerDocumento.mockResolvedValue({ ok: false, errore: 'connessione persa' })
    const r = await salvaDocumento({ nome: 'x', tipo: 'html', conversationId: 'c1', contenuto: '<p>x</p>' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('atteso rifiuto')
    expect(r.motivo).toBe('societa_ignota')
    expect(r.messaggio).toContain('connessione persa')
    expect(insert).not.toHaveBeenCalled()
  })

  it('un documento senza nessuna partita IVA passa: non e\' un caso sospetto', async () => {
    societaPerDocumento.mockResolvedValue({ ok: true, societa: RESTRUKTURA, esplicita: true })
    const r = await salvaDocumento({ nome: 'x', tipo: 'html', conversationId: 'c1', contenuto: '<p>Relazione</p>' })
    expect(r.ok).toBe(true)
  })
})

/**
 * La modifica di una bozza esistente e' il modo in cui una partita IVA
 * sbagliata puo' ENTRARE in un documento gia' approvato: un preventivo
 * salvato pulito, poi "aggiorna_bozza" lo riscrive con l'intestazione
 * sbagliata. Stessa guardia di salvaDocumento, stessi tre casi.
 */
describe('aggiornaContenutoDocumento — la modifica di una bozza ha la stessa guardia dell\'insert', () => {
  it('CONTROLLO POSITIVO: La Real Estate attiva, nuovo contenuto con la P.IVA di Restruktura → NON aggiorna', async () => {
    societaPerDocumento.mockResolvedValue({ ok: true, societa: LAREALESTATE, esplicita: true })
    const r = await aggiornaContenutoDocumento(
      'doc-1',
      '<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p>',
      'c1',
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('ha aggiornato un documento con la partita IVA sbagliata')
    expect(r.motivo).toBe('dati_societari')
    expect(r.messaggio).toContain('02087420762')
    expect(r.messaggio).toContain('02232730768')
    // la prova che conta: NESSUN update eseguito
    expect(insert).not.toHaveBeenCalled()
  })

  it('CONTROLLO NEGATIVO: societa\' coerente → aggiorna per davvero', async () => {
    societaPerDocumento.mockResolvedValue({ ok: true, societa: RESTRUKTURA, esplicita: true })
    const r = await aggiornaContenutoDocumento(
      'doc-1',
      '<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p>',
      'c1',
    )
    expect(r).toEqual({ ok: true, id: 'doc-1' })
    expect(insert).toHaveBeenCalledTimes(1)
    expect((insert.mock.calls[0][0] as Record<string, unknown>).content).toContain('02087420762')
  })

  it('societa\' non leggibile → NON aggiorna, e non indovina Restruktura', async () => {
    societaPerDocumento.mockResolvedValue({ ok: false, errore: 'connessione persa' })
    const r = await aggiornaContenutoDocumento('doc-1', '<p>x</p>', 'c1')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('atteso rifiuto')
    expect(r.motivo).toBe('societa_ignota')
    expect(r.messaggio).toContain('connessione persa')
    expect(insert).not.toHaveBeenCalled()
  })
})
