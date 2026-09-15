/**
 * src/lib/fatture-in-cloud.pagamento-stornato.test.ts — il PIANO PAGAMENTI
 * dell'integrazione in reverse charge, confrontato col documento modello.
 *
 * 🚨 Il modello, `issued_documents/552759661` (l'autofattura TD17 corretta a
 * mano dall'Ingegnere e INVIATA allo SdI), porta:
 *
 *     "payments_list": [{ "amount": 291.78, "due_date": "2026-09-03",
 *                         "paid_date": null, "status": "reversed",
 *                         "payment_account": null }]
 *
 * dove 291,78 e' il LORDO (239,16 + 52,62 di IVA) e 2026-09-03 e' la data del
 * documento, non una scadenza a trenta giorni.
 *
 * Tre cose che questo file pinna, e che ognuna e' costata un giro a vuoto:
 *  - `reversed` e non `paid`: un pagamento saldato pretende il conto di saldo,
 *    e FIC rifiutava la creazione con 422;
 *  - `reversed` e non `not_paid`: col piano a trenta giorni l'autofattura
 *    compariva SCADUTA, col tasto «manda sollecito» verso Booking.com;
 *  - l'importo e' il LORDO. Col solo imponibile il piano non combacia col
 *    totale e Fatture in Cloud rifiuta il documento.
 *
 * ⚠️ E c'e' un CONTROLLO POSITIVO che conta quanto gli altri: una fattura
 * normale (non stornata) deve continuare a nascere `not_paid` a trenta giorni.
 * Una difesa che storna TUTTO passerebbe i test qui sopra e romperebbe ogni
 * fattura emessa ai clienti.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { creaDocumentoFIC } from './fatture-in-cloud'

const AMBIENTE_ORIGINALE = { ...process.env }

/** Gli importi del documento modello. */
const NETTO = 239.16
const LORDO = 291.78
const DATA_DOCUMENTO = '2026-09-03'

const fetchFinto = vi.fn()

/** L'ultimo corpo spedito a `POST /issued_documents`. */
function corpoCreato(): Record<string, unknown> {
  const chiamata = fetchFinto.mock.calls.find(([url]) => String(url).endsWith('/issued_documents'))
  if (!chiamata) throw new Error('nessuna POST su /issued_documents')
  return JSON.parse(String(chiamata[1].body)).data
}

function risposta(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const PAYLOAD_INTEGRAZIONE = {
  type: 'self_supplier_invoice',
  date: DATA_DOCUMENTO,
  numeration: 'INT',
  e_invoice: true,
  entity: { id: 54043577, name: 'Booking.com B.V.' },
  items_list: [{ name: 'Integrazione art. 17 c.2 DPR 633/72', qty: 1, net_price: NETTO, vat: { id: 0 } }],
}

describe('il piano pagamenti dell integrazione ricalca il documento modello', () => {
  beforeEach(() => {
    fetchFinto.mockReset()
    vi.stubGlobal('fetch', fetchFinto)
    process.env.FIC_COMPANY_ID_LAREALESTATE = '222'
    process.env.FIC_ACCESS_TOKEN_LAREALESTATE = 'token-finto'
    // `POST /issued_documents/totals` -> il LORDO calcolato da FIC;
    // `POST /issued_documents`       -> il documento creato.
    fetchFinto.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/totals')) return risposta({ data: { amount_net: NETTO, amount_gross: LORDO, amount_due: LORDO } })
      return risposta({ data: { id: 552759661, url: null } })
    })
  })

  afterEach(() => {
    process.env = { ...AMBIENTE_ORIGINALE }
    vi.unstubAllGlobals()
  })

  it('🚨 l importo del piano e il LORDO, non l imponibile', async () => {
    await creaDocumentoFIC(PAYLOAD_INTEGRAZIONE, 'larealestate', { pagamentoStornato: true })
    const pagamenti = corpoCreato().payments_list as Array<Record<string, unknown>>

    expect(pagamenti).toHaveLength(1)
    expect(pagamenti[0].amount).toBe(LORDO)
    // CONTROLLO che sappia fallire: col netto il piano non combacerebbe.
    expect(pagamenti[0].amount).not.toBe(NETTO)
  })

  it('🚨 lo stato e «reversed» e la scadenza e la DATA DEL DOCUMENTO', async () => {
    await creaDocumentoFIC(PAYLOAD_INTEGRAZIONE, 'larealestate', { pagamentoStornato: true })
    const pagamenti = corpoCreato().payments_list as Array<Record<string, unknown>>

    expect(pagamenti[0].status).toBe('reversed')
    expect(pagamenti[0].due_date).toBe(DATA_DOCUMENTO)
    // ⚠️ Niente conto di saldo: su un reverse charge non si e' pagato niente,
    // e `paid` pretenderebbe di sapere su quale conto (422 di FIC).
    expect(pagamenti[0].payment_account).toBeUndefined()
  })

  it('CONTROLLO POSITIVO — una fattura NORMALE nasce not_paid e scade dopo, non lo stesso giorno', async () => {
    // Senza questo, stornare TUTTO passerebbe i due test qui sopra e
    // romperebbe ogni fattura emessa ai clienti: nessuna risulterebbe piu' da
    // incassare.
    await creaDocumentoFIC({ ...PAYLOAD_INTEGRAZIONE, type: 'invoice' }, 'larealestate')
    const pagamenti = corpoCreato().payments_list as Array<Record<string, unknown>>

    expect(pagamenti[0].status).toBe('not_paid')
    expect(pagamenti[0].due_date).not.toBe(DATA_DOCUMENTO)
  })

  it('un piano pagamenti gia scritto dal chiamante NON viene sovrascritto', async () => {
    // E' il caso della SPESA, che si scrive il suo piano saldato per
    // compensazione: se questa funzione lo rifacesse, la spesa tornerebbe
    // nello scadenzario.
    const mio = [{ due_date: DATA_DOCUMENTO, paid_date: DATA_DOCUMENTO, amount: LORDO, status: 'paid', payment_account: { id: 1570742 } }]
    await creaDocumentoFIC({ ...PAYLOAD_INTEGRAZIONE, payments_list: mio }, 'larealestate', { pagamentoStornato: true })

    expect(corpoCreato().payments_list).toEqual(mio)
  })
})
