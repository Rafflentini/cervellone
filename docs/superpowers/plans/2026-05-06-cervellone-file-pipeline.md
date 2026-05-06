# Cervellone File Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cervellone apre e legge qualsiasi tipo di file (parità Claude.ai + formati italiani .p7m/FatturaPA + CAD .dxf), via pipeline HYBRID che mantiene il fast path base64 esistente e aggiunge Anthropic Files API + container_upload + code_execution per i formati custom.

**Architecture:** Single shared lib `src/lib/file-pipeline.ts` con `detectStrategy` (whitelist NATIVE) + `processNative` (logica esistente di buildContentBlocks rifattorizzata) + `uploadToAnthropic` (Files API + DB tracking) + `processFile` orchestrator. Telegram webhook integra via thin wrapper.

**Tech Stack:** TypeScript, Anthropic SDK 0.80 (beta files API), Supabase Postgres, vitest per unit test, Next.js 16 (App Router).

**Spec:** `docs/superpowers/specs/2026-05-06-cervellone-file-pipeline-design.md` (commit 92a686e)

---

## File Structure

**Da creare:**
- `src/lib/file-pipeline.ts` — pipeline core (detect + native + upload + processFile)
- `src/lib/file-pipeline.test.ts` — unit test vitest
- `supabase/migrations/2026-05-06-anthropic-files-tracking.sql` — tabella tracking file_id

**Da modificare:**
- `src/lib/telegram-helpers.ts` (linee 88-167) — `buildContentBlocks` diventa thin wrapper
- `src/lib/claude.ts` (3 funzioni: callClaudeStream, callClaude, callClaudeStreamTelegram) — beta header `anthropic-beta: files-api-2025-04-14`
- `src/lib/prompts.ts` (~ riga 117) — REGOLA TOOL FILE PIPELINE

**File touched ma non strutturalmente modificati:**
- nessuno

---

## Task 1: Skeleton + types + detectStrategy (TDD)

**Files:**
- Create: `src/lib/file-pipeline.ts`
- Create: `src/lib/file-pipeline.test.ts`

- [ ] **Step 1.1: Write failing tests for detectStrategy**

Create file `src/lib/file-pipeline.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { detectStrategy } from './file-pipeline'

describe('detectStrategy', () => {
  it.each([
    // NATIVE — whitelist explicit
    ['application/pdf', 'doc.pdf', 'native'],
    ['image/jpeg', 'foto.jpg', 'native'],
    ['image/png', 'screenshot.png', 'native'],
    ['image/webp', 'foto.webp', 'native'],
    ['image/heic', 'apple.heic', 'native'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx', 'native'],
    ['application/msword', 'old.doc', 'native'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet.xlsx', 'native'],
    ['application/vnd.ms-excel', 'old.xls', 'native'],
    ['application/vnd.oasis.opendocument.spreadsheet', 'sheet.ods', 'native'],
    ['text/plain', 'note.txt', 'native'],
    ['text/csv', 'data.csv', 'native'],
    ['text/markdown', 'README.md', 'native'],
    // CUSTOM — Files API
    ['application/octet-stream', 'DURC.pdf.p7m', 'files-api'],
    ['application/dxf', 'tavola.dxf', 'files-api'],
    ['application/acad', 'pianta.dwg', 'files-api'],
    ['application/xml', 'fattura.xml', 'files-api'],  // FatturaPA non in whitelist
    ['text/xml', 'fattura.xml', 'files-api'],
    ['application/zip', 'archive.zip', 'files-api'],
    ['message/rfc822', 'email.eml', 'files-api'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'slides.pptx', 'files-api'],
    ['', 'unknown.xyz', 'files-api'],
    ['application/octet-stream', 'random.bin', 'files-api'],
  ])('%s + %s → %s', (mime, name, expected) => {
    expect(detectStrategy(mime, name)).toBe(expected)
  })
})
```

- [ ] **Step 1.2: Run tests — verify FAIL**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx vitest run src/lib/file-pipeline.test.ts`
Expected: FAIL — "Cannot find module './file-pipeline'"

- [ ] **Step 1.3: Implement file-pipeline.ts skeleton + detectStrategy**

Create file `src/lib/file-pipeline.ts`:

```ts
/**
 * lib/file-pipeline.ts — pipeline universale lettura file
 *
 * HYBRID architecture:
 * - NATIVE fast path: PDF/img/Word/Excel/CSV/TXT/ODS via base64 content blocks (logica esistente)
 * - CUSTOM via Anthropic Files API → container_upload → code_execution + Python lib
 *
 * Spec: docs/superpowers/specs/2026-05-06-cervellone-file-pipeline-design.md
 */

import type Anthropic from '@anthropic-ai/sdk'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContentBlockParam = any  // Anthropic.Messages.ContentBlockParam (avoid namespace import quirks)

export type FileInput = {
  buffer: ArrayBuffer | Buffer
  fileName: string
  mimeType: string
}

export type Strategy = 'native' | 'files-api' | 'fallback-text' | 'metadata-only'

export type PipelineResult = {
  blocks: ContentBlockParam[]
  strategy: Strategy
  uploadedFileId?: string
}

