# BUG1 — Memoria immagini ibrida (persistenza estrazione + ri-iniezione) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: questo piano è eseguito da **Codex** via `.loop/queue/` (vedi `.loop/PROTOCOL.md` + `AGENTS.md`). Claude rivede ogni branch, fa audit subagenti e mergia. Steps con checkbox (`- [ ]`).

**Goal:** Le immagini caricate restano "ricordate" nei turni successivi: alla fine del turno che le contiene si persiste l'ESTRAZIONE testuale del modello nello store `documents` (type `image-extraction`), e ad ogni turno successivo un POINTER breve la ri-inietta nel system prompt — così il bot non dice più "non posso rivedere le immagini" e non allucina identificativi.

**Architecture:** Clone del pattern `artifact-capture.ts` (capture a fine turno + `build…Pointer` ri-iniettato), ma applicato all'output di analisi immagini e — CRITICO — **INCONDIZIONATO** (NON gated da `isWorkingMemoryEnabled()`, che in prod è OFF; altrimenti il fix è inerte come lo erano procedure/project_state). Riusa la tabella `documents` esistente (NESSUNA migration). Gamba "ri-aggancio pixel on-demand" (tool `rivedi_immagine` via `downloadFileBase64`) = Increment 2, separata.

**Tech Stack:** Next.js 16 (App Router), Supabase (`documents` table), TypeScript, vitest. Mock supabase come in `src/lib/artifact-capture.test.ts`.

**Decisioni di design (vetoabili dall'utente):**
- **Si cattura l'estrazione che il modello ha GIÀ prodotto** nel turno (l'assistant text), NON una vision-call separata: zero costo extra, riuso del lavoro già fatto. Stessa filosofia di `captureArtifact`.
- **Store = `documents` type `image-extraction`** (no nuova tabella → no dipendenza Cowork/migration; RLS già attiva su `documents`).
- **Incondizionato** (best-effort, mai lancia). Non dipende dal flag.
- **Web-first**: il disastro reale (10 foto → 500, caso Lal Chaman/ALI del 12 giu) è sul path web `/api/chat`. Increment 1 = modulo + wiring web. Telegram = Increment 1b. Re-attach tool = Increment 2.

---

## File Structure

| File | Responsabilità | Increment |
|------|----------------|-----------|
| `src/lib/image-memory.ts` (NEW) | `captureImageExtraction` + `buildImagesPointer` + type `UploadedImageRef` | 1 |
| `src/lib/image-memory.test.ts` (NEW) | unit test del modulo (mock supabase) | 1 |
| `src/app/api/chat/route.ts` (MODIFY) | wiring web: raccogli ref upload, inietta pointer, cattura a fine turno (+ chiude il gap `captureArtifact`/`buildArtifactsPointer` mancanti sul web) | 1 |
| `src/lib/agent-job.ts` (MODIFY) | wiring Telegram: pointer incondizionato + capture a fine turno; estende `AgentJobInput` | 1b |
| `src/app/api/telegram/route.ts` (MODIFY) | raccoglie i ref immagine del turno e li passa a `runAgentJob` | 1b |
| `src/lib/image-recall-tool.ts` (NEW) + registry | tool `rivedi_immagine` (Drive→base64 on-demand) | 2 |

---

## INCREMENT 1 — Modulo + wiring WEB (queue 084, 085)

### Task 084 — Modulo `image-memory.ts` + test

**Files:**
- Create: `src/lib/image-memory.ts`
- Test: `src/lib/image-memory.test.ts`

**Branch:** `codex/084-image-memory-module` da `codex/main` aggiornato.

- [ ] **Step 1: Scrivi il modulo** `src/lib/image-memory.ts`

