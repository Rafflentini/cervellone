# Cervellone File Pipeline — Design

**Data**: 2026-05-06  
**Sub-progetto**: A (programma 6 sub-progetti file/feature)  
**Scope MVP**: Telegram only, lib condivisa per estensione futura  
**Architettura**: HYBRID (native fast path + Anthropic Files API per custom)  
**Effort stimato**: 4-6 h implementazione + verifica deploy

## 1. Contesto e motivazione

Cervellone oggi (V12) gestisce nativamente PDF, immagini, Word, Excel, ODS, CSV, TXT via `buildContentBlocks` in `telegram-helpers.ts`. Per **tutti gli altri formati** (in particolare i firmati italiani `.p7m`, le FatturaPA `.xml` strutturate, i CAD `.dxf`/`.dwg`, i PDF scansionati senza testo, gli `.eml`, gli archivi `.zip`) il file binario non arriva al modello in modo utile: il fallback testo cattura solo gli ASCII, gli altri restano metadata-only.

**Obiettivo**: parità Claude.ai sulla lettura file. Cervellone deve poter aprire qualsiasi file esistente che esiste, scegliendo di volta in volta lo strumento giusto.

**Architettura scelta** (alternative valutate e scartate inline):

- ❌ N tool dedicati server-side (`read_p7m`, `read_xml_fattura`, `read_dxf`, OCR, ecc.) — old-school, scala male, ogni nuovo formato = nuovo codice
- ❌ Pipeline UNIFIED (tutto via Files API anche PDF/img) — regressione velocità su 80% dei file frequenti
- ❌ HYBRID-LAZY (fast path con fallback runtime) — detection runtime fragile, multi-step latency
- ✅ **HYBRID**: fast path base64 per native + Anthropic Files API + `container_upload` + `code_execution` per custom

## 2. Architettura

### 2.1 Modulo nuovo