const NATIVE_MIMES = new Set<string>([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/plain',
  'text/csv',
  'text/markdown',
])

export function detectStrategy(mimeType: string, _fileName: string): 'native' | 'files-api' {
  if (mimeType.startsWith('image/')) return 'native'
  if (NATIVE_MIMES.has(mimeType)) return 'native'
  return 'files-api'
}
```

- [ ] **Step 1.4: Run tests — verify PASS**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx vitest run src/lib/file-pipeline.test.ts`
Expected: PASS — all 22 cases green

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/file-pipeline.ts src/lib/file-pipeline.test.ts
git commit -m "feat(file-pipeline): skeleton + detectStrategy (sub-progetto A)

Whitelist NATIVE per fast path: PDF, image/*, Word, Excel, ODS,
CSV/TXT/markdown. Tutto il resto → files-api.

Test 22 casi (native + custom + edge).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: processNative (refactor 1:1 di buildContentBlocks)

**Files:**
- Modify: `src/lib/file-pipeline.ts` (aggiungi processNative)
- Modify: `src/lib/file-pipeline.test.ts` (aggiungi tests)

- [ ] **Step 2.1: Write failing tests for processNative**

Append to `src/lib/file-pipeline.test.ts`:

```ts
import { processNative } from './file-pipeline'

describe('processNative', () => {
  it('PDF → document base64 block', async () => {
    const buffer = Buffer.from('%PDF-1.4 fake pdf content')
    const result = await processNative({
      buffer,
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
    })
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].type).toBe('document')
    expect(result.blocks[0].source.type).toBe('base64')
    expect(result.blocks[0].source.media_type).toBe('application/pdf')
    expect(result.strategy).toBe('native')
  })

  it('image/* → image base64 block', async () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff]) // JPEG header
    const result = await processNative({
      buffer,
      fileName: 'foto.jpg',
      mimeType: 'image/jpeg',
    })
    expect(result.blocks[0].type).toBe('image')
    expect(result.strategy).toBe('native')
  })

  it('CSV → text block', async () => {
    const text = 'col1,col2\nval1,val2\n' + 'data,'.repeat(100)
    const buffer = Buffer.from(text)
    const result = await processNative({
      buffer,
      fileName: 'data.csv',
      mimeType: 'text/csv',
    })
    expect(result.blocks[0].type).toBe('text')
    expect(result.blocks[0].text).toContain('data.csv')
    expect(result.blocks[0].text).toContain('col1,col2')
    expect(result.strategy).toBe('native')
  })

  it('formato non riconosciuto + binary → metadata-only', async () => {
    // Binary non printable
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0xff, 0xfe, 0xfd])
    const result = await processNative({
      buffer,
      fileName: 'random.bin',
      mimeType: 'application/octet-stream',
    })
    expect(result.blocks[0].type).toBe('text')
    expect(result.blocks[0].text).toContain('[File binario:')
    expect(result.strategy).toBe('metadata-only')
  })

  it('formato non riconosciuto + ASCII printable → fallback text', async () => {
    const text = 'Questo è un file di testo con contenuto valido. '.repeat(20)
    const buffer = Buffer.from(text)
    const result = await processNative({
      buffer,
      fileName: 'unknown.xyz',
      mimeType: 'application/octet-stream',
    })
    expect(result.blocks[0].type).toBe('text')
    expect(result.blocks[0].text).toContain('Questo è un file di testo')
    expect(result.strategy).toBe('fallback-text')
  })
})
```

- [ ] **Step 2.2: Run tests — verify FAIL**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx vitest run src/lib/file-pipeline.test.ts`
Expected: FAIL — "processNative is not exported"

- [ ] **Step 2.3: Implement processNative copiando logica da telegram-helpers.ts:88-167**

Append to `src/lib/file-pipeline.ts`:

```ts
/**
 * processNative — handler per formati nativi (whitelist).
 * Logica copiata 1:1 da buildContentBlocks in telegram-helpers.ts.
 * Strategy può essere 'native', 'fallback-text' (ASCII non whitelist), 'metadata-only' (binario non riconosciuto).
 */
