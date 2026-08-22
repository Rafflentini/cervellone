/**
 * L'azienda di Fatture in Cloud non deve piu essere "la prima della lista".
 *
 * Prima: `getCompanyId()` senza parametri leggeva `FIC_COMPANY_ID`, e se mancava
 * chiedeva l'elenco delle aziende dell'account prendendo `companies[0]`. Con due
 * societa quella scelta la faceva l'ordine di risposta dell'API, cioe nessuno.
 * E il token era uno solo, letto direttamente da `process.env`.
 *
 * Le due societa hanno account FIC separati, quindi anche il token deve venire
 * dalla societa richiesta.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getCompanyId, getFicToken } from './fatture-in-cloud'

const AMBIENTE_ORIGINALE = { ...process.env }

/** Risposta finta di /user/companies. */
function rispostaAziende(companies: Array<{ id: number; name: string }>) {
  return {
    status: 200,
    ok: true,
    json: async () => ({ data: { companies } }),
    text: async () => '',
  } as unknown as Response
}

const fetchFinto = vi.fn()

describe('azienda e token per societa', () => {
  beforeEach(() => {
    fetchFinto.mockReset()
    vi.stubGlobal('fetch', fetchFinto)
    process.env.FIC_COMPANY_ID = '111'
    process.env.FIC_COMPANY_ID_LAREALESTATE = '222'
    process.env.FIC_ACCESS_TOKEN = 'token-restruktura'
    process.env.FIC_ACCESS_TOKEN_LAREALESTATE = 'token-larealestate'
  })

  afterEach(() => {
    process.env = { ...AMBIENTE_ORIGINALE }
    vi.unstubAllGlobals()
  })

  it('legge l id azienda della societa richiesta', async () => {
    expect(await getCompanyId('restruktura')).toEqual({ ok: true, id: '111' })
    expect(await getCompanyId('larealestate')).toEqual({ ok: true, id: '222' })
  })

  it('usa il token della societa richiesta, non un token unico', () => {
    expect(getFicToken('restruktura')).toBe('token-restruktura')
    expect(getFicToken('larealestate')).toBe('token-larealestate')
  })

  // Il cuore del task: senza configurazione si FALLISCE dicendolo, non si
  // ripiega sull'azienda di un'altra societa.
  it('senza variabile e senza aziende sull account, fallisce dicendolo', async () => {
    delete process.env.FIC_COMPANY_ID_LAREALESTATE
    fetchFinto.mockResolvedValue(rispostaAziende([]))

    const r = await getCompanyId('larealestate')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('LA REAL ESTATE')
  })

  // Il ripiego esiste ancora, ma solo nella forma che non puo sbagliare:
  // una sola azienda sull'account = nessuna scelta da fare.
  it('senza variabile, con UNA sola azienda sull account, la usa', async () => {
    delete process.env.FIC_COMPANY_ID
    fetchFinto.mockResolvedValue(rispostaAziende([{ id: 710408, name: 'RESTRUKTURA' }]))

    expect(await getCompanyId('restruktura')).toEqual({ ok: true, id: '710408' })
  })

  // Questo e il caso che il ramo esiste per impedire: con due aziende la scelta
  // NON puo essere fatta dall'ordine della lista.
  it('con DUE aziende rifiuta invece di prendere la prima', async () => {
    delete process.env.FIC_COMPANY_ID
    fetchFinto.mockResolvedValue(rispostaAziende([
      { id: 111, name: 'RESTRUKTURA' },
      { id: 222, name: 'ALTRA' },
    ]))

    const r = await getCompanyId('restruktura')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('2 aziende')
      expect(r.error).toContain('FIC_COMPANY_ID')
    }
  })

  it('la variabile, quando c e, vince sull elenco', async () => {
    fetchFinto.mockResolvedValue(rispostaAziende([{ id: 999, name: 'SBAGLIATA' }]))
    expect(await getCompanyId('restruktura')).toEqual({ ok: true, id: '111' })
    expect(fetchFinto).not.toHaveBeenCalled()
  })

  it('le due societa non si contaminano: cambiare una non tocca l altra', async () => {
    delete process.env.FIC_COMPANY_ID
    expect((await getCompanyId('restruktura')).ok).toBe(false)
    expect(await getCompanyId('larealestate')).toEqual({ ok: true, id: '222' })
  })

  it('token assente ritorna null, senza ripiegare sull altro', () => {
    delete process.env.FIC_ACCESS_TOKEN_LAREALESTATE
    expect(getFicToken('larealestate')).toBeNull()
    expect(getFicToken('restruktura')).toBe('token-restruktura')
  })
})
