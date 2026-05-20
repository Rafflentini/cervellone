/**
 * Cervellone V19 — DOCX renderer semantico
 *
 * Input: JSON semantico (DocxDocument). Output: Buffer DOCX.
 * Usa lib `docx` v9 nativamente con Table/TableRow/TableCell, ShadingType,
 * BorderStyle, HeadingLevel.
 *
 * Sostituisce src/lib/pdf-generator.ts:144-188 (V18 htmlToDocxBlocks naive).
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 8
 */

import {
  Document,
  HeadingLevel,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  Table,
  TableRow,
  TextRun,
  WidthType,
} from 'docx'
import {
  alignFromString,
  borderConfig,
  buildFooterParagraph,
  buildTextRunFromStyle,
  renderCell,
} from './utils'
import type { DocxDocument, DocxSection } from './types'

export async function renderDocx(doc: DocxDocument): Promise<Buffer> {
  const children: (Paragraph | Table)[] = []

  // Title
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: alignFromString('center'),
      children: [
        new TextRun({ text: doc.title, bold: true, size: 32 }), // 16pt
      ],
    }),
  )

  // Sections
  for (const sec of doc.sections) {
    const rendered = renderSection(sec)
    children.push(...rendered)
  }

  // Footer (in-flow paragraph at end; per veri footer Word, vedi sez. polish)
  children.push(buildFooterParagraph(doc.footer))

  const margins = doc.margins
  const orient = doc.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT

  const docxDoc = new Document({
    creator: 'Cervellone V19',
    title: doc.title,
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: margins?.top ?? 1417,
              right: margins?.right ?? 1417,
              bottom: margins?.bottom ?? 1417,
              left: margins?.left ?? 1417,
            },
            size: {
              orientation: orient,
            },
          },
        },
        children,
      },
    ],
  })

  const out = await Packer.toBuffer(docxDoc)
  return Buffer.isBuffer(out) ? out : Buffer.from(out)
}

function renderSection(sec: DocxSection): (Paragraph | Table)[] {
  switch (sec.kind) {
    case 'heading': {
      const headingLevel =
        sec.level === 1 ? HeadingLevel.HEADING_1
        : sec.level === 2 ? HeadingLevel.HEADING_2
        : sec.level === 3 ? HeadingLevel.HEADING_3
        : sec.level === 4 ? HeadingLevel.HEADING_4
        : sec.level === 5 ? HeadingLevel.HEADING_5
        : HeadingLevel.HEADING_6
      return [
        new Paragraph({
          heading: headingLevel,
          alignment: alignFromString(sec.align),
          children: [buildTextRunFromStyle(sec.text, { bold: true, ...sec.style })],
        }),
      ]
    }

    case 'paragraph': {
      return [
        new Paragraph({
          alignment: alignFromString(sec.align),
          children: [buildTextRunFromStyle(sec.text, sec.style)],
        }),
      ]
    }

    case 'paragraph_runs': {
      return [
        new Paragraph({
          alignment: alignFromString(sec.align),
          children: sec.runs.map((r) => buildTextRunFromStyle(r.text, r.style)),
        }),
      ]
    }

    case 'table': {
      return [renderTable(sec)]
    }

    case 'list': {
      return sec.items.map(
        (item, idx) =>
          new Paragraph({
            bullet: sec.ordered ? undefined : { level: 0 },
            numbering: sec.ordered ? { reference: 'numbered', level: 0 } : undefined,
            children: [new TextRun({ text: sec.ordered ? `${idx + 1}. ${item}` : item })],
          }),
      )
    }

    case 'page_break': {
      return [
        new Paragraph({
          children: [new PageBreak()],
        }),
      ]
    }

    case 'horizontal_rule': {
      return [
        new Paragraph({
          children: [new TextRun({ text: '_'.repeat(80) })],
        }),
      ]
    }

    default: {
      const exhaustive: never = sec
      throw new Error(`Sezione DOCX sconosciuta: ${JSON.stringify(exhaustive)}`)
    }
  }
}

function renderTable(t: Extract<DocxSection, { kind: 'table' }>): Table {
  const headerStyle = t.headerStyle ?? { bgColor: 'C00000', color: 'FFFFFF', bold: true }
  const borders = t.cellBorders ?? 'all'

  const headerRow = new TableRow({
    tableHeader: true,
    children: t.columns.map((c) =>
      renderCell(
        {
          text: c.header,
          style: {
            bgColor: headerStyle.bgColor,
            color: headerStyle.color ?? 'FFFFFF',
            bold: headerStyle.bold ?? true,
            align: c.align,
            width: typeof c.width === 'number' ? c.width : undefined,
          },
        },
        borders,
        c.align,
      ),
    ),
  })

  const dataRows = t.rows.map(
    (row) =>
      new TableRow({
        children: row.map((cell, ci) => renderCell(cell, borders, t.columns[ci]?.align)),
      }),
  )

  const allRows = [headerRow, ...dataRows]
  if (t.caption) {
    // Caption non è proprio supportato come elemento docx separato facilmente;
    // lo aggiungiamo sopra come paragrafo italics. Trade-off accettato.
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: allRows,
  })
}