export async function processNative(input: FileInput): Promise<PipelineResult> {
  const { buffer, fileName, mimeType } = input
  const buf = buffer instanceof Buffer ? buffer : Buffer.from(buffer)
  const base64 = buf.toString('base64')

  // PDF → document block
  if (mimeType === 'application/pdf') {
    return {
      blocks: [{ type: 'document', source: { type: 'base64', media_type: mimeType, data: base64 } }],
      strategy: 'native',
    }
  }
  // Image → image block
  if (mimeType.startsWith('image/')) {
    return {
      blocks: [{ type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } }],
      strategy: 'native',
    }
  }
  // Word → mammoth text extraction
  if (mimeType.includes('word') || mimeType === 'application/msword') {
    try {
      const mammoth = await import('mammoth')
      // mammoth richiede ArrayBuffer
      const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      const result = await mammoth.extractRawText({ arrayBuffer: arrayBuffer as ArrayBuffer })
      if (result.value && result.value.length > 50) {
        return {
          blocks: [{ type: 'text', text: `[File Word: ${fileName}]\n\n${result.value}` }],
          strategy: 'native',
        }
      }
    } catch { /* ignore */ }
  }
  // ODS → JSZip XML extract
  if (fileName.endsWith('.ods')) {
    try {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(buf)
      const xml = await zip.file('content.xml')?.async('string')
      if (xml) {
        const rows: string[] = []
        const rowRe = /<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g
        let rm
        while ((rm = rowRe.exec(xml)) !== null) {
          const cells: string[] = []
          const cellRe = /<table:table-cell([^>]*)>([\s\S]*?)<\/table:table-cell>/g
          let cm
          while ((cm = cellRe.exec(rm[1])) !== null) {
            const txt = (cm[2] || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&apos;/g, "'").trim()
            if (txt) cells.push(txt)
          }
          if (cells.length >= 2) rows.push(cells.join(' | '))
        }
        const text = rows.slice(0, 3000).join('\n')
        if (text.length > 50) {
          return {
            blocks: [{ type: 'text', text: `[File ODS: ${fileName} — ${rows.length} righe]\n\n${text.slice(0, 100000)}` }],
            strategy: 'native',
          }
        }
      }
    } catch { /* ignore */ }
  }
  // CSV/TXT/markdown
  if (fileName.endsWith('.csv') || fileName.endsWith('.txt') || fileName.endsWith('.md')) {
    const text = buf.toString('utf-8')
    if (text.length > 50) {
      return {
        blocks: [{ type: 'text', text: `[File ${fileName}]\n\n${text.slice(0, 100000)}` }],
        strategy: 'native',
      }
    }
  }
  // Excel
  if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
    try {
      const JSZip = (await import('jszip')).default
      const zip = await JSZip.loadAsync(buf)
      const shared = await zip.file('xl/sharedStrings.xml')?.async('string')
      if (shared) {
        const texts: string[] = []
        const re = /<t[^>]*>([\s\S]*?)<\/t>/g
        let m
        while ((m = re.exec(shared)) !== null) texts.push(m[1].trim())
        if (texts.length > 0) {
          return {
            blocks: [{ type: 'text', text: `[File Excel: ${fileName}]\n\n${texts.join(' | ').slice(0, 100000)}` }],
            strategy: 'native',
          }
        }
      }
    } catch { /* ignore */ }
  }
  // Fallback testo se ASCII printable
  try {
    const text = buf.toString('utf-8')
    const printable = text.replace(/[^\x20-\x7E\r\n\t\xC0-\xFF]/g, '')
    if (printable.length > text.length * 0.5 && text.length > 50) {
      return {
        blocks: [{ type: 'text', text: `[File: ${fileName}]\n\n${text.slice(0, 100000)}` }],
        strategy: 'fallback-text',
      }
    }
  } catch { /* ignore */ }
  // Ultima risorsa: metadata-only
  return {
    blocks: [{ type: 'text', text: `[File binario: ${fileName}, ${(buf.byteLength / 1024).toFixed(0)} KB]` }],
    strategy: 'metadata-only',
  }
}
```

- [ ] **Step 2.4: Run tests — verify PASS**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx vitest run src/lib/file-pipeline.test.ts`
Expected: PASS — 22 detectStrategy + 5 processNative = 27 green

- [ ] **Step 2.5: Commit**

```bash
git add src/lib/file-pipeline.ts src/lib/file-pipeline.test.ts
git commit -m "feat(file-pipeline): processNative (refactor 1:1 buildContentBlocks)

Logica handler per PDF/img/Word/Excel/ODS/CSV/TXT/fallback copiata
1:1 da telegram-helpers.ts in modulo riusabile. Zero cambio comportamento.

Test 5 casi: PDF, image, CSV, fallback-text ASCII, metadata-only binary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: uploadToAnthropic + DB tracking

**Files:**
- Modify: `src/lib/file-pipeline.ts` (aggiungi uploadToAnthropic)
- Modify: `src/lib/file-pipeline.test.ts` (aggiungi tests con mock)

- [ ] **Step 3.1: Write failing test for uploadToAnthropic**

Append to `src/lib/file-pipeline.test.ts`:

```ts
import { vi } from 'vitest'
import { uploadToAnthropic } from './file-pipeline'

// Mock setup helpers
const mockUpload = vi.fn()
const mockSupabaseInsert = vi.fn()

vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')
  return {
    ...actual,
    default: vi.fn().mockImplementation(() => ({
      beta: { files: { upload: mockUpload } },
    })),
  }
})

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: mockSupabaseInsert.mockResolvedValue({ error: null }),
    })),
  },
}))

