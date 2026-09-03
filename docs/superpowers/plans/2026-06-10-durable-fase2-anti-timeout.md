# Durable Fase 2 — Anti-timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spezzare il loop agentico monolitico in un `'use step'` WDK per iterazione, così che WDK committi ogni turno nel journal e al crash riprenda dall'ultima iterazione senza ri-chiamare Claude — eliminando insieme il timeout 800s e il re-run-da-zero.

**Architecture:** Estrarre il corpo di una singola iterazione del loop (`src/lib/claude.ts`) in una funzione pura riusabile `runOneIteration`. Il path veloce (non-durable) la chiama in-process con streaming live invariato. Il path durable la avvolge in uno step WDK; un workflow body orchestra il loop accumulando `messages`/`accUsage` nel journal, manda heartbeat tra gli step, messaggio finale a fine lavoro. Tool-write irreversibili protetti da idempotency key.

**Tech Stack:** Next.js 16, TypeScript, `workflow@4.3.1` (Vercel WDK), Supabase, Anthropic SDK, vitest.

**Spec:** `docs/superpowers/specs/2026-06-10-cervellone-durable-fase2-design.md`

**Branch:** `feat/durable-fase2` (Claude + subagenti; Codex in pausa via `.loop/STOP`). NON toccare `working-memory.ts` (binario A).

