# Fase 1 — Riparazione streaming Telegram + Trigger.dev v3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Riparare lo streaming Telegram rotto in V10 (bug: thinking budget 100k → kill function) e introdurre Trigger.dev v3 come orchestratore di task durable lunghi (>2 min), con classificazione automatica veloce/lungo, heartbeat di progresso, e fallback robusti.

**Architecture:** Webhook Telegram (Vercel Function `/api/telegram`) classifica il task. Veloce (<2 min) resta `waitUntil()` con stream `text_delta` + `thinking_delta` e budget thinking ridotto a 8k Opus / 4k Sonnet. Lungo (>2 min, es. POS/preventivo completo) viene triggerato come `cervelloneLongTask` su Trigger.dev v3 con context isolato, durata fino a 1h, heartbeat ogni 5s su Telegram via `editMessageText`.

**Tech Stack:** Next.js 16, TypeScript 5, Anthropic SDK ^0.80, Vercel Functions (`waitUntil`), Trigger.dev v3 (`@trigger.dev/sdk`), Vitest (nuovo, solo unit test logica pura), Playwright (esistente, smoke test).

**Spec di riferimento:** `docs/superpowers/specs/2026-05-01-fase1-riparazione-trigger-dev-design.md`
**Visione completa:** `docs/superpowers/specs/2026-05-01-cervellone-vision-prodotto.md`

---

## File Structure

| File | Tipo | Responsabilità |
|------|------|---------------|
| `src/lib/claude.ts` | modifica | Fix streaming: handle `thinking_delta`, riduce budget, await edit finali |
| `src/lib/task-classifier.ts` | nuovo | Classificazione veloce/lungo per task |
| `src/lib/task-classifier.test.ts` | nuovo | Unit test classificatore |
| `src/lib/telegram-helpers.ts` | modifica | Aggiunge `sendHeartbeatToTelegram` |
| `src/app/api/telegram/route.ts` | modifica | Refactor con classificazione + dispatch |
| `trigger.config.ts` | nuovo | Config Trigger.dev v3 base |
| `trigger/cervellone-long-task.ts` | nuovo | Task durable per lavori lunghi |
| `vitest.config.ts` | nuovo | Config Vitest per unit test |
| `package.json` | modifica | Aggiungi `@trigger.dev/sdk`, `vitest`, scripts test |
| `.env.local` + Vercel env | modifica | `TRIGGER_API_KEY`, `TRIGGER_PROJECT_REF` |

---

### Task 0: Setup worktree e branch

**Files:**
- Working directory: `C:/Progetti claude Code/02.SuperING/cervellone-w1` (worktree)

- [ ] **Step 1: Creare worktree dedicato per W1**

```bash
cd "C:/Progetti claude Code/02.SuperING/cervellone"
git worktree add "../cervellone-w1" -b fase1-trigger-dev
```

- [ ] **Step 2: Verificare lo stato pulito**

```bash
cd "C:/Progetti claude Code/02.SuperING/cervellone-w1"
git status
```

Expected: `On branch fase1-trigger-dev. Your branch is up to date... nothing to commit, working tree clean.`

- [ ] **Step 3: Installare dipendenze esistenti**

```bash
npm install
```

Expected: install senza errori.

---

### Task 1: Setup Vitest per unit test logica pura

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json` (aggiungere script `test:unit` + devDependencies)

- [ ] **Step 1: Aggiungere Vitest come devDependency**

```bash
npm install --save-dev vitest @vitest/ui
```

- [ ] **Step 2: Creare `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
})
```

- [ ] **Step 3: Aggiungere script `test:unit` a `package.json`**

Modifica la sezione `"scripts"` di `package.json`:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "eslint",
  "test": "npx playwright test",
  "test:ui": "npx playwright test --ui",
  "test:live": "TEST_BASE_URL=https://cervellone-5poc.vercel.app npx playwright test",
  "test:unit": "vitest run",
  "test:unit:watch": "vitest"
}
```

- [ ] **Step 4: Verificare che Vitest funzioni con un test stub**

Crea temporaneamente `src/lib/_smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2)
  })
})
```

Run: `npm run test:unit`
Expected: `1 passed`

- [ ] **Step 5: Eliminare il file smoke**

```bash
rm src/lib/_smoke.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "chore(W1): aggiungi Vitest per unit test logica pura"
```

---

### Task 2: Implementare task-classifier.ts (TDD pieno)

**Files:**
- Create: `src/lib/task-classifier.ts`
- Test: `src/lib/task-classifier.test.ts`