describe('uploadToAnthropic', () => {
  beforeEach(() => {
    mockUpload.mockReset()
    mockSupabaseInsert.mockReset().mockResolvedValue({ error: null })
  })

  it('upload riuscito → ritorna file_id e traccia in DB', async () => {
    mockUpload.mockResolvedValue({ id: 'file_abc123', filename: 'DURC.p7m', mime_type: 'application/octet-stream', size_bytes: 12345 })

    const result = await uploadToAnthropic({
      buffer: Buffer.from('fake p7m bytes'),
      fileName: 'DURC.p7m',
      mimeType: 'application/octet-stream',
    })

    expect(result.fileId).toBe('file_abc123')
    expect(mockUpload).toHaveBeenCalledOnce()
    // Verifica beta header passato
    const callArgs = mockUpload.mock.calls[0]
    expect(callArgs[1]?.headers?.['anthropic-beta']).toContain('files-api-2025-04-14')
    // Verifica DB insert
    expect(mockSupabaseInsert).toHaveBeenCalledOnce()
  })

  it('upload fallito → throw + nessun insert DB', async () => {
    mockUpload.mockRejectedValue(new Error('Files API down'))

    await expect(uploadToAnthropic({
      buffer: Buffer.from('test'),
      fileName: 'test.bin',
      mimeType: 'application/octet-stream',
    })).rejects.toThrow('Files API down')

    expect(mockSupabaseInsert).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3.2: Run tests — verify FAIL**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx vitest run src/lib/file-pipeline.test.ts`
Expected: FAIL — "uploadToAnthropic is not exported"

- [ ] **Step 3.3: Implement uploadToAnthropic in file-pipeline.ts**

Append to `src/lib/file-pipeline.ts`:

```ts
import Anthropic, { toFile } from '@anthropic-ai/sdk'
import { supabase } from './supabase'

const FILES_API_BETA = 'files-api-2025-04-14'

const anthropicClient = new Anthropic()

/**
 * uploadToAnthropic — uploads buffer to Anthropic Files API + tracks in DB.
 * Throws on failure (no fallback here — caller handles).
 */
export async function uploadToAnthropic(input: FileInput): Promise<{ fileId: string }> {
  const { buffer, fileName, mimeType } = input
  const buf = buffer instanceof Buffer ? buffer : Buffer.from(buffer)

  // Convert Buffer → Uploadable (Anthropic SDK helper toFile)
  const uploadable = await toFile(buf, fileName, { type: mimeType || 'application/octet-stream' })

  console.log(`[FILE-PIPELINE] uploadToAnthropic begin file=${fileName} size=${buf.byteLength}`)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result: any = await anthropicClient.beta.files.upload(
    { file: uploadable },
    { headers: { 'anthropic-beta': FILES_API_BETA } }
  )

  const fileId = result?.id
  if (!fileId) throw new Error('Files API: missing id in upload response')

  console.log(`[FILE-PIPELINE] uploadToAnthropic ok fileId=${fileId} file=${fileName}`)

  // Track in DB (best-effort: se DB fail, non bloccare l'upload)
  try {
    await supabase.from('cervellone_anthropic_files').insert({
      file_id: fileId,
      original_filename: fileName,
      mime_type: mimeType,
      size_bytes: buf.byteLength,
    })
  } catch (err) {
    console.warn(`[FILE-PIPELINE] DB tracking insert failed (non-fatal):`, err)
  }

  return { fileId }
}
```

- [ ] **Step 3.4: Run tests — verify PASS**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx vitest run src/lib/file-pipeline.test.ts`
Expected: PASS — tutti i test (27 + 2) green

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/file-pipeline.ts src/lib/file-pipeline.test.ts
git commit -m "feat(file-pipeline): uploadToAnthropic + DB tracking

Files API upload con beta header files-api-2025-04-14.
Tracking in cervellone_anthropic_files (best-effort, non-fatal).
toFile helper SDK per Buffer → Uploadable.

Test 2 casi: upload ok + traccia DB, upload fail → throw senza insert.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: processFile orchestrator

**Files:**
- Modify: `src/lib/file-pipeline.ts` (aggiungi processFile)
- Modify: `src/lib/file-pipeline.test.ts` (aggiungi tests)

- [ ] **Step 4.1: Write failing tests for processFile**

Append to `src/lib/file-pipeline.test.ts`:

```ts
import { processFile } from './file-pipeline'

describe('processFile (orchestrator)', () => {
  beforeEach(() => {
    mockUpload.mockReset()
    mockSupabaseInsert.mockReset().mockResolvedValue({ error: null })
  })

  it('mime nativo → processNative path', async () => {
    const result = await processFile({
      buffer: Buffer.from('%PDF-1.4 fake'),
      fileName: 'doc.pdf',
      mimeType: 'application/pdf',
    })
    expect(result.strategy).toBe('native')
    expect(result.blocks[0].type).toBe('document')
    expect(result.uploadedFileId).toBeUndefined()
    expect(mockUpload).not.toHaveBeenCalled()
  })

  it('mime custom → uploadToAnthropic + container_upload block', async () => {
    mockUpload.mockResolvedValue({ id: 'file_p7m_xyz', filename: 'DURC.p7m', mime_type: 'application/octet-stream', size_bytes: 1000 })

    const result = await processFile({
      buffer: Buffer.from('fake p7m'),
      fileName: 'DURC.p7m',
      mimeType: 'application/octet-stream',
    })

    expect(result.strategy).toBe('files-api')
    expect(result.uploadedFileId).toBe('file_p7m_xyz')
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[0]).toEqual({ type: 'container_upload', file_id: 'file_p7m_xyz' })
    expect(result.blocks[1].type).toBe('text')
    expect(result.blocks[1].text).toContain('DURC.p7m')
  })

  it('upload fallisce → fallback processNative', async () => {
    mockUpload.mockRejectedValue(new Error('upload error'))

    // ASCII content — fallback-text dovrebbe scattare
    const text = 'Some readable text content. '.repeat(20)
    const result = await processFile({
      buffer: Buffer.from(text),
      fileName: 'unknown.xyz',
      mimeType: 'application/octet-stream',
    })

    expect(result.strategy).toBe('fallback-text')
    expect(result.uploadedFileId).toBeUndefined()
    expect(result.blocks[0].text).toContain('Some readable text')
  })
})
```

- [ ] **Step 4.2: Run tests — verify FAIL**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx vitest run src/lib/file-pipeline.test.ts`
Expected: FAIL — "processFile is not exported"

- [ ] **Step 4.3: Implement processFile orchestrator**

Append to `src/lib/file-pipeline.ts`:

```ts
/**
 * processFile — orchestrator: detect strategy, route a processNative o uploadToAnthropic.
 * Su upload error: fallback a processNative anche se non in whitelist.
 */
export async function processFile(input: FileInput): Promise<PipelineResult> {
  const strategy = detectStrategy(input.mimeType, input.fileName)

  console.log(`[FILE-PIPELINE] processFile begin file=${input.fileName} mime=${input.mimeType} strategy=${strategy}`)

  if (strategy === 'native') {
    return processNative(input)
  }

  // strategy === 'files-api'
  try {
    const { fileId } = await uploadToAnthropic(input)
    return {
      blocks: [
        { type: 'container_upload', file_id: fileId },
        { type: 'text', text: `[File caricato nel sandbox code_execution: ${input.fileName} (${input.mimeType || 'unknown mime'})]` },
      ],
      strategy: 'files-api',
      uploadedFileId: fileId,
    }
  } catch (err) {
    console.warn(`[FILE-PIPELINE] Files API failed, fallback processNative:`, err instanceof Error ? err.message : err)
    return processNative(input)
  }
}
```

- [ ] **Step 4.4: Run tests — verify PASS**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx vitest run src/lib/file-pipeline.test.ts`
Expected: PASS — tutti (~32 test green)

- [ ] **Step 4.5: Commit**

```bash
git add src/lib/file-pipeline.ts src/lib/file-pipeline.test.ts
git commit -m "feat(file-pipeline): processFile orchestrator + fallback

Routing detect → native|files-api. Su upload Anthropic fallito,
fallback a processNative (anche se non whitelist) per non perdere
informazione utente.

Test 3 casi: native path, files-api con container_upload, fallback
su upload error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Refactor buildContentBlocks → thin wrapper

**Files:**
- Modify: `src/lib/telegram-helpers.ts` (linee 87-167)

- [ ] **Step 5.1: Read current buildContentBlocks**

Run: `grep -n "buildContentBlocks" src/lib/telegram-helpers.ts | head -3`
Expected output: linee 88-167 contengono la funzione corrente.

- [ ] **Step 5.2: Replace buildContentBlocks con thin wrapper**

Edit `src/lib/telegram-helpers.ts`:

Trovare il blocco completo da riga 87 (`// eslint-disable-next-line ...`) fino alla riga 167 inclusa (la chiusura della funzione `buildContentBlocks`), che ha questa struttura:

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildContentBlocks(fileData: { buffer: ArrayBuffer; fileName: string; mimeType: string }): Promise<any[]> {
  const { buffer, fileName, mimeType } = fileData
  const base64 = Buffer.from(buffer).toString('base64')
  // ... tutta la logica esistente ...
  return [{ type: 'text', text: `[File binario: ${fileName}, ${(buffer.byteLength / 1024).toFixed(0)} KB]` }]
}
```

Sostituirlo interamente con:

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildContentBlocks(fileData: { buffer: ArrayBuffer; fileName: string; mimeType: string }): Promise<any[]> {
  const { processFile } = await import('./file-pipeline')
  const result = await processFile(fileData)
  console.log(`[BUILD-CONTENT-BLOCKS] file=${fileData.fileName} strategy=${result.strategy} fileId=${result.uploadedFileId ?? '-'}`)
  return result.blocks
}
```

- [ ] **Step 5.3: Run vitest per regressione (file-pipeline test continuano a passare)**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx vitest run src/lib/file-pipeline.test.ts`
Expected: PASS — tutti i test green (la modifica è in telegram-helpers, non in file-pipeline)

- [ ] **Step 5.4: Verifica typecheck no errore**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx tsc --noEmit 2>&1 | head -20`
Expected: nessun errore (potrebbe essere lento se prima compilazione, ~30 sec)

Se ci sono errori TypeScript: leggere l'errore, probabilmente il tipo `ContentBlockParam` da any → ContentBlockParam. Risolvere localmente.

- [ ] **Step 5.5: Commit**

```bash
git add src/lib/telegram-helpers.ts
git commit -m "refactor(telegram): buildContentBlocks → thin wrapper su processFile

Tutta la logica di handling per formato (PDF/Word/ODS/Excel/CSV/fallback)
è ora in src/lib/file-pipeline.ts. buildContentBlocks resta il punto
di chiamata per compatibilità con telegram/route.ts ma delega a processFile.

Zero cambio comportamento per file native. Aggiunge support custom via
Files API + container_upload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Beta header su 3 chiamate stream in claude.ts

**Files:**
- Modify: `src/lib/claude.ts` (3 chiamate `client.messages.stream`)

- [ ] **Step 6.1: Identifica le 3 chiamate stream**

Run: `grep -n "client.messages.stream" src/lib/claude.ts`
Expected: 3 occorrenze (callClaudeStream, callClaude, callClaudeStreamTelegram), + eventuale 4° per force-text synthesis

- [ ] **Step 6.2: Modifica callClaudeStream (riga ~193)**

Edit in `src/lib/claude.ts`, trovare il blocco:

```ts
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
        ...modelOpts,
      }))
    )
