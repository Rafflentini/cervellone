/**
 * Segnare pagata una fattura RICEVUTA: le regole, e la prova che viene dalla
 * RILETTURA.
 *
 * Questo file non parla mai con Fatture in Cloud: `fetch` è finto. Il punto
 * non è che l'API risponda, è che NON ci si fidi della sua risposta.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  classificaFatturaRicevuta,
  corpoModifica,
  elencoContiPagamentoFic,
  pianoConPagamento,
  risolviContoPagamento,
  segnaPagataFatturaRicevuta,
  verificaPagamento,
  type ContoPagamentoFic,
  type FatturaDaSegnarePagata,
} from './fic-pagamenti'

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

/** Una fattura di spesa come la restituisce FIC con fieldset=detailed. */
function fattura(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12,
    type: 'expense',
    entity: { id: 5, name: 'EDIL LIMONGI SRL' },
    invoice_number: '123',
    date: '2026-03-04',
    description: 'Materiale edile',
    amount_net: 100,
    amount_vat: 22,
    amount_gross: 122,
    amount_withholding_tax: 0,
    amount_other_withholding_tax: 0,
    next_due_date: '2026-03-04',
    e_invoice: true,
    locked: false,
    created_at: '2026-03-05 10:00:00',
    updated_at: '2026-03-05 10:00:00',
    payments_list: [
      { id: 777, amount: 122, due_date: '2026-03-04', paid_date: null, status: 'not_paid' },
    ],
    ...over,
  }
}

function vocePagata(over: Record<string, unknown> = {}) {
  return {
    id: 777,
    amount: 122,
    due_date: '2026-03-04',
    paid_date: '2026-03-04',
    status: 'paid',
    payment_account: { id: 222, name: 'Contanti' },
    ...over,
  }
}

function daScrivere(over: Partial<FatturaDaSegnarePagata> = {}): FatturaDaSegnarePagata {
  return {
    id: 12,
    fornitore: 'EDIL LIMONGI SRL',
    numero: '123',
    data: '2026-03-04',
    importo: 122,
    data_pagamento: '2026-03-04',
    importo_pagamento: 122,
    voce: 0,
    voci: 1,
    ...over,
  }
}

