# PDF Puppeteer Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sostituire `generatePdfFromHtml` (jsPDF + strip-tag) con rendering WYSIWYG via Puppeteer headless + Chromium serverless. Output PDF identico al print del browser.

**Architecture:** `puppeteer-core` controlla un Chromium fornito da `@sparticuz/chromium` su Vercel Linux serverless. In dev Windows fallback su `puppeteer` full (Chromium bundled per piattaforma). Firma pubblica `generatePdfFromHtml(html, title): Promise<Buffer>` invariata — nessun caller modificato.

**Tech Stack:** puppeteer-core ^24, @sparticuz/chromium ^138, puppeteer ^24 (devDep), vitest, Next.js 16 (App Router, runtime nodejs).

**Spec di riferimento:** `docs/superpowers/specs/2026-05-08-cervellone-pdf-puppeteer-design.md`

---

## File Structure

| File | Azione | Responsabilità |
|---|---|---|
| `src/lib/pdf-generator.ts` | **rewrite** | `generatePdfFromHtml(html, title): Promise<Buffer>` via Puppeteer |
| `src/lib/pdf-generator.test.ts` | **create** | Vitest unit con mock di puppeteer-core |
| `next.config.ts` | **modify** | Aggiungere `@sparticuz/chromium` + `puppeteer-core` a `serverExternalPackages` |
| `package.json` | **modify** | Deps: `puppeteer-core`, `@sparticuz/chromium`; devDep: `puppeteer` |
| `src/app/api/telegram/route.ts` | **modify (se assente)** | Confermare/aggiungere `export const maxDuration = 60` |
| `src/app/api/chat/route.ts` | **modify (se assente)** | Confermare/aggiungere `export const maxDuration = 60` |
| `scripts/smoke-pdf-puppeteer.ts` | **create** | Smoke locale post-build pre-push |
| `__fixtures__/ddt-test.html` | **create** | HTML DDT realistico per smoke + test |

---

## Task 1: Branch + dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Crea branch dedicato**

```bash
git checkout main
git pull
git checkout -b feat/pdf-puppeteer-wysiwyg
```

- [ ] **Step 2: Installa runtime deps**

```bash
npm install puppeteer-core@^24 @sparticuz/chromium@^138
```

Expected: `package.json` aggiornato, `package-lock.json` aggiornato, no errori. Verifica con `cat package.json | grep -E 'puppeteer-core|sparticuz'`.

- [ ] **Step 3: Installa puppeteer full come devDep**

```bash
npm install --save-dev puppeteer@^24
```

Motivo: serve solo per dev locale Windows. NON viene incluso nel deploy serverless (Vercel skippa devDeps).

- [ ] **Step 4: Verifica install non rompe build**

```bash
npm run build
```

Expected: build success, **bundle warning sotto 250 MB**. Se fallisce per size, vedi rischi spec sezione "Bundle size".

- [ ] **Step 5: Commit deps**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add puppeteer-core + @sparticuz/chromium for PDF WYSIWYG"
```

---

## Task 2: Test setup con magic bytes

**Files:**
- Create: `src/lib/pdf-generator.test.ts`

- [ ] **Step 1: Scrivi test failing magic bytes**

```ts
// src/lib/pdf-generator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock puppeteer-core PRIMA di import del modulo sotto test
vi.mock('puppeteer-core', () => ({
  default: {
    launch: vi.fn(async () => ({
      newPage: vi.fn(async () => ({
        setContent: vi.fn(async () => undefined),
        pdf: vi.fn(async () => Buffer.from('%PDF-1.7\n[mock pdf bytes 30KB padding]'.padEnd(30000, ' '))),
        close: vi.fn(async () => undefined),
      })),
      close: vi.fn(async () => undefined),
    })),
  },
}))

vi.mock('@sparticuz/chromium', () => ({
  default: {
    args: ['--no-sandbox'],
    executablePath: vi.fn(async () => '/tmp/chromium'),
    headless: 'shell',
    setHeadlessMode: vi.fn(),
    setGraphicsMode: false,
  },
}))