```

Nella **prima occorrenza** (`callClaudeStream`, dopo "for (let i = 0; i < MAX_ITERATIONS; i++) {"), sostituire con:

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
        headers: { 'anthropic-beta': 'files-api-2025-04-14' },
      }))
    )
```

- [ ] **Step 6.3: Modifica callClaude (~ riga 269) — stessa modifica**

Trovare la **seconda occorrenza** (in `callClaude`) e applicare identica sostituzione (aggiungere il secondo argomento `{ headers: { 'anthropic-beta': 'files-api-2025-04-14' } }`).

- [ ] **Step 6.4: Modifica callClaudeStreamTelegram (~ riga 360) — stessa modifica**

Trovare la **terza occorrenza** (in `callClaudeStreamTelegram`) e applicare identica sostituzione.

- [ ] **Step 6.5: Modifica force-text synth (~ riga 436) — stessa modifica**

Trovare la **quarta occorrenza** (synth force-text con `tool_choice: { type: 'none' }`) e applicare identica sostituzione (aggiungere il secondo argomento `{ headers: { 'anthropic-beta': 'files-api-2025-04-14' } }` dopo il body).

- [ ] **Step 6.6: Verifica typecheck**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx tsc --noEmit 2>&1 | head -10`
Expected: nessun errore

- [ ] **Step 6.7: Commit**

```bash
git add src/lib/claude.ts
git commit -m "feat(claude): beta header files-api-2025-04-14 su tutte le stream

