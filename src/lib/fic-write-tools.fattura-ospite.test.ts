/**
 * src/lib/fic-write-tools.fattura-ospite.test.ts — il tool
 * `fic_crea_fattura_ospite` visto DA FUORI: dal parametro alla conferma unica.
 *
 * 🚨 Quello che si prova qui e' la CATENA, non i pezzi (i pezzi stanno in
 * `fic-fattura-ospite.difese.test.ts`): che il tool esista nell'elenco che il
 * modello vede, che l'anteprima dica le cose che l'Ingegnere deve leggere
 * PRIMA di dire «confermo» una volta sola, che l'anagrafica venga creata
 * riusando `fic_crea_cliente` — e che quando una difesa scatta NON si crei ne'
 * l'anagrafica ne' la fattura.
 *
 * ⚠️ Dati identificativi INVENTATI: il repo e' PUBBLICO.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stato = {
  inserite: [] as Record<string, unknown>[],
  descrizione: '',
  riga: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  /** Gli input passati a `fic_crea_cliente`: prova che l'anagrafica sia stata toccata. */
  anagrafiche: [] as Record<string, unknown>[],
  rispostaAnagrafica: { ok: true, creato: true, cliente_id: 900001 } as Record<string, unknown>,
  emesse: [] as Record<string, unknown>[],
  elencoTroncato: false,
  creati: [] as Record<string, unknown>[],
  rilettura: null as Record<string, unknown> | null,
}

vi.mock('./supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const catena = (lista: () => unknown[], singolo: () => unknown): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    const me = () => b
    b.eq = me
    b.in = me
    b.gte = me
    b.order = me
    b.limit = me
    b.maybeSingle = async () => ({ data: singolo(), error: null })
    b.single = async () => ({ data: singolo(), error: null })
    b.select = () => catena(lista, singolo)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    b.then = (risolvi: any) => Promise.resolve({ data: lista(), error: null }).then(risolvi)
    return b
  }
  return {
    supabase: {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          stato.inserite.push(row)
          return catena(() => [{ id: 'pend-1' }], () => ({ id: 'pend-1' }))
        },
        select: () => catena(() => (stato.riga ? [stato.riga] : []), () => stato.riga),
        update: (row: Record<string, unknown>) => {
          stato.updates.push(row)
          if (typeof row.descrizione === 'string' && row.descrizione) stato.descrizione = row.descrizione
          return catena(
            () => [{ id: 'pend-1', societa: 'larealestate', tipo: stato.riga?.tipo ?? 'fattura_ospite', stato: row.stato ?? 'in_attesa' }],
            () => ({ id: 'pend-1', descrizione: stato.descrizione }),
          )
        },
      }),
    },
  }
})

vi.mock('./fatture-in-cloud', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./fatture-in-cloud')>()
  return {
    ...vero,
    getCompanyId: async () => ({ ok: true as const, id: 1614746 }),
    ficGet: async () => ({ ok: true as const, data: { data: stato.rilettura ?? {} } }),
    creaDocumentoFIC: async (payload: Record<string, unknown>) => {
      stato.creati.push(payload)
      return { ok: true as const, id: '999', url: 'https://secure.fattureincloud.it/issued_documents/999' }
    },
  }
})

vi.mock('./fic-pagamenti', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./fic-pagamenti')>()
  return {
    ...vero,
    cercaFattureEmesse: async () => ({
      ok: true as const,
      valore: { documenti: stato.emesse, elenco_troncato: stato.elencoTroncato, pagine_lette: 1 },
    }),
    elencoContiPagamentoFic: async () => ({
      ok: true as const,
      valore: [{ id: 1570742, nome: 'BANCA MONTEPRUNO' }, { id: 1565608, nome: 'Contanti' }],
    }),
  }
})

