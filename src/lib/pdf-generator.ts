/**
 * lib/pdf-generator.ts — Generatori documento (PDF + DOCX + XLSX)
 *
 * - generatePdfFromHtml: HTML → Buffer PDF (jsPDF, layout testo riga-per-riga)
 * - generateDocxFromHtml: HTML → Buffer DOCX (libreria docx, blocchi semantici)
 * - generateXlsxFromData: dati strutturati → Buffer XLSX (ExcelJS, header formattato)
 *
 * Tutti gli output sono Buffer Node.js pronti per uploadBinaryToDrive.
 * Nessuno richiede DOM/browser — funzionano in serverless Vercel.
 */

import { jsPDF } from 'jspdf'
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

// ═══════════════════════════════════════════════════════════════
// PDF — invariato dalla versione precedente
// ═══════════════════════════════════════════════════════════════

/**
 * Converte HTML semplice (tipo DDT/preventivo/perizia) in Buffer PDF A4.
 * Strategia: strip tag HTML → testo plain → layout riga-per-riga con jsPDF.
 * Output: Buffer binario del file PDF.
 */
export async function generatePdfFromHtml(html: string, title: string): Promise<Buffer> {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  })

  const pageWidth = 210
  const marginLeft = 15
  const marginRight = 15
  const marginTop = 20
  const marginBottom = 20
  const usableWidth = pageWidth - marginLeft - marginRight
  const pageHeight = 297

  // ── Estrai testo dall'HTML ──
  // Rimuove tag HTML, decodifica entità comuni, preserva struttura paragrafi
  function htmlToText(rawHtml: string): string[] {
    // FIX BUG-PDF-CSS: rimuovi PRIMA il contenuto di <style>, <script>, <head>
    // altrimenti il CSS finisce stampato come testo nel PDF.
    // Regex con flag 's' (dotAll) per matchare anche newline.
    const text = rawHtml
      // Rimuovi blocchi che NON devono apparire come testo
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      // Sostituisce tag di blocco con newline
      .replace(/<\/?(h[1-6]|p|div|tr|li|br)[^>]*>/gi, '\n')
      .replace(/<\/?(th|td)[^>]*>/gi, '  ')
      // Rimuove tutti i tag rimanenti
      .replace(/<[^>]+>/g, '')
      // Decodifica entità HTML
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#039;/g, "'")
      // Collassa spazi multipli su stessa riga
      .replace(/[ \t]+/g, ' ')
      // Collassa 3+ newline consecutive in 2
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    return text.split('\n')
  }

  const lines = htmlToText(html)

  // ── Layout ──
  let y = marginTop

  // Header pagina 1: titolo documento
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  const titleLines = doc.splitTextToSize(title.slice(0, 200), usableWidth)
  doc.text(titleLines, marginLeft, y)
  y += titleLines.length * 7 + 4

  // Linea separatrice sotto titolo
  doc.setLineWidth(0.3)
  doc.line(marginLeft, y, pageWidth - marginRight, y)
  y += 6

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  const lineHeight = 5

  for (const rawLine of lines) {
    const trimmed = rawLine.trim()

    // Linea vuota = spazio verticale
    if (!trimmed) {
      y += lineHeight * 0.6
      if (y > pageHeight - marginBottom) {
        doc.addPage()
        y = marginTop
      }
      continue
    }

    // Detect titoletti (tutto maiuscolo, breve) → grassetto
    const isHeading = trimmed.length < 80 && trimmed === trimmed.toUpperCase() && /[A-Z]/.test(trimmed)
    if (isHeading) {
      doc.setFont('helvetica', 'bold')
      doc.setFontSize(10)
    } else {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
    }

    const wrappedLines = doc.splitTextToSize(trimmed, usableWidth)
    const blockHeight = wrappedLines.length * lineHeight + (isHeading ? 2 : 0)

    // Nuova pagina se necessario
    if (y + blockHeight > pageHeight - marginBottom) {
      doc.addPage()
      y = marginTop
    }

    if (isHeading) {
      y += 2
      doc.text(wrappedLines, marginLeft, y)
      y += blockHeight + 1
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(9)
    } else {
      doc.text(wrappedLines, marginLeft, y)
      y += blockHeight
    }
  }

  // Numerazione pagine
  const totalPages = (doc as unknown as { getNumberOfPages(): number }).getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    doc.setFontSize(8)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(150)
    doc.text(`Pagina ${i} di ${totalPages}`, pageWidth - marginRight, pageHeight - 8, { align: 'right' })
    doc.text('RESTRUKTURA S.r.l. — P.IVA 02087420762', marginLeft, pageHeight - 8)
    doc.setTextColor(0)
  }

  // Output come Buffer Node.js
  const arrayBuffer = doc.output('arraybuffer')
  return Buffer.from(arrayBuffer)
}

// ═══════════════════════════════════════════════════════════════
// DOCX — Generatore Word
// ═══════════════════════════════════════════════════════════════

interface DocBlock {
  text: string
  type: 'h1' | 'h2' | 'h3' | 'p'
}

function htmlToDocxBlocks(rawHtml: string): DocBlock[] {
  // Rimuovi blocchi non testuali (style/script/head/comments)
  const cleaned = rawHtml
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')

  const blocks: DocBlock[] = []

  // Match blocchi semantici di primo livello
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

  // Fallback: nessun blocco semantico → tratta tutto come un singolo paragrafo
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
 * Limiti: no tabelle native (le <table> diventano righe testo con celle separate),
 * no immagini, no CSS. Per output con tabelle vere usare generateXlsxFromData.
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

  // Footer Restruktura
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
// XLSX — Generatore Excel
// ═══════════════════════════════════════════════════════════════

export interface XlsxSheet {
  name: string
  rows: (string | number | null)[][]
}

/**
 * Sanitizza nome foglio Excel: max 31 char, no caratteri proibiti `\ / ? * [ ] :`.
 */
function safeSheetName(raw: string, fallback: string): string {
  const cleaned = (raw || fallback).replace(/[\\/?*[\]:]/g, '_').slice(0, 31)
  return cleaned || fallback
}

/**
 * Converte array di fogli in Buffer .xlsx con header formattato e auto-width.
 * La PRIMA riga di ogni foglio è trattata come header (grassetto, sfondo blu Restruktura).
 *
 * Esempio:
 *   await generateXlsxFromData([{
 *     name: 'CME',
 *     rows: [
 *       ['Codice', 'Descrizione', 'U.M.', 'Q.tà', 'P.U.', 'Importo'],
 *       ['BAS25_E03', 'Demolizione pavimento', 'mq', 50, 12.50, 625.00],
 *     ],
 *   }], 'CME Cantiere Rossi')
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
        // Header: grassetto bianco su sfondo blu Restruktura
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

    // Auto-fit colonne — heuristic: max(header.length, valori) + padding 2, capped 60
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

    // Freeze prima riga (header sempre visibile)
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
  })

  const arrayBuffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer as ArrayBuffer)
}