describe('classificazione: chi si scrive e chi si esclude', () => {
  // ⭐ Il contante si paga AL RITIRO: la data del pagamento e' la data della
  // fattura, non oggi. Un «oggi» comodo sarebbe una data inventata su un
  // movimento contabile.
  it('la data di pagamento predefinita e la data DELLA FATTURA, non oggi', () => {
    const oggi = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
    const c = classificaFatturaRicevuta(fattura())
    expect(c.stato).toBe('da_scrivere')
    if (c.stato !== 'da_scrivere') return
    expect(c.fattura.data_pagamento).toBe('2026-03-04')
    expect(c.fattura.data_pagamento).not.toBe(oggi)
  })

  // Controllo positivo della regola sopra: quando la data viene DETTA, vince.
  it('una data indicata dall Ingegnere vince sulla data della fattura', () => {
    const c = classificaFatturaRicevuta(fattura(), { data_pagamento: '2026-04-10' })
    expect(c.stato).toBe('da_scrivere')
    if (c.stato !== 'da_scrivere') return
    expect(c.fattura.data_pagamento).toBe('2026-04-10')
  })

  // 🚨 Un secondo pagamento sullo stesso documento e' un errore contabile.
  it('una fattura GIA pagata viene esclusa, non riscritta', () => {
    const c = classificaFatturaRicevuta(fattura({ payments_list: [vocePagata()] }))
    expect(c.stato).toBe('esclusa')
    if (c.stato !== 'esclusa') return
    expect(c.fattura.motivo).toContain('GIÀ pagata')
    expect(c.fattura.motivo).toContain('2026-03-04')
  })

  it('basta UNA voce pagata su piu per escludere la fattura', () => {
    const c = classificaFatturaRicevuta(fattura({
      payments_list: [
        { id: 1, amount: 61, due_date: '2026-03-04', status: 'paid', paid_date: '2026-03-04' },
        { id: 2, amount: 61, due_date: '2026-04-04', status: 'not_paid' },
      ],
    }))
    expect(c.stato).toBe('esclusa')
  })

  // 🚨 Con piu voci NON si scegli al posto suo: si dichiara e si chiede.
  it('un piano pagamenti a PIU voci viene escluso dichiarando quante sono', () => {
    const c = classificaFatturaRicevuta(fattura({
      payments_list: [
        { id: 1, amount: 61, due_date: '2026-03-04', status: 'not_paid' },
        { id: 2, amount: 61, due_date: '2026-04-04', status: 'not_paid' },
      ],
    }))
    expect(c.stato).toBe('esclusa')
    if (c.stato !== 'esclusa') return
    expect(c.fattura.motivo).toContain('2 voci')
    expect(c.fattura.motivo).toContain('non scelgo io')
    // Le voci si MOSTRANO: e' cosi' che l'Ingegnere sceglie.
    expect(c.fattura.motivo).toContain('#1')
    expect(c.fattura.motivo).toContain('#2')
  })

  // Controllo positivo: la voce si scrive SOLO quando l'ha detta lui.
  it('con la voce indicata dall Ingegnere, quella voce si scrive', () => {
    const c = classificaFatturaRicevuta(fattura({
      payments_list: [
        { id: 1, amount: 61, due_date: '2026-03-04', status: 'not_paid' },
        { id: 2, amount: 61, due_date: '2026-04-04', status: 'not_paid' },
      ],
    }), { voce: 2 })
    expect(c.stato).toBe('da_scrivere')
    if (c.stato !== 'da_scrivere') return
    expect(c.fattura.voce).toBe(1)
    expect(c.fattura.importo_pagamento).toBe(61)
  })

  it('una voce che non esiste viene rifiutata dicendo quante ce ne sono', () => {
    const c = classificaFatturaRicevuta(fattura({
      payments_list: [
        { id: 1, amount: 61, status: 'not_paid' },
        { id: 2, amount: 61, status: 'not_paid' },
      ],
    }), { voce: 7 })
    expect(c.stato).toBe('esclusa')
    if (c.stato !== 'esclusa') return
    expect(c.fattura.motivo).toContain('2 voci')
  })

  it('senza piano pagamenti la voce si crea con il totale del documento', () => {
    const c = classificaFatturaRicevuta(fattura({ payments_list: [] }))
    expect(c.stato).toBe('da_scrivere')
    if (c.stato !== 'da_scrivere') return
    expect(c.fattura.voce).toBeNull()
    expect(c.fattura.importo_pagamento).toBe(122)
  })

  // Con una ritenuta il totale lordo NON e' l'importo da pagare, e non lo
  // calcoliamo noi: un importo dedotto su un documento fiscale e' un dato
  // inventato.
  it('senza piano pagamenti ma con ritenuta, si esclude invece di dedurre l importo', () => {
    const c = classificaFatturaRicevuta(fattura({ payments_list: [], amount_withholding_tax: 20 }))
    expect(c.stato).toBe('esclusa')
    if (c.stato !== 'esclusa') return
    expect(c.fattura.motivo).toContain('ritenuta')
    expect(c.fattura.motivo).toContain('non lo calcolo io')
  })

  it('una fattura bloccata su FIC viene esclusa', () => {
    const c = classificaFatturaRicevuta(fattura({ locked: true }))
    expect(c.stato).toBe('esclusa')
    if (c.stato !== 'esclusa') return
    expect(c.fattura.motivo).toContain('locked')
  })

  it('l anteprima porta fornitore, numero, data e importo', () => {
    const c = classificaFatturaRicevuta(fattura())
    if (c.stato !== 'da_scrivere') throw new Error('attesa scrivibile')
    expect(c.fattura.fornitore).toBe('EDIL LIMONGI SRL')
    expect(c.fattura.numero).toBe('123')
    expect(c.fattura.data).toBe('2026-03-04')
    expect(c.fattura.importo).toBe(122)
  })
})

describe('il corpo del PUT', () => {
  it('la voce scelta prende status paid, la data e il conto', () => {
    const piano = pianoConPagamento(fattura(), daScrivere(), CONTANTI)
    expect(piano).toHaveLength(1)
    expect(piano[0]).toMatchObject({
      id: 777,
      amount: 122,
      status: 'paid',
      paid_date: '2026-03-04',
      payment_account: { id: 222, name: 'Contanti' },
    })
  })

  it('le altre voci del piano restano INTATTE', () => {
    const doc = fattura({
      payments_list: [
        { id: 1, amount: 61, due_date: '2026-03-04', status: 'not_paid' },
        { id: 2, amount: 61, due_date: '2026-04-04', status: 'not_paid' },
      ],
    })
    const piano = pianoConPagamento(doc, daScrivere({ voce: 1, voci: 2, importo_pagamento: 61 }), CONTANTI)
    expect(piano[0]).toEqual({ id: 1, amount: 61, due_date: '2026-03-04', status: 'not_paid' })
    expect(piano[1]).toMatchObject({ id: 2, status: 'paid' })
  })

  // Il documento si rispedisce INTERO perche' la semantica del PUT non e'
  // documentata: cosi' l'esito e' lo stesso sia che sostituisca tutto, sia che
  // accetti un payload parziale.
  it('rispedisce il documento intero, meno i campi di sola lettura', () => {
    const corpo = corpoModifica(fattura(), [vocePagata()])
    expect(corpo.entity).toMatchObject({ id: 5, name: 'EDIL LIMONGI SRL' })
    expect(corpo.date).toBe('2026-03-04')
    expect(corpo.amount_net).toBe(100)
    expect(corpo.amount_vat).toBe(22)
    expect(corpo.invoice_number).toBe('123')
    expect(corpo.type).toBe('expense')
    for (const campo of ['id', 'amount_gross', 'next_due_date', 'e_invoice', 'locked', 'created_at', 'updated_at']) {
      expect(corpo).not.toHaveProperty(campo)
    }
  })
})

