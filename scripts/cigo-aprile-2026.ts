/**
 * Genera Allegato 10 CIGO Aprile 2026 — RESTRUKTURA S.r.l.
 *
 * USO:
 *   cd "C:\Progetti claude Code\02.SuperING\cervellone"
 *   npx tsx scripts/cigo-aprile-2026.ts
 *
 * OUTPUT:
 *   tmp/All_10_CIGO_Aprile_2026_Restruktura.docx
 *
 * Costanti di stile fedeli alla skill CIGO documentata 9 mag 2026.
 */
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  VerticalAlign,
  LevelFormat,
  HeightRule,
} from 'docx'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ─── COSTANTI STILE ALL.10 RESTRUKTURA ──────────────────────────────────────

const FONT = 'Arial'
const SIZE_BODY = 22 // 11pt
const SIZE_TITLE = 26 // 13pt
const SIZE_TABLE = 20 // 10pt
const SIZE_ALL10 = 22 // 11pt

const PAGE_W = 11906
const PAGE_H = 16838
const MARGIN = { top: 1000, right: 900, bottom: 1000, left: 900 }

const COL_WORKERS = [3000, 2400, 2400, 800, 1400] // 5 colonne

const BORDER_DEF = { style: BorderStyle.SINGLE, size: 8, color: '000000' }
const BORDERS_ALL = {
  top: BORDER_DEF,
  bottom: BORDER_DEF,
  left: BORDER_DEF,
  right: BORDER_DEF,
}
const SHADE_HEADER = 'CCCCCC'
const SHADE_TOTAL = 'EEEEEE'
const CELL_MARGINS = { top: 100, bottom: 100, left: 150, right: 150 }

// ─── HELPER ─────────────────────────────────────────────────────────────────

function p(text: string, opts: { bold?: boolean; align?: AlignmentType; size?: number; spacing?: { before?: number; after?: number } } = {}) {
  return new Paragraph({
    alignment: opts.align ?? AlignmentType.JUSTIFIED,
    spacing: opts.spacing,
    children: [new TextRun({ text, bold: opts.bold, size: opts.size ?? SIZE_BODY, font: FONT })],
  })
}

function pRuns(runs: TextRun[], opts: { align?: AlignmentType; spacing?: { before?: number; after?: number } } = {}) {
  return new Paragraph({ alignment: opts.align ?? AlignmentType.JUSTIFIED, spacing: opts.spacing, children: runs })
}

function run(text: string, opts: { bold?: boolean; size?: number } = {}) {
  return new TextRun({ text, bold: opts.bold, size: opts.size ?? SIZE_BODY, font: FONT })
}

function emptyP() {
  return new Paragraph({ children: [new TextRun('')] })
}

function headerCell(text: string, width: number) {
  return new TableCell({
    borders: BORDERS_ALL,
    margins: CELL_MARGINS,
    width: { size: width, type: WidthType.DXA },
    shading: { fill: SHADE_HEADER, type: ShadingType.CLEAR, color: 'auto' },
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text, bold: true, size: SIZE_TABLE, font: FONT })],
      }),
    ],
  })
}

function dataCell(text: string, width: number, align: AlignmentType = AlignmentType.CENTER, opts: { shade?: string; bold?: boolean } = {}) {
  return new TableCell({
    borders: BORDERS_ALL,
    margins: CELL_MARGINS,
    width: { size: width, type: WidthType.DXA },
    shading: opts.shade ? { fill: opts.shade, type: ShadingType.CLEAR, color: 'auto' } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        alignment: align,
        children: [new TextRun({ text, bold: opts.bold, size: SIZE_TABLE, font: FONT })],
      }),
    ],
  })
}

// ─── DATI SPECIFICI APRILE 2026 ─────────────────────────────────────────────

const dataInizio = '01/04/2026'
const dataFine = '30/04/2026'
const dataFirma = '30/04/2026'
const upNome = 'MARSICOVETERE VIA NAZIONALE'
const dataAperturaCantiere = '18/07/2023'
const giornate = ['01/04/2026', '02/04/2026', '30/04/2026']
const orePerOperaio = 24 // 8h × 3 giornate
const totaleOre = 72

const operai = [
  { nome: 'PACILLI MARTIN', cf: 'PCLMTN94C04E977G', qualifica: 'Muratore Edile', livello: '2^', ore: orePerOperaio },
  { nome: 'PIRRONE MICHELE', cf: 'PRRMHL83H08E977T', qualifica: 'Manovale Edile', livello: '1^', ore: orePerOperaio },
  { nome: 'GURU KULWANT RAY', cf: 'GRUKWN88E01Z222K', qualifica: 'Manovale Edile', livello: '1^', ore: orePerOperaio },
]

// ─── TABELLE ────────────────────────────────────────────────────────────────

