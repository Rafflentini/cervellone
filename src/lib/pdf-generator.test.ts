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
    // Niente doppio wrap: il documento resta il suo, titolo e corpo intatti.
    expect(passedHtml).toContain('<title>Mio</title>')
    expect(passedHtml).toContain('<body>x')
    expect(passedHtml.match(/<html/g) ?? []).toHaveLength(1)
    // Lo stile sta in fondo al body: a parita' di `!important` vince la regola
    // che viene DOPO, e il documento del modello puo' avere i suoi stili.
    expect(passedHtml.indexOf('max-width')).toBeGreaterThan(passedHtml.indexOf('<body>'))
    // Ma la regola sulle immagini viene iniettata ANCHE qui: prima si usciva
    // subito e su questo ramo le foto restavano tagliate come senza il fix, e
    // `genera_pdf` accetta HTML arbitrario dal modello.
    expect(passedHtml).toMatch(/img\s*\{[^}]*max-width:\s*100%/)
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

    // Col NOME del file, non solo l id: "Id Drive: 1a2b3c..." non dice
    // all Ingegnere QUALE foto manca.
    expect(mancanti).toHaveLength(1)
    expect(mancanti[0]).toContain('WWWWWWWWWWWW')
    expect(mancanti[0]).toContain('foto.webp')
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

describe('le foto nel PDF devono STARE nella pagina', () => {
  beforeEach(() => {
    vi.mocked(downloadFileBase64).mockReset()
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: 'AAAA', mimeType: 'image/jpeg', name: 'IMG_5685.jpeg',
    })
  })

  // IL DIFETTO, trovato dall'audit end-to-end: `wrapForPrint` non aveva NESSUNA
  // regola sulle immagini. I byte incorporati sono quelli ORIGINALI (il `sz=w900`
  // dell'URL viene ignorato: si scarica con alt=media), quindi una foto iPhone
  // 4032px finiva in un <img> largo 4032 su un'area utile A4 di ~680: Chromium
  // in stampa RITAGLIA invece di ridurre, e si vedeva l'angolo in alto a
  // sinistra della foto, su piu' pagine.
  // ⭐ Prima del fix di stamattina il browser scaricava la MINIATURA a 900px:
  // la geometria e' peggiorata proprio quando le foto hanno iniziato a entrare.
  it('l HTML stampato impone alle immagini di stare nella larghezza utile', async () => {
    const setContent = vi.fn(async (_html: string) => undefined)
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser({ setContent }) as never)

    await generatePdfFromHtml('<p>Foto</p><img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">', 'Perizia')

    const html = setContent.mock.calls[0][0]
    expect(html).toMatch(/img\s*\{[^}]*max-width:\s*100%/)
    expect(html).toMatch(/img\s*\{[^}]*height:\s*auto/)
  })

  // Il DOCX rifiutava i formati che Word non sa mostrare; il PDF no: un HEIC
  // (le foto dell'iPhone) diventava `data:image/heic;base64,...`, Chromium non
  // lo decodifica, e il riquadro restava vuoto SENZA che nessuno lo dicesse,
  // perche' il download era riuscito.
  it('un HEIC non viene incorporato in silenzio: si dichiara mancante', async () => {
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: 'AAAA', mimeType: 'image/heic', name: 'IMG_5685.HEIC',
    })
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser() as never)
    const mancanti: string[] = []

    await generatePdfFromHtml(
      '<img src="https://drive.google.com/thumbnail?id=HHHHHHHHHHHH">',
      'Perizia',
      { onImmaginiMancanti: (ids) => { mancanti.push(...ids) } },
    )

    expect(mancanti).toHaveLength(1)
  })

  // L'avviso stampava l'id Drive nudo: l'Ingegnere leggeva "Id Drive: 1a2b3c..."
  // e non sapeva QUALE foto mancasse. Il nome del file c'e' gia', lo restituisce
  // `downloadFileBase64`, e veniva buttato.
  it('quando puo, dice il NOME della foto e non solo l id', async () => {
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: 'AAAA', mimeType: 'image/heic', name: 'IMG_5685.HEIC',
    })
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser() as never)
    const mancanti: string[] = []

    await generatePdfFromHtml(
      '<img src="https://drive.google.com/thumbnail?id=HHHHHHHHHHHH">',
      'Perizia',
      { onImmaginiMancanti: (ids) => { mancanti.push(...ids) } },
    )

    expect(mancanti[0]).toContain('IMG_5685.HEIC')
  })
})