```typescript
/**
 * src/lib/image-memory.ts — Memoria delle IMMAGINI caricate (fix BUG1).
 *
 * Problema: le immagini caricate non sono "ricordate" nei turni successivi
 * (la tabella `messages` salva solo testo). Qui, a fine turno, persistiamo
 * l'ESTRAZIONE testuale che il modello ha già prodotto sull'immagine, nello
 * store `documents` (type 'image-extraction'), con i riferimenti Drive in
 * metadata. Ad ogni turno successivo `buildImagesPointer` ri-inietta un blocco
 * breve nel system prompt → il bot non dice "non posso rivederle" e non
 * inventa identificativi.
 *
 * CRITICO: tutto INCONDIZIONATO (NON gated da isWorkingMemoryEnabled, OFF in
 * prod). Best-effort: nessuna funzione lancia mai.
 *
 * Riuso `documents` (id, name, content, conversation_id, type, metadata jsonb,
 * created_at) → nessuna migration.
 */

import { getSupabaseServer } from './supabase-server'

const IMAGE_EXTRACTION_TYPE = 'image-extraction'
/** Recency del pointer: 24h (conversazione Telegram è globale/permanente). */
const POINTER_RECENCY_MS = 24 * 60 * 60 * 1000
const POINTER_MAX_ENTRIES = 8
/** Estratto massimo per immagine mostrato nel pointer. */
const EXTRACTION_EXCERPT_MAXLEN = 600
/** Estrazione minima perché valga la pena salvarla. */
const MIN_EXTRACTION_LENGTH = 40

export interface UploadedImageRef {
  driveFileId: string
  filename: string
  driveUrl?: string | null
}

/**
 * Persiste l'estrazione testuale del turno (assistantText) legandola ai
 * riferimenti Drive delle immagini caricate IN QUEL turno. Salva SOLO se ci
 * sono immagini e l'estrazione è non banale. Best-effort.
 */
export async function captureImageExtraction(
  conversationId: string,
  assistantText: string,
  images: UploadedImageRef[],
): Promise<{ saved: boolean; id?: string; reason?: string }> {
  try {
    if (!conversationId) return { saved: false, reason: 'no-conversation' }
    if (!images || images.length === 0) return { saved: false, reason: 'no-images' }
    const content = (assistantText || '').trim()
    if (content.length < MIN_EXTRACTION_LENGTH) return { saved: false, reason: 'empty-extraction' }

    const supabase = getSupabaseServer()
    const filenames = images.map((i) => i.filename).filter(Boolean)
    const driveFileIds = images.map((i) => i.driveFileId).filter(Boolean)
    const driveUrls = images.map((i) => i.driveUrl).filter((u): u is string => Boolean(u))
    const name = `Estrazione immagini: ${filenames.slice(0, 3).join(', ') || '(immagini)'}`.slice(0, 120)

    const { data, error } = await supabase
      .from('documents')
      .insert({
        name,
        content,
        conversation_id: conversationId,
        type: IMAGE_EXTRACTION_TYPE,
        metadata: { source: 'image-memory', filenames, drive_file_ids: driveFileIds, drive_urls: driveUrls },
      })
      .select('id')
      .single()

    if (error) {
      console.error('[image-memory] insert failed:', error.message)
      return { saved: false, reason: error.message }
    }
    return { saved: true, id: (data as { id?: string } | null)?.id }
  } catch (err) {
    console.error('[image-memory] captureImageExtraction error:', err instanceof Error ? err.message : err)
    return { saved: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Blocco breve che elenca le immagini già caricate+analizzate (ultime 24h) con
 * l'estratto dei dati. Ritorna '' se non ce ne sono. Best-effort.
 */
export async function buildImagesPointer(conversationId: string): Promise<string> {
  try {
    if (!conversationId) return ''
    const supabase = getSupabaseServer()
    const sinceIso = new Date(Date.now() - POINTER_RECENCY_MS).toISOString()

    const { data, error } = await supabase
      .from('documents')
      .select('id, name, content, metadata, created_at')
      .eq('conversation_id', conversationId)
      .eq('type', IMAGE_EXTRACTION_TYPE)
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(POINTER_MAX_ENTRIES)

    if (error) {
      console.error('[image-memory] buildImagesPointer read failed:', error.message)
      return ''
    }
    if (!data || data.length === 0) return ''

    const lines: string[] = []
    lines.push(
      '=== IMMAGINI/DOCUMENTI GIÀ CARICATI E ANALIZZATI in questa chat — i dati estratti sono QUI SOTTO. NON dire che non puoi rivederli; NON re-inventare numeri/ID: se un dato non è qui, CHIEDILO. ===',
    )
    for (const row of data) {
      const r = row as { content?: string | null; metadata?: unknown }
      const meta = (r.metadata ?? {}) as { filenames?: unknown; drive_file_ids?: unknown }
      const names = Array.isArray(meta.filenames) && meta.filenames.length
        ? (meta.filenames as string[]).join(', ')
        : '(immagini)'
      const ids = Array.isArray(meta.drive_file_ids) ? (meta.drive_file_ids as string[]).join(', ') : ''
      const excerpt = (r.content || '').trim().slice(0, EXTRACTION_EXCERPT_MAXLEN)
      lines.push(`- File: ${names}${ids ? ` [drive: ${ids}]` : ''}\n  Dati già estratti: ${excerpt}`)
    }
    lines.push('=== fine immagini ===')
    return lines.join('\n')
  } catch (err) {
    console.error('[image-memory] buildImagesPointer error:', err instanceof Error ? err.message : err)
    return ''
  }
}
```

