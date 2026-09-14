/**
 * `fic_pdf_documento` — il link al PDF di un documento EMESSO.
 *
 * Due cose si provano qui, e sono diverse fra loro:
 *  1. che il LINK sia firmato, legato a societa+id, e che scada;
 *  2. che il tool sia RAGGIUNGIBILE dalla catena di `executeTool` — la lezione
 *     del 14 settembre 2026 (`tools.gmail-allegato-catena.test.ts`): un tool
 *     registrato in cinque posti puo' essere comunque irraggiungibile, perche'
 *     un esecutore che sta prima nella catena rivendica il suo prefisso.
 *     `executeFicTool` rivendica OGNI nome che comincia per `fic_`.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'

const { spiaPdf, spiaSocieta } = vi.hoisted(() => ({
  spiaPdf: vi.fn(),
  spiaSocieta: vi.fn(async () => ({ ok: true as const, codice: 'restruktura' as const })),
}))

// Mock PARZIALE: `fic-allegato` esporta anche le funzioni degli allegati delle
// fatture ricevute, che altri esecutori della catena importano davvero.
vi.mock('@/lib/fic-allegato', async (originale) => {
  const vero = await originale<typeof import('@/lib/fic-allegato')>()
  return { ...vero, pdfDocumentoEmesso: (...a: unknown[]) => spiaPdf(...a) }
})
vi.mock('@/lib/societa-attiva', async (originale) => {
  const vero = await originale<typeof import('@/lib/societa-attiva')>()
  return { ...vero, leggiSocietaAttiva: () => spiaSocieta() }
})

import { executeFicPdfTool, FIC_PDF_TOOLS, DURATA_LINK_MINUTI } from './fic-pdf-tools'
import { chiaveLinkPdf } from '@/lib/fic-allegato'
import { verifyShareToken } from '@/lib/doc-access'

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

beforeAll(() => {
  process.env.AUTH_SECRET = 'test-secret'
  process.env.APP_BASE_URL = 'https://cervellone-five.vercel.app'
  // Valori finti, e servono solo al controllo positivo della catena: senza,
  // `executeFicTool` si ferma su «token non configurato» prima di arrivare a
  // dire «tool FIC sconosciuto», e il controllo proverebbe un'altra cosa.
  process.env.FIC_COMPANY_ID = '111'
  process.env.FIC_ACCESS_TOKEN = 'token-finto-di-prova'
})

beforeEach(() => {
  spiaPdf.mockReset()
  spiaPdf.mockResolvedValue(pdfOk())
  process.env.AUTH_SECRET = 'test-secret'
})

describe('fic_pdf_documento', () => {
  it('CONTROLLO POSITIVO — restituisce un link firmato, coi dati per riconoscere il documento', async () => {
    const r = JSON.parse((await executeFicPdfTool('fic_pdf_documento', { id: 77 }, 'restruktura'))!)
    expect(r.ok).toBe(true)
    expect(r.numero).toBe('19/ED')
    expect(r.data).toBe('2026-06-15')
    expect(r.totale).toBe(501.05)
    expect(r.tipo).toBe('fattura')
    expect(r.cliente).toBe('CONDOMINIO VIA ROMA 1')

    const link = new URL(r.link)
    expect(link.pathname).toBe('/api/fic-pdf/restruktura/77')
    const t = link.searchParams.get('t')!
    const exp = Number(link.searchParams.get('exp'))
    // Il token e' quello che la rotta verifichera', sulla chiave che lega
    // societa e id: se cambiasse una delle due, non aprirebbe piu' niente.
    expect(verifyShareToken(chiaveLinkPdf('restruktura', 77), t, exp)).toBe(true)
  })

  it('🚨 il link SCADE: la scadenza e quella dichiarata, non l infinito', async () => {
    const r = JSON.parse((await executeFicPdfTool('fic_pdf_documento', { id: 77 }, 'restruktura'))!)
    const exp = Number(new URL(r.link).searchParams.get('exp'))
    const adesso = Math.floor(Date.now() / 1000)
    expect(exp).toBeGreaterThan(adesso)
    expect(exp - adesso).toBeLessThanOrEqual(DURATA_LINK_MINUTI * 60)
    // Mezz'ora, non un giorno: e' un documento fiscale con dentro dati di
    // clienti veri, e serve per un controllo che si fa subito.
    expect(DURATA_LINK_MINUTI).toBeLessThanOrEqual(60)
    expect(r.scade_fra_minuti).toBe(DURATA_LINK_MINUTI)
  })

  it('🚨 il token vale per QUELLA societa e QUEL documento, non per gli altri', async () => {
    const r = JSON.parse((await executeFicPdfTool('fic_pdf_documento', { id: 77 }, 'restruktura'))!)
    const link = new URL(r.link)
    const t = link.searchParams.get('t')!
    const exp = Number(link.searchParams.get('exp'))
    expect(verifyShareToken(chiaveLinkPdf('larealestate', 77), t, exp)).toBe(false)
    expect(verifyShareToken(chiaveLinkPdf('restruktura', 78), t, exp)).toBe(false)
  })

  it('🚨 il PDF non arriva: NESSUN link, e il motivo vero con lo stato HTTP', async () => {
    spiaPdf.mockResolvedValue({
      ok: false,
      motivo: 'scaricamento',
      messaggio: 'Non sono riuscito a scaricare il PDF del documento 77: senza token HTTP 403 — Forbidden.',
      meta: META,
    })
    const grezzo = (await executeFicPdfTool('fic_pdf_documento', { id: 77 }, 'restruktura'))!
    const r = JSON.parse(grezzo)
    expect(r.ok).toBe(false)
    expect(r.motivo).toBe('scaricamento')
    expect(r.error).toContain('HTTP 403')
    // Un link «probabilmente valido» sposterebbe il guasto nel browser
    // dell'Ingegnere, dove nessuno lo sa spiegare: qui non ne esce nessuno.
    expect(grezzo).not.toContain('/api/fic-pdf/')
    expect(r.link).toBeUndefined()
  })

  it('🚨 i byte non erano un PDF: il motivo resta DISTINTO da «non si scarica»', async () => {
    spiaPdf.mockResolvedValue({
      ok: false,
      motivo: 'non_pdf',
      messaggio: 'ha risposto, ma NON ha mandato un PDF',
      meta: META,
    })
    const r = JSON.parse((await executeFicPdfTool('fic_pdf_documento', { id: 77 }, 'restruktura'))!)
    expect(r.motivo).toBe('non_pdf')
    expect(r.link).toBeUndefined()
    // I dati del documento restano, cosi' si sa DI COSA si parla.
    expect(r.documento.numero).toBe('19/ED')
  })

  it('🚨 senza AUTH_SECRET non si firma un link indovinabile: lo dice invece di morire', async () => {
    delete process.env.AUTH_SECRET
    const r = JSON.parse((await executeFicPdfTool('fic_pdf_documento', { id: 77 }, 'restruktura'))!)
    expect(r.ok).toBe(false)
    expect(r.motivo).toBe('firma')
    expect(r.error).toContain('AUTH_SECRET')
    expect(r.link).toBeUndefined()
  })

  it('un id che non e un numero viene rifiutato prima di chiamare Fatture in Cloud', async () => {
    const r = JSON.parse((await executeFicPdfTool('fic_pdf_documento', { id: 'la 19/ED' }, 'restruktura'))!)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('id non valido')
    expect(spiaPdf).not.toHaveBeenCalled()
  })

  it('l esecutore non rivendica nomi che non sono suoi', async () => {
    expect(await executeFicPdfTool('fic_fatture_emesse', {}, 'restruktura')).toBeNull()
  })

  it('la societa arriva dalla CONVERSAZIONE, non dall input: non e nello schema', () => {
    const schema = FIC_PDF_TOOLS[0].input_schema as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(['id'])
  })
})

/**
 * 🚨 LA CATENA. Un tool registrato dev'essere anche RAGGIUNGIBILE: `executeTool`
 * si ferma al primo esecutore che non risponde `null`, e `executeFicTool`, per
 * un nome che non conosce, risponde con una stringa («tool FIC sconosciuto»)
 * invece che con `null`.
 *
 * Finche' `executeFicWrapper` rivendicava OGNI `fic_*` per PREFISSO, questo
 * tool era raggiungibile solo perche' il suo esecutore viene PRIMA in
 * `EXECUTORS` — una condizione vera oggi che nessuno ricorda fra un mese, e la
 * stessa che il 14 settembre 2026 ha reso `gmail_leggi_allegato` invisibile in
 * produzione mentre era registrato in cinque posti.
 *
 * Dal 14 settembre 2026 quel wrapper rivendica per ELENCO
 * (`nomiDi(FIC_READ_TOOLS)`), come tutti gli altri wrapper contabili: l'ordine
 * non e' piu' portante, e un nome `fic_*` che non e' di nessuno cade in fondo
 * alla catena, dove `executeTool` lo rifiuta dicendolo.
 */
