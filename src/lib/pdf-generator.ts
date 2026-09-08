/**
 * lib/pdf-generator.ts — Generatori documenti (PDF + DOCX + XLSX).
 *
 * - generatePdfFromHtml: HTML → Buffer PDF WYSIWYG via Puppeteer + Chromium
 * - generateDocxFromHtml: HTML → Buffer DOCX via lib `docx` nativa
 * - generateXlsxFromData: dati strutturati → Buffer XLSX via ExcelJS
 *
 * PDF risolve DDT 002-2026 (CSS in chiaro pag. 1, layout piatto pag. 2-4).
 * Su Vercel serverless Linux: puppeteer-core + @sparticuz/chromium.
 * In dev locale Windows: fallback `puppeteer` full (devDep) o Chrome di sistema.
 *
 * 2026-09-08: aggiunto embedDriveImages() — le immagini Drive richiamate da
 * <img src="https://drive.google.com/..."> o "...googleusercontent.com/..."
 * uscivano vuote nel PDF perché Puppeteer headless server-side non ha la
 * sessione Google dell'utente (il fetch della miniatura fallisce silenziosamente
 * se il file non è condiviso "chiunque abbia il link"). Ora i byte vengono
 * scaricati via Drive API, con lo stesso service account degli altri tool Drive
 * (NB: non scrivere qui la forma abbreviata con l'asterisco e la barra — chiude
 * il commento e rompe il file. E' successo l'8 set 2026: il build falliva, il
 * deploy non partiva e il fix restava fuori dalla produzione mentre sembrava
 * mergiato.)
 * e incorporati come data URI PRIMA del rendering: nessuna dipendenza di rete
 * esterna, funziona indipendentemente dai permessi di condivisione del file.
 *
 * Spec: docs/superpowers/specs/2026-05-08-cervellone-pdf-puppeteer-design.md
 */
import puppeteer from 'puppeteer-core'
import chromium from '@sparticuz/chromium'
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  HeadingLevel,
  AlignmentType,
  PageOrientation,
} from 'docx'
import ExcelJS from 'exceljs'
import {
  dimensioniImmagine,
  estensioneDocx,
  riquadroDocx,
  pianificaAllegato,
} from './immagine-dimensioni'

/**
 * Il piede del PDF. La societa' NON e' cablata: le societa' sono due, e un
 * documento de La Real Estate che porta in fondo "RESTRUKTURA S.r.l. — P.IVA
 * 02087420762" espone un dato societario sbagliato a chi lo riceve.
 */
function piedePagina(societa: { denominazione: string; piva: string }): string {
  return `<div style="font-size: 8pt; color: #888888; width: 100%; padding: 0 15mm; display: flex; justify-content: space-between; -webkit-print-color-adjust: exact;">
  <span>${escapeHtml(societa.denominazione)} — P.IVA ${escapeHtml(societa.piva)}</span>
  <span>Pagina <span class="pageNumber"></span> di <span class="totalPages"></span></span>
</div>`
}

const SOCIETA_PREDEFINITA = { denominazione: 'RESTRUKTURA S.r.l.', piva: '02087420762' }

