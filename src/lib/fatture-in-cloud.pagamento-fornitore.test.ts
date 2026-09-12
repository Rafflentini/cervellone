/**
 * Task 14 — la cura del difetto vero: `mapDoc` deve NOMINARE la differenza fra
 * `payment_account` (il conto con cui NOI registriamo il pagamento) e la
 * `ModalitaPagamento` scritta dal FORNITORE (che mapDoc non può leggere).
 *
 * Il fatto di produzione: il bot ha visto `pagamenti_count: 1` e ha concluso
 * (per tre ore) che l'assenza di quel numero fosse l'assenza di quello che il
 * fornitore ha scritto sulla fattura. Senza un campo che dichiari «questo non
 * lo so leggere da qui», il prossimo modello rifà lo stesso errore.
 *
 * E il tool nuovo, `fic_leggi_allegato_fattura`: il bot non deve indovinare
 * che può scaricare l'allegato — per una funzione nuova serve un tool.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { executeFicTool, FIC_READ_TOOLS } from './fatture-in-cloud'

const AMBIENTE_ORIGINALE = { ...process.env }
const fetchFinto = vi.fn()

function risposta(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

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

describe('mapDoc nomina la differenza fra i due campi', () => {
  it('un pagamento registrato mostra IL CONTO, e dichiara che il campo del fornitore va letto altrove', async () => {
    fetchFinto.mockResolvedValueOnce(risposta({
      data: [{
        id: 42,
        entity: { name: 'EDIL LIMONGI SRL' },
        amount_gross: 122,
        payments_list: [{ id: 1, amount: 122, status: 'paid', payment_account: { id: 222, name: 'Carta di credito (CC Montepruno)' } }],
      }],
    }))
    const out = await executeFicTool('fic_fatture_ricevute', {}, 'restruktura')
    const parsed = JSON.parse(out || '{}')
    expect(parsed.ok).toBe(true)
    const doc = parsed.fatture[0]
    // Il campo NOSTRO: il conto con cui abbiamo registrato il pagamento.
    expect(doc.pagamento_registrato_da_noi).toBe('Carta di credito (CC Montepruno)')
    // Il campo che dichiara l'IGNORANZA di questo tool sul dato del fornitore.
    // Controllo positivo dell'assenza sopra: qui il valore ESISTE (non è null),
    // a dimostrazione che il campo si popola quando i dati ci sono.
    expect(typeof doc.modalita_scritta_dal_fornitore).toBe('string')
    expect(doc.modalita_scritta_dal_fornitore).toContain('fic_leggi_allegato_fattura')
  })

  it('nessun pagamento registrato → pagamento_registrato_da_noi è null, non un numero che si presta a essere letto come "niente"', async () => {
    fetchFinto.mockResolvedValueOnce(risposta({
      data: [{ id: 43, entity: { name: 'ALTRO FORNITORE' }, amount_gross: 50, payments_list: [{ id: 2, amount: 50, status: 'not_paid' }] }],
    }))
    const out = await executeFicTool('fic_fatture_ricevute', {}, 'restruktura')
    const parsed = JSON.parse(out || '{}')
    const doc = parsed.fatture[0]
    expect(doc.pagamento_registrato_da_noi).toBeNull()
    // Anche qui il tool dichiara la stessa ignoranza sul dato del fornitore:
    // l'assenza del NOSTRO conto non deve mai essere letta come assenza del SUO.
    expect(doc.modalita_scritta_dal_fornitore).toContain('fic_leggi_allegato_fattura')
  })
})

describe('fic_leggi_allegato_fattura: il tool nuovo', () => {
  it('è nell elenco dei tool FIC, cosi il bot non deve indovinare di poterlo usare', () => {
    const nomi = FIC_READ_TOOLS.map((t) => t.name)
    expect(nomi).toContain('fic_leggi_allegato_fattura')
  })

  it('senza id dichiara l errore, non un crash', async () => {
    const out = await executeFicTool('fic_leggi_allegato_fattura', {}, 'restruktura')
    const parsed = JSON.parse(out || '{}')
    expect(parsed.ok).toBe(false)
  })

  it('con id valido, scarica il documento e restituisce l esito di leggiAllegatoFatturaRicevuta', async () => {
    fetchFinto
      // GET /received_documents/{id} (chiamato da leggiAllegatoFatturaRicevuta)
      .mockResolvedValueOnce(risposta({ data: { id: 42, attachment_url: undefined } }))
    const out = await executeFicTool('fic_leggi_allegato_fattura', { id: 42 }, 'restruktura')
    const parsed = JSON.parse(out || '{}')
    expect(parsed.ok).toBe(false)
    expect(parsed.motivo).toBe('nessun_allegato')
  })
})