import { generatePdfFromHtml } from './pdf-generator'

describe('generatePdfFromHtml', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Buffer with PDF magic bytes', async () => {
    const buf = await generatePdfFromHtml('<p>test</p>', 'Test Doc')
    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
  })
})
```

- [ ] **Step 2: Run test, verifica FAIL**

```bash
npx vitest run src/lib/pdf-generator.test.ts
```

Expected: FAIL — il file `pdf-generator.ts` esistente usa jsPDF, non puppeteer. Il mock di puppeteer-core non viene usato. Il test passa solo dopo refactor (Task 3).

> Nota: il test in realtà potrebbe **passare** anche con jsPDF perché jsPDF produce comunque magic bytes `%PDF-`. Il valore del test è validare il **percorso puppeteer**, quindi aggiungiamo asserzione sul mock.

- [ ] **Step 3: Aggiungi asserzione sul mock launch**

Modifica il test:

```ts
import puppeteer from 'puppeteer-core'

// dentro it:
expect(puppeteer.launch).toHaveBeenCalledOnce()
```

- [ ] **Step 4: Re-run, verifica FAIL**

```bash
npx vitest run src/lib/pdf-generator.test.ts
```

Expected: FAIL con `expected "spy" to be called at least once` perché `pdf-generator.ts` ancora usa jsPDF.

---

## Task 3: Riscrittura `pdf-generator.ts` con Puppeteer

**Files:**
- Rewrite: `src/lib/pdf-generator.ts`

- [ ] **Step 1: Sostituisci interamente il file**

```ts
// src/lib/pdf-generator.ts
/**
 * PDF generator WYSIWYG via Puppeteer headless + Chromium serverless.
 * Vedi docs/superpowers/specs/2026-05-08-cervellone-pdf-puppeteer-design.md
 */
import puppeteer from 'puppeteer-core'
import chromium from '@sparticuz/chromium'

const FOOTER_TEMPLATE = `<div style="font-size: 8pt; color: #888; width: 100%; padding: 0 15mm; display: flex; justify-content: space-between; -webkit-print-color-adjust: exact;">
  <span>RESTRUKTURA S.r.l. — P.IVA 02087420762</span>
  <span>Pagina <span class="pageNumber"></span> di <span class="totalPages"></span></span>
</div>`

const HEADER_TEMPLATE = `<div></div>`

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

async function getBrowser() {
  const isWindows = process.platform === 'win32'
  const isDev = process.env.NODE_ENV === 'development'

  if (isWindows || isDev) {
    // Dev locale: usa puppeteer full (devDep) con Chromium di sistema/bundled
    const puppeteerFull = await import('puppeteer').catch(() => null)
    if (puppeteerFull?.default) {
      return puppeteerFull.default.launch({ headless: true })
    }
    // Fallback a Chrome/Edge installato (Windows)
    return puppeteer.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    })
  }

  // Vercel serverless Linux
  return puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  })
}

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
    await browser.close()
  }
}
```

- [ ] **Step 2: Run test, verifica PASS**

```bash
npx vitest run src/lib/pdf-generator.test.ts
```

Expected: PASS — magic bytes verificati, mock launch chiamato.

- [ ] **Step 3: Verifica TypeScript build**

```bash
npx tsc --noEmit
```

Expected: no errors. Se errore su tipo `puppeteer-core` Browser.close() async, controlla versioni.

- [ ] **Step 4: Verifica build Next**

```bash
npm run build
```

Expected: build success.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pdf-generator.ts src/lib/pdf-generator.test.ts
git commit -m "feat(pdf): migra generatePdfFromHtml a Puppeteer WYSIWYG

- Sostituisce jsPDF + strip-tag con Chromium headless via @sparticuz/chromium
- Firma pubblica invariata, caller in tools.ts:217 non modificato
- Wrap HTML safety net se modello produce frammento senza <html>/<head>
- Footer Restruktura + page N di M
- Auto-detect Windows dev → puppeteer full fallback
- Risolve DDT 002-2026 (CSS in chiaro pag. 1, layout piatto pag. 2-4)"
```