4 chiamate client.messages.stream aggiornate (callClaudeStream,
callClaude, callClaudeStreamTelegram, force-text synth). Header
anthropic-beta abilita container_upload block in messages, condizione
necessaria per la pipeline file Files API.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: REGOLA TOOL FILE PIPELINE in prompts.ts

**Files:**
- Modify: `src/lib/prompts.ts` (~ riga 117)

- [ ] **Step 7.1: Identifica posizione di inserimento**

Run: `grep -n "REGOLA TOOL" src/lib/prompts.ts`
Expected: vede REGOLA TOOL GMAIL, REGOLA TOOL METEO, REGOLA TOOL DRIVE GOOGLE.

- [ ] **Step 7.2: Inserisci REGOLA TOOL FILE PIPELINE prima di REGOLA AUTONOMIA SVILUPPO**

Edit `src/lib/prompts.ts`, trovare la riga:

```
REGOLA AUTONOMIA SVILUPPO (self-healing):
```

Inserire **prima** di questa riga (lasciando una riga vuota tra le due REGOLE):

```
REGOLA TOOL FILE PIPELINE:
Quando ricevi un container_upload block nel messaggio, il file è disponibile nel filesystem del sandbox code_execution. Usa il tool code_execution per leggerlo con la libreria Python adatta al formato:
- .p7m / .p7s (firma CMS): cryptography (asn1crypto fallback)
- FatturaPA .xml: lxml o xml.etree
- .dxf / .dwg (CAD): ezdxf
- .eml: email.parser
- .zip / .rar / .7z: zipfile
- PDF scansionato senza testo: pytesseract (OCR)
- Altro formato: scegli la lib Python adatta. Se non preinstallata, fai pip install.
Parsa il contenuto, estrai i dati rilevanti, ritorna sintesi leggibile per l'utente. Mai inventare contenuto del file: se la lib non funziona, dichiara cosa è andato storto.

```

- [ ] **Step 7.3: Verifica niente sintassi rotta**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && npx tsc --noEmit 2>&1 | head -5`
Expected: nessun errore (il file è solo testo dentro un template literal)

- [ ] **Step 7.4: Commit**

```bash
git add src/lib/prompts.ts
git commit -m "feat(prompts): REGOLA TOOL FILE PIPELINE per code_execution

Istruzione esplicita al modello: quando vede container_upload block,
usa code_execution con libreria Python appropriata al formato (cryptography
per p7m, lxml per FatturaPA, ezdxf per CAD, pytesseract per OCR, ecc.).
Pip install se necessario. Mai inventare contenuto.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Migration SQL per tabella tracking

