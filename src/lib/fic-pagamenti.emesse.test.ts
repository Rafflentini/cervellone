/**
 * Segnare INCASSATA una fattura EMESSA: lo stesso motore delle ricevute, con
 * le tre differenze che contano — l'endpoint, i campi di sola lettura, e la
 * DATA che non ha un predefinito.
 *
 * Nato il 14 set 2026 alle 00:20: il bot aveva la fattura 19-ED (€501,05 del
 * 15/06) e il bonifico da €501,05 del 15/06, li ha abbinati, e poi «non
 * esiste un tool che scriva pagata su una fattura EMESSA». Mancava il verbo.
 *
 * `fetch` è finto: il punto non è che l'API risponda, è che non ci si fidi.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  classificaFattura,
  classificaFatturaRicevuta,
  corpoModifica,
  datiFattura,
  leggiFatturaEmessa,
  segnaPagataFatturaEmessa,
  verificaPagamento,
  type ContoPagamentoFic,
  type FatturaDaSegnarePagata,
} from './fic-pagamenti'

const AMBIENTE_ORIGINALE = { ...process.env }
const fetchFinto = vi.fn()
const INTESA: ContoPagamentoFic = { id: 333, nome: 'Intesa Sanpaolo' }
const BONIFICO = '2026-06-15'

function risposta(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

/** Una fattura EMESSA come la restituisce FIC con fieldset=detailed. */
function emessa(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 533024661,
    type: 'invoice',
    entity: { id: 9, name: 'Condominio "Residence Vallina II A1,A2,A3"', created_at: 'x', updated_at: 'y' },
    number: 19,
    numeration: '-ED',
    date: '2026-06-15',
    subject: 'Lavori scala',
    items_list: [{ id: 1, name: 'Ripristino intonaco', net_price: 410.7, qty: 1, vat: { id: 0 } }],
    amount_net: 410.7,
    amount_vat: 90.35,
    amount_gross: 501.05,
    amount_due_discount: 0,
    url: 'https://secure.fattureincloud.it/issued_documents/533024661',
    attachment_url: null,
    next_due_date: '2026-07-15',
    ei_status: 'accepted',
    seen_date: null,
    permanent_token: 'tok',
    locked: false,
    created_at: '2026-06-15 10:00:00',
    updated_at: '2026-06-15 10:00:00',
    payments_list: [
      { id: 91, amount: 501.05, due_date: '2026-07-15', paid_date: null, status: 'not_paid' },
    ],
    ...over,
  }
}

function voceIncassata(over: Record<string, unknown> = {}) {
  return {
    id: 91,
    amount: 501.05,
    due_date: '2026-07-15',
    paid_date: BONIFICO,
    status: 'paid',
    payment_account: { id: 333, name: 'Intesa Sanpaolo' },
    ...over,
  }
}

function daScrivere(over: Partial<FatturaDaSegnarePagata> = {}): FatturaDaSegnarePagata {
  return {
    id: 533024661,
    fornitore: 'Condominio "Residence Vallina II A1,A2,A3"',
    numero: '19-ED',
    data: '2026-06-15',
    importo: 501.05,
    data_pagamento: BONIFICO,
    importo_pagamento: 501.05,
    voce: 0,
    voci: 1,
    ...over,
  }
}

