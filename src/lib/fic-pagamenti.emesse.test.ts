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
  /**
   * 🚨 Qui, fino al 14 settembre 2026, si rispediva il DOCUMENTO INTERO, e il
   * test lo pretendeva: «e' un documento intero, non un frammento». La ragione
   * era scritta e ragionevole — «la semantica del PUT non e' documentata: cosi'
   * l'esito e' lo stesso sia che sostituisca tutto, sia che accetti un payload
   * parziale» — cioe' prudenza sotto incertezza.
   *
   * L'incertezza si e' sciolta al primo uso vero, e nel modo peggiore: FIC ha
   * RIFIUTATO. La fattura 19-ED era gia' stata trasmessa allo SdI, quindi
   * «locked». E il rifiuto era corretto: una fattura elettronica trasmessa non
   * si modifica. Era la nostra domanda a essere sbagliata — non stiamo
   * modificando la fattura, stiamo **registrando un incasso**, che
   * dall'interfaccia di FIC si fa senza problemi.
   *
   * Mandare tutto si e' rivelato l'unica forma che NON funziona sulle fatture
   * vere, cioe' quelle trasmesse. La documentazione dichiara supportato
   * l'aggiornamento parziale: si manda solo il piano pagamenti.
   */
  it('🚨 manda SOLO il piano pagamenti: il documento intero fa scattare il blocco delle e-fatture', () => {
    const corpo = corpoModifica(emessa(), [voceIncassata()], 'emessa')

    expect(Object.keys(corpo)).toEqual(['payments_list'])
    expect(corpo.payments_list).toEqual([voceIncassata()])

    // Nessun campo del documento parte piu': sono quelli che FIC rifiuta di
    // vedersi riscrivere su una fattura gia' andata allo SdI.
    for (const k of ['type', 'number', 'numeration', 'date', 'items_list', 'entity', 'amount_due_discount']) {
      expect(corpo, k).not.toHaveProperty(k)
    }
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
    const v = verificaPagamento(prima, emessa({ payments_list: [voceIncassata()], ...over }), daScrivere(), INTESA, 'emessa')
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

describe('la verifica confronta il documento INTERO, non sette campi', () => {
  // Audit del 14 set 2026: una riga sparita con totali uguali, o ei_data
  // alterato, passavano. La semantica del PUT non e' documentata: la
  // rilettura e' l'unica prova, e deve guardare tutto.
  const prima = emessa()
  const conIncasso = (over: Record<string, unknown> = {}) => emessa({ payments_list: [voceIncassata()], ...over })

  it.each([
    ['items_list (riga sparita, totali uguali)', { items_list: [] }],
    ['ei_data', { ei_data: { vat_kind: 'S' } }],
    ['subject', { subject: 'ALTRO' }],
    ['e_invoice', { e_invoice: false }],
  ])('se rileggendo e cambiato %s, lo dice', (_n, over) => {
    const v = verificaPagamento(prima, conIncasso(over), daScrivere(), INTESA, 'emessa')
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.motivo).toContain('CAMBIATO fuori dal pagamento')
  })

  it('una voce del piano NON toccata che cambia viene vista', () => {
    const due = emessa({ payments_list: [voceIncassata(), { id: 92, amount: 10, due_date: '2026-08-15', status: 'not_paid' }] })
    const dopo = emessa({ payments_list: [voceIncassata(), { id: 92, amount: 99, due_date: '2026-08-15', status: 'not_paid' }] })
    const v = verificaPagamento(due, dopo, daScrivere({ voci: 2 }), INTESA, 'emessa')
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.motivo).toContain('payments_list[2]')
  })

  it('le differenze di sola forma (numeri come stringhe, null vs assente, url e date di sistema) NON contano', () => {
    const dopo = conIncasso({
      amount_gross: '501.05',
      url: 'https://altro',
      updated_at: '2026-09-14 01:00:00',
      seen_date: '2026-09-14',
      attachment_url: undefined,
      entity: { id: 9, name: 'Condominio "Residence Vallina II A1,A2,A3"', created_at: 'z', updated_at: 'w', address_extra: null },
    })
    expect(verificaPagamento(prima, dopo, daScrivere(), INTESA, 'emessa')).toEqual({ ok: true })
  })
})

/**
 * 🚨 LA RIGA CHE E' COSTATA DUE GIORNI.
 *
 * `classificaFattura` rifiutava QUALUNQUE documento `locked` con la frase «non
 * è modificabile via API». Sembrava un fatto su Fatture in Cloud: era una
 * nostra convinzione, e nessun test la difendeva in nessuno dei due sensi.
 *
 * Conseguenza: il tool nato apposta per registrare gli incassi delle fatture
 * emesse si rifiutava su **tutte quelle vere** — una fattura a un cliente viene
 * trasmessa allo SdI e da quel momento è `locked`. Il bot riportava
 * all'Ingegnere «FIC impedisce ogni scrittura», diceva «verificato ora», e
 * verificava quella riga. Una richiesta a FIC non è mai partita.
 *
 * Il blocco di FIC è reale ma è sul DOCUMENTO. Un incasso è un'altra cosa, e
 * dal 14 set gliene mandiamo solo il piano pagamenti. Quindi sulle emesse si
 * PROVA e si riporta la risposta vera.
 */
describe('una fattura emessa gia trasmessa allo SdI (locked)', () => {
  it('🚨 NON viene esclusa a priori: si prova, e risponde FIC', () => {
    const classifica = classificaFattura(emessa({ locked: true }), { data_pagamento: BONIFICO }, 'emessa')

    // `da_scrivere` significa esattamente questo: il tool arrivera' a fare il
    // PUT, e a rispondere sara' Fatture in Cloud con le sue parole.
    expect(classifica.stato).toBe('da_scrivere')
    if (classifica.stato !== 'da_scrivere') return
    expect(classifica.fattura.importo_pagamento).toBe(501.05)
    expect(classifica.fattura.data_pagamento).toBe(BONIFICO)
  })

  it('CONTROLLO POSITIVO: una RICEVUTA bloccata resta esclusa', () => {
    // Lì si rispedisce il documento INTERO, cioè esattamente quello che su un
    // documento bloccato non si può fare. Senza questo test, togliere la
    // guardia per tutti passerebbe inosservato.
    const classifica = classificaFatturaRicevuta({ id: 1, locked: true, payments_list: [] })

    expect(classifica.stato).toBe('esclusa')
    if (classifica.stato !== 'esclusa') return
    expect(classifica.fattura.motivo).toContain('locked')
  })

  it('CONTROLLO POSITIVO: una emessa NON bloccata continua a passare', () => {
    // Senza questo, una classificazione che accetta sempre passerebbe il primo
    // test e avremmo tolto ogni filtro invece di correggerne uno.
    const classifica = classificaFattura(emessa(), { data_pagamento: BONIFICO }, 'emessa')
    expect(classifica.stato).toBe('da_scrivere')
  })

  it('e una emessa gia pagata resta esclusa anche se non bloccata', () => {
    const gia = emessa({ payments_list: [{ id: 91, amount: 501.05, paid_date: '2026-06-15', status: 'paid' }] })
    const classifica = classificaFattura(gia, { data_pagamento: BONIFICO }, 'emessa')
    expect(classifica.stato).toBe('esclusa')
    if (classifica.stato !== 'esclusa') return
    expect(classifica.fattura.motivo).toContain('GIÀ pagata')
  })
})