- [ ] **Step 2: Scrivi il test** `src/lib/image-memory.test.ts` (clona il pattern di mock supabase da `src/lib/artifact-capture.test.ts`)

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock del client supabase server (vedi artifact-capture.test.ts per il pattern esatto).
const insertMock = vi.fn()
const selectChain = vi.fn()
vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      insert: (...a: unknown[]) => insertMock(...a),
      select: (...a: unknown[]) => selectChain(...a),
    }),
  }),
}))

import { captureImageExtraction, buildImagesPointer } from './image-memory'

beforeEach(() => {
  insertMock.mockReset()
  selectChain.mockReset()
})

describe('captureImageExtraction', () => {
  it('non salva senza immagini', async () => {
    const r = await captureImageExtraction('conv1', 'testo lungo abbastanza per superare la soglia minima', [])
    expect(r.saved).toBe(false)
    expect(r.reason).toBe('no-images')
  })

  it('non salva con estrazione troppo corta', async () => {
    const r = await captureImageExtraction('conv1', 'corto', [{ driveFileId: 'd1', filename: 'a.jpg' }])
    expect(r.saved).toBe(false)
    expect(r.reason).toBe('empty-extraction')
  })

  it('non salva senza conversation', async () => {
    const r = await captureImageExtraction('', 'x'.repeat(50), [{ driveFileId: 'd1', filename: 'a.jpg' }])
    expect(r.saved).toBe(false)
    expect(r.reason).toBe('no-conversation')
  })

  it('non lancia mai (best-effort) su errore interno', async () => {
    // insert che lancia → ritorna saved:false, non throw
    insertMock.mockImplementation(() => { throw new Error('boom') })
    const r = await captureImageExtraction('conv1', 'x'.repeat(50), [{ driveFileId: 'd1', filename: 'a.jpg' }])
    expect(r.saved).toBe(false)
  })
})