const HEADER_TEMPLATE = '<div></div>'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function wrapForPrint(rawHtml: string, title: string): string {
  if (/<html[\s>]/i.test(rawHtml)) return rawHtml
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
@page { size: A4; margin: 15mm; }
body { font-family: 'Helvetica', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; line-height: 1.4; margin: 0; }
table { border-collapse: collapse; width: 100%; }
h1, h2, h3 { color: #c8102e; }
</style>
</head>
<body>
${rawHtml}
</body>
</html>`
}

// ── Embed immagini Drive come data URI (fix PDF vuoto lato server) ──

function extractDriveFileId(url: string): string | null {
  // In un HTML corretto la `&` fra i parametri e' scritta `&amp;`: senza
  // scioglierla, il carattere prima di `id=` e' un `;` e il riconoscitore non
  // aggancia. Il modello scrive HTML valido, quindi capitava sul serio.
  const pulito = url.replace(/&(?:amp|#38);/gi, '&')
  const patterns = [
    /[?&]id=([a-zA-Z0-9_-]{10,})/,   // drive.google.com/thumbnail?id=... oppure uc?id=...
    /\/d\/([a-zA-Z0-9_-]{10,})/,      // drive.google.com/file/d/ID/view oppure lh3.googleusercontent.com/d/ID
  ]
  for (const re of patterns) {
    const m = pulito.match(re)
    if (m) return m[1]
  }
  return null
}

/**
 * Scansiona l'HTML per <img src="..."> che puntano a Drive/googleusercontent,
 * scarica i byte via Drive API e sostituisce il src con un data URI base64.
 * Se il download di una singola immagine fallisce, logga e lascia l'URL
 * originale (nessun blocco dell'intera generazione per un file problematico).
 */
/**
 * Nei prompt non c'e' nessuna istruzione su COME scrivere il tag: il modello
 * improvvisa il formato ogni volta. Vanno riconosciute anche le forme con apici
 * singoli e senza apici, altrimenti l'immagine sparisce e nessuno se ne accorge.
 */
const RE_TAG_IMG = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi
const sorgenteDi = (m: RegExpMatchArray): string => m[1] ?? m[2] ?? m[3] ?? ''
const eUrlDrive = (u: string) => /drive\.google\.com|googleusercontent\.com/i.test(u)

/**
 * Gli id Drive di tutte le immagini richiamate da un HTML, senza ripetizioni.
 * Un URL Drive di cui non si riesce a estrarre l'id torna com'e': va comunque
 * dichiarato, non fatto sparire.
 */
export function immaginiDriveNellHtml(html: string): string[] {
  const ids = Array.from(html.matchAll(RE_TAG_IMG))
    .map(sorgenteDi)
    .filter(eUrlDrive)
    .map((src) => extractDriveFileId(src) ?? src)
  return Array.from(new Set(ids))
}

export type EsitoImmagini = {
  html: string
  /** Id delle immagini che NON e' stato possibile incorporare. */
  mancanti: string[]
}

async function embedDriveImages(html: string): Promise<EsitoImmagini> {
  const matches = Array.from(html.matchAll(RE_TAG_IMG))
  const driveMatches = matches.filter((m) => eUrlDrive(sorgenteDi(m)))
  if (driveMatches.length === 0) return { html, mancanti: [] }

  const { downloadFileBase64 } = await import('./drive')
  let out = html
  const cache = new Map<string, string>()
  const mancanti: string[] = []

  for (const m of driveMatches) {
    const originalSrc = sorgenteDi(m)
    if (cache.has(originalSrc)) continue // già sostituito (URL duplicata, replace precedente copre tutte le occorrenze)

    const fileId = extractDriveFileId(originalSrc)
    if (!fileId) {
      // Un URL Drive da cui non si cava l'id va DICHIARATO, non saltato: prima
      // spariva in silenzio, che e' lo stesso difetto che questo lavoro chiude.
      console.error(`[PDF] URL Drive non riconosciuto: ${originalSrc}`)
      if (!mancanti.includes(originalSrc)) mancanti.push(originalSrc)
      continue
    }

    try {
      const { base64, mimeType } = await downloadFileBase64(fileId)
      const dataUri = `data:${mimeType};base64,${base64}`
      cache.set(originalSrc, dataUri)
      out = out.split(originalSrc).join(dataUri)
    } catch (err) {
      // NON basta un console.error. L'8 set 2026 il Preventivo Extra B e' uscito
      // a 178KB con la foto rotta e il bot l'ha dichiarato a posto tre volte:
      // il fallimento va RESTITUITO, cosi' chi consegna il documento lo sa e
      // puo' dirlo all'Ingegnere.
      console.error(`[PDF] embed immagine Drive fallito per ${fileId}:`, err instanceof Error ? err.message : err)
      if (!mancanti.includes(fileId)) mancanti.push(fileId)
      // Si lascia l'URL originale: per un file condiviso "chiunque abbia il
      // link" il fetch di rete puo' ancora riuscire.
    }
  }
  return { html: out, mancanti }
}

// Risolve il percorso del binario Chromium da usare. Sempre lanciato via puppeteer-core
// (sotto) — questo permette al mock di puppeteer-core nei test di intercettare ovunque.
async function resolveExecutablePath(): Promise<string | undefined> {
  // Override esplicito (CI / power user)
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH

  // Vercel/Lambda serverless: usa @sparticuz/chromium
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return chromium.executablePath()
  }

  // Test: salta dynamic import puppeteer (lento), lascia decidere al mock
  if (process.env.NODE_ENV === 'test') return undefined

  // Dev locale: usa puppeteer full (devDep) per ottenere il path del Chromium bundled
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const puppeteerFull: any = await import('puppeteer').catch(() => null)
    const path = puppeteerFull?.default?.executablePath?.()
    if (path) return path
  } catch {
    // continua a fallback
  }

  // Fallback Windows
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  }

  return undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getBrowser(): Promise<any> {
  const executablePath = await resolveExecutablePath()
  const isVercel = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)

  if (isVercel) {
    return puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: 'shell',
    })
  }

  return puppeteer.launch({ headless: true, executablePath })
}

/**
 * Converte HTML in Buffer PDF A4 via Chromium headless (rendering identico al browser).
 * Mantiene la firma pubblica precedente — caller (`tools.ts:217`) non deve cambiare.
 */
export type OpzioniDocumento = {
  /**
   * Chiamata con gli id delle immagini rimaste fuori. Serve a NON consegnare in
   * silenzio un documento con le foto rotte: chi salva il file puo' dirlo
   * all'Ingegnere invece di dichiararlo a posto.
   */
  onImmaginiMancanti?: (idMancanti: string[]) => void
  /**
   * Chi firma il documento in fondo. Le societa' sono DUE: un documento de La
   * Real Estate che porta il piede di Restruktura espone al destinatario una
   * ragione sociale e una partita IVA che non sono le sue.
   */
  societa?: { denominazione: string; piva: string }
}

export async function generatePdfFromHtml(
  html: string,
  title: string,
  opzioni: OpzioniDocumento = {},
): Promise<Buffer> {
  const { html: htmlWithEmbeddedImages, mancanti } = await embedDriveImages(html)
  if (mancanti.length > 0) opzioni.onImmaginiMancanti?.(mancanti)
  const wrappedHtml = wrapForPrint(htmlWithEmbeddedImages, title)
  // FIX #10 (report 13/08): Chromium serverless fallisce a intermittenza (cold start,
  // launch race). Retry con browser fresco + timeout su setContent per non appendere.
  const MAX_ATTEMPTS = 2
  let lastErr: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let browser: any
    try {
      browser = await getBrowser()
      const page = await browser.newPage()
      await page.setContent(wrappedHtml, { waitUntil: 'networkidle0', timeout: 30000 })
      const pdfBytes = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '15mm', right: '15mm', bottom: '20mm', left: '15mm' },
        displayHeaderFooter: true,
        headerTemplate: HEADER_TEMPLATE,
        footerTemplate: piedePagina(opzioni.societa ?? SOCIETA_PREDEFINITA),
      })
      return Buffer.from(pdfBytes)
    } catch (err) {
      lastErr = err
      console.error(`[PDF] tentativo ${attempt}/${MAX_ATTEMPTS} fallito:`, err instanceof Error ? err.message : err)
    } finally {
      if (browser) await browser.close().catch(() => undefined)
    }
  }
  throw new Error(`Generazione PDF fallita dopo ${MAX_ATTEMPTS} tentativi: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}

// ═══════════════════════════════════════════════════════════════
// DOCX — Generatore Word da HTML semplice (h1/h2/h3/p)
// ═══════════════════════════════════════════════════════════════

interface DocBlock {
  text: string
  type: 'h1' | 'h2' | 'h3' | 'p'
}

function htmlToDocxBlocks(rawHtml: string): DocBlock[] {
  const cleaned = rawHtml
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  const blocks: DocBlock[] = []
  const blockRe = /<(h1|h2|h3|h4|h5|h6|p|div|tr|li)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(cleaned)) !== null) {
    const tag = m[1].toLowerCase()
    const innerRaw = m[2]
    const inner = innerRaw
      .replace(/<\/?(th|td)[^>]*>/gi, '  ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#039;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
    if (!inner) continue

    let type: DocBlock['type'] = 'p'
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') type = tag
    else if (tag === 'h4' || tag === 'h5' || tag === 'h6') type = 'h3'

    blocks.push({ text: inner, type })
  }

  if (blocks.length === 0) {
    const fallback = cleaned
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (fallback) blocks.push({ text: fallback, type: 'p' })
  }

  return blocks
}

