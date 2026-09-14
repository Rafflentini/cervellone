/**
 * GET /api/fic-pdf/[societa]/[id] — un documento fiscale non si serve a
 * chiunque conosca l'indirizzo.
 *
 * Ogni difesa qui ha accanto il suo CONTROLLO POSITIVO: senza, una rotta che
 * rifiuta SEMPRE passerebbe tutte le prove di rifiuto e sembrerebbe sana.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { getAuthToken, signShareToken } from '@/lib/doc-access'
import { chiaveLinkPdf } from '@/lib/fic-allegato'

beforeAll(() => { process.env.AUTH_SECRET = 'test-secret' })

// Il PDF non si scarica davvero: questa rotta si prova per quello che fa lei —
// chi lascia entrare, cosa consegna e come dichiara i guasti — non per il
// motore di `fic-allegato.ts`, che ha i suoi test.
const pdfFinto = vi.fn()
vi.mock('@/lib/fic-allegato', async (originale) => {
  const vero = await originale<typeof import('@/lib/fic-allegato')>()
  return { ...vero, pdfDocumentoEmesso: (...a: unknown[]) => pdfFinto(...a) }
})

const META = {
  id: 77,
  numero: '19/ED',
  data: '2026-06-15',
  totale: 501.05,
  tipo: 'fattura',
  cliente: 'CONDOMINIO VIA ROMA 1',
  nome_file: 'fattura-19-ED-2026-06-15.pdf',
}

function pdfOk() {
  return { ok: true as const, buffer: Buffer.from('%PDF-1.7 finto'), meta: META, autenticazione: 'nessuna' as const }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function req(url: string, cookie?: string): any {
  return { url, cookies: { get: () => (cookie ? { value: cookie } : undefined) } }
}

function params(societa: string, id: string) {
  return { params: Promise.resolve({ societa, id }) }
}

/** Il link come lo firma il tool: stessa chiave, stessa forma. */
function linkFirmato(societa: string, id: string, fraSecondi = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + fraSecondi
  const t = signShareToken(chiaveLinkPdf(societa, id), exp)
  return `https://x/api/fic-pdf/${societa}/${id}?t=${t}&exp=${exp}`
}

