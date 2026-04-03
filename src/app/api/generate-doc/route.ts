import { NextRequest, NextResponse } from 'next/server'
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } from 'docx'
import ExcelJS from 'exceljs'
import { jsPDF } from 'jspdf'

export async function POST(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  if (!authCookie) {
    return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
  }

  const { type, content, fileName } = await request.json()

  if (type === 'docx') {
    return generateDocx(content, fileName)
  } else if (type === 'xlsx') {
    return generateXlsx(content, fileName)
  } else if (type === 'pdf') {
    return generatePdf(content, fileName)
  }

  return NextResponse.json({ error: 'Tipo non supportato' }, { status: 400 })
}

// Converte markdown-like text in paragrafi Word
function markdownToDocx(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = []
  const lines = text.split('\n')

  for (const line of lines) {
    if (line.trim() === '') {
      paragraphs.push(new Paragraph({ text: '' }))
      continue
    }

    if (line.startsWith('# ')) {
      paragraphs.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [new TextRun({ text: line.slice(2), bold: true, size: 32 })],
        spacing: { before: 400, after: 200 },
      }))
    } else if (line.startsWith('## ')) {
      paragraphs.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: line.slice(3), bold: true, size: 28 })],
        spacing: { before: 300, after: 150 },
      }))
    } else if (line.startsWith('### ')) {
      paragraphs.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: [new TextRun({ text: line.slice(4), bold: true, size: 24 })],
        spacing: { before: 200, after: 100 },
      }))
    } else if (line.startsWith('---')) {
      paragraphs.push(new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 1, color: '999999' } },
        spacing: { before: 200, after: 200 },
      }))
    } else if (line.match(/^[\s]*[-*]\s/)) {
      const content = line.replace(/^[\s]*[-*]\s/, '')
      paragraphs.push(new Paragraph({
        bullet: { level: 0 },
        children: parseInlineFormatting(content),
        spacing: { before: 40, after: 40 },
      }))
    } else if (line.match(/^\s*\d+\.\s/)) {
      const content = line.replace(/^\s*\d+\.\s/, '')
      paragraphs.push(new Paragraph({
        numbering: { reference: 'default-numbering', level: 0 },
        children: parseInlineFormatting(content),
        spacing: { before: 40, after: 40 },
      }))
    } else {
      paragraphs.push(new Paragraph({
        children: parseInlineFormatting(line),
        spacing: { before: 60, after: 60 },
      }))
    }
  }

  return paragraphs
}

// Parse bold/italic inline
function parseInlineFormatting(text: string): TextRun[] {
  const runs: TextRun[] = []
  const regex = /\*\*(.*?)\*\*|\*(.*?)\*/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index), size: 22 }))
    }
    if (match[1]) {
      runs.push(new TextRun({ text: match[1], bold: true, size: 22 }))
    } else if (match[2]) {
      runs.push(new TextRun({ text: match[2], italics: true, size: 22 }))
    }
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex), size: 22 }))
  }

  if (runs.length === 0) {
    runs.push(new TextRun({ text, size: 22 }))
  }

  return runs
}

async function generateDocx(content: string, fileName: string) {
  const doc = new Document({
    numbering: {
      config: [{
        reference: 'default-numbering',
        levels: [{
          level: 0,
          format: 'decimal' as const,
          text: '%1.',
          alignment: AlignmentType.START,
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
        },
      },
      children: markdownToDocx(content),
    }],
  })

  const buffer = await Packer.toBuffer(doc)

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${fileName || 'documento'}.docx"`,
    },
  })
}

async function generateXlsx(content: string, fileName: string) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Dati')

  // Parse: cerca tabelle nel testo (righe con | separatore)
  const lines = content.split('\n')
  let row = 1
  let inTable = false
  let headerDone = false

  for (const line of lines) {
    if (line.includes('|') && line.trim().startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim())

      // Salta la riga separatore (---)
      if (cells.every(c => c.match(/^[-:]+$/))) {
        headerDone = true
        continue
      }

      const excelRow = sheet.addRow(cells)

      if (!headerDone && !inTable) {
        // Header row
        excelRow.font = { bold: true, size: 11 }
        excelRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } }
      }

      excelRow.alignment = { vertical: 'middle', wrapText: true }
      inTable = true
      row++
    } else if (line.trim() && !inTable) {
      // Testo libero — metti in cella A
      const excelRow = sheet.addRow([line.replace(/[#*]/g, '').trim()])
      if (line.startsWith('#')) {
        excelRow.font = { bold: true, size: 13 }
      }
      row++
    } else if (line.trim() === '' && inTable) {
      inTable = false
      headerDone = false
      row++
    }
  }

  // Auto-width colonne
  sheet.columns.forEach(column => {
    let maxLength = 10
    column.eachCell?.({ includeEmpty: false }, cell => {
      const len = cell.value ? cell.value.toString().length : 0
      if (len > maxLength) maxLength = Math.min(len, 50)
    })
    column.width = maxLength + 4
  })

  // Bordi su tutte le celle con dati
  sheet.eachRow(row => {
    row.eachCell(cell => {
      cell.border = {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' },
      }
    })
  })

  const buffer = await workbook.xlsx.writeBuffer()

  return new Response(new Uint8Array(buffer as unknown as ArrayBuffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName || 'documento'}.xlsx"`,
    },
  })
}