**⚠️ CORREZIONI API verificate sul codice reale (10 giu, da T0/T2):**
- `getWorkflowMetadata()` restituisce **`{ workflowRunId }`**, NON `workflowId`. Usare `workflowRunId` ovunque (T4).
- `getSupabaseServer()` si importa da **`@/lib/supabase-server`**, NON da `@/lib/supabase` (che esporta solo l'istanza `supabase`). Vale per T2/T3/T4/T5.
- Avvio workflow: `import { start } from 'workflow/api'`; `await start(fn, [args])` → `run.runId`.

**Stato:** T0 (hello-replay) ✅ committato (`7b5619a`) — verifica sul campo PENDING prima del flag ON. T2 (idempotency) ✅ committato (`48456e4`), 3/3 test verdi.

**Vincoli ambiente Codex:** niente `npx`/`node_modules` → scrivi i test con cura, dichiara nel PR che non li hai eseguiti; li esegue Claude in review. Leggi `node_modules/next/dist/docs/` prima di scrivere (Next.js con breaking changes, vedi AGENTS.md). NON toccare `.env`/secrets/CI.

---

## File Structure

- `src/workflows/hello-replay.ts` — **nuovo** (task-0, rimovibile): prova sul campo del replay WDK.
- `supabase/migrations/2026-06-10-hello-replay-counter.sql` — **nuovo** (task-0): tabella contatore di prova.
- `src/lib/claude.ts` — estrarre `runOneIteration`; `callClaude*` rifattorizzate internamente, comportamento esterno invariato.
- `src/lib/claude.test.ts` — test di `runOneIteration` (Anthropic mockato).
- `src/lib/tool-idempotency.ts` — **nuovo**: `withIdempotency(key, fn)` + accesso tabella.
- `src/lib/tool-idempotency.test.ts` — **nuovo**.
- `supabase/migrations/2026-06-10-tool-idempotency.sql` — **nuovo**: tabella `tool_idempotency`.
- `src/workflows/agent-task-steps.ts` — `runAgentIterationStep` (`'use step'`).
- `src/workflows/agent-task.ts` — workflow body orchestratore (loop a step + heartbeat + finale + budget cumulativo).
- `src/lib/tools.ts` — wrapper idempotency sui soli tool-write (sezione tool-write).

---

## Task 0: Prova sul campo del replay WDK (hello-workflow)

**Scopo:** verificare la garanzia cardine — uno step committato NON viene ri-eseguito al resume — PRIMA di rifattorizzare il loop vero. Se la garanzia non regge, l'intero approccio cambia.

**Files:**
- Create: `supabase/migrations/2026-06-10-hello-replay-counter.sql`
- Create: `src/workflows/hello-replay.ts`

- [ ] **Step 1: Migration tabella contatore**

```sql
-- supabase/migrations/2026-06-10-hello-replay-counter.sql
create table if not exists hello_replay_counter (
  run_id text not null,
  step_name text not null,
  hits int not null default 1,
  created_at timestamptz not null default now(),
  primary key (run_id, step_name)
);
```

- [ ] **Step 2: Hello-workflow a 2 step**

```ts
// src/workflows/hello-replay.ts
import { getWorkflowMetadata } from 'workflow'
import { getSupabaseServer } from '@/lib/supabase'

async function bumpCounter(runId: string, stepName: string): Promise<number> {
  'use step'
  const supabase = getSupabaseServer()
  // upsert con incremento: se la riga esiste, hits++ ; il valore ritornato è il committed value
  const { data } = await supabase.rpc('hello_replay_bump', { p_run_id: runId, p_step: stepName })
  return (data as number) ?? 1
}
bumpCounter.maxRetries = 0

export async function helloReplay(): Promise<void> {
  'use workflow'
  const { workflowId } = getWorkflowMetadata()
  const a = await bumpCounter(workflowId, 'step1')   // committato dopo questa riga
  await new Promise((r) => setTimeout(r, 2000))       // finestra per kill/redeploy manuale
  const b = await bumpCounter(workflowId, 'step2')
  console.log(`[hello-replay] ${workflowId} step1=${a} step2=${b}`)
}
```

- [ ] **Step 3: RPC di bump atomico** (aggiungi alla stessa migration)

```sql
create or replace function hello_replay_bump(p_run_id text, p_step text)
returns int language plpgsql as $$
declare v int;
begin
  insert into hello_replay_counter(run_id, step_name) values (p_run_id, p_step)
  on conflict (run_id, step_name) do update set hits = hello_replay_counter.hits + 1
  returning hits into v;
  return v;
end $$;
```

- [ ] **Step 4: Commit**

```bash
git add src/workflows/hello-replay.ts supabase/migrations/2026-06-10-hello-replay-counter.sql
git commit -m "feat(durable): task-0 hello-replay per provare il replay WDK"
```

**Verifica sul campo (la fa Claude, non Codex):** trigger del workflow su preview, kill/redeploy nella finestra dei 2s tra step1 e step2, poi `SELECT * FROM hello_replay_counter`. **Atteso:** `step1.hits = 1` (NON ri-eseguito al resume), `step2.hits = 1`. Se `step1.hits = 2` → la garanzia non regge, fermarsi e riprogettare.

---

## ⚠️ REVISIONE 10 giu (sicurezza): NON rifattorizzare il path live

Dopo lettura del loop reale (`callClaudeStreamTelegram`, pieno di fix non coperti da test:
Bug5/Bug7/W1/preserve-partial/force-text/thinking-stream), si è deciso di **NON toccare il path
veloce**. Invece di un `runOneIteration` condiviso, si crea una funzione **separata e dedicata**
`runDurableIteration` per il solo path durable (niente `onChunk`/streaming — il durable usa
heartbeat). Force-text e budget li gestisce il workflow body. Un po' di duplicazione, zero rischio
sul bot live. La firma `IterationResult` resta quella sotto.

## Task 1: `runDurableIteration` (nuova, path veloce INTATTO)

**Files:**
- Modify: `src/lib/claude.ts` (loop in `callClaudeStreamTelegram` ~617-740, `callClaudeStream` ~399-450, `callClaude` ~499-540)
- Test: `src/lib/claude.test.ts`

**Interfaccia (definita qui, usata da tutti i task successivi):**

```ts
export interface IterationParams {
  model: string
  systemBlocks: Anthropic.TextBlockParam[]
  messages: Anthropic.MessageParam[]
  tools: Anthropic.Tool[]
  maxTokens: number
  conversationId?: string
}
export interface IterationResult {
  assistantMessage: Anthropic.MessageParam   // assistant content (text + tool_use blocks)
  toolResults: Anthropic.MessageParam | null // { role:'user', content: tool_result[] }, null se end_turn/no-tool
  usageDelta: UsageTokens                     // token di QUESTA iterazione
  stopReason: string | null
  text: string                                // testo prodotto in questa iterazione
}
export async function runOneIteration(params: IterationParams): Promise<IterationResult>
```

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/claude.test.ts (aggiungi)
import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock del client Anthropic: una risposta con UN tool_use e poco testo
vi.mock('@anthropic-ai/sdk', () => {
  const stream = {
    async *[Symbol.asyncIterator]() { yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ciao' } } },
    finalMessage: async () => ({
      content: [
        { type: 'text', text: 'ciao' },
        { type: 'tool_use', id: 'tu_1', name: 'cerca_documenti', input: { q: 'x' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 100, output_tokens: 20 },
    }),
  }
  return { default: class { messages = { stream: () => stream } } }
})
vi.mock('./tools', () => ({
  executeToolBlocks: vi.fn(async () => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'risultato' }] })),
  TOOLS: [],
}))

