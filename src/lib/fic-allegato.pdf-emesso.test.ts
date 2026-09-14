/**
 * 14 settembre 2026 — il PDF di un documento EMESSO, per rivederlo prima di
 * trasmetterlo allo SdI.
 *
 * Questo file non parla mai con Fatture in Cloud: `fetch` e' finto. Prova le
 * due cose che non si potevano provare in produzione prima di scrivere il
 * codice — se l'`url` di FIC voglia o no il token — e le due difese che
 * nascono dal non saperlo: si ritenta col token SOLO su 401/403 e SOLO verso
 * un host di Fatture in Cloud.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { pdfDocumentoEmesso, chiaveLinkPdf } from './fic-allegato'

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
    headers: {
      get: (h: string) => (h.toLowerCase() === 'content-length' ? (opts.contentLength ?? String(buf.length)) : null),
    },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    text: async () => buf.toString('utf-8'),
  } as unknown as Response
}

const PDF_FINTO = Buffer.from('%PDF-1.7\nfinto ma con i byte giusti')

/** Documento EMESSO come lo restituisce /issued_documents/{id}?fieldset=detailed. */
function emesso(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 77,
    type: 'invoice',
    number: 19,
    numeration: '/ED',
    date: '2026-06-15',
    amount_gross: 501.05,
    entity: { id: 5, name: 'CONDOMINIO VIA ROMA 1' },
    url: 'https://compute.fattureincloud.it/doc/77.pdf',
    ...over,
  }
}

/** L'header Authorization della n-esima chiamata a fetch, se c'e'. */
function autorizzazioneDellaChiamata(n: number): string | undefined {
  const init = fetchFinto.mock.calls[n]?.[1] as { headers?: Record<string, string> } | undefined
  return init?.headers?.Authorization
}