function generatePdf(content: string, fileName: string) {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const marginLeft = 20
  const marginRight = 20
  const marginTop = 25
  const marginBottom = 20
  const maxWidth = pageWidth - marginLeft - marginRight
  let y = marginTop

  const lines = content.split('\n')

  for (const line of lines) {
    // Heading 1
    if (line.startsWith('# ')) {
      doc.setFontSize(18)
      doc.setFont('helvetica', 'bold')
      y += 4
      const wrapped = doc.splitTextToSize(line.slice(2), maxWidth)
      for (const wLine of wrapped) {
        if (y > pageHeight - marginBottom) { doc.addPage(); y = marginTop }
        doc.text(wLine, marginLeft, y)
        y += 8
      }
      y += 2
    // Heading 2
    } else if (line.startsWith('## ')) {
      doc.setFontSize(14)
      doc.setFont('helvetica', 'bold')
      y += 3
      const wrapped = doc.splitTextToSize(line.slice(3), maxWidth)
      for (const wLine of wrapped) {
        if (y > pageHeight - marginBottom) { doc.addPage(); y = marginTop }
        doc.text(wLine, marginLeft, y)
        y += 7
      }
      y += 1
    // Heading 3
    } else if (line.startsWith('### ')) {
      doc.setFontSize(12)
      doc.setFont('helvetica', 'bold')
      y += 2
      const wrapped = doc.splitTextToSize(line.slice(4), maxWidth)
      for (const wLine of wrapped) {
        if (y > pageHeight - marginBottom) { doc.addPage(); y = marginTop }
        doc.text(wLine, marginLeft, y)
        y += 6
      }
    // Separatore
    } else if (line.startsWith('---')) {
      if (y > pageHeight - marginBottom) { doc.addPage(); y = marginTop }
      y += 2
      doc.setDrawColor(180, 180, 180)
      doc.line(marginLeft, y, pageWidth - marginRight, y)
      y += 4
    // Bullet point
    } else if (line.match(/^\s*[-*]\s/)) {
      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      const text = line.replace(/^\s*[-*]\s/, '')
      // Rimuovi markdown bold/italic per il PDF
      const clean = text.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
      const wrapped = doc.splitTextToSize(clean, maxWidth - 6)
      for (let i = 0; i < wrapped.length; i++) {
        if (y > pageHeight - marginBottom) { doc.addPage(); y = marginTop }
        if (i === 0) {
          doc.text('•', marginLeft, y)
          doc.text(wrapped[i], marginLeft + 6, y)
        } else {
          doc.text(wrapped[i], marginLeft + 6, y)
        }
        y += 5.5
      }
    // Riga vuota
    } else if (line.trim() === '') {
      y += 3
    // Testo normale
    } else {
      doc.setFontSize(11)
      doc.setFont('helvetica', 'normal')
      const clean = line.replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
      const wrapped = doc.splitTextToSize(clean, maxWidth)
      for (const wLine of wrapped) {
        if (y > pageHeight - marginBottom) { doc.addPage(); y = marginTop }
        doc.text(wLine, marginLeft, y)
        y += 5.5
      }
    }
  }

  // Footer su ogni pagina
  const totalPages = doc.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    doc.setFontSize(8)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(150, 150, 150)
    doc.text(`Cervellone — Restruktura S.r.l.`, marginLeft, pageHeight - 10)
    doc.text(`Pag. ${i}/${totalPages}`, pageWidth - marginRight - 20, pageHeight - 10)
    doc.setTextColor(0, 0, 0)
  }

  const pdfBuffer = doc.output('arraybuffer')

  return new Response(new Uint8Array(pdfBuffer), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fileName || 'documento'}.pdf"`,
    },
  })
}
