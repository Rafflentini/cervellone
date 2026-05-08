/**
 * lib/pdf-generator.ts — PDF generator WYSIWYG via Puppeteer headless + Chromium.
 *
 * Sostituisce la precedente implementazione jsPDF + strip-tag che produceva PDF
 * illeggibili (vedi DDT 002-2026: CSS in chiaro pag. 1, layout piatto pag. 2-4).
 *
 * Su Vercel serverless Linux: puppeteer-core + @sparticuz/chromium.
 * In dev locale Windows: fallback a `puppeteer` full (devDep) o Chrome di sistema.
 *
 * Spec: docs/superpowers/specs/2026-05-08-cervellone-pdf-puppeteer-design.md
 */
import puppeteer from 'puppeteer-core'
import chromium from '@sparticuz/chromium'

const FOOTER_TEMPLATE = `<div style="font-size: 8pt; color: #888888; width: 100%; padding: 0 15mm; display: flex; justify-content: space-between; -webkit-print-color-adjust: exact;">
  <span>RESTRUKTURA S.r.l. — P.IVA 02087420762</span>
  <span>Pagina <span class="pageNumber"></span> di <span class="totalPages"></span></span>
</div>`

const HEADER_TEMPLATE = '<div></div>'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function wrapForPrint(rawHtml: string, title: string): string {
  if (/<html[\s>]/i.test(rawHtml)) return rawHtml
  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
@page { size: A4; margin: 15mm; }
body { font-family: 'Helvetica', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; line-height: 1.4; margin: 0; }
table { border-collapse: collapse; width: 100%; }
h1, h2, h3 { color: #c8102e; }
</style>
</head>
<body>
${rawHtml}
</body>
</html>`
}

// Risolve il percorso del binario Chromium da usare. Sempre lanciato via puppeteer-core
// (sotto) — questo permette al mock di puppeteer-core nei test di intercettare ovunque.
async function resolveExecutablePath(): Promise<string | undefined> {
  // Override esplicito (CI / power user)
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH

  // Vercel/Lambda serverless: usa @sparticuz/chromium
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    return chromium.executablePath()
  }

  // Test: salta dynamic import puppeteer (lento), lascia decidere al mock
  if (process.env.NODE_ENV === 'test') return undefined

  // Dev locale: usa puppeteer full (devDep) per ottenere il path del Chromium bundled
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const puppeteerFull: any = await import('puppeteer').catch(() => null)
    const path = puppeteerFull?.default?.executablePath?.()
    if (path) return path
  } catch {
    // continua a fallback
  }

  // Fallback Windows
  if (process.platform === 'win32') {
    return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  }

  return undefined
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getBrowser(): Promise<any> {
  const executablePath = await resolveExecutablePath()
  const isVercel = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)

  if (isVercel) {
    return puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: chromium.headless,
    })
  }

  return puppeteer.launch({ headless: true, executablePath })
}

/**
 * Converte HTML in Buffer PDF A4 via Chromium headless (rendering identico al browser).
 * Mantiene la firma pubblica precedente — caller (`tools.ts:217`) non deve cambiare.
 */
export async function generatePdfFromHtml(html: string, title: string): Promise<Buffer> {
  const wrappedHtml = wrapForPrint(html, title)
  const browser = await getBrowser()
  try {
    const page = await browser.newPage()
    await page.setContent(wrappedHtml, { waitUntil: 'networkidle0' })
    const pdfBytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '15mm', right: '15mm', bottom: '20mm', left: '15mm' },
      displayHeaderFooter: true,
      headerTemplate: HEADER_TEMPLATE,
      footerTemplate: FOOTER_TEMPLATE,
    })
    return Buffer.from(pdfBytes)
  } finally {
    await browser.close().catch(() => undefined)
  }
}