describe('la data: un incasso ha la data del BONIFICO, e nessun predefinito', () => {
  it('senza data di pagamento la fattura emessa viene ESCLUSA, non datata a caso', () => {
    const c = classificaFattura(emessa(), {}, 'emessa')
    expect(c.stato).toBe('esclusa')
    if (c.stato !== 'esclusa') return
    expect(c.fattura.motivo).toMatch(/data/i)
    expect(c.fattura.motivo).toMatch(/bonifico/i)
  })

  it('con la data del bonifico si scrive quella', () => {
    const c = classificaFattura(emessa(), { data_pagamento: BONIFICO }, 'emessa')
    expect(c.stato).toBe('da_scrivere')
    if (c.stato !== 'da_scrivere') return
    expect(c.fattura.data_pagamento).toBe(BONIFICO)
    expect(c.fattura.importo_pagamento).toBe(501.05)
  })

  // Controllo positivo: la ricevuta conserva il suo predefinito (la data
  // della fattura, il contante si paga al ritiro). Se la regola nuova
  // sbordasse sulle ricevute, questo morirebbe.
  it('la ricevuta invece continua a prendere la data della fattura', () => {
    const c = classificaFatturaRicevuta({ id: 1, entity: { name: 'X' }, invoice_number: '1', date: '2026-03-04', amount_gross: 10, payments_list: [] })
    expect(c.stato).toBe('da_scrivere')
    if (c.stato !== 'da_scrivere') return
    expect(c.fattura.data_pagamento).toBe('2026-03-04')
  })

  it('una fattura emessa gia incassata viene esclusa', () => {
    const c = classificaFattura(emessa({ payments_list: [voceIncassata()] }), { data_pagamento: BONIFICO }, 'emessa')
    expect(c.stato).toBe('esclusa')
    if (c.stato !== 'esclusa') return
    expect(c.fattura.motivo).toContain('GIÀ pagata')
  })
})

describe('i dati che l Ingegnere legge: numero e cliente di una fattura emessa', () => {
  it('il numero e number+numeration (19-ED), il nome e quello del cliente', () => {
    const d = datiFattura(emessa(), 'emessa')
    expect(d.numero).toBe('19-ED')
    expect(d.fornitore).toBe('Condominio "Residence Vallina II A1,A2,A3"')
    expect(d.importo).toBe(501.05)
    expect(d.data).toBe('2026-06-15')
  })

  it('senza numerazione resta il solo numero', () => {
    expect(datiFattura(emessa({ numeration: '' }), 'emessa').numero).toBe('19')
  })
})

describe('il corpo del PUT su una fattura emessa', () => {
  it('rispedisce il documento meno i campi di sola lettura di IssuedDocument', () => {
    const corpo = corpoModifica(emessa(), [voceIncassata()], 'emessa')
    for (const k of ['id', 'amount_net', 'amount_vat', 'amount_gross', 'amount_due_discount', 'url', 'attachment_url', 'next_due_date', 'ei_status', 'seen_date', 'permanent_token', 'locked', 'created_at', 'updated_at']) {
      expect(corpo, k).not.toHaveProperty(k)
    }
    // Quello che DEVE restare: e' un documento intero, non un frammento.
    expect(corpo).toMatchObject({ type: 'invoice', number: 19, numeration: '-ED', date: '2026-06-15' })
    expect(corpo.items_list).toEqual(emessa().items_list)
    expect(corpo.payments_list).toEqual([voceIncassata()])
    expect(corpo.entity).toEqual({ id: 9, name: 'Condominio "Residence Vallina II A1,A2,A3"' })
  })

  // Controllo positivo: sulla ricevuta amount_net resta scrivibile, com'era.
  it('sulla ricevuta amount_net NON viene tolto', () => {
    const corpo = corpoModifica({ id: 1, amount_net: 100, amount_gross: 122, payments_list: [] }, [])
    expect(corpo).toHaveProperty('amount_net')
  })
})

describe('la verifica rilegge anche quello che NON doveva cambiare', () => {
  const prima = emessa()
  const dopo = () => emessa({ payments_list: [voceIncassata()] })

  it('conferma quando la rilettura mostra l incasso e il resto e intatto', () => {
    expect(verificaPagamento(prima, dopo(), daScrivere(), INTESA, 'emessa')).toEqual({ ok: true })
  })

  it.each([
    ['cliente', { entity: { id: 9, name: 'ALTRO CLIENTE' } }],
    ['numero', { number: 20 }],
    ['numerazione', { numeration: '-XX' }],
    ['data', { date: '2026-06-16' }],
    ['totale lordo', { amount_gross: 999 }],
    ['stato SdI', { ei_status: 'rejected' }],
  ])('se rileggendo e cambiato %s, lo dice invece di dire fatto', (_nome, over) => {
    const v = verificaPagamento(prima, dopo() && emessa({ payments_list: [voceIncassata()], ...over }), daScrivere(), INTESA, 'emessa')
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.motivo).toContain('CAMBIATO')
  })

  it('non si accontenta di uno status paid con la data sbagliata', () => {
    const v = verificaPagamento(prima, emessa({ payments_list: [voceIncassata({ paid_date: '2026-06-14' })] }), daScrivere(), INTESA, 'emessa')
    expect(v.ok).toBe(false)
  })
})