vi.mock('./fic-aliquote', () => ({
  elencoAliquoteFic: async () => ({
    ok: true as const,
    righe: [
      { id: 3, value: 10, description: 'Aliquota 10%' },
      { id: 15819187, value: 0, description: 'Iva esclusa ex art. 15' },
    ],
  }),
}))

vi.mock('./fic-verifica-formale', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./fic-verifica-formale')>()
  return { ...vero, verificaFormaleXml: async () => ({ esito: 'valido' as const }) }
})

vi.mock('./fic-anagrafica', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./fic-anagrafica')>()
  return {
    ...vero,
    executeAnagraficaTool: async (nome: string, input: Record<string, unknown>) => {
      stato.anagrafiche.push({ tool: nome, ...input })
      return JSON.stringify(stato.rispostaAnagrafica)
    },
  }
})

import { A_CONFERMA_SINGOLA, FIC_WRITE_TOOLS, confirmFicStep1, executeFicWriteTool } from './fic-write-tools'
import { NOME_RIGA_IMPOSTA } from './fic-fattura-ospite'

const CF_VALIDO = 'VRDGPP85R41F205N'
const CF_STORTO = 'VRDGPP85R41F205A'

const INPUT = {
  unita: 'Blue Maison 1',
  indirizzo_unita: 'Via Fiumicello, Maratea (PZ)',
  check_in: '2027-08-19',
  check_out: '2027-08-22',
  prenotazione: '7100000001',
  prezzo: 516.3,
  adulti: 2,
  bambini: 1,
  data: '2027-09-15',
  ospite: {
    nome: 'VERDI GIUSEPPINA',
    codice_fiscale: CF_VALIDO,
    indirizzo: 'VIA DELLE PROVE, 1',
    cap: '20121',
    citta: 'MILANO',
    provincia: 'MI',
    paese: 'Italia',
  },
  imposta_soggiorno: { importo: 13.5, persone: 3, notti: 3, tariffa: 1.5 },
}

