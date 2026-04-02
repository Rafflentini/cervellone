import { NextRequest, NextResponse } from 'next/server'
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } from 'docx'
import ExcelJS from 'exceljs'

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

  return new Response(new Uint8Array(buffer as Buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${fileName || 'documento'}.xlsx"`,
    },
  })
}