- [ ] **Step 1: Scrivere il test fallente**

Crea `src/lib/task-classifier.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifyTask } from './task-classifier'

describe('classifyTask', () => {
  it('classifica chat veloce per saluti brevi', () => {
    expect(classifyTask('ciao', [])).toBe(false)
    expect(classifyTask('come stai?', [])).toBe(false)
    expect(classifyTask('grazie', [])).toBe(false)
  })

  it('classifica chat veloce per domande brevi', () => {
    expect(classifyTask('che ore sono?', [])).toBe(false)
    expect(classifyTask('quanti cantieri attivi ho?', [])).toBe(false)
  })

  it('classifica come lungo per redazione documenti', () => {
    expect(classifyTask('redigi un POS per cantiere Rossi', [])).toBe(true)
    expect(classifyTask('prepara un preventivo completo per Bianchi', [])).toBe(true)
    expect(classifyTask('elabora la perizia tecnica', [])).toBe(true)
  })

  it('classifica come lungo per documenti tecnici specifici', () => {
    expect(classifyTask('fai il POS', [])).toBe(true)
    expect(classifyTask('serve un computo metrico estimativo', [])).toBe(true)
    expect(classifyTask('relazione di calcolo strutturale', [])).toBe(true)
    expect(classifyTask('CME e quadro economico', [])).toBe(true)
  })

  it('classifica come lungo se ci sono file > 100KB', () => {
    const bigFile = [{ type: 'document', source: { data: 'x'.repeat(150_000) } }]
    expect(classifyTask('cosa ne pensi?', bigFile)).toBe(true)
  })

  it('classifica come veloce se ci sono file piccoli', () => {
    const smallFile = [{ type: 'image', source: { data: 'x'.repeat(50_000) } }]
    expect(classifyTask('descrivi la foto', smallFile)).toBe(false)
  })

  it('case-insensitive sui keyword', () => {
    expect(classifyTask('REDIGI UN POS', [])).toBe(true)
    expect(classifyTask('Preparami un Preventivo', [])).toBe(true)
  })
})
```

- [ ] **Step 2: Run test per verificare fail**

```bash
npm run test:unit
```

Expected: `FAIL — Cannot find module './task-classifier'` (file non esiste ancora).

- [ ] **Step 3: Implementare task-classifier.ts**

Crea `src/lib/task-classifier.ts`:

```ts
const LONG_TASK_KEYWORDS: RegExp[] = [
  /\bredig\w*/i,
  /\bprepar\w*/i,
  /\belabor\w*/i,
  /\bgener\w*/i,
  /\bpreventiv\w*/i,
  /\bcomput\w*/i,
  /\bcme\b/i,
  /\bquadro\s+economic\w*/i,
  /\bsal\b/i,
  /\bpos\b/i,
  /\bperizi\w*/i,
  /\brelazion\w*/i,
  /\bpratic\w*/i,
  /\bscia\b/i,
  /\bcila\b/i,
  /\brelazione\s+di\s+calcol\w*/i,
]

const FILE_SIZE_THRESHOLD_BYTES = 100_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyTask(userText: string, fileBlocks: any[]): boolean {
  if (LONG_TASK_KEYWORDS.some((re) => re.test(userText))) return true
  if (fileBlocks.length > 0 && JSON.stringify(fileBlocks).length > FILE_SIZE_THRESHOLD_BYTES) {
    return true
  }
  return false
}
```

- [ ] **Step 4: Run test per verificare pass**

```bash
npm run test:unit
```

Expected: `7 passed`. Se uno fallisce, leggi il messaggio: probabilmente devi adattare i keyword.

- [ ] **Step 5: Commit**

```bash
git add src/lib/task-classifier.ts src/lib/task-classifier.test.ts
git commit -m "feat(W1): task-classifier per dispatch veloce/lungo"
```

---

### Task 3: Fix `callClaudeStreamTelegram` — handle thinking_delta + budget ridotto

**Files:**
- Modify: `src/lib/claude.ts` (righe 217-292: funzione `callClaudeStreamTelegram`)

- [ ] **Step 1: Leggere il blocco esistente per riferimento**

```bash
sed -n '217,292p' src/lib/claude.ts
```

Conferma di vedere il loop `for await (const event of stream)` con solo `text_delta`.

- [ ] **Step 2: Sostituire la funzione `callClaudeStreamTelegram`**

