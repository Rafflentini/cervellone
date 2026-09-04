# Ottimizzazione Costi API — Default Sonnet + Guard Rails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tagliare il run-rate API Anthropic da ~$12/giorno a ≤$2/giorno: default Sonnet 4.6 (Opus solo on-demand via `/opus`), routing Haiku per chat semplici, hard cap token per run, troncamento tool result, caching incrementale nel tool-loop, finestra contesto ridotta.

**Architecture:** Il modello di default vive in Supabase `cervellone_config` (chiavi `model_default`, `model_subagent_mail`, `model_active`) con fallback hardcoded nel codice. Si cambiano ENTRAMBI (DB subito = sollievo immediato, fallback codice = coerenza). I guard rail si agganciano ai 3 loop V18 in `src/lib/claude.ts` (`callClaudeStream`, `callClaude`, `callClaudeStreamTelegram`) e al loop V19 `src/v19/agent/loop.ts`. Helper nuovi in file separati testabili con Vitest.

**Tech Stack:** Next.js (Turbopack), TypeScript, @anthropic-ai/sdk, Supabase, Vitest.

**Contesto verificato (5 giu 2026):**
- Prompt caching sul prefisso tools+system: **GIÀ ATTIVO** (`buildCachedSystem`, claude.ts:314-323, commit 7ecd615). I campi `cache_read_tokens`/`cache_creation_tokens` sono **già loggati** in `api_usage` (api-usage.ts:87-88). Il punto #2 della task spec è quindi già soddisfatto lato codice → resta solo la verifica post-deploy.
- Canary cron: chiama il modello **solo in stato ROLLED_BACK** (canary/route.ts:30-33) → nessuno spreco, nessuna modifica.
- History Telegram: già limitata a 6 messaggi (telegram/route.ts:483-497). La web chat usa `trimMessages` con finestra 500K char → da ridurre.
- Durable: `should-use-durable.ts` fail-closed su `false`. **NON toccare** (resta OFF).
- `/opus` e `/sonnet` (telegram/route.ts:248-255) restano l'escape hatch esplicito per Opus.

---

### Task 1: Switch DB config → Sonnet (sollievo immediato, prima del codice)

**Files:** nessun file di codice — SQL su Supabase (progetto Cervellone, tabella `cervellone_config`).

- [ ] **Step 1: Eseguire l'UPDATE config** (via Supabase MCP `execute_sql`, oppure SQL Editor se MCP non autenticato)

```sql
-- valori jsonb: stringhe JSON-quoted come scrive il client supabase-js.
-- upsert: alcune chiavi potrebbero non esistere ancora (es. il flag routing).
INSERT INTO cervellone_config (key, value) VALUES
  ('model_default',              to_jsonb('claude-sonnet-4-6'::text)),
  ('model_subagent_mail',        to_jsonb('claude-sonnet-4-6'::text)),
  ('model_active',               to_jsonb('claude-sonnet-4-6'::text)),
  -- routing chat semplici → modello economico (Task 3 cambia CHEAP_MODEL in Haiku;
  -- finché non è deployato, il flag ON instrada su Sonnet = innocuo perché Sonnet è già il default)
  ('cheap_chat_routing_enabled', to_jsonb('true'::text))
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

(Se la tabella non ha vincolo unique su `key`, usare 4 UPDATE singoli e verificare le righe toccate.)

- [ ] **Step 2: Verificare i valori e il flag durable**

```sql
SELECT key, value FROM cervellone_config
WHERE key IN ('model_default','model_subagent_mail','model_active','cheap_chat_routing_enabled','durable_workflows_enabled','circuit_state');
```

Expected: i 3 model = `"claude-sonnet-4-6"`, routing = `"true"`, `durable_workflows_enabled` = `"false"` (se diverso → segnalare, NON cambiare durable in questa iterazione). Se `circuit_state.state` ≠ `NORMAL`, segnalarlo (il breaker potrebbe rimettere un altro modello).

**Nota cache config:** `getConfig()` ha TTL 60s e `getActiveModel()` 60s — entro 1-2 minuti il prod usa Sonnet senza deploy.

---

### Task 2: Fallback hardcoded Opus → Sonnet nel codice

**Files:**
- Modify: `src/lib/claude.ts:241-242`
- Modify: `src/lib/circuit-breaker.ts:100,132`
- Modify: `src/app/api/cron/canary/route.ts:42`

- [ ] **Step 1: claude.ts — fallback getConfig**

```ts
// PRIMA (riga 241-242)
  let model = 'claude-opus-4-7'
  let modelSubagentMail = 'claude-opus-4-7'
