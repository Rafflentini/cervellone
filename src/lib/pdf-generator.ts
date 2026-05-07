/**
 * lib/pdf-generator.ts — Generatore PDF da HTML usando jsPDF
 *
 * Usa jsPDF text rendering riga-per-riga per produrre PDF A4 leggibili.
 * Non richiede DOM/html2canvas — funziona in ambiente serverless Node.js.
 */

import { jsPDF } from 'jspdf'

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
  const usableHeight = pageHeight - marginTop - marginBottom

  // ── Estrai testo dall'HTML ──
  // Rimuove tag HTML, decodifica entità comuni, preserva struttura paragrafi
  function htmlToText(rawHtml: string): string[] {
    // Sostituisce tag di blocco con newline
    let text = rawHtml
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
  let isFirstPage = true

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

  isFirstPage = false

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