In `src/lib/claude.ts`, sostituire l'intera funzione `callClaudeStreamTelegram` (dalla riga `export async function callClaudeStreamTelegram(` fino alla `}` finale che chiude la funzione, prima del commento `// ── Helpers ──`) con:

```ts
export async function callClaudeStreamTelegram(
  request: ClaudeRequest,
  onChunk: (accumulated: string) => void | Promise<void>,
): Promise<string> {
  const { systemPrompt, userQuery, conversationId } = request

  const memoryContext = await searchMemory(userQuery).catch(() => '')
  const fullSystemPrompt = systemPrompt + memoryContext

  if (conversationId && userQuery) {
    saveMessageWithEmbedding(conversationId, 'user', userQuery).catch(() => {})
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = getToolDefinitions()
  let currentMessages = [...request.messages]
  let fullResponse = ''
  const MAX_ITERATIONS = 10

  const cfg = await getConfig()
  const isOpus = cfg.model.includes('opus')
  // FIX W1: budget thinking drasticamente ridotto.
  // V10 lasciava 100_000 = il modello pensava per minuti, function killata da Vercel a 300s
  // prima che arrivasse il primo text_delta. Ora 8k Opus / 4k Sonnet danno reasoning sufficiente
  // per la chat veloce, con margine ampio per l'output.
  const modelConfig: ModelConfig = {
    model: cfg.model,
    thinkingBudget: isOpus ? 8_000 : 4_000,
    maxTokens: isOpus ? 32_000 : 16_000,
  }
  console.log(`MODEL TG: ${modelConfig.model} thinking=${modelConfig.thinkingBudget} for "${userQuery.slice(0, 50)}"`)

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
        thinking: { type: 'enabled', budget_tokens: modelConfig.thinkingBudget },
      }))
    )

    let lastTextEdit = 0
    let lastThinkingEdit = 0
    let thinkingChars = 0

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        // Streaming testo: accumula e edit ogni 3s
        if (event.delta.type === 'text_delta') {
          fullResponse += event.delta.text
          const now = Date.now()
          if (now - lastTextEdit > 3000) {
            await onChunk(fullResponse)
            lastTextEdit = now
          }
        }
        // FIX W1: stream del thinking. Aggiorna placeholder Telegram con counter
        // così l'utente vede progresso anche durante il reasoning.
        // Solo finché non c'è ancora testo (poi il testo prevale).
        else if (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (event.delta as any).type === 'thinking_delta' && fullResponse === ''
        ) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const td = (event.delta as any).thinking
          thinkingChars += typeof td === 'string' ? td.length : 0
          const now = Date.now()
          if (now - lastThinkingEdit > 5000) {
            await onChunk(`🧠 Sto pensando... (${thinkingChars} char di reasoning)`)
            lastThinkingEdit = now
          }
        }
      }
    }

    const final = await stream.finalMessage()
    const toolBlocks = final.content.filter((b) => b.type === 'tool_use')

    if (toolBlocks.length === 0 || final.stop_reason === 'end_turn') break
    if (i > 0 && !final.content.some((b) => b.type === 'text')) break

    const toolResults = await executeToolBlocks(toolBlocks, conversationId)
    if (toolResults.length === 0) break

    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: final.content },
      { role: 'user' as const, content: toolResults },
    ]
  }

  // FIX W1: await esplicito sull'edit finale.
  // Prima era fire-and-forget: se la function moriva subito dopo, l'edit non partiva.
  await onChunk(fullResponse)

  if (conversationId && fullResponse) {
    saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
  }

  return fullResponse
}
```

Note importanti:
- Cambiata la signature: `onChunk` ora accetta `void | Promise<void>` (per `await`)
- Aggiunto `await onChunk(...)` ovunque
- Aggiunto handler `thinking_delta` con counter visivo

- [ ] **Step 3: Verificare che il TypeScript compili**

```bash
npx tsc --noEmit
```

Expected: zero errori. Se errori in `route.ts` per il tipo del callback `onChunk`, ci pensa il Task 5.

- [ ] **Step 4: Commit**

```bash
git add src/lib/claude.ts
git commit -m "fix(W1): thinking_delta + budget ridotto in callClaudeStreamTelegram"
```

---

### Task 4: Fix `callClaude` (Telegram non-streaming) e `callClaudeStream` (web)

**Files:**
- Modify: `src/lib/claude.ts` (`callClaude` righe ~149-215, `callClaudeStream` righe ~71-145)

- [ ] **Step 1: Sostituire il blocco modelConfig in `callClaude`**