describe('pdfDocumentoEmesso', () => {
  beforeEach(() => {
    fetchFinto.mockReset()
    vi.stubGlobal('fetch', fetchFinto)
    process.env.FIC_COMPANY_ID = '111'
    process.env.FIC_ACCESS_TOKEN = 'token-restruktura'
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ── CONTROLLO POSITIVO ─────────────────────────────────────────────
  // Senza questo, una funzione che rifiuta SEMPRE passerebbe tutte le prove
  // delle difese qui sotto.
  it('CONTROLLO POSITIVO — l url risponde 200 con byte di PDF: il documento arriva', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: emesso() }))
      .mockResolvedValueOnce(rispostaBinaria(PDF_FINTO))

    const r = await pdfDocumentoEmesso(77, 'restruktura')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.buffer.subarray(0, 4).toString('latin1')).toBe('%PDF')
    // Dichiarata, non dedotta: al primo uso vero dira' quale strada ha funzionato.
    expect(r.autenticazione).toBe('nessuna')
    expect(r.meta.numero).toBe('19/ED')
    expect(r.meta.data).toBe('2026-06-15')
    expect(r.meta.totale).toBe(501.05)
    expect(r.meta.tipo).toBe('fattura')
    expect(r.meta.cliente).toBe('CONDOMINIO VIA ROMA 1')
    // Nome leggibile: numero e data, non l'id nudo — e senza la barra del numero.
    expect(r.meta.nome_file).toBe('fattura-19-ED-2026-06-15.pdf')
    // Primo tentativo: NESSUN token addosso. E' l'ipotesi che si prova per prima.
    expect(autorizzazioneDellaChiamata(1)).toBeUndefined()
  })

  it('401 su un host di Fatture in Cloud: ritenta col token e lo dichiara', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: emesso() }))
      .mockResolvedValueOnce(rispostaBinaria('non autorizzato', { status: 401 }))
      .mockResolvedValueOnce(rispostaBinaria(PDF_FINTO))

    const r = await pdfDocumentoEmesso(77, 'restruktura')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.autenticazione).toBe('bearer')
    expect(autorizzazioneDellaChiamata(1)).toBeUndefined()
    expect(autorizzazioneDellaChiamata(2)).toBe('Bearer token-restruktura')
  })

  // ── LA DIFESA: il token non si manda a chi non lo deve avere ───────
  it('🚨 401 da un host che NON e Fatture in Cloud: il token NON parte, e lo dice', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: emesso({ url: 'https://esempio-non-fic.test/doc/77.pdf' }) }))
      .mockResolvedValueOnce(rispostaBinaria('nope', { status: 401 }))

    const r = await pdfDocumentoEmesso(77, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('scaricamento')
    expect(r.messaggio).toContain('HTTP 401')
    expect(r.messaggio).toContain('esempio-non-fic.test')
    expect(r.messaggio).toMatch(/NON ho ritentato/i)
    // Due chiamate in tutto: dettaglio + un solo tentativo. Nessun terzo giro.
    expect(fetchFinto).toHaveBeenCalledTimes(2)
    // E in nessuna chiamata il token e' finito addosso a quell'host.
    for (let i = 0; i < fetchFinto.mock.calls.length; i++) {
      const url = String(fetchFinto.mock.calls[i][0])
      if (url.includes('esempio-non-fic.test')) expect(autorizzazioneDellaChiamata(i)).toBeUndefined()
    }
  })

  it('un 404 sull url NON si ritenta col token: un 404 col token resta un 404', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: emesso() }))
      .mockResolvedValueOnce(rispostaBinaria('not found', { status: 404 }))

    const r = await pdfDocumentoEmesso(77, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('scaricamento')
    expect(r.messaggio).toContain('HTTP 404')
    expect(fetchFinto).toHaveBeenCalledTimes(2)
  })

  it('entrambi i tentativi falliti: il messaggio porta TUTTI E DUE gli stati veri', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: emesso() }))
      .mockResolvedValueOnce(rispostaBinaria('no', { status: 403 }))
      .mockResolvedValueOnce(rispostaBinaria('no nemmeno col token', { status: 401 }))

    const r = await pdfDocumentoEmesso(77, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.messaggio).toContain('HTTP 403')
    expect(r.messaggio).toContain('HTTP 401')
    // Il messaggio deve DIRE il guasto, non nasconderlo dietro una formula.
    expect(r.messaggio.toLowerCase()).not.toContain('non disponibile')
  })

  // ── LA DIFESA: i BYTE, non il nome ─────────────────────────────────
  it('🚨 200 con estensione .pdf ma byte di HTML: riconosciuto e DICHIARATO, non consegnato', async () => {
    const paginaErrore = '<!doctype html><html><body><h1>Sessione scaduta</h1></body></html>'
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: emesso() }))
      .mockResolvedValueOnce(rispostaBinaria(paginaErrore))

    const r = await pdfDocumentoEmesso(77, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('non_pdf')
    expect(r.messaggio).toContain('NON ha mandato un PDF')
    // Dice cosa e' arrivato davvero: il formato riconosciuto e i primi byte.
    expect(r.messaggio).toContain('altro')
    expect(r.messaggio).toContain('<!doctype html>')
    // E porta comunque i dati del documento, cosi si sa DI COSA si sta parlando.
    expect(r.meta?.numero).toBe('19/ED')
  })

  it('nessun campo url sul documento: lo dice, e non prova a scaricare niente', async () => {
    fetchFinto.mockResolvedValueOnce(rispostaJson({ data: emesso({ url: undefined }) }))

    const r = await pdfDocumentoEmesso(77, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('nessun_url')
    expect(r.messaggio).toContain('19/ED')
    expect(fetchFinto).toHaveBeenCalledTimes(1)
  })

  it('il documento non si legge affatto: motivo documento, col messaggio vero di FIC', async () => {
    fetchFinto.mockResolvedValueOnce(rispostaJson({ error: 'x' }, 401))

    const r = await pdfDocumentoEmesso(77, 'restruktura')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.motivo).toBe('documento')
    expect(r.messaggio).toMatch(/revocat|non valido/i)
  })

  it('un autofattura dichiara il tipo E il codice SDI, che sta in ei_raw', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({
        data: emesso({
          type: 'self_supplier_invoice',
          ei_raw: { FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD17' } } } },
        }),
      }))
      .mockResolvedValueOnce(rispostaBinaria(PDF_FINTO))

    const r = await pdfDocumentoEmesso(77, 'restruktura')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.meta.tipo).toContain('autofattura')
    expect(r.meta.tipo).toContain('TD17')
  })

  it('un tipo fuori tabella non si nasconde: si restituisce grezzo e dichiarato', async () => {
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: emesso({ type: 'tipo_mai_visto' }) }))
      .mockResolvedValueOnce(rispostaBinaria(PDF_FINTO))

    const r = await pdfDocumentoEmesso(77, 'restruktura')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.meta.tipo).toContain('tipo_mai_visto')
    expect(r.meta.tipo).toContain('non in tabella')
  })

  it('🚨 il nome del file non puo spezzare Content-Disposition', async () => {
    // Il numero arriva da Fatture in Cloud, cioe' da fuori: se ci finisse un a
    // capo o una virgoletta, il nome entrerebbe in un header HTTP.
    fetchFinto
      .mockResolvedValueOnce(rispostaJson({ data: emesso({ number: 'a"\r\nX-Colpito: si', numeration: '' }) }))
      .mockResolvedValueOnce(rispostaBinaria(PDF_FINTO))

    const r = await pdfDocumentoEmesso(77, 'restruktura')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.meta.nome_file).not.toMatch(/["\r\n]/)
    expect(r.meta.nome_file).toMatch(/^[A-Za-z0-9._-]+\.pdf$/)
  })
})

describe('chiaveLinkPdf', () => {
  it('🚨 la societa fa parte della chiave: il 123 di una non e il 123 dell altra', () => {
    // I due account FIC hanno numerazioni indipendenti. Se la chiave fosse il
    // solo id, un collegamento firmato per la fattura 123 di Restruktura
    // aprirebbe anche la 123 de La Real Estate.
    expect(chiaveLinkPdf('restruktura', 123)).not.toBe(chiaveLinkPdf('larealestate', 123))
  })

  it('CONTROLLO POSITIVO — stessa societa e stesso id danno la stessa chiave', () => {
    expect(chiaveLinkPdf('restruktura', 123)).toBe(chiaveLinkPdf('restruktura', '123'))
  })
})