describe('la verifica: l esito viene dalla rilettura', () => {
  it('conferma quando la rilettura mostra il pagamento', () => {
    const prima = fattura()
    const dopo = fattura({ payments_list: [vocePagata()] })
    expect(verificaPagamento(prima, dopo, daScrivere(), CONTANTI)).toEqual({ ok: true })
  })

  // ⭐ IL TEST PIU IMPORTANTE: la PUT ha risposto ok, ma rileggendo il
  // pagamento non c'e'. Mutazione: fidarsi della risposta della PUT.
  it('se la rilettura NON conferma, lo dice con quelle parole', () => {
    const prima = fattura()
    const dopo = fattura() // nessun pagamento scritto
    const v = verificaPagamento(prima, dopo, daScrivere(), CONTANTI)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.motivo).toContain("l'API ha risposto ok ma rileggendo il pagamento non risulta")
  })

  it('non si accontenta di uno status paid col conto sbagliato', () => {
    const dopo = fattura({ payments_list: [vocePagata({ payment_account: { id: 999, name: 'Altro conto' } })] })
    const v = verificaPagamento(fattura(), dopo, daScrivere(), CONTANTI)
    expect(v.ok).toBe(false)
  })

  it('non si accontenta di uno status paid con la data sbagliata', () => {
    const dopo = fattura({ payments_list: [vocePagata({ paid_date: '2026-09-12' })] })
    const v = verificaPagamento(fattura(), dopo, daScrivere(), CONTANTI)
    expect(v.ok).toBe(false)
  })

  // La semantica del PUT non e' documentata: se fosse una sostituzione
  // integrale, un campo perso si vedrebbe QUI.
  it('se rileggendo e cambiato il fornitore, lo dice invece di dire fatto', () => {
    const dopo = fattura({ entity: { id: 5, name: 'ALTRO FORNITORE' }, payments_list: [vocePagata()] })
    const v = verificaPagamento(fattura(), dopo, daScrivere(), CONTANTI)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.motivo).toContain('è CAMBIATO fornitore')
  })

  it('se rileggendo e cambiato l importo lordo, lo dice', () => {
    const dopo = fattura({ amount_gross: 999, payments_list: [vocePagata()] })
    const v = verificaPagamento(fattura(), dopo, daScrivere(), CONTANTI)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.motivo).toContain('totale_lordo')
  })
})

describe('le modalita di pagamento vengono da Fatture in Cloud', () => {
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

  // 🔬 Mutazione: una lista fissa scritta nel codice. Questo test morirebbe,
  // perche' i nomi arrivano dalla risposta di FIC e l'URL chiamato e' quello.
  it('l elenco arriva da /info/payment_accounts, non da una lista scritta a mano', async () => {
    fetchFinto.mockResolvedValue(risposta({
      data: [
        { id: 222, name: 'Contanti', type: 'standard' },
        { id: 333, name: 'Conto Banca Intesa', type: 'bank' },
      ],
    }))

    const r = await elencoContiPagamentoFic('restruktura')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.valore).toEqual([
      { id: 222, nome: 'Contanti' },
      { id: 333, nome: 'Conto Banca Intesa' },
    ])
    expect(String(fetchFinto.mock.calls[0][0])).toContain('/c/111/info/payment_accounts')
  })

  it('se l elenco cambia, cambia il risultato: non c e niente di cablato', async () => {
    fetchFinto.mockResolvedValue(risposta({ data: [{ id: 9, name: 'Cassa di cantiere' }] }))
    const r = await elencoContiPagamentoFic('restruktura')
    if (!r.ok) throw new Error(r.error)
    expect(r.valore).toEqual([{ id: 9, nome: 'Cassa di cantiere' }])
  })
})