In `callClaude` (Telegram non-streaming), trovare il blocco:

```ts
const modelConfig: ModelConfig = {
  model: cfg.model,
  thinkingBudget: isOpus ? 100_000 : 10_000,
  maxTokens: isOpus ? 128_000 : 32_000,
}
```

Sostituire con:

```ts
const modelConfig: ModelConfig = {
  model: cfg.model,
  thinkingBudget: isOpus ? 8_000 : 4_000,
  maxTokens: isOpus ? 32_000 : 16_000,
}
```

- [ ] **Step 2: Sostituire il blocco modelConfig in `callClaudeStream`**

In `callClaudeStream` (chat web), stesso blocco:

```ts
const modelConfig: ModelConfig = {
  model: cfg.model,
  thinkingBudget: isOpus ? 100_000 : 10_000,
  maxTokens: isOpus ? 128_000 : 32_000,
}
```

Sostituire con:

```ts
const modelConfig: ModelConfig = {
  model: cfg.model,
  thinkingBudget: isOpus ? 8_000 : 4_000,
  maxTokens: isOpus ? 32_000 : 16_000,
}
```

**Nota:** per task lunghi web (es. POS via interfaccia browser) verrà gestito con dispatch a Trigger.dev nei task successivi. Per ora il web fa chat veloce come Telegram.

- [ ] **Step 3: Verificare TypeScript**

```bash
npx tsc --noEmit
```

Expected: zero errori.

- [ ] **Step 4: Commit**

```bash
git add src/lib/claude.ts
git commit -m "fix(W1): allinea thinking budget anche su callClaude e callClaudeStream"
```

---

### Task 5: Aggiornare il chiamante in `route.ts` per supportare `await onChunk`

**Files:**
- Modify: `src/app/api/telegram/route.ts` (callback dentro `bgProcess`)

- [ ] **Step 1: Verificare la signature del callback attuale**

In `src/app/api/telegram/route.ts`, cercare il blocco `await callClaudeStreamTelegram(`. Il callback attuale è:

```ts
(accumulated) => {
  if (!currentMsgId) return
  const preview = accumulated.slice(0, 4000)
  if (preview === lastEditText) return
  lastEditText = preview
  editTelegramMessage(chatId, currentMsgId, preview)
}
```

- [ ] **Step 2: Sostituire il callback con versione async + await**

Sostituire l'intero blocco precedente con:

```ts
async (accumulated) => {
  if (!currentMsgId) return
  const preview = accumulated.slice(0, 4000)
  if (preview === lastEditText) return
  lastEditText = preview
  await editTelegramMessage(chatId, currentMsgId, preview)
}
```

- [ ] **Step 3: Verificare TypeScript**

```bash
npx tsc --noEmit
```

Expected: zero errori.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/telegram/route.ts
git commit -m "fix(W1): await edit su callback streaming Telegram"
```

---

### Task 6: Setup Trigger.dev v3 — account, SDK, config

**Files:**
- Modify: `package.json`
- Create: `trigger.config.ts`
- Modify: `.env.local` (creare se non esiste)

- [ ] **Step 1: Creare account Trigger.dev e progetto** (manuale)

Sul browser:
1. Vai su https://trigger.dev e registrati con l'account GitHub di Rafflentini
2. Crea un nuovo progetto chiamato `cervellone-prod`
3. Copia il `Project Reference` (formato `proj_abcd1234...`) — servirà a breve
4. Vai in Settings → API Keys e crea una **Server API Key** (la chiave server-side per dev e prod). Copiala.

- [ ] **Step 2: Aggiungere il Trigger.dev SDK come dipendenza**

```bash
npm install @trigger.dev/sdk@latest
```

- [ ] **Step 3: Aggiungere variabili a `.env.local`**

Modificare/creare `.env.local` aggiungendo:

```
TRIGGER_API_KEY=tr_dev_xxxxxxxxxxxxxxxx
TRIGGER_PROJECT_REF=proj_xxxxxxxxxxxxxxxx
```

(Sostituire con i valori reali copiati dal browser.)

- [ ] **Step 4: Aggiungere lo stesso su Vercel**

Sul browser:
1. Vai sul dashboard Vercel del progetto `cervellone-5poc` (team `team_QOxzPu6kcaxY8Jdc45arGmgL`)
2. Settings → Environment Variables
3. Aggiungi `TRIGGER_API_KEY` per environment `Production`, `Preview`, `Development`
4. Aggiungi `TRIGGER_PROJECT_REF` per gli stessi environment

- [ ] **Step 5: Creare `trigger.config.ts` nella root**

```ts
import { defineConfig } from '@trigger.dev/sdk/v3'

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  runtime: 'node',
  logLevel: 'log',
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 2,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  dirs: ['./trigger'],
})
```

- [ ] **Step 6: Aggiornare `.gitignore`**

Verificare che `.env.local` sia già in `.gitignore`. Se no:

```bash
echo ".env.local" >> .gitignore
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json trigger.config.ts .gitignore
git commit -m "chore(W1): setup Trigger.dev v3 (SDK + config)"
```

---

### Task 7: Definire il task durable `cervellone.long-task`

**Files:**
- Create: `trigger/cervellone-long-task.ts`

- [ ] **Step 1: Creare la cartella trigger e il file task**

```bash
mkdir -p trigger
```

- [ ] **Step 2: Creare `trigger/cervellone-long-task.ts`**

```ts
import { task, metadata } from '@trigger.dev/sdk/v3'
import { callClaudeStreamTelegram } from '@/lib/claude'
import { editTelegramMessage, sendTelegramMessage } from '@/lib/telegram-helpers'
import { parseDocumentBlocks } from '@/lib/parseDocumentBlocks'
import { supabase } from '@/lib/supabase'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMessage = { role: string; content: any }