---

## Task 4: Test addizionali wrap + size

**Files:**
- Modify: `src/lib/pdf-generator.test.ts`

- [ ] **Step 1: Aggiungi test wrap fallback**

Aggiungi a `pdf-generator.test.ts`:

```ts
it('wraps HTML fragment with boilerplate when missing <html>', async () => {
  const setContentSpy = vi.fn()
  vi.mocked(puppeteer.launch).mockResolvedValueOnce({
    newPage: vi.fn(async () => ({
      setContent: setContentSpy,
      pdf: vi.fn(async () => Buffer.from('%PDF-1.7\n'.padEnd(30000, ' '))),
      close: vi.fn(),
    })),
    close: vi.fn(),
  } as never)

  await generatePdfFromHtml('<p>frammento</p>', 'Test')

  const passedHtml = setContentSpy.mock.calls[0][0]
  expect(passedHtml).toContain('<!DOCTYPE html>')
  expect(passedHtml).toContain('<title>Test</title>')
  expect(passedHtml).toContain('<p>frammento</p>')
})

it('does NOT double-wrap if HTML already has <html> tag', async () => {
  const setContentSpy = vi.fn()
  vi.mocked(puppeteer.launch).mockResolvedValueOnce({
    newPage: vi.fn(async () => ({
      setContent: setContentSpy,
      pdf: vi.fn(async () => Buffer.from('%PDF-1.7\n'.padEnd(30000, ' '))),
      close: vi.fn(),
    })),
    close: vi.fn(),
  } as never)

  const fullDoc = '<!DOCTYPE html><html><head><title>Mio</title></head><body>x</body></html>'
  await generatePdfFromHtml(fullDoc, 'Ignored')

  const passedHtml = setContentSpy.mock.calls[0][0]
  expect(passedHtml).toBe(fullDoc)
})

it('escapes HTML in title to prevent injection', async () => {
  const setContentSpy = vi.fn()
  vi.mocked(puppeteer.launch).mockResolvedValueOnce({
    newPage: vi.fn(async () => ({
      setContent: setContentSpy,
      pdf: vi.fn(async () => Buffer.from('%PDF-1.7\n'.padEnd(30000, ' '))),
      close: vi.fn(),
    })),
    close: vi.fn(),
  } as never)

  await generatePdfFromHtml('<p>x</p>', 'Doc <script>alert(1)</script>')

  const passedHtml = setContentSpy.mock.calls[0][0]
  expect(passedHtml).toContain('Doc &lt;script&gt;alert(1)&lt;/script&gt;')
  expect(passedHtml).not.toContain('<title>Doc <script>')
})

it('always closes browser, even on pdf error', async () => {
  const closeSpy = vi.fn()
  vi.mocked(puppeteer.launch).mockResolvedValueOnce({
    newPage: vi.fn(async () => ({
      setContent: vi.fn(),
      pdf: vi.fn(async () => { throw new Error('pdf render failed') }),
      close: vi.fn(),
    })),
    close: closeSpy,
  } as never)

  await expect(generatePdfFromHtml('<p>x</p>', 'T')).rejects.toThrow('pdf render failed')
  expect(closeSpy).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run src/lib/pdf-generator.test.ts
```