describe('il piede del documento porta la societa giusta', () => {
  beforeEach(() => {
    vi.mocked(downloadFileBase64).mockReset()
  })

  // L'audit end-to-end: `societa` veniva calcolata e passata SOLO a
  // generateXlsxFromData, che non la legge; PDF e DOCX la leggono e non la
  // ricevevano mai. Il fix del piede era INERTE AL 100%: ogni documento de La
  // Real Estate portava comunque "RESTRUKTURA S.r.l. — P.IVA 02087420762".
  it('il PDF de La Real Estate NON porta la partita IVA di Restruktura', async () => {
    const pdf = vi.fn(async (opts: Record<string, unknown>) => {
      return mockPdfBytes
    })
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser({ pdf }) as never)

    await generatePdfFromHtml('<p>Contratto</p>', 'Doc', {
      societa: { denominazione: 'LA REAL ESTATE SRLS', piva: '02232730768' },
    })

    const opzioniPdf = pdf.mock.calls[0][0] as { footerTemplate: string }
    expect(opzioniPdf.footerTemplate).toContain('LA REAL ESTATE SRLS')
    expect(opzioniPdf.footerTemplate).toContain('02232730768')
    expect(opzioniPdf.footerTemplate).not.toContain('02087420762')
  })
})

describe('il tetto vale anche nel WORD, e nello stesso modo', () => {
  beforeEach(() => {
    vi.mocked(downloadFileBase64).mockReset()
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: 'AAAA', mimeType: 'image/jpeg', name: 'f.jpg',
    })
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser() as never)
  })

  const htmlCon = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      `<img src="https://drive.google.com/thumbnail?id=IMG${String(i).padStart(9, '0')}">`).join('')

  // IL BUG VIVO, trovato da tutti e tre gli audit dell'8 set: `oltreIlTetto` era
  // calcolato e MAI usato. Nel Word le foto oltre la ventesima non venivano
  // incorporate NE' dichiarate: sparivano, che e' il difetto d'origine di tutta
  // la giornata. Il describe precedente diceva "coerenza fra PDF e Word" ma
  // chiamava solo il PDF: era un titolo, non un'asserzione.
  it('nel Word le foto oltre il tetto vengono DETTE', async () => {
    const mancanti: string[] = []
    await generateDocxFromHtml(htmlCon(MAX_IMMAGINI_PER_DOCUMENTO + 3), 'Perizia', {
      onImmaginiMancanti: (ids) => { mancanti.push(...ids) },
    })
    expect(mancanti).toHaveLength(3)
  })

  // Il tetto del PDF contava le RIUSCITE, quello del Word tagliava la lista a
  // monte: con dei fallimenti i due formati finivano per contenere foto diverse
  // dallo stesso HTML — proprio la divergenza che si voleva chiudere.
  it('PDF e Word scaricano lo STESSO insieme di foto', async () => {
    const html = htmlCon(MAX_IMMAGINI_PER_DOCUMENTO + 5)

    await generatePdfFromHtml(html, 'Doc')
    const idPdf = vi.mocked(downloadFileBase64).mock.calls.map((c) => c[0]).sort()

    vi.mocked(downloadFileBase64).mockClear()
    await generateDocxFromHtml(html, 'Doc')
    const idDocx = vi.mocked(downloadFileBase64).mock.calls.map((c) => c[0]).sort()

    expect(idPdf).toEqual(idDocx)
    expect(idPdf).toHaveLength(MAX_IMMAGINI_PER_DOCUMENTO)
  })
})

/**
 * Apre un .docx (che e' uno ZIP) e restituisce cio' che serve per giudicarlo:
 * quante foto contiene davvero, il testo del documento, e le dimensioni
 * dichiarate per ciascuna immagine.
 *
 * Serve perche' `toContain('media/')` sul buffer compresso non discrimina:
 * l'audit sui test ha mostrato che con quell'asserzione sopravvivevano sia
 * l'accodamento (foto sotto la didascalia sbagliata) sia la misura fissa
 * (verticali schiacciate).
 */