describe('buildImagesPointer', () => {
  it('ritorna stringa vuota senza conversation', async () => {
    expect(await buildImagesPointer('')).toBe('')
  })
})
```

> NB Codex: la sandbox è offline (no node_modules) → NON eseguire i test. Se il pattern di mock esatto di `artifact-capture.test.ts` differisce dal mio scheletro, ADEGUA il mock a quello del file esistente (è la fonte di verità) e dichiaralo nel done.log. La logica del modulo (Step 1) NON va cambiata.

- [ ] **Step 3: Commit**

```bash
git add src/lib/image-memory.ts src/lib/image-memory.test.ts
git commit -m "feat(image-memory): persistenza estrazione immagini + pointer (BUG1 core, incondizionato)"
```

- [ ] **Step 4: Done**

Appendi a `.loop/done.log`:
`084 | codex/084-image-memory-module | image-memory.ts: captureImageExtraction + buildImagesPointer (documents type image-extraction, incondizionato) + test | files: src/lib/image-memory.ts, src/lib/image-memory.test.ts`

---

### Task 085 — Wiring path WEB (`src/app/api/chat/route.ts`)

**Files:**
- Modify: `src/app/api/chat/route.ts`

**Branch:** `codex/085-image-memory-web-wiring` da `codex/main` (DOPO il merge di 084 — Claude aggiorna codex/main).

Questo task: (a) raccoglie i ref delle immagini ingerite nel turno; (b) inietta `buildImagesPointer` + `buildArtifactsPointer` nel workingContext (oggi sul web MANCANO entrambi); (c) a fine turno cattura `captureImageExtraction` + `captureArtifact`.

- [ ] **Step 1: Import.** In testa a `src/app/api/chat/route.ts`, accanto all'import esistente `import { buildTemplateContext } from '@/lib/template-context'` (riga 14), aggiungi:

```typescript
import { buildArtifactsPointer, captureArtifact } from '@/lib/artifact-capture'
import { captureImageExtraction, buildImagesPointer, type UploadedImageRef } from '@/lib/image-memory'
```

- [ ] **Step 2: Raccogli i ref immagine dall'ingest.** Il blocco esistente (righe ~79-101) chiama `ingestPhotoUpload(...)` SENZA usarne il ritorno. Dichiara una variabile di turno PRIMA del blocco e popolala col ritorno. Sostituisci `await ingestPhotoUpload({...})` con la cattura del risultato.

Prima (estratto, riga ~84-96):
```typescript
    if (imgs.length > 0) {
      try {
        const { ingestPhotoUpload } = await import('@/lib/foto-ingest')
        await ingestPhotoUpload({
          canale: 'web',
          chatId: conversationId ?? null,
```
Dopo:
```typescript
    if (imgs.length > 0) {
      try {
        const { ingestPhotoUpload } = await import('@/lib/foto-ingest')
        const recs = await ingestPhotoUpload({
          canale: 'web',
          chatId: conversationId ?? null,
```
e, subito dopo la chiamata (dopo la `})` che chiude l'oggetto passato a `ingestPhotoUpload`), mappa i record nella variabile di turno:
```typescript
        uploadedImageRefs = recs.map((r) => ({
          driveFileId: r.driveFileId,
          filename: r.filename,
          driveUrl: r.driveUrl,
        }))
```
Dichiara la variabile di turno appena PRIMA del blocco `if (lastUserMsg && Array.isArray(lastUserMsg.content))` (riga ~79):
```typescript
  let uploadedImageRefs: UploadedImageRef[] = []
```

- [ ] **Step 3: Inietta i pointer nel workingContext.** Modifica il blocco righe ~215-217. Prima:

```typescript
  const workingContext = [flaggedWorkingContext, templateContext]
    .filter((b) => b && b.trim())
    .join('\n\n') || undefined
```
Dopo (aggiungi i due pointer, INCONDIZIONATI come templateContext):
```typescript
  const artifactsPointer = await buildArtifactsPointer(conversationId ?? '')
  const imagesPointer = await buildImagesPointer(conversationId ?? '')
  const workingContext = [flaggedWorkingContext, templateContext, artifactsPointer, imagesPointer]
    .filter((b) => b && b.trim())
    .join('\n\n') || undefined
```

- [ ] **Step 4: Cattura a fine turno.** Dopo `const fullResponse = await callClaudeStream(...)` (riga ~223-229), aggiungi le catture best-effort (non bloccano lo stream):

```typescript
        if (conversationId) {
          captureArtifact(conversationId, fullResponse).catch(() => {})
          captureImageExtraction(conversationId, fullResponse, uploadedImageRefs).catch(() => {})
        }
```
> Mettile DOPO l'assegnazione di `fullResponse` e PRIMA che lo stream venga chiuso, oppure subito dopo — l'importante è che `fullResponse` (il testo completo) e `uploadedImageRefs` siano in scope. `captureImageExtraction` salva da sola SOLO se `uploadedImageRefs` non è vuoto.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/chat/route.ts
git commit -m "feat(chat-web): pointer immagini+bozze + cattura a fine turno (BUG1 web + chiude gap artifact-capture web)"
```

- [ ] **Step 6: Done**

`085 | codex/085-image-memory-web-wiring | web chat: buildImagesPointer+buildArtifactsPointer nel workingContext + captureImageExtraction+captureArtifact a fine turno + raccolta uploadedImageRefs | files: src/app/api/chat/route.ts`

---

## INCREMENT 1b — Wiring Telegram (queue 086, dopo merge 1)

### Task 086 — Wiring path Telegram

**Files:**
- Modify: `src/lib/agent-job.ts`
- Modify: `src/app/api/telegram/route.ts`

**Branch:** `codex/086-image-memory-telegram-wiring`.

- [ ] **Step 1: Estendi `AgentJobInput`** in `src/lib/agent-job.ts`: aggiungi il campo opzionale `uploadedImages?: UploadedImageRef[]` al tipo/interfaccia `AgentJobInput` (cerca `type AgentJobInput` o `interface AgentJobInput`). Importa il type:
```typescript
import { captureImageExtraction, buildImagesPointer, type UploadedImageRef } from '@/lib/image-memory'
```

- [ ] **Step 2: Inietta il pointer immagini (INCONDIZIONATO).** Nel merge del workingContext (righe 110-112) aggiungi `buildImagesPointer` accanto a `templateContext` (NON dentro il blocco flag-gated 97-103):

Prima:
```typescript
  const workingContext = [flaggedWorkingContext, templateContext]
    .filter((b) => b && b.trim())
    .join('\n\n') || undefined
```
Dopo:
```typescript
  const imagesPointer = await buildImagesPointer(conversationId)
  const workingContext = [flaggedWorkingContext, templateContext, imagesPointer]
    .filter((b) => b && b.trim())
    .join('\n\n') || undefined
```

- [ ] **Step 3: Cattura a fine turno.** Accanto alla riga 196 `captureArtifact(conversationId, finalText).catch(() => {})` aggiungi:
```typescript
  captureImageExtraction(conversationId, finalText, input.uploadedImages ?? []).catch(() => {})
```

- [ ] **Step 4: Passa i ref dal route Telegram.** In `src/app/api/telegram/route.ts`: il sito di ingest è alla riga ~161-162 (`const [rec] = await ingestPhotoUpload({...})`). Leggi le righe ~150-200 per capire come il turno raccoglie le foto (singola o media-group), e COLLEZIONA tutti i `FotoIngestRecord` del turno in un array `turnImageRefs: { driveFileId; filename; driveUrl }[]`. Poi, nella chiamata a `runAgentJob({...})` (riga ~668), aggiungi il campo:
```typescript
            uploadedImages: turnImageRefs,
```
> Se la struttura del route rende difficile collezionare TUTTI i ref (es. foto gestite una per messaggio), passa almeno il/i ref disponibili nel turno corrente; il fix degrada con grazia: senza ref `captureImageExtraction` non salva (ok), il pointer continua a funzionare per i turni in cui i ref ci sono. Dichiara nel done.log come hai raccolto i ref.

- [ ] **Step 5: Commit**
```bash
git add src/lib/agent-job.ts src/app/api/telegram/route.ts
git commit -m "feat(telegram): memoria immagini (pointer incondizionato + cattura a fine turno con ref Drive)"
```

- [ ] **Step 6: Done**
`086 | codex/086-image-memory-telegram-wiring | telegram: buildImagesPointer incondizionato + captureImageExtraction a fine turno + threading uploadedImages da route a runAgentJob | files: src/lib/agent-job.ts, src/app/api/telegram/route.ts`

---

## INCREMENT 2 — Re-attach pixel on-demand (DOPO Increment 1, spec separata)

Tool `rivedi_immagine(filename | drive_file_id)` → `downloadFileBase64(fileId)` (esiste già, `src/lib/drive.ts:291`, guard 20MB) → ritorna un blocco `type:'image'` al modello, per quando serve RIVEDERE i pixel (es. ricontrollare una cifra letta male). Richiede: nuovo modulo tool + registrazione nel registry tool (`src/lib/tools.ts` — `ALL_TOOLS`/`EXECUTORS`) + regola di prompt. **Da dettagliare in un task spec separato dopo aver letto `src/lib/tools.ts`** (il wiring del registry è intricato e va visto sul codice). NON parte di questo piano finché Increment 1 non è live e verificato.

---

## Self-Review (eseguita)

1. **Spec coverage:** BUG1 (immagini non ricordate) → Task 084 (persistenza) + 085/086 (ri-iniezione su web+TG). BUG2/3 (estrazione incompleta + allucinazione ID) → mitigati dal pointer che ri-inietta i dati estratti + istruzione "non re-inventare, chiedi". Gamba "ri-aggancio pixel" → Increment 2. BUG4 (500) → task 083 separata (in corso Codex). BUG5 (force-action web) → fuori scope (task separata futura, nota nel memory 12giu).
2. **Placeholder scan:** nessun TODO/TBD nei task attivi (084/085/086 hanno codice completo). Increment 2 è marcato esplicitamente come spec futura, non placeholder in-task.
3. **Type consistency:** `UploadedImageRef { driveFileId; filename; driveUrl? }` definito in 084, usato identico in 085 (map da `FotoIngestRecord` che ha `driveFileId/filename/driveUrl`) e 086 (`AgentJobInput.uploadedImages`). `captureImageExtraction(conversationId, assistantText, images)` e `buildImagesPointer(conversationId)` firme coerenti tra modulo e call-site. `documents` type `'image-extraction'` coerente tra capture e pointer.

## Note di rischio per la review/audit Claude
- **Incondizionato vs flag:** verificare che 085/086 NON re-introducano il gate `isWorkingMemoryEnabled` sui pointer immagini (sarebbe inerte in prod).
- **Costo token:** il pointer ri-inietta l'estratto (max 600 char × 8 voci = ~4.8K char ≈ 1.5K token) ogni turno per 24h. Accettabile; se troppo, ridurre `POINTER_MAX_ENTRIES`/`EXTRACTION_EXCERPT_MAXLEN`. Sta DOPO il cache breakpoint statico (blocco non-cachato) → nessun danno alla cache.
- **`documents` overload:** type `image-extraction` è distinto da `auto-bozza`; `ritrova_bozza`/`buildArtifactsPointer` filtrano per type, quindi non si mescolano. Verificare che nessuna query draft prenda `image-extraction` per sbaglio.
- **Privacy:** le righe `image-extraction` ereditano la RLS di `documents` (già hardenata). OK.