describe('runOneIteration', () => {
  it('ritorna assistantMessage, toolResults, usageDelta e stopReason per una iterazione con tool', async () => {
    const { runOneIteration } = await import('./claude')
    const r = await runOneIteration({
      model: 'claude-sonnet-4-6', systemBlocks: [{ type: 'text', text: 'sys' }],
      messages: [{ role: 'user', content: 'fai x' }], tools: [], maxTokens: 4096,
    })
    expect(r.stopReason).toBe('tool_use')
    expect(r.toolResults).not.toBeNull()
    expect(r.text).toContain('ciao')
    expect(r.usageDelta.input_tokens).toBe(100)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/claude.test.ts -t runOneIteration`
Expected: FAIL — `runOneIteration is not a function`.

- [ ] **Step 3: Implementare `runOneIteration`**

Estrai dal loop esistente (corpo di una iterazione: stream → `finalMessage()` → split text/tool_use → se ci sono tool, `executeToolBlocks` → costruisci `toolResults`). NON chiamare `onChunk` qui (lo streaming resta nel wrapper veloce). Ritorna l'`IterationResult`. Lo streaming `onChunk` nel path veloce continua a leggere i delta — mantieni la firma del loop veloce passando un callback opzionale `onTextDelta` al posto del vecchio inline, oppure lascia il consumo dello stream nel wrapper e fa' che `runOneIteration` accetti lo stream già aperto. Scelta consigliata: `runOneIteration` apre lo stream, accumula testo, e accetta un `onTextDelta?: (acc: string) => void` opzionale così il wrapper veloce passa lo streaming e il durable no.

Aggiorna `IterationParams` con `onTextDelta?: (accumulated: string) => void | Promise<void>`.

- [ ] **Step 4: Rifattorizzare i 3 loop per usare `runOneIteration`**

`callClaudeStreamTelegram`, `callClaudeStream`, `callClaude`: il loop `for` ora chiama `runOneIteration`, fa push di `assistantMessage`/`toolResults` su `currentMessages`, accumula `accUsage`, applica il cache breakpoint, mantiene i guard (budget, consecutiveNoText, force-text). Il path veloce passa `onTextDelta` per lo streaming live; il resto invariato. **Comportamento esterno identico.**

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/lib/claude.test.ts`
Expected: PASS (nuovi + esistenti del file).

- [ ] **Step 6: Commit**

```bash
git add src/lib/claude.ts src/lib/claude.test.ts
git commit -m "refactor(claude): estrai runOneIteration; path veloce invariato"
```

---

## Task 2: Tabella + wrapper idempotency tool-write

**Files:**
- Create: `supabase/migrations/2026-06-10-tool-idempotency.sql`
- Create: `src/lib/tool-idempotency.ts`
- Test: `src/lib/tool-idempotency.test.ts`

- [ ] **Step 1: Migration**

```sql
-- supabase/migrations/2026-06-10-tool-idempotency.sql
create table if not exists tool_idempotency (
  run_id text not null,
  tool_use_id text not null,
  iteration int,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, tool_use_id)
);
alter table tool_idempotency enable row level security;
-- accesso solo service_role (coerente con magic-fix supabase.ts server-side)
```

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/tool-idempotency.test.ts
import { describe, it, expect, vi } from 'vitest'
const store = new Map<string, unknown>()
vi.mock('./supabase', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: store.get('k') ? { result: store.get('k') } : null }) }) }) }),
      insert: async (row: any) => { store.set('k', row.result); return { error: null } },
    }),
  }),
}))