describe('lettura e scrittura: endpoint delle fatture EMESSE, poi rilettura', () => {
  beforeEach(() => {
    fetchFinto.mockReset()
    vi.stubGlobal('fetch', fetchFinto)
    process.env.FIC_COMPANY_ID = '111'
    process.env.FIC_ACCESS_TOKEN = 'token-restruktura'
  })
  afterEach(() => {
    process.env = { ...AMBIENTE_ORIGINALE }
    vi.unstubAllGlobals()
  })

  it('legge da issued_documents con type=invoice e fieldset=detailed', async () => {
    fetchFinto.mockResolvedValueOnce(risposta({ data: emessa() }))
    const r = await leggiFatturaEmessa(533024661, 'restruktura')
    expect(r.ok).toBe(true)
    const url = String(fetchFinto.mock.calls[0][0])
    expect(url).toContain('/c/111/issued_documents/533024661')
    expect(url).toContain('type=invoice')
    expect(url).toContain('fieldset=detailed')
  })

  it('una fattura emessa che non esiste lo dice con quelle parole', async () => {
    fetchFinto.mockResolvedValueOnce(risposta({ error: 'nope' }, 404))
    const r = await leggiFatturaEmessa(1, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('la fattura emessa 1 non esiste')
  })

  it('legge, scrive col PUT su issued_documents e conferma dalla rilettura', async () => {
    fetchFinto
      .mockResolvedValueOnce(risposta({ data: emessa() }))
      .mockResolvedValueOnce(risposta({ data: emessa({ payments_list: [voceIncassata()] }) }))
      .mockResolvedValueOnce(risposta({ data: emessa({ payments_list: [voceIncassata()] }) }))

    const r = await segnaPagataFatturaEmessa(533024661, INTESA, { data_pagamento: BONIFICO }, 'restruktura')
    expect(r.ok).toBe(true)

    const put = fetchFinto.mock.calls[1]
    expect(String(put[0])).toBe('https://api-v2.fattureincloud.it/c/111/issued_documents/533024661')
    expect((put[1] as RequestInit).method).toBe('PUT')
    const corpo = JSON.parse(String((put[1] as RequestInit).body))
    expect(corpo.data.payments_list[0]).toMatchObject({
      status: 'paid',
      paid_date: BONIFICO,
      amount: 501.05,
      payment_account: { id: 333, name: 'Intesa Sanpaolo' },
    })
    expect(corpo.data).not.toHaveProperty('amount_gross')
    expect(fetchFinto).toHaveBeenCalledTimes(3)
  })

  it('senza data del bonifico NON scrive: una sola chiamata, la lettura', async () => {
    fetchFinto.mockResolvedValueOnce(risposta({ data: emessa() }))
    const r = await segnaPagataFatturaEmessa(533024661, INTESA, {}, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toMatch(/bonifico/i)
    expect(fetchFinto).toHaveBeenCalledTimes(1)
  })

  it('la PUT risponde ok ma rileggendo l incasso non c e: lo dice', async () => {
    fetchFinto
      .mockResolvedValueOnce(risposta({ data: emessa() }))
      .mockResolvedValueOnce(risposta({ data: emessa({ payments_list: [voceIncassata()] }) }))
      .mockResolvedValueOnce(risposta({ data: emessa() }))
    const r = await segnaPagataFatturaEmessa(533024661, INTESA, { data_pagamento: BONIFICO }, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toContain('rileggendo il pagamento non risulta')
  })

  it('se nel frattempo risulta incassata, NON scrive niente', async () => {
    fetchFinto.mockResolvedValueOnce(risposta({ data: emessa({ payments_list: [voceIncassata()] }) }))
    const r = await segnaPagataFatturaEmessa(533024661, INTESA, { data_pagamento: BONIFICO }, 'restruktura')
    expect(r.ok).toBe(false)
    expect(fetchFinto).toHaveBeenCalledTimes(1)
  })
})
