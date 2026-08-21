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
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getCompanyId, getFicToken } from './fatture-in-cloud'

const AMBIENTE_ORIGINALE = { ...process.env }

describe('azienda e token per societa', () => {
  beforeEach(() => {
    process.env.FIC_COMPANY_ID = '111'
    process.env.FIC_COMPANY_ID_LAREALESTATE = '222'
    process.env.FIC_ACCESS_TOKEN = 'token-restruktura'
    process.env.FIC_ACCESS_TOKEN_LAREALESTATE = 'token-larealestate'
  })

  afterEach(() => {
    process.env = { ...AMBIENTE_ORIGINALE }
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
  it('se la variabile manca fallisce e nomina la variabile mancante', async () => {
    delete process.env.FIC_COMPANY_ID_LAREALESTATE
    const r = await getCompanyId('larealestate')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('FIC_COMPANY_ID_LAREALESTATE')
  })

  it('non esiste piu un ripiego che interroga l elenco delle aziende', async () => {
    delete process.env.FIC_COMPANY_ID
    // Se ci fosse ancora il ripiego su /user/companies, questa chiamata
    // proverebbe a raggiungere la rete. Deve invece fallire subito.
    const r = await getCompanyId('restruktura')
    expect(r.ok).toBe(false)
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