describe('fic_pdf_documento arriva davvero al suo esecutore', () => {
  it('🚨 la catena lo esegue: torna il link, non «tool FIC sconosciuto»', async () => {
    const { executeTool } = await import('@/lib/tools')
    const esito = await executeTool('fic_pdf_documento', { id: 77 }, 'conv-1')
    expect(esito).not.toContain('sconosciuto')
    expect(esito).not.toContain('non riconosciuto')
    expect(esito).toContain('/api/fic-pdf/restruktura/77')
    expect(spiaPdf).toHaveBeenCalledWith(77, 'restruktura')
  }, 30_000)

  it('CONTROLLO POSITIVO — un nome fic_ inesistente viene ancora rifiutato, non ingoiato', async () => {
    // Senza questo, un wrapper che tornasse sempre una risposta passerebbe il
    // test qui sopra e farebbe sparire ogni errore di battitura del modello.
    const { executeTool } = await import('@/lib/tools')
    const esito = await executeTool('fic_inventato_di_sana_pianta', {}, 'conv-1')
    expect(esito).toContain('non riconosciuto')
    expect(spiaPdf).not.toHaveBeenCalled()
  }, 30_000)

  it('🚨 senza conversazione non si esegue: la societa non si indovina', async () => {
    const { executeTool } = await import('@/lib/tools')
    const esito = await executeTool('fic_pdf_documento', { id: 77 })
    expect(esito).toContain('societa non determinabile')
    expect(spiaPdf).not.toHaveBeenCalled()
  }, 30_000)
})
