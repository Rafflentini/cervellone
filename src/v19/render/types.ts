/**
 * Cervellone V19 — DOCX/XLSX/PDF semantic render types
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 8
 */

export type DocxAlignment = 'left' | 'center' | 'right' | 'justify'

export type DocxRunStyle = {
  bold?: boolean
  italics?: boolean
  underline?: boolean
  size?: number // half-points (es. 22 = 11pt)
  color?: string // hex senza '#', es. "C00000"
  font?: string
}

export type DocxCellStyle = {
  bgColor?: string
  align?: DocxAlignment
  bold?: boolean
  color?: string
  width?: number // percentage 0-100
}

export type DocxCell = string | { text: string; style?: DocxCellStyle }

export type DocxColumn = {
  header: string
  align?: DocxAlignment
  width?: 'auto' | number // numero = percentage 0-100
}

export type DocxHeaderStyle = {
  bgColor?: string // es. "C00000" rosso INPS
  color?: string // default "FFFFFF"
  bold?: boolean // default true
}

export type DocxBordersKind = 'all' | 'horizontal' | 'none'

export type DocxSection =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string; align?: DocxAlignment; style?: DocxRunStyle }
  | { kind: 'paragraph'; text: string; align?: DocxAlignment; style?: DocxRunStyle }
  | { kind: 'paragraph_runs'; runs: { text: string; style?: DocxRunStyle }[]; align?: DocxAlignment }
  | { kind: 'table'; caption?: string; columns: DocxColumn[]; headerStyle?: DocxHeaderStyle; cellBorders?: DocxBordersKind; rows: DocxCell[][] }
  | { kind: 'list'; ordered?: boolean; items: string[] }
  | { kind: 'page_break' }
  | { kind: 'horizontal_rule' }

export type DocxDocument = {
  title: string
  sections: DocxSection[]
  /** Footer testuale custom. Se assente, default Restruktura. */
  footer?: string
  /** Margini in TWIPS (1 cm = 567). Default tutti 1417 (~2.5cm). */
  margins?: { top?: number; right?: number; bottom?: number; left?: number }
  /** Orientamento. Default portrait. */
  orientation?: 'portrait' | 'landscape'
}

export type XlsxSheet = {
  name: string
  rows: (string | number | null)[][]
  /** Se true (default), prima riga è header con stile. */
  hasHeader?: boolean
}