describe('withIdempotency', () => {
  it('miss: esegue fn e salva; hit: ritorna cached senza eseguire', async () => {
    const { withIdempotency } = await import('./tool-idempotency')
    const fn = vi.fn(async () => ({ ok: 1 }))
    const a = await withIdempotency({ runId: 'r', toolUseId: 't', iteration: 0 }, fn)
    expect(a).toEqual({ ok: 1 }); expect(fn).toHaveBeenCalledTimes(1)
    const b = await withIdempotency({ runId: 'r', toolUseId: 't', iteration: 0 }, fn)
    expect(b).toEqual({ ok: 1 }); expect(fn).toHaveBeenCalledTimes(1) // NON ri-eseguito
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/tool-idempotency.test.ts`
Expected: FAIL — modulo inesistente.

- [ ] **Step 4: Implementare**

```ts
// src/lib/tool-idempotency.ts
import { getSupabaseServer } from './supabase'
export interface IdemKey { runId: string; toolUseId: string; iteration?: number }

export async function withIdempotency<T>(key: IdemKey, fn: () => Promise<T>): Promise<T> {
  const supabase = getSupabaseServer()
  try {
    const { data } = await supabase.from('tool_idempotency').select('result')
      .eq('run_id', key.runId).eq('tool_use_id', key.toolUseId).maybeSingle()
    if (data && (data as { result: unknown }).result !== undefined) {
      return (data as { result: T }).result
    }
  } catch { /* fail-open: in dubbio, esegui */ }
  const result = await fn()
  try {
    await supabase.from('tool_idempotency').insert({
      run_id: key.runId, tool_use_id: key.toolUseId, iteration: key.iteration ?? null, result: result as unknown,
    })
  } catch { /* best-effort */ }
  return result
}
```

- [ ] **Step 5: Run tests** — `npx vitest run src/lib/tool-idempotency.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/tool-idempotency.ts src/lib/tool-idempotency.test.ts supabase/migrations/2026-06-10-tool-idempotency.sql
git commit -m "feat(durable): tabella + withIdempotency per tool-write irreversibili"
```

---

## Task 3: `runAgentIterationStep` (`'use step'`)

**Files:**
- Modify: `src/workflows/agent-task-steps.ts`
- Test: `src/workflows/agent-task-steps.test.ts`

- [ ] **Step 1: Write the failing test** (mock di `runOneIteration`)

```ts
// src/workflows/agent-task-steps.test.ts (aggiungi)
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/claude', () => ({ runOneIteration: vi.fn(async () => ({
  assistantMessage: { role: 'assistant', content: [] }, toolResults: null,
  usageDelta: { input_tokens: 10 }, stopReason: 'end_turn', text: 'fatto',
})) }))