// DOPO — cost-control 5 giu 2026: default Sonnet, Opus solo on-demand via /opus
  let model = 'claude-sonnet-4-6'
  let modelSubagentMail = 'claude-sonnet-4-6'
```

- [ ] **Step 2: circuit-breaker.ts — fallback model_active**

```ts
// riga 100, in loadConfig():  PRIMA
  let activeModel = 'claude-opus-4-8'
// DOPO
  let activeModel = 'claude-sonnet-4-6'

// riga 132, in getActiveModel():  PRIMA
  return 'claude-opus-4-7'
// DOPO
  return 'claude-sonnet-4-6'
```

- [ ] **Step 3: canary route — fallback model_default**

```ts
// riga 40-42:  PRIMA
  const defaultModel = defaultRow?.value
    ? String(defaultRow.value).replace(/"/g, '')
    : 'claude-opus-4-8'
// DOPO
  const defaultModel = defaultRow?.value
    ? String(defaultRow.value).replace(/"/g, '')
    : 'claude-sonnet-4-6'
```

- [ ] **Step 4: Verifica — nessun fallback Opus residuo nel path di default**

Run: `npx grep` non serve — usare: `rg -n "claude-opus" src/ --type ts`
Expected: restano SOLO occorrenze legittime (comando `/opus` in telegram/route.ts, pattern legacy `LEGACY_THINKING_PATTERN`, pricing in api-usage.ts, eventuali commenti). Nessun fallback di default.

- [ ] **Step 5: Commit**

```bash
git add src/lib/claude.ts src/lib/circuit-breaker.ts src/app/api/cron/canary/route.ts
git commit -m "feat(cost): default model Sonnet 4.6 — fallback codice allineati al config DB"
```

---

### Task 3: CHEAP_MODEL → Haiku 4.5 (routing chat semplici)

**Files:**
- Modify: `src/lib/cheap-routing.ts:4-5` (+ commenti righe 8-16, 37)

- [ ] **Step 1: Cambiare il modello economico**

```ts
// PRIMA
/** Modello economico usato per le chat semplici quando il routing è attivo. */
export const CHEAP_MODEL = 'claude-sonnet-4-6'
// DOPO
/** Modello economico usato per le chat semplici quando il routing è attivo.
 *  Cost-control 5 giu 2026: con default=Sonnet, le chat semplici scalano su Haiku. */
export const CHEAP_MODEL = 'claude-haiku-4-5'
```

Aggiornare anche i commenti che dicono "richiedono Opus" → "richiedono il modello di default" (righe 12-16 e 37-40): la semantica ora è default-vs-economico, non Opus-vs-Sonnet.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (nessun errore nuovo)

- [ ] **Step 3: Commit**

```bash
git add src/lib/cheap-routing.ts
git commit -m "feat(cost): routing chat semplici su Haiku 4.5 (flag-gated, era Sonnet)"
```

---

### Task 4: Guard rail — budget token per run (helper + test + wiring nei 3 loop V18)

**Files:**
- Create: `src/lib/run-budget.ts`
- Test: `src/lib/__tests__/run-budget.test.ts` (seguire la convenzione test esistente del repo: se i test stanno altrove, es. `test/` o `*.test.ts` accanto al sorgente, adeguarsi)
- Modify: `src/lib/claude.ts` (3 punti, dopo ogni `accUsage = addUsage(...)`)

- [ ] **Step 1: Scrivere il test fallente**

```ts
import { describe, it, expect } from 'vitest'
import { runTokens, isRunOverBudget, MAX_RUN_TOKENS } from '@/lib/run-budget'

describe('run-budget', () => {
  it('somma input + cache_creation + output (esclude cache_read, già quasi gratis)', () => {
    expect(runTokens({
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 999_999,
    })).toBe(3500)
  })

  it('usage vuoto = 0, non over budget', () => {
    expect(runTokens({})).toBe(0)
    expect(isRunOverBudget({})).toBe(false)
  })

  it('oltre il cap → over budget', () => {
    expect(isRunOverBudget({ input_tokens: MAX_RUN_TOKENS + 1 })).toBe(true)
  })

  it('cap custom rispettato', () => {
    expect(isRunOverBudget({ input_tokens: 50 }, 49)).toBe(true)
    expect(isRunOverBudget({ input_tokens: 50 }, 51)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test → FAIL** (`npx vitest run src/lib/__tests__/run-budget.test.ts` → "Cannot find module")

- [ ] **Step 3: Implementare `src/lib/run-budget.ts`**

```ts
/**
 * Cost-control 5 giu 2026: hard cap token per singola run dell'agente.
 * Impedisce che un runaway (loop tool infinito, tool result giganti) bruci
 * il credito API. Al superamento il loop si ferma e logga `run_aborted_budget`.
 *
 * Metrica: input non-cached + cache_creation + output. I cache_read sono
 * esclusi (costano ~10% dell'input: non sono il driver del runaway).
 */
import type { UsageTokens } from './api-usage'

export const MAX_RUN_TOKENS = 200_000

export function runTokens(u: UsageTokens): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0)
  )
}

export function isRunOverBudget(u: UsageTokens, max: number = MAX_RUN_TOKENS): boolean {
  return runTokens(u) > max
}
```

(Verificare che `UsageTokens` in `api-usage.ts` sia esportato con quei campi opzionali — lo è, righe 36-41.)

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Wiring nei 3 loop V18 (`src/lib/claude.ts`)**

Import in testa: `import { isRunOverBudget, runTokens, MAX_RUN_TOKENS } from './run-budget'`

In **callClaudeStream** (dopo riga 391 `accUsage = addUsage(...)`) e in **callClaude** (dopo riga 478), PRIMA del calcolo `toolBlocks`... subito dopo l'accumulo usage:

```ts
    // Guard rail cost-control: stop se la run ha superato il budget token
    if (isRunOverBudget(accUsage)) {
      console.warn(`run_aborted_budget: ${runTokens(accUsage)} > ${MAX_RUN_TOKENS} tokens (iter=${iterations})`)
      fullResponse += '\n\n⚠️ _Mi fermo qui: la richiesta ha superato il budget di elaborazione. Riformuli in modo più mirato o la spezzi in passi più piccoli._'
      break
    }
```

In **callClaudeStreamTelegram** (dopo riga 611 `accUsage = addUsage(...)`), stessa cosa MA il messaggio deve arrivare all'utente via `onChunk` (l'append a `fullResponse` basta: l'`onChunk(fullResponse)` finale a riga 729 lo consegna comunque). Inserire il check subito dopo `accUsage = addUsage(...)` e prima del log `STREAM iter=...`:

```ts
    if (isRunOverBudget(accUsage)) {
      console.warn(`run_aborted_budget: ${runTokens(accUsage)} > ${MAX_RUN_TOKENS} tokens (iter=${iterations})`)
      fullResponse += '\n\n⚠️ _Mi fermo qui: la richiesta ha superato il budget di elaborazione. Riformuli in modo più mirato o la spezzi in passi più piccoli._'
      break
    }
```

Nel `meta` di `logApiUsage` di tutte e 3 le funzioni aggiungere il flag:

```ts
    meta: { iterations, runAborted: isRunOverBudget(accUsage), ... /* campi esistenti invariati */ },
```

- [ ] **Step 6: Typecheck + test**

Run: `npx tsc --noEmit && npx vitest run src/lib/__tests__/run-budget.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/run-budget.ts src/lib/__tests__/run-budget.test.ts src/lib/claude.ts
git commit -m "feat(cost): hard cap 200K token per run nei 3 loop V18 (run_aborted_budget)"
```

---

### Task 5: Guard rail loop V19 (iterazioni, max_tokens, effort, budget)

**Files:**
- Modify: `src/v19/agent/loop.ts:34-36,302-305` (+ check budget nel loop)

- [ ] **Step 1: Ridurre le costanti**

```ts
// PRIMA (righe 34-36)
const MAX_ITERATIONS_DEFAULT = 30
const NO_TEXT_LIMIT_DEFAULT = 8
const MAX_TOKENS_OPUS = 64_000
// DOPO — cost-control 5 giu 2026: allineato a V18 (10 iter) + max_tokens 16K (Sonnet default)
const MAX_ITERATIONS_DEFAULT = 10
const NO_TEXT_LIMIT_DEFAULT = 5
const MAX_TOKENS_PER_CALL = 16_000
```

Aggiornare il riferimento a `MAX_TOKENS_OPUS` in `buildCreateArgs` (riga 302): `max_tokens: MAX_TOKENS_PER_CALL`.

- [ ] **Step 2: effort xhigh → high**

```ts
// PRIMA (righe 304-306)
    output_config: {
      effort: input.intent === 'chat' ? 'high' : 'xhigh',
    },
// DOPO — cost-control: xhigh moltiplica il thinking (fatturato come output)
    output_config: {
      effort: 'high',
    },
```

- [ ] **Step 3: Budget token nel loop V19**

Import: `import { isRunOverBudget, MAX_RUN_TOKENS } from '@/lib/run-budget'`

Dopo il blocco token accounting (righe 123-126), aggiungere:

```ts
      // Guard rail cost-control: stop se la run ha superato il budget token
      if (isRunOverBudget({ input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: cacheCreationTokens })) {
        console.warn(`[v19/loop] run_aborted_budget: oltre ${MAX_RUN_TOKENS} tokens (iter=${iterations})`)
        stopReason = 'max_tokens'
        break
      }
```

(`stopReason = 'max_tokens'` è già nel tipo `StopReason` — verificare in `src/v19/agent/types.ts`; se non c'è, usare un valore esistente o estendere il tipo.)

- [ ] **Step 4: Typecheck + test esistenti del loop V19**

Run: `npx tsc --noEmit && npx vitest run src/v19` (adattare il path ai test V19 esistenti)
Expected: typecheck PASS. Se i test V19 esistenti asseriscono MAX_ITER=30/NO_TEXT=8, aggiornarli alle nuove costanti.

- [ ] **Step 5: Commit**

```bash
git add src/v19/agent/loop.ts
git commit -m "feat(cost): V19 loop — 10 iter, max_tokens 16K, effort high, budget cap per run"
```

---

### Task 6: Troncamento tool result

**Files:**
- Create: `src/lib/tool-result-utils.ts`
- Test: `src/lib/__tests__/tool-result-utils.test.ts`
- Modify: `src/lib/claude.ts:771-786` (`executeToolBlocks`)
- Modify: `src/v19/agent/loop.ts:168-184` (loop tool_use)

- [ ] **Step 1: Test fallente**

```ts
import { describe, it, expect } from 'vitest'
import { truncateToolResult, MAX_TOOL_RESULT_CHARS } from '@/lib/tool-result-utils'

describe('truncateToolResult', () => {
  it('lascia intatti i risultati sotto soglia', () => {
    expect(truncateToolResult('breve')).toBe('breve')
  })

  it('tronca oltre soglia con marker esplicito', () => {
    const big = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 5000)
    const out = truncateToolResult(big)
    expect(out.length).toBeLessThan(big.length)
    expect(out).toContain('[output troncato')
    expect(out).toContain(String(big.length))
  })

  it('soglia custom', () => {
    expect(truncateToolResult('abcdef', 3)).toContain('[output troncato')
  })

  it('non-string passa invariato', () => {
    const blocks = [{ type: 'text', text: 'ciao' }]
    expect(truncateToolResult(blocks as unknown as string)).toBe(blocks)
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implementare**

```ts
/**
 * Cost-control 5 giu 2026: i tool result vengono rimessi in contesto a OGNI
 * iterazione del loop (input non-cached). Un risultato da 100K char (~25K token)
 * × 10 iterazioni = 250K token. Cap esplicito con marker, così il modello sa
 * che il contenuto è parziale e può richiederlo a pezzi se serve.
 */
export const MAX_TOOL_RESULT_CHARS = 30_000

export function truncateToolResult<T>(result: T, max: number = MAX_TOOL_RESULT_CHARS): T | string {
  if (typeof result !== 'string') return result
  if (result.length <= max) return result
  return (
    result.slice(0, max) +
    `\n\n…[output troncato: ${result.length} caratteri totali, mostrati i primi ${max}. ` +
    `Se servono le parti successive, richiedile in modo mirato (es. range, filtro, pagina).]`
  )
}
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Wiring V18** — in `executeToolBlocks` (claude.ts:778-779):

```ts
// PRIMA
      const result = await executeTool(block.name, block.input as Record<string, unknown>, conversationId)
      results.push({ type: 'tool_result', tool_use_id: block.id, content: result })
// DOPO
      const result = await executeTool(block.name, block.input as Record<string, unknown>, conversationId)
      results.push({ type: 'tool_result', tool_use_id: block.id, content: truncateToolResult(result) })
```

Import in testa a claude.ts: `import { truncateToolResult } from './tool-result-utils'`

- [ ] **Step 6: Wiring V19** — in loop.ts dopo `const result = await toolExecutor(tu, req.conversationId)` (riga 172):

```ts
            const result = await toolExecutor(tu, req.conversationId)
            if (typeof result.content === 'string') {
              result.content = truncateToolResult(result.content) as string
            }
            toolResults.push(result)
```

Import: `import { truncateToolResult } from '@/lib/tool-result-utils'`

- [ ] **Step 7: Typecheck + test → PASS, poi commit**

```bash
git add src/lib/tool-result-utils.ts src/lib/__tests__/tool-result-utils.test.ts src/lib/claude.ts src/v19/agent/loop.ts
git commit -m "feat(cost): troncamento tool result a 30K char con marker (V18+V19)"
```

---

### Task 7: Caching incrementale nel tool-loop (cache anche la conversazione, non solo il prefisso)

**Razionale:** oggi è cachato solo il prefisso tools+system. I messaggi (history + tool result accumulati) vengono rifatturati come input pieno a OGNI iterazione del loop. Spostando un breakpoint `ephemeral` sull'ultimo blocco dell'ultimo messaggio dopo ogni append, l'iterazione N+1 legge cached tutto il prefisso conversazionale dell'iterazione N. Con run multi-tool è il singolo risparmio più grosso (input cached ≈ 10% del prezzo).

**Files:**
- Create: `src/lib/cache-breakpoints.ts`
- Test: `src/lib/__tests__/cache-breakpoints.test.ts`
- Modify: `src/lib/claude.ts` (3 punti: dopo ogni costruzione di `currentMessages = [...]` nel loop)
- Modify: `src/v19/agent/loop.ts` (dopo `messages.push({ role: 'user', content: toolResults })`)

- [ ] **Step 1: Test fallente**

```ts
import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { applyIncrementalCacheBreakpoint } from '@/lib/cache-breakpoints'

function msgs(): Anthropic.MessageParam[] {
  return [
    { role: 'user', content: 'ciao' },
    { role: 'assistant', content: [{ type: 'text', text: 'uso un tool' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }] as never },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'risultato' }] as never },
  ]
}

describe('applyIncrementalCacheBreakpoint', () => {
  it('mette cache_control SOLO sull ultimo blocco dell ultimo messaggio', () => {
    const m = msgs()
    applyIncrementalCacheBreakpoint(m)
    const last = m[m.length - 1].content as Array<Record<string, unknown>>
    expect(last[last.length - 1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('rimuove i breakpoint precedenti (mai più di 1 nei messages)', () => {
    const m = msgs()
    applyIncrementalCacheBreakpoint(m)
    // simula iterazione successiva: nuovo scambio in coda
    m.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'y', input: {} }] as never })
    m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'r2' }] as never })
    applyIncrementalCacheBreakpoint(m)
    let count = 0
    for (const msg of m) {
      if (!Array.isArray(msg.content)) continue
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b.cache_control) count++
      }
    }
    expect(count).toBe(1)
  })

  it('ultimo messaggio con content string → no-op senza errori', () => {
    const m: Anthropic.MessageParam[] = [{ role: 'user', content: 'solo testo' }]
    expect(() => applyIncrementalCacheBreakpoint(m)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implementare**

```ts
/**
 * Cost-control 5 giu 2026: breakpoint di cache "mobile" sulla coda dei messages.
 * Il prefisso tools+system è già cachato (buildCachedSystem). Questo helper
 * cacha ANCHE la conversazione accumulata nel tool-loop: a ogni iterazione
 * sposta un singolo breakpoint ephemeral sull'ultimo blocco dell'ultimo
 * messaggio, così l'iterazione successiva paga il prefisso come cache_read
 * (~10% del prezzo input) invece che input pieno.
 *
 * Limite Anthropic: max 4 breakpoint totali → 1 sul system + 1 mobile qui = 2.
 * Sotto la soglia minima cacheabile (1024/2048 token) il breakpoint è ignorato
 * dall'API senza errori: il no-op è sicuro.
 */
import type Anthropic from '@anthropic-ai/sdk'

export function applyIncrementalCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  // 1) Strip dei breakpoint esistenti nei messages (il limite è 4 totali)
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content as Array<Record<string, unknown>>) {
      if (block && typeof block === 'object' && 'cache_control' in block) {
        delete (block as { cache_control?: unknown }).cache_control
      }
    }
  }
  // 2) Breakpoint sull'ultimo blocco dell'ultimo messaggio
  const last = messages[messages.length - 1]
  if (!last || !Array.isArray(last.content) || last.content.length === 0) return
  const lastBlock = last.content[last.content.length - 1] as Record<string, unknown>
  lastBlock.cache_control = { type: 'ephemeral' }
}
```

- [ ] **Step 4: Run → PASS**

- [ ] **Step 5: Wiring V18** — in tutti e 3 i loop di claude.ts, subito dopo l'append dei tool result. Esempio per `callClaudeStream` (righe 400-404), identico negli altri due:

```ts
    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: final.content },
      { role: 'user' as const, content: toolResults },
    ]
    applyIncrementalCacheBreakpoint(currentMessages)
```

ATTENZIONE in `callClaudeStream`/`callClaude`/`callClaudeStreamTelegram`: `final.content` è il content del messaggio API (oggetti SDK) — lo strip in `applyIncrementalCacheBreakpoint` muta i blocchi in place: è accettabile perché quei blocchi vengono usati solo per il giro successivo. Import: `import { applyIncrementalCacheBreakpoint } from './cache-breakpoints'`

- [ ] **Step 6: Wiring V19** — in loop.ts dopo riga 185 `messages.push({ role: 'user', content: toolResults })`:

```ts
        messages.push({ role: 'user', content: toolResults })
        applyIncrementalCacheBreakpoint(messages)
```

Import: `import { applyIncrementalCacheBreakpoint } from '@/lib/cache-breakpoints'`

- [ ] **Step 7: Typecheck + test → PASS, poi commit**

```bash
git add src/lib/cache-breakpoints.ts src/lib/__tests__/cache-breakpoints.test.ts src/lib/claude.ts src/v19/agent/loop.ts
git commit -m "feat(cost): cache breakpoint incrementale nel tool-loop (V18+V19)"
```

---

### Task 8: Finestra contesto web chat 500K → 120K char

**Files:**
- Modify: `src/lib/claude.ts:788`

- [ ] **Step 1: Ridurre la costante**

```ts
// PRIMA
const MAX_CONTEXT_CHARS = 500_000
// DOPO — cost-control 5 giu 2026: 500K char ≈ 125K token di input A OGNI messaggio web.
// 120K char ≈ 30K token: ampiamente sufficiente per la chat (Telegram usa già solo 6 messaggi).
const MAX_CONTEXT_CHARS = 120_000
```

- [ ] **Step 2: Test esistenti di trimMessages** — `npx vitest run` sui test che coprono `trimMessages` (cercare con `rg -l "trimMessages" src test`). Se asseriscono la soglia 500K, aggiornarli.

- [ ] **Step 3: Commit**

```bash
git add src/lib/claude.ts
git commit -m "feat(cost): finestra contesto web chat 500K -> 120K char"
```

---

### Task 9: Verifica completa pre-deploy (typecheck SEMPRE — lezione 2-3 giu)

- [ ] **Step 1:** `npx tsc --noEmit` → PASS
- [ ] **Step 2:** `npx vitest run` → i test NUOVI tutti verdi; i rossi pre-esistenti per env (noti, vedi memoria 4 giu) NON aumentano di numero rispetto a `git stash && npx vitest run && git stash pop` (baseline)
- [ ] **Step 3:** `npm run build` (o `npx next build`) → PASS
- [ ] **Step 4:** Push su main

```bash
git push origin main
```

Il push su main triggera l'auto-deploy Vercel (progetto `cervellone`, prod = cervellone-five.vercel.app).

---

### Task 10: Verifica post-deploy (obbligatoria, da task spec)

- [ ] **Step 1:** Verificare deploy READY su Vercel (MCP `get_deployment` o dashboard) — pre-flight verification, lezione 4-5 mag
- [ ] **Step 2:** Raffaele manda 2-3 messaggi di test al bot Telegram (1 chat semplice, 1 richiesta con tool es. "che mail ho ricevuto oggi?")
- [ ] **Step 3:** Query verifica modello + cache:

```sql
SELECT created_at, entry_point, model, input_tokens, output_tokens,
       cache_read_tokens, cache_creation_tokens, cost_usd
FROM api_usage
ORDER BY created_at DESC
LIMIT 20;
```

Expected: `model` = `claude-sonnet-4-6` (o `claude-haiku-4-5` per chat semplici), `cache_read_tokens > 0` dalla seconda chiamata, NESSUNA riga Opus.

- [ ] **Step 4:** Proiezione giornaliera: `SELECT date_trunc('day', created_at) d, sum(cost_usd) FROM api_usage GROUP BY 1 ORDER BY 1 DESC LIMIT 7;` → il run-rate proiettato deve stare **< $2/giorno**. Se sopra: ridurre `MAX_TOOL_RESULT_CHARS` (30K→15K), history Telegram 6→4, o spostare più routing su Haiku.
- [ ] **Step 5:** Controllo incrociato su Console Anthropic → Cost raggruppato per modello (lo fa Raffaele: Code non tocca l'account).

---

## Fuori scope (esplicito)

- **Durable workflows**: resta `false`, nessun codice toccato (bug P0 race + run infinito ancora aperti).
- **Impostazioni account Anthropic/credenziali**: non toccate da Code.
- **Canary cron**: già ottimale (chiama il modello solo in ROLLED_BACK).
- **Prompt caching base**: già attivo, nessuna modifica (solo verifica in Task 10).