interface CervelloneLongTaskPayload {
  conversationId: string
  chatId: number
  placeholderMsgId: number | null
  userQuery: string
  history: AnyMessage[]
  systemPrompt: string
  fileDescription?: string
}

export const cervelloneLongTask = task({
  id: 'cervellone.long-task',
  maxDuration: 60 * 60, // 1 ora hard cap
  retry: { maxAttempts: 2 },
  run: async (payload: CervelloneLongTaskPayload) => {
    const { conversationId, chatId, placeholderMsgId, userQuery, history, systemPrompt } = payload

    metadata.set('status', 'avvio elaborazione')
    let lastEditText = ''

    const fullResponse = await callClaudeStreamTelegram(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: history as any,
        systemPrompt,
        userQuery,
        conversationId,
      },
      async (accumulated) => {
        metadata.set('progress_chars', accumulated.length)
        if (!placeholderMsgId) return
        const preview = accumulated.slice(0, 4000)
        if (preview === lastEditText) return
        lastEditText = preview
        await editTelegramMessage(chatId, placeholderMsgId, preview)
      },
    )

    metadata.set('status', 'invio risposta finale')

    // Parsing documenti generati e invio finale
    const responseBlocks = parseDocumentBlocks(fullResponse)
    const textParts: string[] = []

    for (const block of responseBlocks) {
      if (block.type === 'document') {
        const titleMatch = block.content.match(/<h1[^>]*>(.*?)<\/h1>/i)
        const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'Documento'

        const { data: savedDoc } = await supabase
          .from('documents')
          .insert({
            name: title,
            content: block.content,
            conversation_id: conversationId,
            type: 'html',
            metadata: { source: 'telegram_long_task' },
          })
          .select('id')
          .single()

        const docUrl = savedDoc?.id
          ? `https://cervellone-5poc.vercel.app/doc/${savedDoc.id}`
          : 'https://cervellone-5poc.vercel.app'

        textParts.push(`📄 *${title}*\n👉 ${docUrl}`)
      } else if (block.content.trim()) {
        textParts.push(block.content)
      }
    }

    const finalText = textParts.join('\n\n') || fullResponse

    if (placeholderMsgId) {
      if (finalText.length <= 4000) {
        await editTelegramMessage(chatId, placeholderMsgId, finalText)
      } else {
        await editTelegramMessage(chatId, placeholderMsgId, finalText.slice(0, 4000))
        const remaining = finalText.slice(4000)
        if (remaining.trim()) await sendTelegramMessage(chatId, remaining)
      }
    } else {
      await sendTelegramMessage(chatId, finalText)
    }

    return { ok: true, length: fullResponse.length }
  },
})
```

- [ ] **Step 3: Verificare TypeScript**

```bash
npx tsc --noEmit
```

Expected: zero errori. Se ci sono errori sui path `@/lib/...`, verifica `tsconfig.json` ha l'alias.

- [ ] **Step 4: Commit**

```bash
git add trigger/cervellone-long-task.ts
git commit -m "feat(W1): cervellone.long-task durable workflow"
```

---

### Task 8: Aggiungere `sendHeartbeatToTelegram` helper (opzionale ma utile per altre integrazioni)

**Files:**
- Modify: `src/lib/telegram-helpers.ts`

- [ ] **Step 1: Aggiungere il helper alla fine di `src/lib/telegram-helpers.ts`**

Aggiungere prima dell'ultima `}` del file (o in append):

```ts
/**
 * Helper unificato per heartbeat su task lunghi durable.
 * Aggiorna il placeholder iniziale via editMessageText.
 * Stessa logica di editTelegramMessage ma con nome semantico.
 */