**Files:**
- Create: `supabase/migrations/2026-05-06-anthropic-files-tracking.sql`

- [ ] **Step 8.1: Verifica path migrations esiste**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && ls supabase/migrations/ | tail -5`
Expected: vede altre migration recenti (es. 2026-05-05-gmail-rw.sql, 2026-05-06-gmail-processed-pk-fix.sql).

- [ ] **Step 8.2: Crea migration file**

Create file `supabase/migrations/2026-05-06-anthropic-files-tracking.sql`:

```sql
-- Migration: cervellone_anthropic_files — tracking file uploadati ad Anthropic Files API
-- Spec: docs/superpowers/specs/2026-05-06-cervellone-file-pipeline-design.md
-- Sub-progetto A — File Pipeline universale

CREATE TABLE IF NOT EXISTS cervellone_anthropic_files (
  file_id TEXT PRIMARY KEY,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  original_filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  conversation_id UUID,
  -- TTL per cleanup futuro (iter #5)
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_anthropic_files_expires ON cervellone_anthropic_files(expires_at);
CREATE INDEX IF NOT EXISTS idx_anthropic_files_conv ON cervellone_anthropic_files(conversation_id);

-- RLS DISABLED come per altre tabelle Cervellone (server-only access via service_role)
ALTER TABLE cervellone_anthropic_files DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_anthropic_files IS 'Tracking file uploadati su Anthropic Files API. Cleanup cron pending (iter #5).';
```

- [ ] **Step 8.3: Commit**

```bash
git add supabase/migrations/2026-05-06-anthropic-files-tracking.sql
git commit -m "feat(db): migration cervellone_anthropic_files

Tabella tracking file uploadati su Anthropic Files API. Indici su
expires_at (per cleanup cron futuro) + conversation_id (per cleanup
on-conversation-end futuro).

RLS DISABLED come pattern Cervellone (server-only).

Setup utente: applicare via Supabase SQL editor (utente la applica
dopo che il deploy va READY).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Push + verifica deploy + DoD checklist

**Files:**
- Memo (no code)

- [ ] **Step 9.1: Push tutti i commit**

Run: `cd "C:/Progetti claude Code/02.SuperING/cervellone" && git push origin main 2>&1 | tail -5`
Expected: i 8 commit (1+1+1+1+1+1+1+1 dei task 1-8) pushati su origin/main.

- [ ] **Step 9.2: Verifica deploy Vercel READY**

Run via Vercel MCP tool:
```
mcp__plugin_vercel_vercel__list_deployments
  projectId: prj_82oAdncoRjfm5LulvBgzWbel5Pva
  teamId: team_QOxzPu6kcaxY8Jdc45arGmgL
```
Cercare il deploy del commit più recente (ultimo SHA pushato). Aspettare che `state` sia `READY` (~30-60 sec).

Se `state === 'ERROR'`: leggere build log via `mcp__plugin_vercel_vercel__get_deployment_build_logs`, identificare causa, fix in nuovo commit, push, re-verifica. NON marcare task done finché READY.

- [ ] **Step 9.3: Comunica all'utente i 5 smoke test richiesti**

Output testuale all'utente (non un comando, una nota):

```
📋 Smoke test prod richiesti per validare la pipeline:

1. Migration applica (lato utente):
   - Apri Supabase SQL editor
   - Incolla contenuto di supabase/migrations/2026-05-06-anthropic-files-tracking.sql
   - Run

2. Test custom file 1 — DURC firmato:
   - Trascina un file DURC.pdf.p7m reale via Telegram
   - Atteso: Cervellone risponde con dati DURC (numero, scadenza, ente, esito)
   - Log Vercel: [FILE-PIPELINE] strategy=files-api fileId=...

3. Test custom file 2 — CAD:
   - Trascina un .dxf reale via Telegram
   - Atteso: Cervellone elenca layer/blocchi/quote principali
   - Log Vercel: [FILE-PIPELINE] strategy=files-api

4. Test custom file 3 — FatturaPA:
   - Trascina un FatturaPA .xml reale via Telegram
   - Atteso: Cervellone estrae fornitore, importo totale, IVA, righe principali

5. Test regression file native:
   - Trascina un PDF nativo qualsiasi → atteso: legge come oggi (no regressione)
   - Trascina una foto → atteso: descrive come oggi
   - Log Vercel: [FILE-PIPELINE] strategy=native

Tutti gli atteso devono essere verde prima di marcare A=done.
```

- [ ] **Step 9.4: Aggiorna memo `cervellone-roadmap-tattica.md`**

Aggiornare `C:\Users\Raffaele\.claude\projects\C--Progetti-claude-Code\memory\cervellone-roadmap-tattica.md` aggiungendo nella sezione "Stato execution":

```markdown
- ✅ **#A File Pipeline LIVE** — commit 92a686e (spec) + commit subseguenti per implementazione, deploy <SHA> READY <data>. Pipeline HYBRID: native fast path + Files API + container_upload + code_execution. Smoke test 5/5 verde (DURC, DXF, FatturaPA, PDF native, image native). Sub-progetti E (FatturaPA) e D (OCR) si chiudono di conseguenza.
```

- [ ] **Step 9.5: Aggiorna memo `cervellone-programma-file-handlers.md`**

Aggiornare la sezione "Stato sub-progetti (vivo)":

```markdown
- [x] A: ✅ DONE (date)
- [x] E: ✅ DONE via A (FatturaPA via lxml in code_execution)
- [x] D: ✅ DONE via A (OCR via pytesseract in code_execution)
- [ ] F (test self-heal)
- [ ] C (Gmail classification)
- [ ] B (memoria persistente)
```

E aggiornare il totale: "**4 sub-progetti residui invece di 6**".

- [ ] **Step 9.6: Commit memo updates**

```bash
git add ../../Users/Raffaele/.claude/projects/C--Progetti-claude-Code/memory/cervellone-roadmap-tattica.md ../../Users/Raffaele/.claude/projects/C--Progetti-claude-Code/memory/cervellone-programma-file-handlers.md
```

(Path complete possono variare; in Windows usare path assoluto. I memo sono FUORI dal repo cervellone, quindi probabilmente NON committabili come parte del repo cervellone — saltare il commit, ma aggiornare comunque i file di memoria.)

---

## Done Definition (DoD)

Prima di dichiarare il sub-progetto A completato, verificare TUTTI i seguenti:

- [ ] `src/lib/file-pipeline.ts` esiste, esporta `processFile`, `detectStrategy`, `processNative`, `uploadToAnthropic`, types
- [ ] `src/lib/file-pipeline.test.ts` con ≥ 32 test, tutti verdi via `npx vitest run src/lib/file-pipeline.test.ts`
- [ ] `src/lib/telegram-helpers.ts` `buildContentBlocks` è thin wrapper (~5 righe)
- [ ] `src/lib/claude.ts` 4 chiamate stream hanno header `anthropic-beta: files-api-2025-04-14`
- [ ] `src/lib/prompts.ts` contiene REGOLA TOOL FILE PIPELINE
- [ ] `supabase/migrations/2026-05-06-anthropic-files-tracking.sql` esiste
- [ ] Migration applicata su Supabase (utente)
- [ ] `npx tsc --noEmit` non riporta errori
- [ ] Vercel deploy ultimo commit READY
- [ ] Smoke test prod 5/5 verde (DURC.p7m, .dxf, FatturaPA.xml, PDF native, image)
- [ ] Memo `cervellone-roadmap-tattica.md` e `cervellone-programma-file-handlers.md` aggiornati
- [ ] Tabella `cervellone_anthropic_files` riceve insert per ogni file uploadato (verifica via SELECT su Supabase)

## Self-review

**Spec coverage check** (cross-reference con sezioni dello spec):

- §2.1 Modulo nuovo `file-pipeline.ts` → Task 1
- §2.2 Interfaccia pubblica → Task 1, 2, 3, 4 (incrementale)
- §2.3 Flusso interno → Task 4 (orchestrator)
- §2.4 Modifiche codice esistente `buildContentBlocks` → Task 5
- §2.5 Dipendenze (SDK 0.80) → nessun task (già disponibile)
- §3 Detection logic → Task 1 (detectStrategy + whitelist)
- §4.1 Tabella tracking → Task 8 (migration)
- §4.2 Cleanup OUT-OF-SCOPE → corretto, no task
- §4.3 Limiti 32MB/20MB → no task (già limitato in Telegram route)
- §5.1 Files API fallback → Task 4 (try/catch in processFile)
- §5.2 Sandbox timeout → no task (gestito da flusso esistente)
- §5.3 Python lib mancante → no task (system prompt menziona pip install)
- §6 System prompt → Task 7
- §7 Beta header → Task 6
- §8.1 Unit test → Task 1, 2, 3, 4
- §8.2 Smoke test prod → Task 9
- §8.3 Logging → Task 1, 3, 4 (console.log [FILE-PIPELINE])
- §9 DoD → Task 9 + sezione DoD finale

✅ Tutte le sezioni dello spec coperte.

**Placeholder scan**: nessun TBD/TODO/vague nel piano. Code mostrato per ogni step. Comandi esatti.

**Type consistency**: 
- `FileInput`, `Strategy`, `PipelineResult` definiti in Task 1, riusati coerentemente in Task 2, 3, 4
- `processFile`, `detectStrategy`, `processNative`, `uploadToAnthropic` chiamati con signature coerenti
- `cervellone_anthropic_files` schema coerente tra Task 3 (insert in `uploadToAnthropic`) e Task 8 (migration CREATE TABLE)
- Beta header string `'files-api-2025-04-14'` identico in Task 3 e Task 6

✅ Type consistency ok.

**Edge cases / known unknowns documentati**:
- Beta header value (`files-api-2025-04-14`) potrebbe essere obsoleto se Anthropic ha bumpato la data → Task 6 verifica typecheck + Task 9 verifica deploy READY
- Anthropic SDK upload signature potrebbe richiedere cast `any` aggiuntivi → Task 3 ha già `(result: any)`
- ContentBlockParam type strict → Task 1 usa `any` per evitare quirks namespace import