`src/lib/file-pipeline.ts` — single source of truth per detection + routing + upload Anthropic. Riusabile da Telegram (MVP), webchat (iter #2), tool Drive/Gmail attivi (iter #3).

### 2.2 Interfaccia pubblica

```ts
import type Anthropic from '@anthropic-ai/sdk'
type ContentBlockParam = Anthropic.Messages.ContentBlockParam

export type FileInput = {
  buffer: ArrayBuffer | Buffer
  fileName: string
  mimeType: string
}

export type Strategy = 'native' | 'files-api' | 'fallback-text' | 'metadata-only'

export type PipelineResult = {
  blocks: ContentBlockParam[]
  strategy: Strategy
  uploadedFileId?: string  // popolato se strategy === 'files-api'
}

export async function processFile(input: FileInput): Promise<PipelineResult>
export function detectStrategy(mimeType: string, fileName: string): 'native' | 'files-api'
```

### 2.3 Flusso interno

```
processFile(input)
  │
  ├─ detectStrategy(mimeType, fileName)
  │
  ├─ se 'native':
  │     processNative(input)  ← logica esistente di buildContentBlocks rifattorizzata qui
  │     ritorna { blocks, strategy: 'native' }
  │
  ├─ se 'files-api':
  │     uploadToAnthropic(input)
  │       ├─ client.beta.files.upload({ file: <Uploadable> })
  │       │     header: betas: ['files-api-2025-04-14']
  │       ├─ traccia in tabella cervellone_anthropic_files
  │       └─ ritorna file_id
  │     ritorna {
  │       blocks: [
  │         { type: 'container_upload', file_id },
  │         { type: 'text', text: `[File caricato nel sandbox: ${fileName}]` }
  │       ],
  │       strategy: 'files-api',
  │       uploadedFileId: file_id
  │     }
  │
  └─ catch (errore upload):
        fallback: prova processNative anche se non in whitelist
        se ASCII printable → text block troncato 100KB → strategy: 'fallback-text'
        else → metadata-only block → strategy: 'metadata-only'
```

### 2.4 Modifiche al codice esistente

`src/lib/telegram-helpers.ts:88-167` — `buildContentBlocks` diventa thin wrapper:

```ts
export async function buildContentBlocks(fileData: FileInput): Promise<ContentBlockParam[]> {
  const { processFile } = await import('./file-pipeline')
  const result = await processFile(fileData)
  return result.blocks
}
```

Tutta la logica esistente di handler (PDF/Word/ODS/Excel/CSV/fallback text) viene **trasferita 1:1 dentro `processNative()`** in `file-pipeline.ts`. Zero cambio di comportamento per file native.

`src/app/api/telegram/route.ts` — nessuna modifica.

### 2.5 Dipendenze

- **Nessuna lib server-side aggiuntiva** (no `node-forge`, `ezdxf`, ecc.)
- Anthropic SDK 0.80 già presente: `client.beta.files.upload`, `code_execution_20260120` già registrato dopo commit `cd79063`
- Beta header `betas: ['files-api-2025-04-14']` aggiunto alle chiamate `.stream()` in `claude.ts` per abilitare Files API in messages

## 3. Detection logic

### 3.1 Whitelist NATIVE (fast path base64)

Tutto ciò che oggi `buildContentBlocks` gestisce con successo:

| Categoria | Mime / estensione |
|---|---|
| PDF | `application/pdf` |
| Immagini | `image/jpeg`, `image/png`, `image/webp`, `image/gif`, `image/heic`, `image/bmp`, `image/tiff` |
| Word | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/msword` |
| Excel | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-excel` |
| ODS | `application/vnd.oasis.opendocument.spreadsheet` |
| Testo | `text/plain`, `text/csv`, `text/markdown` |

### 3.2 Tutto il resto → CUSTOM (Files API)

Esempi non esaustivi: `.p7m`, `.p7s`, `.dxf`, `.dwg`, FatturaPA `.xml`, `.eml`, `.zip`, `.rar`, `.7z`, `.pptx`, `.rtf`, `.odt`, `.tiff` scansionati, `.json` complessi, file con mime `application/octet-stream`, qualsiasi mime non in whitelist.

### 3.3 Caso particolare PDF scansionato

Un PDF senza livello testo passa fast path (perché il mime è `application/pdf`). Il modello vedrà l'immagine e proverà a leggerla; se fallisce, comunica all'utente "questo PDF è scansionato, devo passarlo via OCR". L'iterazione successiva può aggiungere detection del testo (pdfjs `getTextContent` len < N → forza Files API), ma è **fuori scope MVP** per non rallentare il fast path con check sempre.

## 4. File lifecycle

### 4.1 Tabella di tracking

Migration `2026-05-06-anthropic-files-tracking.sql`:

```sql
CREATE TABLE cervellone_anthropic_files (
  file_id TEXT PRIMARY KEY,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  original_filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  conversation_id UUID,
  -- Per cleanup futuro
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days')
);
CREATE INDEX idx_anthropic_files_expires ON cervellone_anthropic_files(expires_at);
CREATE INDEX idx_anthropic_files_conv ON cervellone_anthropic_files(conversation_id);
ALTER TABLE cervellone_anthropic_files DISABLE ROW LEVEL SECURITY;
```

### 4.2 Cleanup

**Out of scope MVP**. Tracking esiste, ma il cron di cleanup è iterazione successiva (~30 min). Documentato come **debt**: senza cleanup, lo storage Anthropic Files cresce nel tempo. Acceptable per uso interno Restruktura, da rivedere se scala.

Quando scriviamo il cleanup: cron `/api/cron/cleanup-anthropic-files` daily 3am Europe/Rome → DELETE Anthropic file_id + DELETE row dove `expires_at < NOW()`.

### 4.3 Limiti

- Anthropic Files API: max 32 MB per file. Reject in pipeline con messaggio chiaro all'utente.
- Telegram Bot API: max 20 MB già limitato in `route.ts:90`. Più stringente, prevale.

## 5. Error handling

### 5.1 Files API fallback

```ts
try {
  const { id } = await client.beta.files.upload({ file: <Uploadable> }, {
    headers: { 'anthropic-beta': 'files-api-2025-04-14' }
  })
  // ...
} catch (err) {
  console.warn('[FILE-PIPELINE] Files API failed:', err)
  // Fallback: prova processNative anche se non whitelist (potrebbe estrarre qualcosa)
  const nativeAttempt = await processNative(input)
  if (nativeAttempt.blocks.length > 0) {
    return { ...nativeAttempt, strategy: 'fallback-text' }
  }
  // Ultima risorsa: metadata-only (utente sa che il file è arrivato ma non leggibile)
  return {
    blocks: [{ type: 'text', text: `[File ${input.fileName}: upload Anthropic fallito (${err.message}). Riprova tra qualche minuto.]` }],
    strategy: 'metadata-only',
  }
}
```

### 5.2 Sandbox code_execution timeout o fail

Già gestito dal flusso esistente: il modello riceve `code_execution_tool_result_error`, può ritentare o spiegare all'utente. Nessuna modifica necessaria.

### 5.3 Python lib mancante nel sandbox

Il sandbox Anthropic ha `cryptography`, `lxml`, `pillow`, `numpy`, `pandas` preinstallati (verificato via documentazione Anthropic). Per `ezdxf` (CAD), `pytesseract` (OCR), il modello prova `pip install` (sandbox ha internet di default). Se `pip install` fallisce, il modello comunica all'utente in modo trasparente.

## 6. Aggiunta system prompt

`src/lib/prompts.ts` — aggiungere REGOLA TOOL FILE PIPELINE dopo le altre REGOLE TOOL (~ riga 117):

```
REGOLA TOOL FILE PIPELINE:
Quando ricevi un container_upload block, il file è disponibile nel sandbox code_execution. Usa code_execution con la libreria Python appropriata al formato:
- .p7m / .p7s (firma CMS): cryptography (asn1crypto fallback)
- FatturaPA .xml: lxml o xml.etree
- .dxf / .dwg (CAD): ezdxf
- .eml: email.parser
- .zip / .rar: zipfile
- PDF scansionati senza testo: pytesseract (OCR)
- Altro formato: scegli la lib Python giusta per il file rilevato
Se la lib non è preinstallata nel sandbox, fai pip install. Parsa, estrai i dati rilevanti, ritorna in formato leggibile per l'utente.
```

## 7. Beta header per messages

`src/lib/claude.ts` — aggiungere alle 3 funzioni (`callClaudeStream`, `callClaude`, `callClaudeStreamTelegram`) il beta header per Files API + container_upload:

```ts
const stream = await withRetry(() =>
  Promise.resolve(client.messages.stream({
    model: modelConfig.model,
    max_tokens: modelConfig.maxTokens,
    system: fullSystemPrompt,
    messages: currentMessages,
    tools,
    ...modelOpts,
  }, {
    headers: { 'anthropic-beta': 'files-api-2025-04-14' }
  }))
)
```

Se Anthropic richiede beta multipli, concatenare con virgola: `'files-api-2025-04-14,code-execution-2026-01-20'`. Verifica in implementation guardando i 401/400 response codes.

## 8. Testing strategy

### 8.1 Unit test

`src/lib/__tests__/file-pipeline.test.ts` (vitest):

```ts
describe('detectStrategy', () => {
  it.each([
    ['application/pdf', 'doc.pdf', 'native'],
    ['image/jpeg', 'foto.jpg', 'native'],
    ['application/octet-stream', 'DURC.pdf.p7m', 'files-api'],
    ['application/dxf', 'tavola.dxf', 'files-api'],
    ['application/xml', 'fattura.xml', 'files-api'],  // FatturaPA non è in whitelist
    ['application/zip', 'archive.zip', 'files-api'],
    ['', 'unknown.xyz', 'files-api'],
  ])('%s + %s → %s', (mime, name, expected) => {
    expect(detectStrategy(mime, name)).toBe(expected)
  })
})

describe('processNative regression', () => {
  // Riusa test esistenti se presenti, altrimenti aggiungi
  // PDF, image, Word, Excel, ODS, CSV, TXT, fallback text, metadata-only
})

describe('processFile via mock Files API', () => {
  // Mock client.beta.files.upload
  it('uploadFile → ritorna container_upload block + uploadedFileId')
  it('su errore upload → fallback processNative')
})
```

### 8.2 Smoke test in produzione (verifica end-to-end manuale)

| # | Test | Atteso |
|---|---|---|
| 1 | Trascina `DURC.pdf.p7m` reale via Telegram | Cervellone risponde con dati estratti dal payload PDF interno (numero DURC, scadenza, ente, ecc.) |
| 2 | Trascina `tavola.dxf` reale via Telegram | Cervellone elenca layer/blocchi/quote principali |
| 3 | Trascina `FatturaPA.xml` reale via Telegram | Cervellone estrae fornitore, importo, IVA, righe |
| 4 | Trascina PDF nativo (regression test) | Cervellone risponde come oggi (no regressione) |
| 5 | Trascina `.docx` (regression test) | Cervellone risponde come oggi |

### 8.3 Logging

`processFile` logga: `[FILE-PIPELINE] strategy=X file=Y size=Z fileId=W` per ogni invocazione. Permette diagnosi futura senza tirare fuori test ad-hoc.

## 9. Done Definition (DoD)

- [ ] `src/lib/file-pipeline.ts` esiste, esporta `processFile`, `detectStrategy`, `processNative`, types
- [ ] `buildContentBlocks` in `telegram-helpers.ts` riusa `processFile` (thin wrapper)
- [ ] System prompt aggiornato con REGOLA TOOL FILE PIPELINE
- [ ] Beta header `files-api-2025-04-14` aggiunto a 3 chiamate `messages.stream` in `claude.ts`
- [ ] Migration `2026-05-06-anthropic-files-tracking.sql` creata
- [ ] Migration applicata in prod (utente)
- [ ] Unit test detectStrategy passa (≥ 7 casi)
- [ ] Unit test processNative non regredisce (test esistenti continuano a passare)
- [ ] Unit test processFile mock Files API passa (happy + fallback)
- [ ] Vercel deploy READY post-push
- [ ] Smoke test prod 5/5 verde (3 custom + 2 native)
- [ ] Memo aggiornato in `cervellone-roadmap-tattica.md` con stato A=done e debt cleanup futuro
- [ ] Memo aggiornato in `cervellone-programma-file-handlers.md` con A completato + E e D che si chiudono di conseguenza

## 10. Out of scope (iterazioni future, non MVP)

- **Iter #2**: integrazione webchat (`parseDocumentBlocks` → `processFile`)
- **Iter #3**: integrazione Drive (refactor `drive_read_*` per supportare file custom via Files API + container_upload)
- **Iter #4**: nuovo tool `gmail_get_attachment(message_id, attachment_id)` per integrazione Gmail attiva
- **Iter #5**: cron cleanup `/api/cron/cleanup-anthropic-files` (delete > 30gg)
- **Iter #6**: detection PDF scansionati → forza Files API anche se mime è PDF
- **Iter #7**: (eventualmente) caching file_id per "ti ricordi quel DURC" cross-sessione

## 11. Rischi e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Files API beta header cambia / API rotta | Try/catch con fallback processNative; beta header centralizzato in 1 punto per cambio rapido |
| Modello non invoca code_execution dopo container_upload | System prompt REGOLA TOOL FILE PIPELINE esplicita; smoke test #1-3 verificano |
| Costi Anthropic Files API + code_execution > preventivo | Logging strategia per ogni file; budget alert già attivo (cervellone_usage_daily) |
| Privacy file italiani PA su server US Anthropic | TTL via tabella tracking + cleanup futuro; documentato come debt |
| Telegram >20MB rejected ma utente trascina file CAD grande | Messaggio chiaro: "file >20MB, mandalo via Drive" |
| Regressione su file native (PDF/Word) | Refactor 1:1 senza cambio comportamento; unit test regression |

## 12. Riferimenti

- SDK Anthropic 0.80: `node_modules/@anthropic-ai/sdk/resources/beta/files.d.ts`
- ContainerUploadBlockParam: `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:424`
- code_execution_20260120: `messages.d.ts:339-361` (REPL state persistence + gVisor checkpoint)
- Programma master: `memory/cervellone-programma-file-handlers.md`
- Roadmap tattica: `memory/cervellone-roadmap-tattica.md`
- Telegram webhook attuale: `src/app/api/telegram/route.ts`
- buildContentBlocks attuale: `src/lib/telegram-helpers.ts:88-167`
- Tools registry: `src/lib/tools.ts:1751-1757` (code_execution già registrato)