export async function sendHeartbeatToTelegram(
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  await editTelegramMessage(chatId, messageId, text)
}
```

- [ ] **Step 2: Verificare TypeScript**

```bash
npx tsc --noEmit
```

Expected: zero errori.

- [ ] **Step 3: Commit**

```bash
git add src/lib/telegram-helpers.ts
git commit -m "feat(W1): sendHeartbeatToTelegram helper"
```

---

### Task 9: Refactor `route.ts` con classificazione e dispatch

**Files:**
- Modify: `src/app/api/telegram/route.ts` (blocco `// ── Claude (ASINCRONO)` ~righe 251-332)

- [ ] **Step 1: Aggiungere import in cima al file**

In `src/app/api/telegram/route.ts`, aggiungere agli import (dopo gli import esistenti):

```ts
import { tasks } from '@trigger.dev/sdk/v3'
import { classifyTask } from '@/lib/task-classifier'
import type { cervelloneLongTask } from '../../../../trigger/cervellone-long-task'
```

Verifica che il path `../../../../trigger/cervellone-long-task` sia corretto rispetto alla posizione di `route.ts`. Se preferisci usare l'alias `@/`, configura tsconfig per esporre la directory `trigger/` (di solito non lo è — meglio relative path).

- [ ] **Step 2: Sostituire il blocco `bgProcess` + `waitUntil` con classificazione**

Localizza nel file il blocco che inizia con `// ── Claude (ASINCRONO) — risponde subito, elabora in background ──` e termina alla riga `return NextResponse.json({ ok: true })` (dopo `waitUntil(bgProcess())`).

Sostituire l'intero blocco con:

```ts
// ── Classifica task: veloce vs durable ──
const isLongTask = classifyTask(userText, fileBlocks)

if (isLongTask) {
  // ── Path lungo: Trigger.dev durable workflow ──
  const placeholderMsgId = await sendTelegramMessageWithId(
    chatId,
    '🛠️ Avvio elaborazione lunga... Le invio aggiornamenti durante il lavoro.',
  )

  try {
    await tasks.trigger<typeof cervelloneLongTask>('cervellone.long-task', {
      conversationId,
      chatId,
      placeholderMsgId,
      userQuery: userText,
      history,
      systemPrompt: await getTelegramSystemPrompt(userText),
      fileDescription,
    })
  } catch (err) {
    console.error('TRIGGER.DEV trigger failed, fallback to in-process:', err)
    // Fallback: se Trigger.dev down, esegui in-process come prima (max 300s)
    await sendTelegramMessage(
      chatId,
      '⚠️ Modalità degradata: lavoro in corso ma con limite 5 min.',
    )
    waitUntil(bgProcess())
  }

  if (typingInterval) {
    clearInterval(typingInterval)
    typingInterval = null
  }
  return NextResponse.json({ ok: true })
}

// ── Path veloce: bgProcess in waitUntil (logica esistente) ──
waitUntil(bgProcess())
return NextResponse.json({ ok: true })
```

**Importante:** la funzione `bgProcess()` deve restare definita **PRIMA** di questo blocco, altrimenti `waitUntil(bgProcess())` non la trova. Se nel codice attuale `bgProcess` è definita inline subito prima di `waitUntil`, è OK. Verificare scorrendo il file.

- [ ] **Step 3: Verificare TypeScript**

```bash
npx tsc --noEmit
```

Expected: zero errori. Possibile issue: tipo di `cervelloneLongTask` non importabile lato Vercel Functions perché il file `trigger/` è separato. Se TS si lamenta, sostituire `<typeof cervelloneLongTask>` con `<any>` temporaneamente:

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
await tasks.trigger<any>('cervellone.long-task', { ... })
```

- [ ] **Step 4: Lint check**

```bash
npm run lint
```

Expected: zero errori. Eventuali warning su `any` sono accettabili per ora.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/telegram/route.ts
git commit -m "feat(W1): dispatch veloce/durable in route.ts via task-classifier"
```

---

### Task 10: Smoke test locale unit