describe('GET /api/fic-pdf/[societa]/[id]', () => {
  beforeEach(() => {
    pdfFinto.mockReset()
    pdfFinto.mockResolvedValue(pdfOk())
  })

  it('🚨 401 senza nessun token', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('https://x/api/fic-pdf/restruktura/77'), params('restruktura', '77'))
    expect(res.status).toBe(401)
    // E non ha nemmeno chiesto il documento a Fatture in Cloud.
    expect(pdfFinto).not.toHaveBeenCalled()
  })

  // ── CONTROLLO POSITIVO della riga qui sopra ────────────────────────
  it('CONTROLLO POSITIVO — 200 con un collegamento firmato valido, ed e un PDF', async () => {
    const { GET } = await import('./route')
    const res = await GET(req(linkFirmato('restruktura', '77')), params('restruktura', '77'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain('fattura-19-ED-2026-06-15.pdf')
    expect(res.headers.get('cache-control')).toContain('no-store')
    const byte = Buffer.from(await res.arrayBuffer())
    expect(byte.subarray(0, 4).toString('latin1')).toBe('%PDF')
  })

  it('CONTROLLO POSITIVO — 200 anche col cookie di sessione (l Ingegnere sul web)', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('https://x/api/fic-pdf/restruktura/77', getAuthToken()), params('restruktura', '77'))
    expect(res.status).toBe(200)
  })

  it('🚨 un collegamento SCADUTO non apre piu niente', async () => {
    const { GET } = await import('./route')
    const res = await GET(req(linkFirmato('restruktura', '77', -60)), params('restruktura', '77'))
    expect(res.status).toBe(401)
    expect(pdfFinto).not.toHaveBeenCalled()
  })

  it('🚨 il collegamento di UNA societa non apre lo stesso id dell ALTRA', async () => {
    // Stesso id, altra societa: due documenti diversi su due account diversi.
    const url = linkFirmato('restruktura', '77').replace('/restruktura/', '/larealestate/')
    const { GET } = await import('./route')
    const res = await GET(req(url), params('larealestate', '77'))
    expect(res.status).toBe(401)
    expect(pdfFinto).not.toHaveBeenCalled()
  })

  it('🚨 il collegamento di UN documento non apre un ALTRO documento', async () => {
    const url = linkFirmato('restruktura', '77').replace('/restruktura/77', '/restruktura/78')
    const { GET } = await import('./route')
    const res = await GET(req(url), params('restruktura', '78'))
    expect(res.status).toBe(401)
  })

  it('🚨 un token inventato non vale', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const { GET } = await import('./route')
    const res = await GET(
      req(`https://x/api/fic-pdf/restruktura/77?t=${'a'.repeat(64)}&exp=${exp}`),
      params('restruktura', '77'),
    )
    expect(res.status).toBe(401)
  })

  it('una societa sconosciuta da 401, non 404: senza token non si scopre nemmeno cosa esiste', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('https://x/api/fic-pdf/inventata/77'), params('inventata', '77'))
    expect(res.status).toBe(401)
  })

  it('una societa sconosciuta CON il cookie da 404 e la nomina', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('https://x/api/fic-pdf/inventata/77', getAuthToken()), params('inventata', '77'))
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('inventata')
    expect(pdfFinto).not.toHaveBeenCalled()
  })

  it('un id non numerico e rifiutato (con il cookie: l accesso viene prima)', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('https://x/api/fic-pdf/restruktura/ciao', getAuthToken()), params('restruktura', 'ciao'))
    expect(res.status).toBe(400)
    expect(pdfFinto).not.toHaveBeenCalled()
  })

  // ── SE NON SI LEGGE, SI DICE ───────────────────────────────────────
  it('🚨 il PDF non si scarica: 502 col motivo VERO, non un «non disponibile»', async () => {
    pdfFinto.mockResolvedValue({
      ok: false,
      motivo: 'scaricamento',
      messaggio: 'Non sono riuscito a scaricare il PDF del documento 77: senza token HTTP 403 — Forbidden.',
      meta: META,
    })
    const { GET } = await import('./route')
    const res = await GET(req(linkFirmato('restruktura', '77')), params('restruktura', '77'))
    expect(res.status).toBe(502)
    const corpo = await res.text()
    expect(corpo).toContain('HTTP 403')
    expect(corpo.toLowerCase()).not.toContain('non disponibile')
    // E soprattutto: NON esce un corpo vuoto spacciato per PDF.
    expect(res.headers.get('content-type')).not.toBe('application/pdf')
  })

  it('🚨 i byte non sono un PDF: 502, e lo dice', async () => {
    pdfFinto.mockResolvedValue({
      ok: false,
      motivo: 'non_pdf',
      messaggio: 'L\'indirizzo del documento 77 ha risposto, ma NON ha mandato un PDF: 64 byte riconosciuti come «altro».',
      meta: META,
    })
    const { GET } = await import('./route')
    const res = await GET(req(linkFirmato('restruktura', '77')), params('restruktura', '77'))
    expect(res.status).toBe(502)
    expect(await res.text()).toContain('NON ha mandato un PDF')
    expect(res.headers.get('content-type')).not.toBe('application/pdf')
  })

  it('FIC non espone nessun file: 404, che e una cosa diversa dal 502', async () => {
    pdfFinto.mockResolvedValue({
      ok: false,
      motivo: 'nessun_url',
      messaggio: 'Fatture in Cloud non espone nessun file (campo url) per il documento emesso 77.',
      meta: META,
    })
    const { GET } = await import('./route')
    const res = await GET(req(linkFirmato('restruktura', '77')), params('restruktura', '77'))
    expect(res.status).toBe(404)
  })
})