function riletturaBuona() {
  return {
    id: 999,
    type: 'invoice',
    e_invoice: true,
    number: 20,
    numeration: '',
    amount_net: 469.36,
    amount_vat: 46.94,
    amount_gross: 529.8,
    entity: { id: 900001 },
    items_list: [
      { name: 'Soggiorno Blue Maison 1 dal 19/08/2027 al 22/08/2027', vat: { id: 3, value: 10 } },
      { name: NOME_RIGA_IMPOSTA, vat: { id: 15819187, value: 0, description: 'Iva esclusa ex art. 15' }, not_taxable: true },
    ],
    payments_list: [{ amount: 516.3, status: 'paid' }, { amount: 13.5, status: 'paid' }],
    ei_raw: { FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD01' } } } },
  }
}

async function compila(extra: Record<string, unknown> = {}) {
  const grezzo = await executeFicWriteTool('fic_crea_fattura_ospite', { ...INPUT, ...extra }, 'larealestate')
  return JSON.parse(grezzo ?? '{}')
}

beforeEach(() => {
  stato.inserite = []
  stato.descrizione = ''
  stato.riga = null
  stato.updates = []
  stato.anagrafiche = []
  stato.rispostaAnagrafica = { ok: true, creato: true, cliente_id: 900001 }
  stato.emesse = []
  stato.elencoTroncato = false
  stato.creati = []
  stato.rilettura = riletturaBuona()
})

describe('il tool esiste e il modello lo vede', () => {
  const tool = FIC_WRITE_TOOLS.find((t) => t.name === 'fic_crea_fattura_ospite')

  it('e\' nell\'elenco dei tool di scrittura', () => {
    expect(tool).toBeDefined()
  })

  it('🚨 la descrizione dice le tre cose che, taciute, producono un danno', () => {
    const d = tool!.description
    // Il prezzo LORDO: col payout netto la fattura esce di 150 euro piu' bassa.
    expect(d).toMatch(/LORDO/)
    // Il divieto del Garante: il modello non deve nemmeno provare a passarle.
    expect(d).toMatch(/nascita/i)
    // Che non trasmette: e' la promessa che regge tutto il ramo FIC.
    expect(d).toMatch(/NON trasmette allo SdI/i)
  })

  it('i parametri senza i quali non si fattura sono OBBLIGATORI', () => {
    const richiesti = (tool!.input_schema as { required: string[] }).required
    for (const campo of ['unita', 'check_in', 'check_out', 'prenotazione', 'prezzo', 'ospite']) {
      expect(richiesti).toContain(campo)
    }
  })

  it('🚨 si chiude con UNA conferma sola', () => {
    expect(A_CONFERMA_SINGOLA.has('fattura_ospite')).toBe(true)
  })
})

describe('la compilazione', () => {
  it('prepara la bozza, crea l\'anagrafica e non scrive NESSUNA fattura', async () => {
    const r = await compila()
    expect(r.ok).toBe(true)
    expect(r.id).toBe('pend-1')
    expect(stato.creati).toHaveLength(0)
    expect(stato.anagrafiche).toHaveLength(1)
    expect(stato.anagrafiche[0].tool).toBe('fic_crea_cliente')
    expect(stato.anagrafiche[0].codice_fiscale).toBe(CF_VALIDO)
    expect(stato.inserite[0].tipo).toBe('fattura_ospite')
  })

  it('🚨 all\'anagrafica NON passa data ne\' luogo di nascita', async () => {
    await compila({ adulti: undefined, bambini: undefined, date_nascita: ['1985-10-01', '1987-03-12', '2018-06-30'] })
    const spedito = JSON.stringify(stato.anagrafiche[0])
    expect(spedito).not.toContain('1985-10-01')
    expect(spedito).not.toMatch(/nascita/i)
  })

  it('🚨 l\'anteprima dice tutto quello che si legge PRIMA della conferma unica', async () => {
    await compila()
    const a = stato.descrizione
    expect(a).toContain('LA REAL ESTATE SRLS')
    expect(a).toContain('VERDI GIUSEPPINA')
    expect(a).toMatch(/516,30 LORDI/)
    expect(a).toMatch(/payout netto/)
    expect(a).toMatch(/13,50 \(3 x 3 x 1,50\)/)
    expect(a).toMatch(/TOTALE documento: 529,80/)
    expect(a).toMatch(/art\. 15/)
    expect(a).toMatch(/Garante/)
    expect(a).toMatch(/VERIFICA FORMALE/)
    expect(a).toContain('/fic_ok')
  })

  it('con cliente_id NON tocca l\'anagrafica', async () => {
    const r = await compila({ cliente_id: 777 })
    expect(r.ok).toBe(true)
    expect(stato.anagrafiche).toHaveLength(0)
  })

  it('🚨 CF storto: NIENTE anagrafica, NIENTE bozza', async () => {
    const r = await compila({ ospite: { ...INPUT.ospite, codice_fiscale: CF_STORTO } })
    expect(r.ok).toBe(false)
    expect(stato.anagrafiche).toHaveLength(0)
    expect(stato.inserite).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: col CF giusto l\'anagrafica e la bozza nascono', async () => {
    const r = await compila()
    expect(r.ok).toBe(true)
    expect(stato.anagrafiche).toHaveLength(1)
    expect(stato.inserite).toHaveLength(1)
  })

  it('🚨 doppione gia\' su FIC: NIENTE anagrafica, NIENTE bozza, e dice qual e\'', async () => {
    stato.emesse = [{
      id: 552778017,
      number: 20,
      date: '2027-09-15',
      amount_gross: 529.8,
      visible_subject: 'Soggiorno Blue Maison 1 - prenotazione Booking.com n. 7100000001',
    }]
    const r = await compila()
    expect(r.ok).toBe(false)
    expect(r.fattura_esistente.id).toBe(552778017)
    expect(stato.anagrafiche).toHaveLength(0)
    expect(stato.inserite).toHaveLength(0)
  })

  it('🚨 elenco TRONCATO: si rifiuta invece di dire «non c\'e\'»', async () => {
    stato.elencoTroncato = true
    const r = await compila()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/troncato/i)
    expect(stato.inserite).toHaveLength(0)
  })

  it('se l\'anagrafica non nasce, la bozza NON nasce', async () => {
    stato.rispostaAnagrafica = { ok: false, error: 'Fatture in Cloud ha rifiutato' }
    const r = await compila()
    expect(r.ok).toBe(false)
    expect(stato.inserite).toHaveLength(0)
  })

  it('se l\'anagrafica torna senza id, NON si intesta a un id inventato', async () => {
    stato.rispostaAnagrafica = { ok: true, creato: true }
    const r = await compila()
    expect(r.ok).toBe(false)
    expect(stato.inserite).toHaveLength(0)
  })

  it('⚠️ se in anagrafica ce n\'erano piu\' d\'una, l\'anteprima lo DICE', async () => {
    stato.rispostaAnagrafica = { ok: true, creato: false, cliente_id: 900001, clienti: [{ id: 900001 }, { id: 900002 }] }
    await compila()
    expect(stato.descrizione).toMatch(/ATTENZIONE/)
  })
})

describe('la conferma UNICA crea la fattura', () => {
  it('un solo /fic_ok e la fattura nasce, riletta e verificata', async () => {
    await compila()
    const payload = stato.inserite[0].payload as Record<string, unknown>
    stato.riga = { id: 'pend-1', tipo: 'fattura_ospite', payload, conferme: 1, stato: 'in_attesa', societa: 'larealestate' }

    const messaggio = await confirmFicStep1('pend-1')

    expect(stato.creati).toHaveLength(1)
    expect(messaggio).toMatch(/FATTURA CREATA/)
    expect(messaggio).toMatch(/XML VALIDO/)
    // 🚨 Non si chiede una seconda conferma: la riga si chiude qui.
    expect(messaggio).not.toMatch(/fic_ok2/)
    const chiusura = stato.updates.find((u) => u.stato === 'creata')
    expect(chiusura?.fic_document_id).toBe('999')
  })

  it('🚨 il documento spedito a FIC e\' quello dell\'anteprima, non un altro', async () => {
    await compila()
    const payload = stato.inserite[0].payload as Record<string, unknown>
    stato.riga = { id: 'pend-1', tipo: 'fattura_ospite', payload, conferme: 1, stato: 'in_attesa', societa: 'larealestate' }
    await confirmFicStep1('pend-1')

    const spedito = stato.creati[0]
    expect(spedito).toEqual((payload as { documento: unknown }).documento)
    expect(spedito.use_gross_prices).toBe(true)
    expect(spedito.e_invoice).toBe(true)
    expect(spedito.numeration).toBe('')
    expect(spedito.payment_method).toBeUndefined()
    expect(spedito.extra_data).toEqual({ debt_vat_detect: true, revenue_detect: true })
  })

  it('🚨 se fra l\'anteprima e la conferma la fattura e\' nata altrove, NON se ne crea una seconda', async () => {
    await compila()
    const payload = stato.inserite[0].payload as Record<string, unknown>
    stato.riga = { id: 'pend-1', tipo: 'fattura_ospite', payload, conferme: 1, stato: 'in_attesa', societa: 'larealestate' }
    // L'anti-doppione si RIFA' al momento della scrittura: in mezzo c'e' una
    // conferma, e l'Ingegnere puo' averla emessa a mano dal gestionale.
    stato.emesse = [{ id: 1, number: 21, date: '2027-09-15', amount_gross: 529.8, visible_subject: 'prenotazione Booking.com n. 7100000001' }]

    const messaggio = await confirmFicStep1('pend-1')
    expect(stato.creati).toHaveLength(0)
    expect(messaggio).toMatch(/GIA'/)
  })
})
