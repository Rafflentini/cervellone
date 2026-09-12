/**
 * Cervellone V19 — DOCX render utilities
 */

import {
  AlignmentType,
  BorderStyle,
  Paragraph,
  ShadingType,
  TableCell,
  TextRun,
  WidthType,
} from 'docx'
import type { DocxAlignment, DocxBordersKind, DocxCell, DocxCellStyle, DocxRunStyle } from './types'

type DocxBorderSide = {
  style: (typeof BorderStyle)[keyof typeof BorderStyle]
  size: number
  color: string
}

type DocxBorderConfig = {
  top: DocxBorderSide
  bottom: DocxBorderSide
  left: DocxBorderSide
  right: DocxBorderSide
} | undefined

export function alignFromString(a?: DocxAlignment): typeof AlignmentType[keyof typeof AlignmentType] | undefined {
  switch (a) {
    case 'center':
      return AlignmentType.CENTER
    case 'right':
      return AlignmentType.RIGHT
    case 'justify':
      return AlignmentType.JUSTIFIED
    case 'left':
      return AlignmentType.LEFT
    default:
      return undefined
  }
}

export function borderConfig(kind: DocxBordersKind = 'all'): DocxBorderConfig {
  if (kind === 'none') {
    return undefined
  }
  const single = { style: BorderStyle.SINGLE, size: 6, color: '000000' }
  if (kind === 'horizontal') {
    return {
      top: single,
      bottom: single,
      left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    }
  }
  return { top: single, bottom: single, left: single, right: single }
}

export function buildTextRunFromStyle(text: string, style?: DocxRunStyle): TextRun {
  return new TextRun({
    text,
    bold: style?.bold,
    italics: style?.italics,
    underline: style?.underline ? {} : undefined,
    size: style?.size,
    color: style?.color,
    font: style?.font,
  })
}

export function renderCell(cell: DocxCell, borders: DocxBordersKind, columnAlign?: DocxAlignment): TableCell {
  if (typeof cell === 'string') {
    return new TableCell({
      borders: borderConfig(borders),
      children: [
        new Paragraph({
          alignment: alignFromString(columnAlign),
          children: [new TextRun({ text: cell })],
        }),
      ],
    })
  }
  const style: DocxCellStyle = cell.style ?? {}
  return new TableCell({
    borders: borderConfig(borders),
    shading: style.bgColor
      ? { type: ShadingType.SOLID, color: style.bgColor, fill: style.bgColor }
      : undefined,
    width: style.width
      ? { size: Math.round(style.width * 100), type: WidthType.PERCENTAGE }
      : undefined,
    children: [
      new Paragraph({
        alignment: alignFromString(style.align ?? columnAlign),
        children: [
          new TextRun({
            text: cell.text,
            bold: style.bold,
            color: style.color,
          }),
        ],
      }),
    ],
  })
}

/**
 * Il piede del documento. `text` e' OBBLIGATORIO (Task 5): il predefinito
 * "RESTRUKTURA S.r.l. — P.IVA 02087420762 — Villa d'Agri (PZ)" faceva
 * prendere l'identita' di Restruktura a chi dimenticava di passarlo — corretto
 * per caso finche' l'unico chiamante era il CIGO, un difetto muto il giorno in
 * cui qualcun altro riusasse questa funzione per un documento de La Real
 * Estate. Un chiamante che dimentica il piede ora non compila, invece di
 * stampare una partita IVA che non c'entra.
 */
export function buildFooterParagraph(text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [
      new TextRun({
        text,
        size: 18, // 9pt
        italics: true,
      }),
    ],
  })
}
