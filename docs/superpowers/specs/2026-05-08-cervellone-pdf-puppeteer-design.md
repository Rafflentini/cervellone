# Spec — Migrazione PDF generator a Puppeteer headless (WYSIWYG)

**Data:** 2026-05-08
**Autore:** Ing. Lentini + Claude Opus 4.7
**Stato:** draft, da approvare prima di plan
**Riferimenti incidenti:** DDT 002-2026 Vallina/Maratea (CSS in chiaro pagina 1, layout piatto pagine 2-4)

## Problema

`generatePdfFromHtml` in `src/lib/pdf-generator.ts` usa jsPDF con strip-tag naive (`replace(/<[^>]+>/g, '')`). Il modello produce HTML strutturato (tabelle, header, firme box, classi CSS) che il generator riduce a flusso testo lineare.

Conseguenze osservate:
- Pagina 1 del DDT 002-2026: 32 righe di CSS stampate come testo del corpo perché l'HTML in input non aveva tag `<style>` wrapper (probabile residuo compressione history pre-PR #5).
- Pagine 2-4: nessuna tabella merce, nessun box firme, nessuna intestazione — testo lineare in colonna unica.

PR #2 (`fix/pdf-strip-style-tags`) e PR #6 (DOCX/XLSX backend) sono palliativi/laterali: non risolvono il rendering. Memoria progetto già marca "Puppeteer/Chromium per PDF WYSIWYG" come **debt esplicito**.

## Obiettivo

Rendere PDF identici al rendering browser print (Chrome). Un HTML con `<style>`, `<table>`, `flexbox`, font Restruktura → produce PDF impaginato come l'anteprima HTML su `/doc/[id]`.

## Non-obiettivo

- Migrare `/api/generate-doc/route.ts` (è una route frontend separata che riceve markdown, non HTML — fuori scope di questa PR; resta su jsPDF per ora).
- Migrare `generateDocxFromHtml`/`generateXlsxFromData` (PR #6 separata, librerie native `docx`/`exceljs`).
- Aggiungere parametri di customizzazione PDF (header/footer custom, watermark) — YAGNI.

## Architettura

### Stack

- **`puppeteer-core`** ^24 — solo controller, no Chromium bundled (~3 MB)
- **`@sparticuz/chromium`** ^138 — Chromium binary Linux x64 ottimizzato per AWS Lambda/Vercel serverless (~50 MB)
- **`puppeteer` full** dev-only fallback per sviluppo locale Windows (auto-detect platform)

Ragioni della scelta vs alternative:
- `@sparticuz/chromium-min` (no binary, scarica da CDN al primo run): scartato — cantieri con rete instabile non possono dipendere da CDN esterno al cold start.
- `chrome-aws-lambda`: deprecato.
- `playwright-core`: bundle simile, complessità superiore, no benefici netti per il nostro use case.

### Flusso

```
genera_pdf tool
  └── tools.ts:217  await generatePdfFromHtml(html, title)
       └── pdf-generator.ts:generatePdfFromHtml
            ├── (env)  if process.platform === 'win32' || NODE_ENV === 'development'
            │            use puppeteer (full, system Chrome)
            │          else
            │            use @sparticuz/chromium executablePath
            ├── puppeteer.launch({ args, executablePath, headless: 'shell' })
            ├── page.setContent(wrappedHtml, { waitUntil: 'networkidle0' })
            ├── page.pdf({ format: 'A4', printBackground: true,
            │              margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
            │              displayHeaderFooter: true, headerTemplate: '...', footerTemplate: '...' })
            └── browser.close() in finally
            return Buffer.from(pdfBytes)
```

### Wrapping HTML

L'HTML in input può essere frammento (senza `<html>`, `<head>`, `<body>`). Funzione interna `wrapForPrint(html, title)`:

```ts
function wrapForPrint(rawHtml: string, title: string): string {
  // Se l'HTML è già un documento completo, usa as-is.
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
    /* fallback minimo: il modello è incoraggiato a includere il proprio <style> */
  </style>
</head>
<body>
${rawHtml}
</body>
</html>`
}
```

Importante: il modello continuerà a produrre HTML con il proprio `<style>` contenente la grafica DDT/preventivo Restruktura. Il wrap è un **safety net** se il modello scorda il boilerplate.

### Header/footer Restruktura

Spostiamo i footer "Pagina N di M" + "RESTRUKTURA S.r.l. — P.IVA 02087420762" dal codice jsPDF al `footerTemplate` Puppeteer:

```html
<div style="font-size: 8pt; color: #888; width: 100%; padding: 0 15mm; display: flex; justify-content: space-between;">
  <span>RESTRUKTURA S.r.l. — P.IVA 02087420762</span>
  <span>Pagina <span class="pageNumber"></span> di <span class="totalPages"></span></span>