async function apriDocx(buf: Buffer) {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(buf)
  const media = Object.keys(zip.files).filter((n) => n.startsWith('word/media/'))
  const xml = await zip.file('word/document.xml')!.async('string')
  const misure = Array.from(xml.matchAll(/<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"/g))
    .map((m) => ({ cx: Number(m[1]), cy: Number(m[2]) }))
  const testo = Array.from(xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)).map((m) => m[1]).join(' ')
  return { quanteFoto: media.length, misure, testo }
}

describe('dentro il Word, guardato davvero', () => {
  beforeEach(() => { vi.mocked(downloadFileBase64).mockReset() })

  const jpegVerticale = (l: number, a: number) => {
    const b = Buffer.alloc(13)
    b.writeUInt16BE(0xffd8, 0)
    b.writeUInt16BE(0xffc0, 2)
    b.writeUInt16BE(9, 4)
    b.writeUInt8(8, 6)
    b.writeUInt16BE(a, 7)
    b.writeUInt16BE(l, 9)
    return b
  }

  // Uccide la mutazione "accodamento": con il filtro, le due foto riuscite
  // finirebbero in posizione 1 e 2 e il segnaposto sparirebbe.
  it('la foto mancante lascia il suo posto, DICHIARATO nel testo', async () => {
    vi.mocked(downloadFileBase64).mockImplementation(async (id: string) => {
      if (id === 'BBBBBBBBBBBB') throw new Error('File not found')
      return { base64: jpegVerticale(1200, 1600).toString('base64'), mimeType: 'image/jpeg', name: `${id}.jpg` }
    })

    const buf = await generateDocxFromHtml(
      '<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">' +
      '<img src="https://drive.google.com/thumbnail?id=BBBBBBBBBBBB">' +
      '<img src="https://drive.google.com/thumbnail?id=CCCCCCCCCCCC">',
      'Perizia',
    )
    const { quanteFoto, testo } = await apriDocx(buf)

    expect(quanteFoto).toBe(2)
    // Il buco e' al SECONDO posto, e lo dice.
    expect(testo).toContain('Foto 2 non disponibile')
    expect(testo).toContain('BBBBBBBBBBBB')
  })

  // Uccide la mutazione "misura fissa 480x360": una foto 1200x1600 deve
  // restare VERTICALE dentro il documento.
  it('una foto verticale resta verticale dentro il Word', async () => {
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: jpegVerticale(1200, 1600).toString('base64'), mimeType: 'image/jpeg', name: 'f.jpg',
    })

    const buf = await generateDocxFromHtml(
      '<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">', 'Perizia',
    )
    const { misure } = await apriDocx(buf)

    expect(misure).toHaveLength(1)
    expect(misure[0].cy).toBeGreaterThan(misure[0].cx)
    // 3:4, le proporzioni vere della foto
    expect(misure[0].cx / misure[0].cy).toBeCloseTo(0.75, 2)
  })
})

describe('l HTML consegnato a Chromium, guardato davvero', () => {
  beforeEach(() => { vi.mocked(downloadFileBase64).mockReset() })

  // ⭐ La correzione di punta — sostituire il TAG INTERO da destra a sinistra —
  // non era coperta da NIENTE: rimettere `split/join`, o invertire il verso,
  // passava tutte e 1970 le prove. I test guardavano le chiamate di rete, che
  // sono identiche prima e dopo. Qui si guarda il risultato.
  it('con due foto, l HTML resta integro e ogni tag ha il SUO data URI', async () => {
    vi.mocked(downloadFileBase64).mockImplementation(async (id: string) => ({
      base64: Buffer.from(`byte-${id}`).toString('base64'),
      mimeType: 'image/png',
      name: `${id}.png`,
    }))
    const setContent = vi.fn(async (_html: string) => undefined)
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser({ setContent }) as never)

    await generatePdfFromHtml(
      '<p>Prima</p><img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">' +
      '<p>Mezzo</p><img src="https://drive.google.com/thumbnail?id=BBBBBBBBBBBB"><p>Dopo</p>',
      'Doc',
    )

    const html = setContent.mock.calls[0][0]
    // Il testo del documento non e' stato toccato
    expect(html).toContain('<p>Prima</p>')
    expect(html).toContain('<p>Mezzo</p>')
    expect(html).toContain('<p>Dopo</p>')
    // Due tag img, ciascuno col proprio contenuto, e nessun URL Drive residuo
    const tag = html.match(/<img[^>]*>/g) ?? []
    expect(tag).toHaveLength(2)
    expect(tag[0]).toContain(Buffer.from('byte-AAAAAAAAAAAA').toString('base64'))
    expect(tag[1]).toContain(Buffer.from('byte-BBBBBBBBBBBB').toString('base64'))
    expect(html).not.toContain('drive.google.com')
  })

  // La forma che rompeva davvero: un URL prefisso dell'altro.
  it('due URL della stessa foto, uno prefisso dell altro, non si corrompono', async () => {
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: 'QUJD', mimeType: 'image/png', name: 'f.png',
    })
    const setContent = vi.fn(async (_html: string) => undefined)
    vi.mocked(puppeteer.launch).mockResolvedValue(makeMockBrowser({ setContent }) as never)

    await generatePdfFromHtml(
      '<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">' +
      '<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA&sz=w600">',
      'Doc',
    )

    const html = setContent.mock.calls[0][0]
    // Nessun avanzo dell'URL appiccicato in coda al base64
    expect(html).not.toContain('sz=w600')
    expect(html.match(/data:image\/png;base64,QUJD"/g) ?? []).toHaveLength(2)
    // e una sola chiamata di rete: e' la stessa foto
    expect(downloadFileBase64).toHaveBeenCalledTimes(1)
  })
})