**Files:**
- Verifica: tutti i file modificati/creati

- [ ] **Step 1: Run unit tests**

```bash
npm run test:unit
```

Expected: `passed` per tutti i test del task-classifier.

- [ ] **Step 2: Build production locale**

```bash
npm run build
```

Expected: build completata senza errori. Se errori, leggi e correggi.

- [ ] **Step 3: Lint completo**

```bash
npm run lint
```

Expected: zero errori, warning accettabili se non legati ai file modificati.

- [ ] **Step 4: Verifica dev server avvia**

NB: l'utente avvia manualmente il dev server (limite shell). Dirgli:

> "Apri PowerShell, cd nella worktree `C:/Progetti claude Code/02.SuperING/cervellone-w1`, esegui `npm run dev`. Verifica che parta su http://localhost:3000 senza errori in console."

Wait per conferma utente.

---

### Task 11: Deploy preview Vercel + test in preview

**Files:**
- Branch: `fase1-trigger-dev`

- [ ] **Step 1: Push branch su GitHub**

```bash
git push -u origin fase1-trigger-dev
```

Expected: branch pubblicato. Vercel rileva automaticamente e crea un preview deployment.

- [ ] **Step 2: Trovare l'URL del preview**

```bash
gh pr create --title "Fase 1: Riparazione Telegram + Trigger.dev v3" --body "$(cat <<'EOF'
## Summary
- Fix bug streaming Telegram V10 (thinking budget 100k → kill function)
- Riduzione thinking budget a 8k Opus / 4k Sonnet
- Handling thinking_delta con feedback visivo durante reasoning
- Setup Trigger.dev v3 per task durable >2 min
- Classificazione automatica veloce/lungo via task-classifier

## Test plan
- [ ] Telegram: "ciao" → risposta veloce con streaming visibile
- [ ] Telegram: "redigi un POS per cantiere Test" → trigger durable, heartbeat ogni 5-10s, documento finale con URL
- [ ] Dashboard Trigger.dev: task appare e mostra step
- [ ] Web chat: domanda normale → risposta streaming
- [ ] Test fallback: simula Trigger.dev down → vedi messaggio degradato

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Restituirà URL della PR. Da quella pagina si vede il link al preview deployment.

- [ ] **Step 3: Aggiungere TRIGGER_API_KEY e TRIGGER_PROJECT_REF al preview environment Vercel**

Già fatto al Task 6 step 4. Verificare che siano impostate per `Preview`.

- [ ] **Step 4: Deployare il task durable a Trigger.dev** (dev environment)

```bash
npx trigger.dev@latest deploy --env=dev
```

Expected: task `cervellone.long-task` deployato. Output mostra l'URL dashboard.

- [ ] **Step 5: Smoke test preview Telegram (manuale)**

Configurare temporaneamente il webhook Telegram al preview URL:

```bash
# Prendi BOT_TOKEN da .env.local o Vercel
TG_TOKEN="il_tuo_bot_token"
PREVIEW_URL="https://cervellone-w1-fase1-trigger-dev.vercel.app"  # o quello che ti dà Vercel

curl -X POST "https://api.telegram.org/bot$TG_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$PREVIEW_URL/api/telegram\",\"secret_token\":\"$TELEGRAM_WEBHOOK_SECRET\"}"
```

Da Telegram, dal proprio account autorizzato:
1. Inviare "ciao" → atteso: risposta veloce con streaming text_delta
2. Inviare "che ore sono?" → atteso: risposta veloce
3. Inviare "redigi un POS per cantiere Test in Marsicovetere" → atteso:
   - Risposta immediata: "🛠️ Avvio elaborazione lunga..."
   - Heartbeat ogni 5-10s con counter thinking
   - Risposta finale con URL documento
4. Verificare dashboard Trigger.dev: il task `cervellone.long-task` dev environment mostra il run come `completed`

- [ ] **Step 6: Smoke test Web (manuale)**

Aprire il preview URL in browser, login con `Raffaele2026!`, inviare un messaggio normale. Atteso: streaming visibile.

- [ ] **Step 7: Riportare il webhook Telegram alla produzione (importante!)**

```bash
PROD_URL="https://cervellone-5poc.vercel.app"
curl -X POST "https://api.telegram.org/bot$TG_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$PROD_URL/api/telegram\",\"secret_token\":\"$TELEGRAM_WEBHOOK_SECRET\"}"
```

Anche se al momento la prod è rotta, lasciamola sul webhook prod. La merge a main farà ripartire la prod sana.

---

### Task 12: Merge a main + deploy produzione + smoke test live

**Files:**
- Branch: merge `fase1-trigger-dev` → `main`

- [ ] **Step 1: Approvare la PR e mergiare**

Via GitHub UI o:

```bash
gh pr merge fase1-trigger-dev --squash --subject "feat(W1): Fase 1 — Riparazione Telegram + Trigger.dev v3"
```

Vercel deploya automaticamente la nuova `main` su prod.

- [ ] **Step 2: Deployare il task Trigger.dev su environment prod**

```bash
npx trigger.dev@latest deploy --env=prod
```

Expected: task deployato anche in prod environment.

- [ ] **Step 3: Smoke test produzione Telegram**

Da Telegram:
1. "ciao" → risposta veloce
2. "redigi un POS per Test" → durable workflow + URL finale
3. Verifica dashboard Trigger.dev prod environment

- [ ] **Step 4: Smoke test produzione Web**

`https://cervellone-5poc.vercel.app` — login + messaggio normale.