// Tabella DATI AZIENDA (1 colonna larga, righe interne con label/valore)
const tableAzienda = new Table({
  width: { size: 10000, type: WidthType.DXA },
  columnWidths: [10000],
  rows: [
    new TableRow({
      children: [
        new TableCell({
          borders: BORDERS_ALL,
          margins: CELL_MARGINS,
          width: { size: 10000, type: WidthType.DXA },
          shading: { fill: SHADE_HEADER, type: ShadingType.CLEAR, color: 'auto' },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: 'DATI RELATIVI ALL’AZIENDA', bold: true, size: SIZE_TABLE, font: FONT })],
            }),
          ],
        }),
      ],
    }),
    ...[
      ['Denominazione:', 'RESTRUKTURA S.R.L.'],
      ['Matricola / Codice Fiscale:', '6405924990 / 02087420762'],
      ['Unità Produttiva:', upNome],
      ['Data inizio attività produttiva:', dataAperturaCantiere],
    ].map(
      ([label, value]) =>
        new TableRow({
          children: [
            new TableCell({
              borders: BORDERS_ALL,
              margins: CELL_MARGINS,
              width: { size: 10000, type: WidthType.DXA },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({ text: label + '   ', bold: true, size: SIZE_TABLE, font: FONT }),
                    new TextRun({ text: value, size: SIZE_TABLE, font: FONT }),
                  ],
                }),
              ],
            }),
          ],
        }),
    ),
  ],
})

// Tabella LAVORATORI
const headerRow = new TableRow({
  tableHeader: true,
  children: [
    headerCell('COGNOME E NOME', COL_WORKERS[0]),
    headerCell('CODICE FISCALE', COL_WORKERS[1]),
    headerCell('QUALIFICA', COL_WORKERS[2]),
    headerCell('LIV.', COL_WORKERS[3]),
    headerCell('ORE SOSP.', COL_WORKERS[4]),
  ],
})

const operaiRows = operai.map(
  (o) =>
    new TableRow({
      children: [
        dataCell(o.nome, COL_WORKERS[0], AlignmentType.LEFT),
        dataCell(o.cf, COL_WORKERS[1]),
        dataCell(o.qualifica, COL_WORKERS[2], AlignmentType.LEFT),
        dataCell(o.livello, COL_WORKERS[3]),
        dataCell(String(o.ore), COL_WORKERS[4]),
      ],
    }),
)

// Riga totale: "TOTALE ORE RICHIESTE:" allineato a destra nelle prime 4 colonne unite, totale nella 5a
const totalRow = new TableRow({
  children: [
    new TableCell({
      borders: BORDERS_ALL,
      margins: CELL_MARGINS,
      columnSpan: 4,
      shading: { fill: SHADE_TOTAL, type: ShadingType.CLEAR, color: 'auto' },
      verticalAlign: VerticalAlign.CENTER,
      children: [
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: 'TOTALE ORE RICHIESTE:', bold: true, size: SIZE_TABLE, font: FONT })],
        }),
      ],
    }),
    dataCell(String(totaleOre), COL_WORKERS[4], AlignmentType.CENTER, { shade: SHADE_TOTAL, bold: true }),
  ],
})

const tableLavoratori = new Table({
  width: { size: 10000, type: WidthType.DXA },
  columnWidths: COL_WORKERS,
  rows: [headerRow, ...operaiRows, totalRow],
})

// ─── DOCUMENTO ──────────────────────────────────────────────────────────────