describe('risoluzione della modalita richiesta', () => {
  const conti: ContoPagamentoFic[] = [
    { id: 222, nome: 'Contanti' },
    { id: 333, nome: 'Carta di credito' },
    { id: 444, nome: 'Carta prepagata' },
  ]

  it('trova per nome esatto, senza badare a maiuscole', () => {
    expect(risolviContoPagamento(conti, 'contanti')).toEqual({ ok: true, valore: { id: 222, nome: 'Contanti' } })
  })

  it('trova per id', () => {
    expect(risolviContoPagamento(conti, '333')).toEqual({ ok: true, valore: { id: 333, nome: 'Carta di credito' } })
  })

  it('con una richiesta ambigua NON scegli: dichiara e chiede', () => {
    const r = risolviContoPagamento(conti, 'carta')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('2 conti')
    expect(r.error).toContain('non scelgo io')
  })

  it('con una modalita inesistente elenca quelle vere', () => {
    const r = risolviContoPagamento(conti, 'bitcoin')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('Contanti')
    expect(r.error).toContain('Carta di credito')
  })

  it('senza modalita chiede, elencando quelle di FIC', () => {
    const r = risolviContoPagamento(conti, '')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('modalita_pagamento richiesta')
    expect(r.error).toContain('Contanti')
  })
})

describe('scrittura completa: PUT, poi rilettura', () => {
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

  it('legge, scrive col PUT e conferma dalla rilettura', async () => {
    fetchFinto
      .mockResolvedValueOnce(risposta({ data: fattura() }))                              // lettura
      .mockResolvedValueOnce(risposta({ data: fattura({ payments_list: [vocePagata()] }) })) // PUT
      .mockResolvedValueOnce(risposta({ data: fattura({ payments_list: [vocePagata()] }) })) // rilettura

    const r = await segnaPagataFatturaRicevuta(12, CONTANTI, {}, 'restruktura')
    expect(r.ok).toBe(true)

    const put = fetchFinto.mock.calls[1]
    expect(String(put[0])).toBe('https://api-v2.fattureincloud.it/c/111/received_documents/12')
    expect((put[1] as RequestInit).method).toBe('PUT')
    const corpo = JSON.parse(String((put[1] as RequestInit).body))
    expect(corpo.data.payments_list[0]).toMatchObject({
      status: 'paid',
      paid_date: '2026-03-04',
      payment_account: { id: 222, name: 'Contanti' },
    })
    // Tre chiamate: lettura, scrittura, RILETTURA. La terza e' la prova.
    expect(fetchFinto).toHaveBeenCalledTimes(3)
  })

  // 🔬 Mutazione: fidarsi della risposta della PUT (cioe' non rileggere, o
  // rileggere e non guardare). Questo test muore.
  it('la PUT risponde ok ma rileggendo il pagamento non c e: lo dice', async () => {
    fetchFinto
      .mockResolvedValueOnce(risposta({ data: fattura() }))
      .mockResolvedValueOnce(risposta({ data: fattura({ payments_list: [vocePagata()] }) })) // la PUT MENTE
      .mockResolvedValueOnce(risposta({ data: fattura() }))                                  // la verita'

    const r = await segnaPagataFatturaRicevuta(12, CONTANTI, {}, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toContain("l'API ha risposto ok ma rileggendo il pagamento non risulta")
  })

  it('se la rilettura non risponde, non dichiara fatto', async () => {
    fetchFinto
      .mockResolvedValueOnce(risposta({ data: fattura() }))
      .mockResolvedValueOnce(risposta({ data: fattura({ payments_list: [vocePagata()] }) }))
      .mockResolvedValueOnce(risposta({ error: 'boom' }, 500))

    const r = await segnaPagataFatturaRicevuta(12, CONTANTI, {}, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toContain('non riesco a rileggere')
  })

  // 🚨 La rilettura PRIMA di scrivere: fra l'anteprima e la conferma quella
  // fattura puo' essere stata pagata da FIC o a mano.
  it('se nel frattempo risulta pagata, NON scrive niente', async () => {
    fetchFinto.mockResolvedValueOnce(risposta({ data: fattura({ payments_list: [vocePagata()] }) }))

    const r = await segnaPagataFatturaRicevuta(12, CONTANTI, {}, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toContain('GIÀ pagata')
    // Nessun PUT: una sola chiamata, la lettura.
    expect(fetchFinto).toHaveBeenCalledTimes(1)
  })

  it('una fattura che non esiste lo dice, senza scrivere', async () => {
    fetchFinto.mockResolvedValueOnce(risposta({ error: 'not found' }, 404))
    const r = await segnaPagataFatturaRicevuta(999, CONTANTI, {}, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toContain('non esiste su Fatture in Cloud')
    expect(fetchFinto).toHaveBeenCalledTimes(1)
  })
})