/**
 * Converte HTML semplice in Buffer .docx A4 portrait.
 *
 * Le immagini Drive VENGONO incluse (8 set 2026). Prima il limite dichiarato era
 * "no immagini": un Word con l'allegato fotografico usciva senza le foto, e
 * senza dirlo. Un documento consegnato al committente a cui mancano le foto del
 * degrado non e' un documento con meno grafica: e' un documento che non prova
 * quello che afferma.
 *
 * Limiti che restano: no tabelle native (`<table>` → righe testo), no CSS.
 * Per output con tabelle vere usare generateXlsxFromData.
 */
export async function generateDocxFromHtml(
  html: string,
  title: string,
  opzioni: OpzioniDocumento = {},
): Promise<Buffer> {
  const blocks = htmlToDocxBlocks(html)

  // Le foto si scaricano PRIMA di comporre il documento: `docx` vuole i byte,
  // non un URL.
  const idImmagini = immaginiDriveNellHtml(html)
  /**
   * Una voce per OGNI immagine richiamata, nell'ordine del documento. Chi non
   * ce l'ha fatta resta come `null` e occupa comunque il suo posto.
   *
   * Prima le immagini riuscite venivano semplicemente accodate: se la seconda
   * di sei falliva, la terza scivolava al secondo posto e nella perizia
   * consegnata al committente la foto del balcone finiva sotto la didascalia
   * del cornicione. Un documento che attribuisce la foto sbagliata al degrado
   * sbagliato e' peggio di un documento senza foto.
   */
  const immagini: Array<{ byte: Buffer; tipo: 'jpg' | 'png' | 'gif' | 'bmp' } | null> = []
  const mancanti: string[] = []
  if (idImmagini.length > 0) {
    const { downloadFileBase64 } = await import('./drive')
    for (const id of idImmagini) {
      try {
        const { base64, mimeType } = await downloadFileBase64(id)
        // Il tipo VERO, non 'jpg' per tutto: byte WEBP o HEIC dentro una parte
        // dichiarata JPEG diventano un riquadro rotto dentro Word, mentre il
        // download e' andato a buon fine e quindi nessuno avvisa.
        const tipo = estensioneDocx(mimeType)
        if (!tipo) {
          console.error(`[DOCX] formato non inseribile in un Word (${mimeType}) per ${id}`)
          immagini.push(null)
          mancanti.push(id)
          continue
        }
        immagini.push({ byte: Buffer.from(base64, 'base64'), tipo })
      } catch (err) {
        console.error(`[DOCX] immagine Drive non scaricata (${id}):`, err instanceof Error ? err.message : err)
        immagini.push(null)
        mancanti.push(id)
      }
    }
    if (mancanti.length > 0) opzioni.onImmaginiMancanti?.(mancanti)
  }

  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: title, bold: true, size: 32 })],
    }),
    new Paragraph({ children: [new TextRun(' ')] }),
  ]

  for (const block of blocks) {
    let heading: (typeof HeadingLevel)[keyof typeof HeadingLevel] | undefined
    if (block.type === 'h1') heading = HeadingLevel.HEADING_1
    else if (block.type === 'h2') heading = HeadingLevel.HEADING_2
    else if (block.type === 'h3') heading = HeadingLevel.HEADING_3

    children.push(
      new Paragraph({
        heading,
        children: [new TextRun({ text: block.text, size: heading ? 26 : 22 })],
      }),
    )
  }

  // Le foto, in fondo: l'allegato fotografico. Larghezza fissa a misura di A4
  // con i margini, altezza proporzionata a 4:3 — senza dimensioni `docx` non
  // sa che spazio darle e Word le mostra schiacciate.
  for (const voce of pianificaAllegato(idImmagini, immagini)) {
    if (voce.tipo === 'assente') {
      // Il posto resta occupato, e dichiarato. Cosi' la foto dopo non slitta e
      // chi legge sa che li' ne manca una, invece di guardare quella sbagliata.
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({
              text: `[Foto ${voce.indice + 1} non disponibile — id Drive ${voce.id}]`,
              italics: true,
              size: 18,
            }),
          ],
        }),
      )
      continue
    }
    // Proporzioni VERE. Le foto di cantiere scattate col telefono sono in larga
    // parte verticali: a 480x360 fissi uscivano tutte schiacciate.
    const misura = riquadroDocx(dimensioniImmagine(voce.byte))
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            type: voce.formato,
            data: voce.byte,
            transformation: { width: misura.larghezza, height: misura.altezza },
          }),
        ],
      }),
    )
  }

  children.push(new Paragraph({ children: [new TextRun(' ')] }))
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: `${(opzioni.societa ?? SOCIETA_PREDEFINITA).denominazione} — P.IVA ${(opzioni.societa ?? SOCIETA_PREDEFINITA).piva}`,
          size: 18,
          italics: true,
        }),
      ],
    }),
  )

  const doc = new Document({
    creator: 'Cervellone — Restruktura S.r.l.',
    title,
    sections: [
      {
        properties: { page: { size: { orientation: PageOrientation.PORTRAIT } } },
        children,
      },
    ],
  })

  const buffer = await Packer.toBuffer(doc)
  return Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
}

