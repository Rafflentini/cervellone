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
 * Spec: docs/superpowers/specs/2026-05-08-cervellone-pdf-puppeteer-design.md
 */
import puppeteer from 'puppeteer-core'
import chromium from '@sparticuz/chromium'
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  PageOrientation,
} from 'docx'
import ExcelJS from 'exceljs'

const FOOTER_TEMPLATE = `<div style="font-size: 8pt; color: #888888; width: 100%; padding: 0 15mm; display: flex; justify-content: space-between; -webkit-print-color-adjust: exact;">
  <span>RESTRUKTURA S.r.l. — P.IVA 02087420762</span>
  <span>Pagina <span class="pageNumber"></span> di <span class="totalPages"></span></span>
</div>`

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
export async function generatePdfFromHtml(html: string, title: string): Promise<Buffer> {
  const wrappedHtml = wrapForPrint(html, title)
  const browser = await getBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(wrappedHtml, { waitUntil: 'networkidle0' })
    const pdfBytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', right: '15mm', bottom: '20mm', left: '15mm' },
      displayHeaderFooter: true,
      headerTemplate: HEADER_TEMPLATE,
      footerTemplate: FOOTER_TEMPLATE,
    })
    return Buffer.from(pdfBytes)
  } finally {
    await browser.close().catch(() => undefined)
  }
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
 * Limiti accettati: no tabelle native (`<table>` → righe testo), no immagini, no CSS.
 * Per output con tabelle vere usare generateXlsxFromData.
 */
export async function generateDocxFromHtml(html: string, title: string): Promise<Buffer> {
  const blocks = htmlToDocxBlocks(html)

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

  children.push(new Paragraph({ children: [new TextRun(' ')] }))
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({
          text: "RESTRUKTURA S.r.l. — P.IVA 02087420762 — Villa d'Agri (PZ)",
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

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer as ArrayBuffer)
}