Expected: 4-5 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/pdf-generator.test.ts
git commit -m "test(pdf): aggiunge wrap fallback + escape title + browser close on error"
```

---

## Task 5: `next.config.ts` serverExternalPackages

**Files:**
- Modify: `next.config.ts:5`

- [ ] **Step 1: Aggiorna serverExternalPackages**

In `next.config.ts`, sostituisci la riga 5:

```ts
serverExternalPackages: ['pdf-parse', '@napi-rs/canvas', 'pdfjs-dist'],
```

con:

```ts
serverExternalPackages: ['pdf-parse', '@napi-rs/canvas', 'pdfjs-dist', '@sparticuz/chromium', 'puppeteer-core'],
```

- [ ] **Step 2: Verifica build**

```bash
npm run build
```

Expected: build success, nessun warning su moduli external.

- [ ] **Step 3: Commit**

```bash
git add next.config.ts
git commit -m "chore(next): externalize @sparticuz/chromium + puppeteer-core dal bundle"
```

---

## Task 6: Verifica `maxDuration` su routes che usano genera_pdf

**Files:**
- Inspect: `src/app/api/telegram/route.ts`
- Inspect: `src/app/api/chat/route.ts`

- [ ] **Step 1: Cerca config esistente**

```bash
grep -nE "maxDuration|export const runtime" src/app/api/telegram/route.ts src/app/api/chat/route.ts
```

Expected: vedere lo stato attuale.

- [ ] **Step 2: Aggiungi/aggiorna se assente**

In ciascuno dei due file, all'inizio (dopo import):

```ts
export const runtime = 'nodejs'
export const maxDuration = 60
```

Se già presente con valore < 60, alzare a 60.

- [ ] **Step 3: Build per verifica**

```bash
npm run build
```

Expected: success.

- [ ] **Step 4: Commit (solo se modifiche)**

```bash
git add src/app/api/telegram/route.ts src/app/api/chat/route.ts
git commit -m "chore(routes): set maxDuration=60 per Puppeteer cold start"
```

---

## Task 7: Smoke script locale + fixture

**Files:**
- Create: `scripts/smoke-pdf-puppeteer.ts`
- Create: `__fixtures__/ddt-test.html`

- [ ] **Step 1: Crea fixture HTML DDT**

`__fixtures__/ddt-test.html` (snippet — replica struttura del DDT 002-2026):

```html
<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="utf-8">
<title>DDT TEST</title>
<style>
@page { size: A4 portrait; margin: 15mm; }
body { font-family: 'Helvetica', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; line-height: 1.35; margin: 0; }
.header { border-bottom: 3px solid #c8102e; padding-bottom: 10px; margin-bottom: 12px; }
.header-row { display: table; width: 100%; }
.header-left, .header-right { display: table-cell; vertical-align: top; }
.header-right { text-align: right; }
.azienda-nome { font-size: 18pt; font-weight: bold; color: #c8102e; margin: 0; }
.ddt-titolo { font-size: 16pt; font-weight: bold; margin: 0; }
table.merce { width: 100%; border-collapse: collapse; margin: 10px 0; }
table.merce th { background: #2c2c2c; color: white; padding: 6px 5px; font-size: 9pt; text-align: left; }
table.merce td { border: 1px solid #999; padding: 6px 5px; font-size: 10pt; }
.firme { display: table; width: 100%; margin-top: 18px; }
.firma-cell { display: table-cell; width: 33.33%; border: 1px solid #999; padding: 6px 8px; height: 65px; }
</style>
</head>
<body>
<div class="header">
  <div class="header-row">
    <div class="header-left">
      <p class="azienda-nome">RESTRUKTURA S.r.l.</p>
      <p>Villa d'Agri (PZ) — P.IVA 02087420762</p>
    </div>
    <div class="header-right">
      <p class="ddt-titolo">DOCUMENTO DI TRASPORTO</p>
      <p>N. TEST/2026</p>
      <p>Data: 08/05/2026</p>
    </div>
  </div>
</div>

<h3>Destinatario</h3>
<p>Cliente Test — Via Roma 1, Milano</p>

<table class="merce">
  <thead>
    <tr><th>N.</th><th>Descrizione</th><th>U.M.</th><th>Quantità</th></tr>
  </thead>
  <tbody>
    <tr><td>1</td><td>Frangisole IRIS 8 cotto</td><td>PALLET</td><td>3</td></tr>
    <tr><td>2</td><td>Test accenti àèìòù</td><td>PZ</td><td>10</td></tr>
  </tbody>
</table>

<div class="firme">
  <div class="firma-cell"><strong>Firma Mittente</strong></div>
  <div class="firma-cell"><strong>Firma Vettore</strong></div>
  <div class="firma-cell"><strong>Firma Destinatario</strong></div>
</div>
</body>
</html>
```

- [ ] **Step 2: Crea smoke script**

`scripts/smoke-pdf-puppeteer.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { generatePdfFromHtml } from '../src/lib/pdf-generator'

async function main() {
  const html = readFileSync(resolve(__dirname, '../__fixtures__/ddt-test.html'), 'utf-8')
  const t0 = Date.now()
  const buf = await generatePdfFromHtml(html, 'DDT TEST 2026')
  const elapsed = Date.now() - t0

  mkdirSync(resolve(__dirname, '../tmp'), { recursive: true })
  const out = resolve(__dirname, '../tmp/smoke-puppeteer.pdf')
  writeFileSync(out, buf)

  console.log(`OK: ${buf.length} bytes in ${elapsed}ms`)
  console.log(`Magic bytes: ${buf.subarray(0, 5).toString()}`)
  console.log(`Output: ${out}`)
}

main().catch(err => {
  console.error('SMOKE FAIL:', err)
  process.exit(1)
})
```

- [ ] **Step 3: Aggiungi script a package.json**

Sotto `scripts`:

```json
"smoke:pdf": "tsx scripts/smoke-pdf-puppeteer.ts"
```

Se `tsx` non installato, aggiungilo come devDep:

```bash
npm install --save-dev tsx
```

- [ ] **Step 4: Run smoke locale**

```bash
npm run smoke:pdf
```

Expected:
- Output `OK: <N> bytes in <ms>ms`
- Magic bytes: `%PDF-`
- File `tmp/smoke-puppeteer.pdf` apribile in viewer
- **Visivamente**: header rosso, tabella merce con bordi e header scuro, box firme tre celle affiancate, accenti italiani corretti

Se output non visivamente corretto: STOP, debug prima di pushare.

- [ ] **Step 5: Apri PDF risultante**

Windows:
```bash
start tmp/smoke-puppeteer.pdf
```

Verifica visiva: confrontare con DDT 002-2026 rotto. Layout deve essere vero documento, non testo lineare.

- [ ] **Step 6: Commit smoke fixture**

```bash
git add scripts/smoke-pdf-puppeteer.ts __fixtures__/ddt-test.html package.json package-lock.json
git commit -m "test(pdf): smoke script + fixture DDT WYSIWYG"
```

---

## Task 8: Push + PR

**Files:**
- (nessuno — operazioni git/GitHub)

- [ ] **Step 1: Pre-flight check**

```bash
npm run build && npx vitest run src/lib/pdf-generator.test.ts && npm run lint
```

Expected: 3 step success.

- [ ] **Step 2: Push branch**

```bash
git push -u origin feat/pdf-puppeteer-wysiwyg
```

- [ ] **Step 3: Apri PR**

Tramite GitHub API (gh CLI non disponibile, usiamo curl o web). Body:

```markdown
## Problema
DDT 002-2026 ha rivelato che `generatePdfFromHtml` (jsPDF + strip-tag naive) non renderizza HTML strutturato:
- Pagina 1: 32 righe CSS stampate come testo del corpo
- Pagine 2-4: nessuna tabella merce, nessun box firme, layout lineare

## Causa
jsPDF.text() rende solo stringhe riga-per-riga. Lo strip dei tag distrugge la semantica HTML. Anche con CSS strippato perfettamente, output illeggibile by design.

## Fix
Migrazione a `puppeteer-core` + `@sparticuz/chromium` su Vercel serverless Linux. Rendering identico a Chrome browser print.

- Firma `generatePdfFromHtml(html, title): Promise<Buffer>` invariata
- Caller `tools.ts:217` non modificato
- Wrap HTML safety net se modello dimentica `<html>`/`<head>`
- Footer Restruktura + page numbers via `footerTemplate`
- Auto-detect Windows dev → fallback `puppeteer` full (devDep)
- `maxDuration = 60` su `/api/telegram` e `/api/chat` per cold start

## Test
- 4 unit vitest con mock puppeteer-core
- Smoke script locale `npm run smoke:pdf` produce PDF visivamente corretto

## Smoke prod
Dopo merge: rigenerare DDT 002-2026 dal bot Telegram, confrontare con quello rotto allegato in chat.

## Backward compatibility
Nessun caller modificato. Output Buffer Node.js identico per pipe `uploadBinaryToDrive`.

## Risk
- Bundle size: `@sparticuz/chromium` ~50 MB unzipped → totale stimato sotto limite Vercel 250 MB
- Cold start +2-5s (Chromium launch)
- Memory function default 1024 MB OK; alzare a 1536 MB se OOM (verificabile post-deploy)

## Closes
Debt esplicito Puppeteer/Chromium per PDF WYSIWYG (memoria progetto).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Comando (PowerShell):

```powershell
$body = Get-Content pr-body.md -Raw
$payload = @{
  title = "feat(pdf): migra generatePdfFromHtml a Puppeteer WYSIWYG"
  body = $body
  head = "feat/pdf-puppeteer-wysiwyg"
  base = "main"
} | ConvertTo-Json
$h = @{ Accept = 'application/vnd.github+json'; Authorization = "Bearer $env:GITHUB_TOKEN" }
Invoke-RestMethod -Uri 'https://api.github.com/repos/Rafflentini/cervellone/pulls' -Method POST -Headers $h -Body $payload -ContentType 'application/json'
```

- [ ] **Step 4: Verifica CI Vercel Preview**

Aspetta 2-3 min. Endpoint:

```
https://api.github.com/repos/Rafflentini/cervellone/commits/feat/pdf-puppeteer-wysiwyg/check-runs
```

Expected: check `Vercel` con `conclusion: success`. Se `failure`, leggi log build da `vercel logs <preview-url>` e fix.

---

## Task 9: Merge + verify production

**Files:**
- (nessuno — git/Vercel)

- [ ] **Step 1: Merge PR**

Via web GitHub o gh CLI o github_merge_pr. Conferma con utente prima di mergiare.

- [ ] **Step 2: Verifica deploy production READY**

Polla `https://api.vercel.com/v6/deployments?projectId=prj_82oAdncoRjfm5LulvBgzWbel5Pva&teamId=team_QOxzPu6kcaxY8Jdc45arGmgL&limit=1` con `Authorization: Bearer $VERCEL_TOKEN` finché `state == "READY"`.

Se `state == "ERROR"` → leggi build log, rollback (git revert + push).

- [ ] **Step 3: Smoke production**

Da Telegram bot: *"Genera DDT di prova: cliente Test SRL, indirizzo Via Roma 1 Milano, merce 5 pallet IRIS cotto"*.

Verifica visiva PDF allegato/su Drive.

- [ ] **Step 4: Aggiorna memoria progetto**

Aggiorna `memory/cervellone-progetto.md` rimuovendo "Puppeteer/Chromium per PDF WYSIWYG (debt esplicito)" dalla sezione debt e segnando V18.

---

## Self-Review Checklist

- [x] Spec coverage: ogni decisione spec → task corrispondente
- [x] Placeholder scan: niente TBD/TODO, tutti i file path concreti
- [x] Type consistency: `generatePdfFromHtml(html, title): Promise<Buffer>` invariata in firma in tutti i task
- [x] Test code completo: ogni test mostra il codice, non "scrivi test simile"
- [x] Comandi esatti: ogni step ha bash/PowerShell concreto + expected output
- [x] Commit ad ogni task: TDD frequent commits

---

## Execution

**Plan complete and saved to `docs/superpowers/plans/2026-05-08-cervellone-pdf-puppeteer.md`. Two execution options:**

1. **Inline Execution** (raccomandato per questa sessione) — eseguo i task in batch con checkpoint review prima di push (Task 8). Veloce per work non-rischioso.

2. **Subagent-Driven** — fresh agent per ogni task con review intermedie. Più sicuro ma più lento, indicato per task con rischio architetturale alto.

Per questo plan: rischio limitato (firma invariata, fallback dev locale, test mockati). **Inline è appropriato.**