// ═══════════════════════════════════════════════════════════════
// XLSX — Generatore Excel da dati strutturati
// ═══════════════════════════════════════════════════════════════

export interface XlsxSheet {
  name: string
  rows: (string | number | null)[][]
  /**
   * Id Drive delle foto da mettere nel foglio, sotto la tabella. Prima non
   * c'era nessun canale: un registro fotografico di cantiere usciva con gli URL
   * scritti in cella, o senza niente, e la descrizione del tool non lo diceva.
   */
  immagini?: string[]
}

function safeSheetName(raw: string, fallback: string): string {
  const cleaned = (raw || fallback).replace(/[\\/?*[\]:]/g, '_').slice(0, 31)
  return cleaned || fallback
}

/**
 * Converte array di fogli in Buffer .xlsx con header formattato e auto-width.
 * La PRIMA riga di ogni foglio = header (grassetto bianco su sfondo blu Restruktura).
 * Freeze prima riga sempre attivo.
 */
export async function generateXlsxFromData(
  sheets: XlsxSheet[],
  title: string,
  opzioni: OpzioniDocumento = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Cervellone — Restruktura S.r.l.'
  workbook.title = title
  workbook.created = new Date()

  if (sheets.length === 0) {
    workbook.addWorksheet('Foglio1')
  }

  sheets.forEach((sheetDef, sheetIdx) => {
    const sheetName = safeSheetName(sheetDef.name, `Foglio${sheetIdx + 1}`)
    const sheet = workbook.addWorksheet(sheetName)

    if (!sheetDef.rows || sheetDef.rows.length === 0) return

    sheetDef.rows.forEach((row, idx) => {
      const xlsxRow = sheet.addRow(row)
      if (idx === 0) {
        xlsxRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        xlsxRow.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF1E3A5F' },
        }
        xlsxRow.alignment = { horizontal: 'left', vertical: 'middle' }
        xlsxRow.height = 22
      }
    })

    const numCols = sheetDef.rows[0]?.length || 0
    for (let i = 0; i < numCols; i++) {
      let maxLen = 10
      for (const row of sheetDef.rows) {
        const val = row[i]
        if (val != null) {
          const len = String(val).length
          if (len > maxLen) maxLen = len
        }
      }
      const col = sheet.getColumn(i + 1)
      col.width = Math.min(maxLen + 2, 60)
    }

    sheet.views = [{ state: 'frozen', ySplit: 1 }]
  })

  // Le foto, sotto la tabella di ogni foglio. Un registro fotografico di
  // cantiere in Excel non aveva nessun modo di contenerle.
  const mancanti: string[] = []
  for (const [sheetIdx, sheetDef] of sheets.entries()) {
    if (!sheetDef.immagini?.length) continue
    const sheet = workbook.getWorksheet(safeSheetName(sheetDef.name, `Foglio${sheetIdx + 1}`))
    if (!sheet) continue

    const { downloadFileBase64 } = await import('./drive')
    let riga = (sheetDef.rows?.length ?? 0) + 2
    for (const id of sheetDef.immagini) {
      try {
        const { base64, mimeType } = await downloadFileBase64(id)
        const estensione = estensioneDocx(mimeType)
        if (!estensione || estensione === 'bmp') {
          // ExcelJS accetta jpeg/png/gif: cio' che non sa mettere si dichiara,
          // invece di infilarlo dentro col nome sbagliato.
          console.error(`[XLSX] formato non inseribile (${mimeType}) per ${id}`)
          mancanti.push(id)
          continue
        }
        const misura = riquadroDocx(dimensioniImmagine(Buffer.from(base64, 'base64')))
        const idImmagine = workbook.addImage({
          buffer: Buffer.from(base64, 'base64') as unknown as ExcelJS.Buffer,
          extension: estensione === 'jpg' ? 'jpeg' : estensione,
        })
        sheet.addImage(idImmagine, {
          tl: { col: 0, row: riga },
          ext: { width: misura.larghezza, height: misura.altezza },
        })
        // Righe di Excel occupate dalla foto, piu' una di respiro.
        riga += Math.ceil(misura.altezza / 20) + 1
      } catch (err) {
        console.error(`[XLSX] immagine Drive non scaricata (${id}):`, err instanceof Error ? err.message : err)
        mancanti.push(id)
      }
    }
  }
  if (mancanti.length > 0) opzioni.onImmaginiMancanti?.(mancanti)

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer as ArrayBuffer)
}
