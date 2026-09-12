/**
 * Le due società non si contaminano nemmeno quando si SCRIVE un pagamento.
 *
 * Stesso schema di `fatture-in-cloud.societa.test.ts`: le due società hanno
 * account Fatture in Cloud separati, quindi token e azienda distinti. Qui il
 * rischio è peggiore che in lettura — una scrittura finita sull'account
 * sbagliato segna pagata la fattura di un'altra partita IVA.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { segnaPagataFatturaRicevuta, elencoContiPagamentoFic, type ContoPagamentoFic } from './fic-pagamenti'

const AMBIENTE_ORIGINALE = { ...process.env }
const fetchFinto = vi.fn()

const CONTANTI: ContoPagamentoFic = { id: 222, nome: 'Contanti' }

function risposta(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function fattura(): Record<string, unknown> {
  return {
    id: 12,
    type: 'expense',
    entity: { id: 5, name: 'EDIL LIMONGI SRL' },
    invoice_number: '123',
    date: '2026-03-04',
    amount_net: 100,
    amount_vat: 22,
    amount_gross: 122,
    payments_list: [{ id: 777, amount: 122, due_date: '2026-03-04', status: 'not_paid' }],
  }
}

function pagata(): Record<string, unknown> {
  return {
    ...fattura(),
    payments_list: [{
      id: 777,
      amount: 122,
      due_date: '2026-03-04',
      paid_date: '2026-03-04',
      status: 'paid',
      payment_account: { id: 222, name: 'Contanti' },
    }],
  }
}

function autorizzazione(chiamata: unknown[]): string {
  const init = chiamata[1] as RequestInit
  const headers = (init.headers ?? {}) as Record<string, string>
  return headers.Authorization
}

describe('pagamenti: ogni societa sul proprio account', () => {
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

  it('la scrittura per Restruktura usa azienda e token di Restruktura', async () => {
    fetchFinto
      .mockResolvedValueOnce(risposta({ data: fattura() }))
      .mockResolvedValueOnce(risposta({ data: pagata() }))
      .mockResolvedValueOnce(risposta({ data: pagata() }))

    const r = await segnaPagataFatturaRicevuta(12, CONTANTI, {}, 'restruktura')
    expect(r.ok).toBe(true)
    for (const chiamata of fetchFinto.mock.calls) {
      expect(String(chiamata[0])).toContain('/c/111/')
      expect(String(chiamata[0])).not.toContain('/c/222/')
      expect(autorizzazione(chiamata)).toBe('Bearer token-restruktura')
    }
  })

  it('la scrittura per La Real Estate usa azienda e token de La Real Estate', async () => {
    fetchFinto
      .mockResolvedValueOnce(risposta({ data: fattura() }))
      .mockResolvedValueOnce(risposta({ data: pagata() }))
      .mockResolvedValueOnce(risposta({ data: pagata() }))

    const r = await segnaPagataFatturaRicevuta(12, CONTANTI, {}, 'larealestate')
    expect(r.ok).toBe(true)
    for (const chiamata of fetchFinto.mock.calls) {
      expect(String(chiamata[0])).toContain('/c/222/')
      expect(autorizzazione(chiamata)).toBe('Bearer token-larealestate')
    }
  })

  // Il token assente NON deve far ripiegare sull'altro account: il PUT
  // andrebbe a segnare pagata la fattura dell'altra partita IVA.
  it('senza il token della societa richiesta non scrive, e nomina quella societa', async () => {
    delete process.env.FIC_ACCESS_TOKEN_LAREALESTATE
    const r = await segnaPagataFatturaRicevuta(12, CONTANTI, {}, 'larealestate')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toContain('FIC_ACCESS_TOKEN_LAREALESTATE')
    expect(r.motivo).toContain('LA REAL ESTATE')
    expect(fetchFinto).not.toHaveBeenCalled()
  })

  it('togliere il token di una societa non tocca l altra', async () => {
    delete process.env.FIC_ACCESS_TOKEN_LAREALESTATE
    fetchFinto
      .mockResolvedValueOnce(risposta({ data: fattura() }))
      .mockResolvedValueOnce(risposta({ data: pagata() }))
      .mockResolvedValueOnce(risposta({ data: pagata() }))

    expect((await segnaPagataFatturaRicevuta(12, CONTANTI, {}, 'restruktura')).ok).toBe(true)
  })

  it('anche l elenco delle modalita e per societa', async () => {
    fetchFinto.mockResolvedValue(risposta({ data: [{ id: 1, name: 'Contanti' }] }))

    await elencoContiPagamentoFic('larealestate')
    expect(String(fetchFinto.mock.calls[0][0])).toContain('/c/222/info/payment_accounts')
    expect(autorizzazione(fetchFinto.mock.calls[0])).toBe('Bearer token-larealestate')
  })
})
