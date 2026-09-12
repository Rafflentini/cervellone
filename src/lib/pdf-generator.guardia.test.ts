/**
 * La guardia sui dati societari (Task 5) dentro i render — PDF, Word e i
 * metadati del file. Non ripete guardia-societa.test.ts (il confronto sulle
 * partite IVA è testato lì): qui si prova che `generatePdfFromHtml` e
 * `generateDocxFromHtml` la CHIAMINO davvero, PRIMA di costare un browser o
 * scaricare immagini, e che un chiamante che passa una società coerente non
 * venga disturbato.
 *
 * Vedi .superpowers/sdd/2026-09-12-guardia-dati-societari/task-5-brief.md e
 * note-task-5.md per le decisioni prese dal coordinatore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPdfBytes = Buffer.from('%PDF-1.7\n'.padEnd(30000, ' '))

const launchMock = vi.fn()
vi.mock('puppeteer-core', () => ({
  default: {
    launch: (...args: unknown[]) => launchMock(...args),
  },
}))

vi.mock('@sparticuz/chromium', () => ({
  default: {
    args: ['--no-sandbox'],
    executablePath: vi.fn(async () => '/tmp/chromium'),
    headless: 'shell',
    setHeadlessMode: vi.fn(),
    setGraphicsMode: false,
  },
}))

// Task 12 — la via d'uscita. Mockata qui: il suo comportamento VERO (le
// cinque scelte che la rendono sicura) e' provato in
// guardia-autorizzazioni.test.ts; qui interessa solo che i due imbuti la
// CONSULTINO davvero prima di dichiarare un blocco definitivo.
const mockAutorizzazioneValida = vi.fn()
const mockChiediAutorizzazione = vi.fn()
vi.mock('./guardia-autorizzazioni', () => ({
  autorizzazioneValida: (...a: unknown[]) => mockAutorizzazioneValida(...a),
  chiediAutorizzazione: (...a: unknown[]) => mockChiediAutorizzazione(...a),
}))

import {
  generatePdfFromHtml,
  generateDocxFromHtml,
  generateXlsxFromData,
  ErroreDatiSocietari,
} from './pdf-generator'

const RESTRUKTURA = { denominazione: 'RESTRUKTURA S.r.l.', piva: '02087420762' }
const LAREALESTATE = { denominazione: 'LA REAL ESTATE SRLS', piva: '02232730768' }

function makeMockBrowser() {
  const setContent = vi.fn(async (_html: string) => undefined)
  const pdf = vi.fn(async (_opts: Record<string, unknown>) => mockPdfBytes)
  return {
    newPage: vi.fn(async () => ({ setContent, pdf, close: vi.fn(async () => undefined) })),
    close: vi.fn(async () => undefined),
  }
}

/** Legge il campo `<dc:creator>` dai metadati OOXML (docx e xlsx usano lo stesso schema). */
async function creatorDi(buf: Buffer): Promise<string> {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buf)
  const core = await zip.file('docProps/core.xml')!.async('string')
  return core.match(/<dc:creator>([^<]*)<\/dc:creator>/)?.[1] ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  launchMock.mockResolvedValue(makeMockBrowser() as never)
  mockAutorizzazioneValida.mockResolvedValue(false)
  mockChiediAutorizzazione.mockResolvedValue({ uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
})

describe('la guardia sui dati societari, dentro generatePdfFromHtml', () => {
  it('CONTROLLO POSITIVO — PDF con la P.IVA di Restruktura e La Real Estate attesa: RIGETTA', async () => {
    await expect(
      generatePdfFromHtml('<h1>RESTRUKTURA S.r.l.</h1><p>02087420762</p>', 'x', { societa: LAREALESTATE }),
    ).rejects.toThrow(/02087420762/)
  })

  it('il rifiuto e un ErroreDatiSocietari, non un Error generico: claude.ts lo riconosce', async () => {
    await expect(
      generatePdfFromHtml('<p>02087420762</p>', 'x', { societa: LAREALESTATE }),
    ).rejects.toBeInstanceOf(ErroreDatiSocietari)
  })

  it('la guardia gira PRIMA di Chromium: un documento bloccato non deve costare un browser', async () => {
    await expect(
      generatePdfFromHtml('<p>02087420762</p>', 'x', { societa: LAREALESTATE }),
    ).rejects.toThrow()
    expect(launchMock).not.toHaveBeenCalled()
  })

  // CONTROLLO NEGATIVO: senza questo, una guardia che rifiuta SEMPRE
  // passerebbe il test sopra e renderebbe il PDF impossibile da generare.
  it('CONTROLLO NEGATIVO — societa coerente: genera, la guardia non interferisce', async () => {
    await expect(
      generatePdfFromHtml('<h1>RESTRUKTURA S.r.l.</h1><p>02087420762</p>', 'x', { societa: RESTRUKTURA }),
    ).resolves.toBeInstanceOf(Buffer)
    expect(launchMock).toHaveBeenCalledOnce()
  })

  it('un contenuto senza nessuna delle nostre P.IVA passa, qualunque sia la societa attesa', async () => {
    await expect(
      generatePdfFromHtml('<p>Preventivo per il committente Mario Rossi</p>', 'x', { societa: LAREALESTATE }),
    ).resolves.toBeInstanceOf(Buffer)
  })

  // Task 12 — la via d'uscita: senza, il messaggio di blocco prometteva
  // "dimmelo e lo genero comunque" senza nessun modo di mantenerla.
  it('Task 12 — senza autorizzazione, il blocco la CHIEDE (registra un nuovo codice)', async () => {
    await expect(
      generatePdfFromHtml('<h1>RESTRUKTURA S.r.l.</h1><p>02087420762</p>', 'x', {
        societa: LAREALESTATE,
        conversationId: 'conv-1',
      }),
    ).rejects.toBeInstanceOf(ErroreDatiSocietari)

    expect(mockChiediAutorizzazione).toHaveBeenCalledWith(
      'conv-1',
      expect.stringContaining('02087420762'),
      expect.objectContaining({ ok: false }),
    )
  })

  it('Task 12 — CONTROLLO NEGATIVO: con un\'autorizzazione valida per QUESTO contenuto, genera comunque', async () => {
    mockAutorizzazioneValida.mockResolvedValue(true)
    const html = '<h1>RESTRUKTURA S.r.l.</h1><p>02087420762</p>'

    await expect(
      generatePdfFromHtml(html, 'x', { societa: LAREALESTATE, conversationId: 'conv-1' }),
    ).resolves.toBeInstanceOf(Buffer)

    expect(mockAutorizzazioneValida).toHaveBeenCalledWith('conv-1', html)
    expect(mockChiediAutorizzazione).not.toHaveBeenCalled()
  })
})

