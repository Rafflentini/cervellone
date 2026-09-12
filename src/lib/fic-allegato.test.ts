/**
 * Task 14 — leggere cosa ha scritto il FORNITORE sulla fattura, non cosa
 * abbiamo registrato NOI.
 *
 * Il fatto che genera questo test: tre ore di conversazione in cui il bot ha
 * riportato l'assenza di `payment_account` (il NOSTRO conto di pagamento)
 * come assenza della `ModalitaPagamento` scritta dal fornitore nell'XML SDI.
 * `ModalitaPagamento` non è esposta da nessun campo di `ReceivedDocument`:
 * l'unica via è scaricare l'allegato (`attachment_url`) e leggerlo.
 *
 * Questo file non parla mai con Fatture in Cloud: `fetch` è finto.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// pdf-parse (usato via testoDaPdf, riesportato da drive.ts) non va mai
// invocato per davvero nei test: finge sempre lo stesso testo estratto,
// così il caso "allegato PDF" prova la strada senza dipendere dalla libreria.
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText() { return { text: 'pagamento contanti', numpages: 1 } }
    async destroy() {}
  },
}))

import { leggiAllegatoFatturaRicevuta } from './fic-allegato'

const fetchFinto = vi.fn()

function rispostaJson(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function rispostaBinaria(
  contenuto: string | Buffer,
  opts: { status?: number; contentLength?: string | null } = {},
): Response {
  const buf = Buffer.isBuffer(contenuto) ? contenuto : Buffer.from(contenuto, 'utf-8')
  const status = opts.status ?? 200
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? (opts.contentLength ?? String(buf.length)) : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString('utf-8'),
  } as unknown as Response
}

/** Documento FIC ricevuto, come lo restituisce /received_documents/{id}. */
function documento(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    type: 'expense',
    entity: { id: 5, name: 'EDIL LIMONGI SRL' },
    attachment_url: 'https://files.fattureincloud.it/tmp/allegato-42.xml',
    payments_list: [{ id: 1, amount: 122, status: 'paid', payment_account: { id: 222, name: 'Carta di credito' } }],
    ...over,
  }
}

const XML_MP01 = `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12">
  <FatturaElettronicaBody>
    <DatiPagamento>
      <CondizioniPagamento>TP02</CondizioniPagamento>
      <DettaglioPagamento>
        <ModalitaPagamento>MP01</ModalitaPagamento>
        <ImportoPagamento>122.00</ImportoPagamento>
      </DettaglioPagamento>
    </DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>`

const XML_MP99 = XML_MP01.replace('MP01', 'MP99')

describe('leggiAllegatoFatturaRicevuta', () => {
  beforeEach(() => {
    fetchFinto.mockReset()
    vi.stubGlobal('fetch', fetchFinto)
    process.env.FIC_COMPANY_ID = '111'
    process.env.FIC_ACCESS_TOKEN = 'token-restruktura'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('XML SDI con MP01 → contanti, e lo dichiara come scritto dal fornitore', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: documento() })) // GET dettaglio
      .mockResolvedValueOnce(rispostaBinaria(XML_MP01)) // GET attachment_url
    const r = await leggiAllegatoFatturaRicevuta(42, 'restruktura')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.formato).toBe('xml')
    expect(r.modalita_sdi).toBe('MP01')
    expect(r.modalita_leggibile).toBe('contanti')
    expect(r.testo).toContain('ModalitaPagamento')
  })

  // Controllo positivo dell'assenza sotto: qui il tool VIENE chiamato (URL
  // dell'allegato) e la risposta arriva — prova che il percorso funziona
  // quando c'è qualcosa da leggere, non solo quando manca.
  it('un codice SDI ignoto (MP99) si restituisce grezzo e dichiarato non in tabella', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: documento() }))
      .mockResolvedValueOnce(rispostaBinaria(XML_MP99))
    const r = await leggiAllegatoFatturaRicevuta(42, 'restruktura')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.modalita_sdi).toBe('MP99')
    expect(r.modalita_leggibile).toContain('MP99')
    expect(r.modalita_leggibile).toContain('non in tabella')
  })

  it('nessun allegato → motivo nessun_allegato, con un messaggio che dice cosa fare', async () => {
    fetchFinto.mockResolvedValueOnce(rispostaJson({ data: documento({ attachment_url: undefined }) }))
    const r = await leggiAllegatoFatturaRicevuta(42, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('nessun_allegato')
    expect(r.messaggio.toLowerCase()).not.toContain('non trovato')
    // Deve dire COSA fare, non solo constatare l'assenza.
    expect(r.messaggio).toMatch(/fornitore|carica|drive/i)
    // Non deve nemmeno provare a chiamare l'URL: non ne esiste uno da chiamare.
    expect(fetchFinto).toHaveBeenCalledTimes(1)
  })

  it('un PDF di cortesia si legge estraendone il testo, e dichiara formato pdf', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: documento({ attachment_url: 'https://files.fattureincloud.it/tmp/allegato-42.pdf' }) }))
      .mockResolvedValueOnce(rispostaBinaria(Buffer.from('%PDF-1.4 finto')))
    const r = await leggiAllegatoFatturaRicevuta(42, 'restruktura')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.formato).toBe('pdf')
    expect(r.testo).toContain('pagamento contanti')
  })

  it('l allegato non scaricabile (HTTP 404) dichiara il fallimento, non un testo vuoto', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: documento() }))
      .mockResolvedValueOnce(rispostaBinaria('', { status: 404 }))
    const r = await leggiAllegatoFatturaRicevuta(42, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('scaricamento')
    expect(r.messaggio).toMatch(/404/)
  })

  it('un allegato oltre il tetto di dimensione lo dichiara, non lo tronca in silenzio', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: documento() }))
      .mockResolvedValueOnce(rispostaBinaria('x', { contentLength: String(11 * 1024 * 1024) }))
    const r = await leggiAllegatoFatturaRicevuta(42, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('scaricamento')
    expect(r.messaggio).toMatch(/grande|MB/i)
  })

  it('il dettaglio documento fallisce (errore FIC) → motivo scaricamento, non un crash', async () => {
    fetchFinto.mockResolvedValueOnce(rispostaJson({}, 500))
    const r = await leggiAllegatoFatturaRicevuta(42, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('scaricamento')
  })
})
