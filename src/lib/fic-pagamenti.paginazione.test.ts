/**
 * `cercaFattureRicevute` cammina sulle pagine di Fatture in Cloud e filtra il
 * fornitore su TUTTE quelle lette — non solo sulla prima.
 *
 * PRIMA di questo file, il filtro girava in memoria SOLO sulla pagina 1, e
 * `altre_pagine` leggeva `last_page` dell'insieme NON filtrato: con più di
 * 100 fatture ricevute nel periodo, il tool rifiutava SEMPRE — anche per 7
 * risultati — e le fatture del fornitore oltre la prima pagina non le vedeva
 * nessuno. Vedi `.superpowers/sdd/2026-09-12-guardia-dati-societari/
 * diagnosi-limongi-modalita-pagamento.md`, Difetto C.
 *
 * Non si chiama mai l'API vera: `fetch` è finto.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cercaFattureRicevute } from './fic-pagamenti'

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

/** Una fattura ricevuta minimale: l'unico campo che conta qui è entity.name. */
function fatturaDi(fornitore: string, id: number): Record<string, unknown> {
  return { id, type: 'expense', entity: { id, name: fornitore }, invoice_number: `n${id}`, date: '2026-03-04' }
}

/** Una pagina di risultati FIC: `nLimongi` fatture del fornitore cercato, il resto rumore. */
function pagina(nLimongi: number, nAltri: number, lastPage: number, startId: number) {
  const limongi = Array.from({ length: nLimongi }, (_, i) => fatturaDi('EDIL LIMONGI SRL', startId + i))
  const altri = Array.from({ length: nAltri }, (_, i) => fatturaDi('ALTRO FORNITORE SRL', startId + 1000 + i))
  return risposta({ data: [...limongi, ...altri], last_page: lastPage })
}

beforeEach(() => {
  fetchFinto.mockReset()
  vi.stubGlobal('fetch', fetchFinto)
  process.env.FIC_COMPANY_ID = '111'
  process.env.FIC_ACCESS_TOKEN = 'token-restruktura'
})

afterEach(() => {
  process.env = { ...AMBIENTE_ORIGINALE }
})

describe('cercaFattureRicevute: si cammina sulle pagine, si filtra su tutte quelle lette', () => {
  it('IL DIFETTO: con piu di una pagina di fatture, oggi rifiuta anche per 7 risultati filtrati', async () => {
    // pagina 1: 93 di rumore + 7 Limongi, last_page 3 — sull'insieme NON filtrato la
    // vecchia implementazione avrebbe messo altre_pagine=true anche se i 7 stanno tutti qui.
    fetchFinto
      .mockResolvedValueOnce(pagina(7, 93, 3, 1))
      .mockResolvedValueOnce(pagina(0, 100, 3, 200))
      .mockResolvedValueOnce(pagina(0, 50, 3, 400))

    const esito = await cercaFattureRicevute({ fornitore: 'Limongi', anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.valore.documenti).toHaveLength(7)
    expect(esito.valore.elenco_troncato).toBe(false)
  })

  it('CONTROLLO POSITIVO — le fatture del fornitore a pagina 2 e 3 vengono trovate', async () => {
    // 2 in pagina 1, 3 in pagina 2, 1 in pagina 3: se il filtro girasse solo sulla
    // prima pagina, qui il totale sarebbe 2, non 6.
    fetchFinto
      .mockResolvedValueOnce(pagina(2, 98, 3, 1))
      .mockResolvedValueOnce(pagina(3, 97, 3, 200))
      .mockResolvedValueOnce(pagina(1, 99, 3, 400))

    const esito = await cercaFattureRicevute({ fornitore: 'Limongi', anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.valore.documenti).toHaveLength(6)
    expect(esito.valore.elenco_troncato).toBe(false)
  })

  it('elenco_troncato e vero SOLO se il tetto di pagine non basta', async () => {
    for (let p = 1; p <= 10; p++) {
      fetchFinto.mockResolvedValueOnce(pagina(1, 99, 20, p * 1000))
    }
    const esito = await cercaFattureRicevute({ fornitore: 'Limongi', anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.valore.elenco_troncato).toBe(true)
    expect(esito.valore.pagine_lette).toBe(10)
    expect(fetchFinto).toHaveBeenCalledTimes(10)
  })

  it('una sola pagina: nessun giro in piu e elenco_troncato falso', async () => {
    fetchFinto.mockResolvedValueOnce(pagina(4, 6, 1, 1))
    const esito = await cercaFattureRicevute({ fornitore: 'Limongi', anno: 2026 }, 'restruktura')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.valore.documenti).toHaveLength(4)
    expect(esito.valore.elenco_troncato).toBe(false)
    expect(esito.valore.pagine_lette).toBe(1)
    expect(fetchFinto).toHaveBeenCalledTimes(1)
  })
})
