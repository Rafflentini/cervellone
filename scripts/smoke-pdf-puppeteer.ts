/**
 * Smoke test locale del nuovo generatePdfFromHtml (Puppeteer).
 * Run: npm run smoke:pdf
 *
 * Output: tmp/smoke-puppeteer.pdf — verificare visivamente che:
 * - Il CSS NON appare come testo (problema DDT 002-2026)
 * - Header rosso bordo + tabelle con bordi + box firme tre celle
 * - Accenti italiani (àèìòù é È) renderizzati correttamente
 * - Footer "RESTRUKTURA S.r.l. — P.IVA ..." + page N di M
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  generatePdfFromHtml,
  generateDocxFromHtml,
  generateXlsxFromData,
} from '../src/lib/pdf-generator'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  const outDir = resolve(__dirname, '../tmp')
  mkdirSync(outDir, { recursive: true })

  // ── PDF ──
  const fixturePath = resolve(__dirname, '../__fixtures__/ddt-test.html')
  const html = readFileSync(fixturePath, 'utf-8')
  console.log(`[SMOKE-PDF] Loading fixture: ${fixturePath} (${html.length} chars)`)
  const t0 = Date.now()
  const pdfBuf = await generatePdfFromHtml(html, 'DDT TEST 2026')
  const pdfElapsed = Date.now() - t0
  const pdfOut = resolve(outDir, 'smoke-puppeteer.pdf')
  writeFileSync(pdfOut, pdfBuf)
  console.log(`[SMOKE-PDF] OK: ${pdfBuf.length} bytes in ${pdfElapsed}ms — magic ${pdfBuf.subarray(0, 5).toString('ascii')}`)
  console.log(`[SMOKE-PDF] Output: ${pdfOut}`)

  // ── DOCX ──
  const docxHtml = `
<h1>Checklist preventivo cantiere</h1>
<h2>Voci da verificare</h2>
<p>1. Sopralluogo eseguito il 08/05/2026</p>
<p>2. Fotografie pre-intervento archiviate</p>
<p>3. Misure rilevate: 12.5 m × 8 m × 3 m</p>
<h2>Materiali necessari</h2>
<p>Frangisole IRIS 8 (cotto): 3 pallet</p>
<p>Test accenti: àèìòù é È</p>
<h3>Note operative</h3>
<p>Consegna prevista: lunedì 11 maggio 2026.</p>
`
  const t1 = Date.now()
  const docxBuf = await generateDocxFromHtml(docxHtml, 'Checklist Cantiere TEST')
  const docxElapsed = Date.now() - t1
  const docxOut = resolve(outDir, 'smoke-doc.docx')
  writeFileSync(docxOut, docxBuf)
  console.log(`[SMOKE-DOCX] OK: ${docxBuf.length} bytes in ${docxElapsed}ms — magic ${docxBuf.subarray(0, 2).toString('ascii')}`)
  console.log(`[SMOKE-DOCX] Output: ${docxOut}`)

  // ── XLSX ──
  const t2 = Date.now()
  const xlsxBuf = await generateXlsxFromData(
    [
      {
        name: 'CME Cantiere',
        rows: [
          ['Codice', 'Descrizione', 'U.M.', 'Q.tà', 'P.U.', 'Importo'],
          ['BAS25_E03', 'Demolizione pavimento esistente', 'mq', 50, 12.5, 625.0],
          ['BAS25_E07', 'Massetto cementizio sp. 5cm', 'mq', 50, 18.3, 915.0],
          ['BAS25_F01', 'Posa frangisole IRIS 8 cotto', 'mq', 24, 145.0, 3480.0],
          ['', 'Totale', '', '', '', 5020.0],
        ],
      },
      {
        name: 'SAL Mensile',
        rows: [
          ['Voce', 'Avanzamento %', 'Importo'],
          ['Demolizioni', 100, 625],
          ['Massetto', 80, 732],
          ['Frangisole', 30, 1044],
        ],
      },
    ],
    'CME e SAL TEST',
  )
  const xlsxElapsed = Date.now() - t2
  const xlsxOut = resolve(outDir, 'smoke-doc.xlsx')
  writeFileSync(xlsxOut, xlsxBuf)
  console.log(`[SMOKE-XLSX] OK: ${xlsxBuf.length} bytes in ${xlsxElapsed}ms — magic ${xlsxBuf.subarray(0, 2).toString('ascii')}`)
  console.log(`[SMOKE-XLSX] Output: ${xlsxOut}`)

  console.log('')
  console.log('Verifica visiva:')
  console.log(`  PDF: ${pdfOut} → tabelle, bordi, firme, NO CSS in chiaro, accenti corretti`)
  console.log(`  DOCX: ${docxOut} → editabile in Word, headings + paragrafi + footer Restruktura`)
  console.log(`  XLSX: ${xlsxOut} → 2 fogli, header blu/bianco grassetto, freeze prima riga, importi numerici`)
}

main().catch(err => {
  console.error('[SMOKE] FAIL:', err)
  process.exit(1)
})