describe('runAgentIterationStep', () => {
  it('delega a runOneIteration e ne ritorna il risultato serializzabile', async () => {
    const { runAgentIterationStep } = await import('./agent-task-steps')
    const r = await runAgentIterationStep('run1', 0, {
      model: 'claude-sonnet-4-6', systemBlocks: [], messages: [], tools: [], maxTokens: 4096,
    })
    expect(r.stopReason).toBe('end_turn'); expect(r.text).toBe('fatto')
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run src/workflows/agent-task-steps.test.ts -t runAgentIterationStep` → FAIL.

- [ ] **Step 3: Implementare**

```ts
// src/workflows/agent-task-steps.ts (aggiungi)
import { runOneIteration, type IterationParams, type IterationResult } from '@/lib/claude'

export async function runAgentIterationStep(
  runId: string, iteration: number, params: IterationParams,
): Promise<IterationResult> {
  'use step'
  return await runOneIteration(params)
}
runAgentIterationStep.maxRetries = 0
```

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/workflows/agent-task-steps.ts src/workflows/agent-task-steps.test.ts
git commit -m "feat(durable): runAgentIterationStep per-iterazione (use step)"
```

---

## Task 4: Workflow body orchestratore (loop a step + heartbeat + finale + budget cumulativo)

**Files:**
- Modify: `src/workflows/agent-task.ts`
- Test: `src/workflows/agent-task.test.ts`

- [ ] **Step 1: Write the failing test** (3 iterazioni mockate: 2 con tool, la 3ª end_turn)

```ts
// src/workflows/agent-task.test.ts (aggiungi)
import { describe, it, expect, vi } from 'vitest'
const calls: number[] = []
vi.mock('./agent-task-steps', () => ({
  runAgentIterationStep: vi.fn(async (_r, i) => {
    calls.push(i)
    const tool = i < 2
    return { assistantMessage: { role: 'assistant', content: [] },
      toolResults: tool ? { role: 'user', content: [] } : null,
      usageDelta: { input_tokens: 100 }, stopReason: tool ? 'tool_use' : 'end_turn', text: `t${i}` }
  }),
  markRunStep: vi.fn(async () => {}),
}))
const heartbeats: string[] = []
vi.mock('@/lib/agent-job', () => ({ heartbeat: vi.fn(async (_i, s) => { heartbeats.push(s) }), sendFinalMessage: vi.fn(async () => {}) }))

describe('runAgentTask orchestration', () => {
  it('cicla gli step fino a end_turn, accumula messages e manda heartbeat', async () => {
    const { runAgentTask } = await import('./agent-task')
    await runAgentTask({ /* AgentJobInput minimo */ maxRunTokens: 1_000_000 } as any)
    expect(calls).toEqual([0, 1, 2])           // 3 iterazioni, poi break su end_turn
    expect(heartbeats.length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.

- [ ] **Step 3: Implementare il body** (sostituisce la chiamata monolitica a `runAgentJobStep` nel ramo durable)

```ts
// src/workflows/agent-task.ts
'use workflow'
import { getWorkflowMetadata } from 'workflow'
import { runAgentIterationStep, markRunStep } from './agent-task-steps'
import { heartbeat, sendFinalMessage, buildInitialState } from '@/lib/agent-job'
import { isRunOverBudget, addUsage } from '@/lib/run-budget'

const MAX_ITERATIONS = 10
export async function runAgentTask(input: AgentJobInput): Promise<void> {
  'use workflow'
  const { workflowRunId } = getWorkflowMetadata()
  await markRunStep(workflowRunId, 'running')
  try {
    const st = buildInitialState(input)   // { model, systemBlocks, messages, tools, maxTokens }
    let acc = {}
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (isRunOverBudget(acc, input.maxRunTokens ?? 1_000_000)) break
      const r = await runAgentIterationStep(workflowId, i, { ...st, messages: st.messages })
      st.messages.push(r.assistantMessage)
      if (r.toolResults) st.messages.push(r.toolResults)
      acc = addUsage(acc, r.usageDelta)
      await heartbeat(input, statusFor(r))
      if (!r.toolResults || r.stopReason === 'end_turn') break
    }
    await sendFinalMessage(input, st.messages)
    await markRunStep(workflowId, 'done')
  } catch (err) {
    await markRunStep(workflowId, 'error')
    throw err
  }
}
function statusFor(r: { text: string }): string {
  return r.text ? '⚙️ Sto lavorando…' : '⚙️ Eseguo un passaggio…'
}
```

Nota: `buildInitialState`, `heartbeat`, `sendFinalMessage` vanno aggiunti a `agent-job.ts` (Task 5).

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/workflows/agent-task.ts src/workflows/agent-task.test.ts
git commit -m "feat(durable): workflow body a step con heartbeat e budget cumulativo"
```

---

## Task 5: Helper `agent-job.ts` (buildInitialState / heartbeat / sendFinalMessage)

**Files:**
- Modify: `src/lib/agent-job.ts`
- Test: `src/lib/agent-job.test.ts`

**ATTENZIONE coordinamento:** `agent-job.ts` è condiviso col binario A (hook auto-debrief a fine `runAgentJob`). Aggiungi SOLO nuovi export; NON toccare la coda di `runAgentJob`. Se serve modificarla, fermati e segnala nel PR.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/agent-job.test.ts (aggiungi)
import { describe, it, expect, vi } from 'vitest'
describe('buildInitialState', () => {
  it('produce messages iniziali + model + tools dal job input', async () => {
    const { buildInitialState } = await import('./agent-job')
    const st = buildInitialState({ userText: 'fai x', chatId: '1' } as any)
    expect(Array.isArray(st.messages)).toBe(true)
    expect(typeof st.model).toBe('string')
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.

- [ ] **Step 3: Implementare** `buildInitialState(input)` (riusa la logica già presente in `runAgentJob` per costruire system/messages/tools, estraendola in modo che entrambi i path la condividano), `heartbeat(input, text)` (edita un messaggio Telegram di stato, best-effort, idempotente per testo), `sendFinalMessage(input, messages)` (invia il testo finale accumulato). Riusa `sendTelegramMessageWithId`/edit già usati nel file.

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/agent-job.ts src/lib/agent-job.test.ts
git commit -m "feat(durable): buildInitialState/heartbeat/sendFinalMessage condivisi"
```

---

## Task 6: Applicare `withIdempotency` ai tool-write in `tools.ts`

**Files:**
- Modify: `src/lib/tools.ts` (sezione tool-write: `uploadBinaryToDrive`/genera_pdf|docx|xlsx, send_email/forward, trasmissione bozze)
- Test: `src/lib/tools.idempotency.test.ts`

**ATTENZIONE coordinamento:** tocca SOLO la sezione tool-write. NON toccare la sezione working-memory (binario A).

- [ ] **Step 1: Write the failing test** (chiamando l'esecutore tool-write due volte con stesso `tool_use_id` → un solo upload reale)

```ts
// src/lib/tools.idempotency.test.ts
import { describe, it, expect, vi } from 'vitest'
const uploads: number[] = []
vi.mock('./drive', () => ({ uploadBinaryToDrive: vi.fn(async () => { uploads.push(1); return { id: 'file1' } }) }))
// withIdempotency reale o mockato a passthrough-con-cache
describe('tool-write idempotente', () => {
  it('due esecuzioni con stesso tool_use_id → un solo upload', async () => {
    // arrange: esegui executePdfTools/equivalente due volte con stesso ctx { runId, toolUseId }
    // assert: uploads.length === 1
    expect(uploads.length).toBeLessThanOrEqual(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (upload eseguito 2 volte).

- [ ] **Step 3: Implementare** — passare `runId`+`toolUseId` al contesto di esecuzione tool (da `executeToolBlocks`, che ha già `block.id`); avvolgere le sole chiamate irreversibili in `withIdempotency({ runId, toolUseId, iteration }, () => realCall())`. Quando non c'è `runId` (path veloce non-durable), `withIdempotency` con runId vuoto degrada a passthrough (esegue sempre): gating `if (!runId) return fn()`.

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.ts src/lib/tools.idempotency.test.ts
git commit -m "feat(durable): tool-write irreversibili idempotenti su run_id+tool_use_id"
```

---

## Task 7: Wiring del ramo durable in `agent-job.ts` / route + estensione stress test S1

**Files:**
- Modify: `src/lib/agent-job.ts` (ramo durable usa `start(runAgentTask)` con il nuovo body; verificare che il path veloce resti `bgProcess`/loop in-process)
- Modify: `src/app/api/telegram/route.ts` (se serve, passare `runId`/`toolUseId` nel ctx — minimale)
- Test: estendere `src/workflows/agent-task-steps.attempts.test.ts` (S1) per il nuovo modello a step

- [ ] **Step 1:** Verificare che `shouldUseDurable` → `start(runAgentTask, [input])` invochi il nuovo body a step e che `createRun` resti invariato.
- [ ] **Step 2:** Test: una run durable a 3 iterazioni con la 2ª che "crasha" (mock che lancia) → al replay le iterazioni 0-1 vengono dal journal (mock che conta le chiamate reali), zero ri-chiamate Claude su 0-1. (Simulazione del journal nei test: vedi pattern S1.)
- [ ] **Step 3:** Run full suite — `npx vitest run` — verde (a parte i 29 fail pre-esistenti env, invariati).
- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(durable): wiring ramo durable a step + estensione stress test"
```

---

## Self-Review (Claude, prima del merge)

1. **Spec coverage:** step-per-iterazione (T1,T3,T4) ✓ · heartbeat+finale (T4,T5) ✓ · budget cumulativo nel body (T4) ✓ · idempotenza mirata (T2,T6) ✓ · task-0 replay (T0) ✓ · path veloce invariato (T1) ✓ · circuit-breaker outcome una volta sola — **DA AGGIUNGERE in T4** (recordOutcome dopo il loop nel body).
2. **Type consistency:** `IterationParams`/`IterationResult` definiti in T1, usati identici in T3/T4. `withIdempotency(IdemKey, fn)` T2 usato in T6. ✓
3. **Placeholder:** T6/T7 hanno test scheletro (arrange descritto a parole) — Codex deve completarli col pattern reale degli esecutori tool; accettabile come guida, ma segnalare nel PR se l'aggancio runId non è banale.

**Fix inline:** in T4 Step 3 aggiungere dopo il loop, prima di `markRunStep('done')`:
`recordOutcome(st.model, 'success', { iterations: i, durable: true })` (una sola registrazione per run).

---

## Ordine di esecuzione

T0 (prova replay, blocca tutto se fallisce) → T1 → T2 → T3 → T4 → T5 → T6 → T7. Una task = una PR. Claude rivede, esegue i test, mergia.