describe('la guardia sui dati societari, dentro generateDocxFromHtml', () => {
  it('il Word si comporta identico al PDF: due formati dallo stesso HTML non possono divergere', async () => {
    await expect(
      generateDocxFromHtml('<p>02087420762</p>', 'x', { societa: LAREALESTATE }),
    ).rejects.toThrow(/02087420762/)
  })

  it('la guardia del Word gira PRIMA di costruire il documento', async () => {
    // Nessun modo diretto di "spiare" htmlToDocxBlocks da qui: il controllo
    // vero e' che il reject arrivi SENZA che generateDocxFromHtml provi a
    // scaricare immagini o costruire il pacchetto — cioe' che sia sincrono
    // rispetto al parsing, non un errore emerso a meta' strada.
    await expect(
      generateDocxFromHtml('<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA"><p>02087420762</p>', 'x', {
        societa: LAREALESTATE,
      }),
    ).rejects.toBeInstanceOf(ErroreDatiSocietari)
  })

  it('CONTROLLO NEGATIVO — Word con societa coerente: genera', async () => {
    await expect(
      generateDocxFromHtml('<p>Contratto</p>', 'x', { societa: RESTRUKTURA }),
    ).resolves.toBeInstanceOf(Buffer)
  })

  // Task 12 — stesso imbuto, stessa via d'uscita del PDF: due formati dallo
  // stesso HTML non possono divergere nemmeno su questo.
  it('Task 12 — CONTROLLO NEGATIVO: con un\'autorizzazione valida, il Word esce comunque', async () => {
    mockAutorizzazioneValida.mockResolvedValue(true)
    await expect(
      generateDocxFromHtml('<p>02087420762</p>', 'x', { societa: LAREALESTATE, conversationId: 'conv-1' }),
    ).resolves.toBeInstanceOf(Buffer)
  })
})

describe('i metadati del file: il creator porta la societa giusta (nota Task 5, aggiunta dal grep tarato)', () => {
  // Un PDF o un Excel de La Real Estate portava "Restruktura S.r.l." come
  // AUTORE nelle proprieta' del file: invisibile nella pagina, visibile a
  // chiunque apra le proprieta'. Nessuna guardia sul CONTENUTO lo vedrebbe
  // mai — i metadati non stanno nell'HTML.
  it('il DOCX de La Real Estate porta LA REAL ESTATE nel creator, non Restruktura', async () => {
    const buf = await generateDocxFromHtml('<p>Contratto</p>', 'Doc', { societa: LAREALESTATE })
    const creator = await creatorDi(buf)
    expect(creator).toContain('LA REAL ESTATE')
    expect(creator).not.toContain('Restruktura')
  })

  it('il DOCX di Restruktura porta Restruktura nel creator', async () => {
    const buf = await generateDocxFromHtml('<p>Contratto</p>', 'Doc', { societa: RESTRUKTURA })
    const creator = await creatorDi(buf)
    expect(creator).toContain('RESTRUKTURA')
  })

  it('lo XLSX de La Real Estate porta LA REAL ESTATE nel creator, non Restruktura', async () => {
    const buf = await generateXlsxFromData(
      [{ name: 'Dati', rows: [['a', 1]] }],
      'X',
      { societa: LAREALESTATE },
    )
    const creator = await creatorDi(buf)
    expect(creator).toContain('LA REAL ESTATE')
    expect(creator).not.toContain('Restruktura')
  })

  it('lo XLSX di Restruktura porta Restruktura nel creator', async () => {
    const buf = await generateXlsxFromData(
      [{ name: 'Dati', rows: [['a', 1]] }],
      'X',
      { societa: RESTRUKTURA },
    )
    const creator = await creatorDi(buf)
    expect(creator).toContain('RESTRUKTURA')
  })
})