- [ ] **Step 5: Verificare log Vercel** (assenza errori)

Tramite plugin Vercel o:

```
mcp_vercel get_runtime_logs project=cervellone-5poc since=10m
```

Expected: vedere `MODEL TG: claude-opus-... thinking=8000 for "..."` (era 100k = problema). Nessun timeout silenzioso.

- [ ] **Step 6: Cleanup worktree**

```bash
cd "C:/Progetti claude Code/02.SuperING/cervellone"
git worktree remove "../cervellone-w1"
```

---

### Task 13: Aggiornare memoria + roadmap

**Files:**
- Modify: `C:/Users/Raffaele/.claude/projects/C--Progetti-claude-Code/memory/cervellone-roadmap.md`
- Modify: `C:/Users/Raffaele/.claude/projects/C--Progetti-claude-Code/memory/cervellone-progetto.md`

- [ ] **Step 1: Aggiornare `cervellone-roadmap.md` per marcare W1 come completato**

In `memory/cervellone-roadmap.md`, sostituire la sezione "🚧 Fase 1 — W1" con "✅ Completato — W1 (data effettiva di chiusura)".

- [ ] **Step 2: Aggiornare `cervellone-progetto.md`**

Aggiungere nota allo "Stato": "Telegram operativo. Trigger.dev v3 attivo. Bug V10 risolto. Pronto per W2 (cron schedulati)."

- [ ] **Step 3: Aggiornare `MEMORY.md` se necessario** (di solito no)

Verificare che i pointer puntino ancora ai file giusti. Nessuna modifica strutturale.

- [ ] **Step 4: Aggiornare task list**

Marcare le task #5 (cap costi Anthropic) e #6 (backup Supabase) come `pending` ancora ma da affrontare in W2 setup.

Marcare task #8 (Implementazione W1) come `completed`.

---

## Self-Review (al termine della scrittura plan)

**Spec coverage:**
- ✅ Fix streaming Telegram (thinking_delta + budget) → Task 3, 4, 5
- ✅ Setup Trigger.dev v3 → Task 6
- ✅ Definizione task durable → Task 7
- ✅ Helper Telegram heartbeat → Task 8
- ✅ Classificazione veloce/lungo → Task 2
- ✅ Refactor route.ts dispatch → Task 9
- ✅ Smoke test locale + preview + prod → Task 10, 11, 12
- ✅ Aggiornamento memoria → Task 13

**Placeholder scan:** nessun TBD/TODO. Codice completo in ogni step. Comandi esatti.

**Type consistency:** `classifyTask(userText: string, fileBlocks: any[]): boolean` coerente in test e implementazione. `cervelloneLongTask` payload type definito una volta in `cervellone-long-task.ts` e referenziato in `route.ts`.

**Risks identified:**
- Trigger.dev SDK + Next.js 16 compatibility — mitigato da fallback in-process se trigger() lancia
- Task TypeScript import paths cross-directory — mitigato con `<any>` fallback se TS si lamenta

---

## Execution Handoff

**Plan completo e salvato in `docs/superpowers/plans/2026-05-01-fase1-riparazione-trigger-dev.md`. Due opzioni di esecuzione:**

**1. Subagent-Driven (raccomandato)** — Dispatch fresh subagent per task, review tra task, iterazione rapida. Sub-skill: `superpowers:subagent-driven-development`.

**2. Inline Execution** — Esegui task in questa sessione con `superpowers:executing-plans`, batch execution con checkpoint per review.

**Quale approccio?**