</div>
```

### Configurazione runtime

Vercel serverless function (route `/api/telegram` e `/api/chat`) richiedono:

```ts
// route file
export const runtime = 'nodejs'  // NON edge
export const maxDuration = 60    // chromium può richiedere 5-10s cold start
```

Memoria: i route attuali sono già nodejs. `maxDuration` da verificare e alzare se default <60s.

### `next.config.ts` — modifiche

```ts
serverExternalPackages: [
  'pdf-parse', '@napi-rs/canvas', 'pdfjs-dist',
  '@sparticuz/chromium', 'puppeteer-core',  // nuovi
],
```

`outputFileTracingIncludes` non serve — `@sparticuz/chromium` gestisce il binary internamente via `executablePath()`.

### Backward compatibility

- **Firma pubblica invariata**: `generatePdfFromHtml(html: string, title: string): Promise<Buffer>` — nessun caller in `tools.ts:217` deve cambiare.
- **Output sempre Buffer Node.js** — pipe identico a `uploadBinaryToDrive`.
- **Fallback jsPDF rimosso**: niente safety net legacy. Se Puppeteer fallisce, throw → il tool `genera_pdf` cattura e ritorna messaggio errore all'LLM. Motivo: jsPDF produce output illeggibile (vedi DDT 002-2026), tenerlo come fallback significa "rotto silenzioso". Meglio errore esplicito.

### Costo serverless

Cold start +2-5s (lancio Chromium). Memoria function: bisogna passare almeno **1024 MB** (default 1024 OK su Vercel Pro). Se OOM, alzare a 1536 MB nel `vercel.json`. Da verificare a smoke time, non prematuramente.

Per uso reale Cervellone: ~5-10 PDF/giorno. Cost trascurabile.

## Test plan

### Unit (vitest)

`src/lib/pdf-generator.test.ts`:

1. **Magic bytes PDF** — `generatePdfFromHtml('<p>test</p>', 'Test').then(b => expect(b.subarray(0,4).toString()).toBe('%PDF'))`
2. **Size sanity** — output > 20 KB (jsPDF testo plain era ~16 KB; Puppeteer A4 vuoto è ~25-30 KB)
3. **Wrap fallback** — input frammento `<p>x</p>` → wrap automatico applicato (verificabile ispezionando contenuto setContent intercettato via mock)
4. **HTML completo passa-thru** — input con `<html>`/`<head>` non viene doppio-wrappato

Mock di `puppeteer.launch` per i test unit (non lanciamo Chromium in CI).

### Integration locale

`scripts/smoke-pdf-puppeteer.ts` — script Node che:
- Carica HTML del DDT 002-2026 da fixture (estratto da Drive o ricreato manualmente con il CSS pagina 1)
- Chiama `generatePdfFromHtml`
- Salva su `tmp/smoke.pdf`
- Apre con default viewer

Fixture HTML in `__fixtures__/ddt-002-2026.html` ricostruito dall'analisi del PDF rotto (header rosso bordo, tabella merce con colonne N/Descrizione/UM/Quantità/Note, box firme tre celle).

### Smoke prod

Post-deploy, utente da Telegram: *"Genera DDT di prova: cliente Pippo Test, indirizzo Via Roma 1 Milano, merce 5 pallet di prova"*. Verifica risultato.

## Rischi e mitigazioni

| Rischio | Probabilità | Mitigazione |
|---|---|---|
| Bundle size > limite Vercel 250 MB | bassa | `@sparticuz/chromium` ~50 MB unzipped, totale stimato ~120 MB con altre deps. Verifica `next build` size dopo install. |
| Cold start timeout su Vercel default `maxDuration` | media | Set esplicito `maxDuration = 60` su route Telegram/chat che invocano genera_pdf. |
| OOM su PDF lunghi (multi-pagina, immagini) | bassa | Vercel Pro 1024 MB default. Monitora via vercel runtime logs. Se fail, alzare. |
| Dev locale Windows non funziona | alta se non gestito | Auto-detect: `process.platform === 'win32'` → usa `puppeteer` full come dev dependency, oppure path Edge/Chrome di sistema. |
| Font italiani non disponibili | bassa | `@sparticuz/chromium` include Noto fonts. Test su accenti (è, à, ò, ù) durante smoke. |
| Race condition se più chiamate concorrenti `genera_pdf` | media | Ogni chiamata lancia browser nuovo (già gestito). No browser pool — overhead accettabile per nostro volume. |

## Open questions

1. **Mantenere il file legacy jsPDF in `pdf-generator.ts` come funzione separata `generatePdfFromHtmlLegacy` per emergency rollback?** Proposta: NO. Se Puppeteer fallisce ripetutamente, il rollback è git revert della PR — più pulito.
2. **`@sparticuz/chromium-min` vs `@sparticuz/chromium` full?** Decisione: full. Stabilità > bundle size minore.
3. **Header pagina (oltre footer)?** Proposta: NO header — il logo/intestazione Restruktura è già nell'HTML del documento generato dal modello. Il footer è solo legal note + page numbers.

## Decisioni chiave

- ✅ Stack: `puppeteer-core` + `@sparticuz/chromium` full (no `-min`)
- ✅ No fallback jsPDF — fail loudly invece di output silente rotto
- ✅ Wrap HTML safety net interno se modello dimentica `<html>`/`<head>`
- ✅ Footer Puppeteer (page N di M + P.IVA), no header
- ✅ Dev locale: auto-detect Windows + fallback `puppeteer` full
- ✅ Migrazione SOLO `generatePdfFromHtml` — `/api/generate-doc/route.ts` resta su jsPDF (scope minimo)
- ✅ Firma pubblica invariata: nessuna modifica caller
