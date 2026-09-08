/**
 * Test unit per generatePdfFromHtml — mocka puppeteer-core e @sparticuz/chromium.
 * Vedi docs/superpowers/specs/2026-05-08-cervellone-pdf-puppeteer-design.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPdfBytes = Buffer.from('%PDF-1.7\n'.padEnd(30000, ' '))

vi.mock('puppeteer-core', () => ({
  default: {
    launch: vi.fn(),
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

import puppeteer from 'puppeteer-core'
import {
  generatePdfFromHtml, generateDocxFromHtml, generateXlsxFromData, MAX_IMMAGINI_PER_DOCUMENTO,
} from './pdf-generator'

function makeMockBrowser(opts: {
  setContent?: ReturnType<typeof vi.fn>
  pdf?: ReturnType<typeof vi.fn>
  close?: ReturnType<typeof vi.fn>
} = {}) {
  const setContent = opts.setContent ?? vi.fn(async (_html: string) => undefined)
  const pdf = opts.pdf ?? vi.fn(async (_opts: Record<string, unknown>) => mockPdfBytes)
  const closePage = vi.fn(async () => undefined)
  const closeBrowser = opts.close ?? vi.fn(async () => undefined)
  return {
    newPage: vi.fn(async () => ({
      setContent,
      pdf,
      close: closePage,
    })),
    close: closeBrowser,
  }
}

describe('generatePdfFromHtml', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Buffer with PDF magic bytes', async () => {
    vi.mocked(puppeteer.launch).mockResolvedValueOnce(makeMockBrowser() as never)

    const buf = await generatePdfFromHtml('<p>test</p>', 'Test Doc')

    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(puppeteer.launch).toHaveBeenCalledOnce()
  })

  it('wraps HTML fragment with boilerplate when missing <html>', async () => {
    const setContent = vi.fn(async (_html: string) => undefined)
    vi.mocked(puppeteer.launch).mockResolvedValueOnce(makeMockBrowser({ setContent }) as never)

    await generatePdfFromHtml('<p>frammento</p>', 'Test')

    const passedHtml = setContent.mock.calls[0][0]
    expect(passedHtml).toContain('<!DOCTYPE html>')
    expect(passedHtml).toContain('<title>Test</title>')
    expect(passedHtml).toContain('<p>frammento</p>')
  })

  it('does NOT double-wrap if HTML already has <html> tag', async () => {
    const setContent = vi.fn(async (_html: string) => undefined)
    vi.mocked(puppeteer.launch).mockResolvedValueOnce(makeMockBrowser({ setContent }) as never)

    const fullDoc = '<!DOCTYPE html><html><head><title>Mio</title></head><body>x</body></html>'
    await generatePdfFromHtml(fullDoc, 'Ignored')

    const passedHtml = setContent.mock.calls[0][0]
    expect(passedHtml).toBe(fullDoc)
  })

  it('escapes HTML in title to prevent injection', async () => {
    const setContent = vi.fn(async (_html: string) => undefined)
    vi.mocked(puppeteer.launch).mockResolvedValueOnce(makeMockBrowser({ setContent }) as never)

    await generatePdfFromHtml('<p>x</p>', 'Doc <script>alert(1)</script>')

    const passedHtml = setContent.mock.calls[0][0]
    expect(passedHtml).toContain('Doc &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(passedHtml).not.toContain('<title>Doc <script>')
  })

  it('always closes browser, even on pdf error', async () => {
    const closeBrowser = vi.fn(async () => undefined)
    const pdf = vi.fn(async () => {
      throw new Error('pdf render failed')
    })
    // FIX #10: generatePdfFromHtml ora ritenta (2 tentativi) su errore transitorio.
    // Usa mockResolvedValue (persistente) così entrambi i tentativi ottengono un browser;
    // l'invariante verificato è "il browser viene chiuso ad OGNI tentativo".
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser({ pdf, close: closeBrowser }) as never)

    await expect(generatePdfFromHtml('<p>x</p>', 'T')).rejects.toThrow('pdf render failed')
    expect(closeBrowser).toHaveBeenCalledTimes(2)
  })

  it('uses A4 + printBackground + margins + footer template', async () => {
    const pdf = vi.fn(async (_opts: Record<string, unknown>) => mockPdfBytes)
    vi.mocked(puppeteer.launch).mockResolvedValueOnce(makeMockBrowser({ pdf }) as never)

    await generatePdfFromHtml('<p>x</p>', 'T')

    expect(pdf).toHaveBeenCalledOnce()
    const opts = pdf.mock.calls[0][0]
    expect(opts.format).toBe('A4')
    expect(opts.printBackground).toBe(true)
    expect(opts.displayHeaderFooter).toBe(true)
    expect(opts.footerTemplate).toContain('RESTRUKTURA')
    expect(opts.footerTemplate).toContain('pageNumber')
  })
})

describe('generateDocxFromHtml', () => {
  it('returns Buffer with ZIP magic bytes (DOCX is ZIP)', async () => {
    const buf = await generateDocxFromHtml('<h1>Titolo</h1><p>Corpo</p>', 'TestDoc')
    expect(buf).toBeInstanceOf(Buffer)
    // DOCX file = ZIP container, magic bytes "PK\x03\x04"
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK')
    expect(buf.length).toBeGreaterThan(2000)
  })

  it('handles plain text fallback when no semantic blocks', async () => {
    const buf = await generateDocxFromHtml('Solo testo senza tag', 'PlainText')
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK')
  })

  it('strips style/script/head from HTML before parsing', async () => {
    const html = `<style>body{color:red}</style><h1>Vero titolo</h1>`
    const buf = await generateDocxFromHtml(html, 'StripTest')
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK')
  })
})

describe('generateXlsxFromData', () => {
  it('returns Buffer with ZIP magic bytes (XLSX is ZIP)', async () => {
    const buf = await generateXlsxFromData(
      [{ name: 'Test', rows: [['Codice', 'Descr', 'Q.tà'], ['BAS_01', 'Demolizione', 50]] }],
      'TestXlsx',
    )
    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK')
    expect(buf.length).toBeGreaterThan(2000)
  })

  it('handles empty sheets array', async () => {
    const buf = await generateXlsxFromData([], 'EmptyTest')
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK')
  })

  it('sanitizes sheet names with forbidden characters', async () => {
    // Excel proibisce \ / ? * [ ] : nei nomi foglio
    const buf = await generateXlsxFromData(
      [{ name: 'CME/2026:test', rows: [['a', 'b']] }],
      'SanitizeTest',
    )
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK')
  })

  it('handles multi-sheet workbook', async () => {
    const buf = await generateXlsxFromData(
      [
        { name: 'CME', rows: [['Codice', 'Descr'], ['A', 'X']] },
        { name: 'SAL', rows: [['Voce', 'Importo'], ['Demo', 1000]] },
      ],
      'MultiSheet',
    )
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK')
  })
})

// ── Immagini nei documenti (8 set 2026) ──
//
// Il caso vero: Preventivo Extra B della commessa C2026-008. Il PDF usciva a
// 178KB con la foto ROTTA, e il bot dichiarava "confermato, e' a posto" tre
// volte di fila. La causa era in `drive.ts` (mancava `supportsAllDrives`), ma il
// difetto che l'ha resa invisibile e' qui: il fallimento veniva ingoiato.

vi.mock('./drive', () => ({
  downloadFileBase64: vi.fn(),
}))
import { downloadFileBase64 } from './drive'

const HTML_CON_FOTO =
  '<h1>Preventivo</h1><p>Facciata Est</p>' +
  '<img src="https://drive.google.com/thumbnail?id=1Zg97_TDKOoUWeAAYsTQ-TrlH5m601rXU&sz=w600">'

describe('immagini Drive nei PDF', () => {
  beforeEach(() => {
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser() as never)
    vi.mocked(downloadFileBase64).mockReset()
  })

  it('incorpora la foto come data URI invece di lasciare l URL', async () => {
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: Buffer.from('pixel').toString('base64'), mimeType: 'image/jpeg', name: 'IMG.jpeg',
    })
    const setContent = vi.fn(async (_html: string) => undefined)
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser({ setContent }) as never)

    await generatePdfFromHtml(HTML_CON_FOTO, 'Preventivo')

    const htmlRenderizzato = setContent.mock.calls[0][0]
    expect(htmlRenderizzato).toContain('data:image/jpeg;base64,')
    expect(htmlRenderizzato).not.toContain('drive.google.com/thumbnail')
  })

  it('DICE quali immagini non e riuscito a incorporare, invece di tacere', async () => {
    // Prima: `catch` con un console.error e via — il PDF usciva con la foto
    // rotta e il bot lo consegnava come riuscito.
    vi.mocked(downloadFileBase64).mockRejectedValue(new Error('File not found'))
    const mancanti: string[] = []

    await generatePdfFromHtml(HTML_CON_FOTO, 'Preventivo', {
      onImmaginiMancanti: (ids) => { mancanti.push(...ids) },
    })

    expect(mancanti).toEqual(['1Zg97_TDKOoUWeAAYsTQ-TrlH5m601rXU'])
  })

  it('non disturba quando sono entrate tutte', async () => {
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: 'AAAA', mimeType: 'image/jpeg', name: 'IMG.jpeg',
    })
    const onImmaginiMancanti = vi.fn()

    await generatePdfFromHtml(HTML_CON_FOTO, 'Preventivo', { onImmaginiMancanti })

    expect(onImmaginiMancanti).not.toHaveBeenCalled()
  })
})

describe('immagini Drive nei DOCX', () => {
  beforeEach(() => { vi.mocked(downloadFileBase64).mockReset() })

  it('mette la foto DENTRO il Word, non la butta via', async () => {
    // Il generatore DOCX dichiarava "no immagini" come limite accettato: un
    // Word con l'allegato fotografico usciva senza le foto, in silenzio.
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: Buffer.from('pixel-di-prova').toString('base64'),
      mimeType: 'image/jpeg',
      name: 'IMG.jpeg',
    })

    const buf = await generateDocxFromHtml(HTML_CON_FOTO, 'Preventivo')

    expect(downloadFileBase64).toHaveBeenCalledWith('1Zg97_TDKOoUWeAAYsTQ-TrlH5m601rXU')
    // Un DOCX e' uno ZIP: con un'immagine dentro contiene la cartella media/.
    expect(buf.subarray(0, 2).toString()).toBe('PK')
    expect(buf.toString('latin1')).toContain('media/')
  })

  it('un Word senza foto resta un Word valido', async () => {
    const buf = await generateDocxFromHtml('<h1>Solo testo</h1><p>Nessuna foto.</p>', 'Titolo')
    expect(buf.subarray(0, 2).toString()).toBe('PK')
    expect(downloadFileBase64).not.toHaveBeenCalled()
  })
})

describe('DOCX — quando una foto non si scarica', () => {
  const TRE_FOTO =
    '<h1>Perizia</h1>' +
    '<p>Foto 1 - Facciata Est</p><img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">' +
    '<p>Foto 2 - Cornicione</p><img src="https://drive.google.com/thumbnail?id=BBBBBBBBBBBB">' +
    '<p>Foto 3 - Balcone</p><img src="https://drive.google.com/thumbnail?id=CCCCCCCCCCCC">'

  beforeEach(() => { vi.mocked(downloadFileBase64).mockReset() })

  // IL DIFETTO, trovato dall'audit sul commit che aggiungeva le foto ai Word.
  // Le foto venivano accodate in ordine, ma una che falliva NON lasciava il
  // posto: le successive slittavano di una. Nella perizia consegnata al
  // committente la foto del balcone finiva sotto la didascalia del cornicione.
  // Un documento che attribuisce la foto sbagliata al degrado sbagliato e'
  // PEGGIO di un documento senza foto.
  it('non fa slittare le altre: chi manca lascia il posto', async () => {
    vi.mocked(downloadFileBase64).mockImplementation(async (id: string) => {
      if (id === 'BBBBBBBBBBBB') throw new Error('File not found')
      return { base64: Buffer.from(`foto-${id}`).toString('base64'), mimeType: 'image/jpeg', name: `${id}.jpg` }
    })
    const mancanti: string[] = []

    const buf = await generateDocxFromHtml(TRE_FOTO, 'Perizia', {
      onImmaginiMancanti: (ids) => { mancanti.push(...ids) },
    })

    expect(mancanti).toEqual(['BBBBBBBBBBBB'])
    // Che il posto resti occupato da un segnaposto e' provato su
    // `pianificaAllegato` (immagine-dimensioni.test.ts): un .docx e' uno ZIP
    // compresso, qui dentro il testo non e' ispezionabile.
    expect(buf.subarray(0, 2).toString()).toBe('PK')
  })

  // Il download RIESCE ma il formato non e' infilabile in un Word: prima
  // finiva dentro dichiarato 'jpg' e Word mostrava un riquadro rotto, mentre il
  // tool rispondeva "salvato" senza avvisi.
  it('un WEBP non viene spacciato per JPEG: si dichiara mancante', async () => {
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: Buffer.from('byte-webp').toString('base64'),
      mimeType: 'image/webp',
      name: 'foto.webp',
    })
    const mancanti: string[] = []

    await generateDocxFromHtml(
      '<p>Foto</p><img src="https://drive.google.com/thumbnail?id=WWWWWWWWWWWW">',
      'Perizia',
      { onImmaginiMancanti: (ids) => { mancanti.push(...ids) } },
    )

    expect(mancanti).toEqual(['WWWWWWWWWWWW'])
  })
})

describe('le forme di <img> che il modello puo scrivere', () => {
  beforeEach(() => {
    vi.mocked(downloadFileBase64).mockReset()
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: 'AAAA', mimeType: 'image/jpeg', name: 'f.jpg',
    })
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser() as never)
  })

  // Nei prompt non c'e' nessuna istruzione su COME scrivere il tag: il modello
  // improvvisa il formato ogni volta. Il fix dell'8 set riconosceva solo la
  // forma canonica con apici doppi e `?id=`; tutte queste sono HTML valido, e
  // sparivano senza nemmeno finire fra le mancanti.
  it.each([
    ['apici singoli', "<img src='https://drive.google.com/thumbnail?id=AAAAAAAAAAAA'>"],
    ['&amp; escapato', '<img src="https://drive.google.com/thumbnail?sz=w600&amp;id=AAAAAAAAAAAA">'],
    ['forma /d/', '<img src="https://drive.google.com/file/d/AAAAAAAAAAAA/view">'],
  ])('riconosce e incorpora la forma con %s', async (_nome, tag) => {
    const setContent = vi.fn(async (_html: string) => undefined)
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser({ setContent }) as never)

    await generatePdfFromHtml(`<p>Foto</p>${tag}`, 'Doc')

    expect(setContent.mock.calls[0][0]).toContain('data:image/jpeg;base64,')
  })

  // Se proprio non si riesce a capire quale file sia, va DETTO. Prima un URL
  // Drive da cui non si estraeva l'id veniva saltato in silenzio: nessuna
  // immagine e nessun avviso, cioe' lo stesso difetto che il fix chiudeva.
  it('un URL Drive di cui non capisce l id finisce comunque fra le mancanti', async () => {
    const mancanti: string[] = []

    await generatePdfFromHtml(
      '<img src="https://lh3.googleusercontent.com/drive-viewer/AKxyz-senza-id">',
      'Doc',
      { onImmaginiMancanti: (ids) => { mancanti.push(...ids) } },
    )

    expect(mancanti).toHaveLength(1)
    expect(mancanti[0]).toContain('drive-viewer')
  })
})

describe('immagini negli Excel', () => {
  beforeEach(() => { vi.mocked(downloadFileBase64).mockReset() })

  // Prima non c'era nessun canale per una foto in un XLSX, e la descrizione del
  // tool non lo diceva: un registro fotografico di cantiere usciva con gli URL
  // scritti in cella, o senza niente. ExcelJS le immagini le sa mettere.
  it('mette le foto nel foglio quando gliele si passa', async () => {
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: Buffer.from('pixel').toString('base64'), mimeType: 'image/jpeg', name: 'f.jpg',
    })

    const buf = await generateXlsxFromData(
      [{ name: 'Foto', rows: [['Data', 'Descrizione'], ['08/09', 'Facciata Est']], immagini: ['AAAAAAAAAAAA'] }],
      'Registro',
    )

    expect(downloadFileBase64).toHaveBeenCalledWith('AAAAAAAAAAAA')
    expect(buf.subarray(0, 2).toString()).toBe('PK')
    expect(buf.toString('latin1')).toContain('media/')
  })

  it('una foto che non si scarica viene DETTA, non ignorata', async () => {
    vi.mocked(downloadFileBase64).mockRejectedValue(new Error('File not found'))
    const mancanti: string[] = []

    await generateXlsxFromData(
      [{ name: 'Foto', rows: [['a']], immagini: ['BBBBBBBBBBBB'] }],
      'Registro',
      { onImmaginiMancanti: (ids) => { mancanti.push(...ids) } },
    )

    expect(mancanti).toEqual(['BBBBBBBBBBBB'])
  })

  it('un Excel senza foto resta com era', async () => {
    const buf = await generateXlsxFromData([{ name: 'Dati', rows: [['a', 1]] }], 'X')
    expect(buf.subarray(0, 2).toString()).toBe('PK')
    expect(downloadFileBase64).not.toHaveBeenCalled()
  })
})

describe('coerenza fra PDF e Word, e tetto alle foto', () => {
  beforeEach(() => {
    vi.mocked(downloadFileBase64).mockReset()
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: 'AAAA', mimeType: 'image/jpeg', name: 'f.jpg',
    })
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser() as never)
  })

  // Il PDF metteva in cache per URL, il Word deduplicava per ID: la STESSA foto
  // richiamata con due URL diversi veniva scaricata due volte nel PDF e una
  // sola nel Word. Due formati che dallo stesso HTML producono insiemi diversi.
  it('la stessa foto richiamata due volte si scarica UNA volta sola', async () => {
    const html =
      '<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA&sz=w600">' +
      '<img src="https://drive.google.com/file/d/AAAAAAAAAAAA/view">'

    await generatePdfFromHtml(html, 'Doc')

    expect(downloadFileBase64).toHaveBeenCalledTimes(1)
  })

  // Ogni foto incorporata ricopia l'intera stringa dell'HTML: con decine di
  // data URI da megabyte la function esaurisce la memoria. Prima non si vedeva
  // perche' i download fallivano tutti; da quando funzionano, il tetto serve.
  it('oltre il tetto le foto in eccesso vengono DETTE, non incorporate in silenzio', async () => {
    const html = Array.from({ length: MAX_IMMAGINI_PER_DOCUMENTO + 3 }, (_, i) =>
      `<img src="https://drive.google.com/thumbnail?id=IMG${String(i).padStart(9, '0')}">`).join('')
    const mancanti: string[] = []

    await generatePdfFromHtml(html, 'Doc', { onImmaginiMancanti: (ids) => { mancanti.push(...ids) } })

    expect(downloadFileBase64).toHaveBeenCalledTimes(MAX_IMMAGINI_PER_DOCUMENTO)
    expect(mancanti).toHaveLength(3)
  })
})