describe('il piede: sul Word come sul PDF', () => {
  beforeEach(() => { vi.mocked(downloadFileBase64).mockReset() })

  // Il describe precedente si chiamava "il piede del documento porta la
  // societa giusta" e chiamava SOLO il PDF: cablare di nuovo Restruktura nel
  // Word lasciava la suite verde. Stesso errore di forma del vecchio
  // "coerenza fra PDF e Word".
  it('il Word de La Real Estate NON porta la partita IVA di Restruktura', async () => {
    const buf = await generateDocxFromHtml('<p>Contratto</p>', 'Doc', {
      societa: { denominazione: 'LA REAL ESTATE SRLS', piva: '02232730768' },
    })
    const { testo } = await apriDocx(buf)

    expect(testo).toContain('LA REAL ESTATE SRLS')
    expect(testo).toContain('02232730768')
    expect(testo).not.toContain('02087420762')
  })

  it('senza indicazioni resta Restruktura', async () => {
    const buf = await generateDocxFromHtml('<p>Contratto</p>', 'Doc')
    const { testo } = await apriDocx(buf)
    expect(testo).toContain('02087420762')
  })
})

describe('l ORDINE delle foto nel Word', () => {
  beforeEach(() => { vi.mocked(downloadFileBase64).mockReset() })

  // Il test precedente usava byte IDENTICI per tutte le foto: invertire
  // l'ordine lasciava conteggio e segnaposto invariati, quindi la mutazione
  // sopravviveva. Qui ogni foto ha dimensioni proprie, cosi' `wp:extent` dice
  // quale sta dove.
  const jpeg = (l: number, a: number) => {
    const b = Buffer.alloc(13)
    b.writeUInt16BE(0xffd8, 0); b.writeUInt16BE(0xffc0, 2); b.writeUInt16BE(9, 4)
    b.writeUInt8(8, 6); b.writeUInt16BE(a, 7); b.writeUInt16BE(l, 9)
    return b
  }

  it('le foto escono nell ordine del documento, non in un altro', async () => {
    // tre proporzioni ben distinte: 1:2 verticale, 1:1 quadrata, 2:1 orizzontale
    const forme: Record<string, [number, number]> = {
      AAAAAAAAAAAA: [400, 800],
      BBBBBBBBBBBB: [600, 600],
      CCCCCCCCCCCC: [800, 400],
    }
    vi.mocked(downloadFileBase64).mockImplementation(async (id: string) => ({
      base64: jpeg(...forme[id]).toString('base64'), mimeType: 'image/jpeg', name: `${id}.jpg`,
    }))

    const buf = await generateDocxFromHtml(
      Object.keys(forme).map((id) => `<img src="https://drive.google.com/thumbnail?id=${id}">`).join(''),
      'Perizia',
    )
    const { misure } = await apriDocx(buf)

    expect(misure).toHaveLength(3)
    const rapporti = misure.map((m) => Number((m.cx / m.cy).toFixed(2)))
    // 0.5 (verticale), 1 (quadrata), 2 (orizzontale): nell'ordine del documento
    expect(rapporti).toEqual([0.5, 1, 2])
  })

  // La misura ASSOLUTA non era pinnata: raddoppiare tutte le dimensioni
  // lasciava verde il rapporto. Una foto piu' larga della pagina esce tagliata
  // anche nel Word.
  it('nessuna foto supera la larghezza utile della pagina', async () => {
    vi.mocked(downloadFileBase64).mockResolvedValue({
      base64: jpeg(4032, 3024).toString('base64'), mimeType: 'image/jpeg', name: 'grande.jpg',
    })

    const buf = await generateDocxFromHtml(
      '<img src="https://drive.google.com/thumbnail?id=AAAAAAAAAAAA">', 'Perizia',
    )
    const { misure } = await apriDocx(buf)

    // `docx` scrive in EMU: 9525 EMU per pixel.
    expect(misure[0].cx).toBeLessThanOrEqual(480 * 9525)
    expect(misure[0].cy).toBeLessThanOrEqual(620 * 9525)
  })
})
