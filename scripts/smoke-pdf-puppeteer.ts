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
import { generatePdfFromHtml } from '../src/lib/pdf-generator'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  const fixturePath = resolve(__dirname, '../__fixtures__/ddt-test.html')
  const html = readFileSync(fixturePath, 'utf-8')

  console.log(`[SMOKE] Loading fixture: ${fixturePath} (${html.length} chars)`)

  const t0 = Date.now()
  const buf = await generatePdfFromHtml(html, 'DDT TEST 2026')
  const elapsed = Date.now() - t0

  const outDir = resolve(__dirname, '../tmp')
  mkdirSync(outDir, { recursive: true })
  const outPath = resolve(outDir, 'smoke-puppeteer.pdf')
  writeFileSync(outPath, buf)

  console.log(`[SMOKE] OK: ${buf.length} bytes in ${elapsed}ms`)
  console.log(`[SMOKE] Magic bytes: ${buf.subarray(0, 5).toString('ascii')}`)
  console.log(`[SMOKE] Output: ${outPath}`)
  console.log(``)
  console.log(`Apri il PDF e verifica:`)
  console.log(`  1. Pagina 1 NON contiene CSS come testo (es. "@page { size: A4 }" non deve apparire)`)
  console.log(`  2. Header rosso bordo con "RESTRUKTURA S.r.l." stilizzato`)
  console.log(`  3. Tabella merce con header scuro + bordi celle`)
  console.log(`  4. Box firme tre celle affiancate sul fondo`)
  console.log(`  5. Accenti italiani: àèìòù é È renderizzati correttamente`)
  console.log(`  6. Footer "RESTRUKTURA S.r.l. — P.IVA 02087420762" + "Pagina 1 di 1"`)
}

main().catch(err => {
  console.error('[SMOKE] FAIL:', err)
  process.exit(1)
})