const doc = new Document({
  creator: 'RESTRUKTURA S.r.l.',
  title: 'Allegato 10 CIGO Aprile 2026',
  numbering: {
    config: [
      {
        reference: 'date-list',
        levels: [
          {
            level: 0,
            format: LevelFormat.BULLET,
            text: '-',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } },
          },
        ],
      },
    ],
  },
  sections: [
    {
      properties: {
        page: {
          size: { width: PAGE_W, height: PAGE_H },
          margin: MARGIN,
        },
      },
      children: [
        // "All.10" in alto a destra
        new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: 'All.10', bold: true, size: SIZE_ALL10, font: FONT })],
        }),
        emptyP(),

        // Titolo
        p('RELAZIONE TECNICA DETTAGLIATA DI CUI ALL’ART. 2 DEL D.M. 95442/2016', {
          bold: true,
          align: AlignmentType.CENTER,
          size: SIZE_TITLE,
        }),
        p('CAUSALE: EVENTI METEOROLOGICI', { bold: true, align: AlignmentType.CENTER, size: SIZE_TITLE }),
        emptyP(),

        // Tabella dati azienda
        tableAzienda,
        emptyP(),

        // Dichiarazione sostitutiva
        p('DICHIARAZIONE SOSTITUTIVA DELL’ATTO DI NOTORIETÀ', { bold: true, align: AlignmentType.CENTER }),
        p('(Art. 47 D.P.R. 28 dicembre 2000, n.445 e ss.mm.i.)', { align: AlignmentType.CENTER }),
        emptyP(),

        // Dichiarante
        pRuns([
          run('Il sottoscritto '),
          run('LENTINI RAFFAELE', { bold: true }),
          run(' nato a '),
          run('MARSICOVETERE', { bold: true }),
          run(' prov. '),
          run('PZ', { bold: true }),
          run(' il '),
          run('24/04/1983', { bold: true }),
          run(' residente a '),
          run('MARSICOVETERE', { bold: true }),
          run(' Prov. '),
          run('PZ', { bold: true }),
          run(' Cap '),
          run('85050', { bold: true }),
          run(' Via '),
          run('CARLO ALBERTO DALLA CHIESA 13', { bold: true }),
          run(' Tel. '),
          run('0975/318890', { bold: true }),
        ]),
        emptyP(),

        p('IN QUALITÀ DI:', { bold: true, align: AlignmentType.LEFT }),
        emptyP(),
        pRuns(
          [
            run('☐     titolare          '),
            run('X', { bold: true }),
            run('     legale rappresentante'),
          ],
          { align: AlignmentType.LEFT },
        ),
        emptyP(),

        pRuns([
          run('dell’azienda '),
          run('RESTRUKTURA S.R.L.', { bold: true }),
          run('   codice fiscale '),
          run('02087420762', { bold: true }),
          run(' posizione INPS '),
          run('6405924990', { bold: true }),
          run('  in riferimento alla richiesta delle integrazioni salariali per il periodo dal '),
          run(dataInizio, { bold: true }),
          run('   al   '),
          run(dataFine, { bold: true }),
        ]),
        emptyP(),

        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 200 },
          children: [
            new TextRun({
              text: 'D I C H I A R A',
              bold: true,
              size: SIZE_TITLE,
              font: FONT,
              characterSpacing: 100,
            }),
          ],
        }),

        // Corpo dichiarazione — premessa
        pRuns([
          run('Che nel cantiere ubicato nel Comune di '),
          run('Marsicovetere (PZ)', { bold: true }),
          run(' in '),
          run('Via Nazionale SNC', { bold: true }),
          run(', aperto in data '),
          run(dataAperturaCantiere, { bold: true }),
          run(', nelle giornate:'),
        ]),

        // Date come bullet list
        ...giornate.map(
          (d) =>
            new Paragraph({
              numbering: { reference: 'date-list', level: 0 },
              children: [new TextRun({ text: d, size: SIZE_BODY, font: FONT })],
            }),
        ),
        emptyP(),

        // Lavorazioni eseguite
        p(
          'si stavano eseguendo i lavori di: nelle giornate del 01/04/2026 e 02/04/2026 fugatura in opera dei rivestimenti in Gres sui parapetti esterni dei balconi e posa in opera del primer per sistema a cappotto; nella giornata del 30/04/2026 posa in opera del tonachino di finitura del sistema a cappotto.',
        ),
        emptyP(),

        // Motivazione meteo
        p(
          'La pioggia, anche se a volte non costante nelle ore lavorative, impediva l’esecuzione delle suddette lavorazioni in quanto determinava il concreto rischio di dilavamento delle malte da fugatura del rivestimento in Gres prima della loro completa presa, di compromissione dell’adesione e della corretta essiccazione del primer per sistema a cappotto, e di dilavamento del tonachino di finitura ancora fresco con conseguente alterazione della texture e della tonalità cromatica e formazione di colature superficiali, con conseguente pregiudizio per la corretta esecuzione dei lavori e per la sicurezza del cantiere, determinando così l’interruzione delle lavorazioni per un totale di 8 (otto) ore giornaliere nelle giornate sopra indicate.',
        ),
        emptyP(),

        p('I lavoratori interessati dalla sospensione, con il dettaglio delle ore di integrazione salariale richieste, sono i seguenti:'),
        emptyP(),

        // Tabella lavoratori
        tableLavoratori,
        emptyP(),

        p('Si allega documento di riconoscimento.'),
        emptyP(),
        emptyP(),

        pRuns([run('Data '), run(dataFirma, { bold: true })]),
        emptyP(),
        emptyP(),

        p('Timbro e firma', { align: AlignmentType.RIGHT }),
        p('Rappresentante Legale / Delegato', { align: AlignmentType.RIGHT }),
        emptyP(),
        emptyP(),
        p('_________________________________', { align: AlignmentType.RIGHT }),
        p('Lentini Raffaele', { align: AlignmentType.RIGHT }),
      ],
    },
  ],
})

// ─── EXPORT ─────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(__dirname, '../tmp')
mkdirSync(outDir, { recursive: true })
const outPath = resolve(outDir, 'All_10_CIGO_Aprile_2026_Restruktura.docx')

Packer.toBuffer(doc).then((buf) => {
  writeFileSync(outPath, buf)
  console.log(`[CIGO] OK: ${buf.length} bytes`)
  console.log(`[CIGO] Output: ${outPath}`)
  console.log(``)
  console.log(`Apri con: start "${outPath}"`)
})
