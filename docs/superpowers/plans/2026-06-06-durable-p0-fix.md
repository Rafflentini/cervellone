# Durable P0 Fix — Anti Crash-Restart Loop + Race Tracking + Budget 1M Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Riaccendere `durable_workflows_enabled` in sicurezza: il workflow durable non deve mai più poter bruciare credito in loop (incidente $118 del 4 giu), il tracking run non deve perdere righe, e le task lunghe legittime hanno budget dedicato 1M token.

**Architecture:** Il loop killer del 4 giu è un **crash-restart loop WDK**: `runAgentJobStep` (maxRetries=0) protegge dagli *errori* ma non dai *crash* — se Vercel uccide l'esecutore (800s Fluid), WDK riprende la run e ri-esegue lo step da zero (nuovo placeholder + nuova run Opus completa), all'infinito. Difese: (A) **contatore tentativi atomico in DB** dentro lo step — al 3° tentativo lo step abortisce SENZA chiamare Claude; (B) fallback già esistente in `updateRunStatus` finalmente CABLATO (oggi `markRunStep` non lo passa mai); (C) guard anti-paralleli per chat; (D) budget dedicato 1M per il path durable via `ClaudeRequest.maxRunTokens`.

**Tech Stack:** Next.js, TypeScript, Vercel WDK (`'use workflow'`/`'use step'`), Supabase, Vitest.

**Contesto verificato (6 giu notte):**
- `agent_workflow_runs` ESISTE in prod (id, channel, chat_id, conversation_id, status, created_at, updated_at) — 15 run recenti tutte `done`, RLS on.
- `runAgentTask` (src/workflows/agent-task.ts) → `markRunStep(runId,'running')` → `runAgentJobStep(input)` → `markRunStep('done')`, catch → `'error'`+rethrow.
- `markRunStep` chiama `updateRunStatus(id, status)` SENZA fallback (agent-task-steps.ts:34) → il recovery insert-then-update (commit 1d065d1) non si attiva mai.
- Dedup `telegram_dedup` per message_id esiste (route:62-72) → i duplicati webhook sono coperti; restano i paralleli da messaggi DIVERSI sulla stessa chat (durable rilascia il mutex subito, route:709).
- Budget attuale: `MAX_RUN_TOKENS=200_000` fisso in `callClaudeStreamTelegram` — vale anche per il durable (troppo stretto per task 30-60 min).
- Smoke live: webhook secret solo su Vercel env → smoke finale via Telegram lo fa Raffaele domattina.

---

### Task 1: Migration — colonna attempts + funzione atomica

**Files:** migration via Supabase MCP `apply_migration` (nome `add_workflow_run_attempts`), copia in `supabase/migrations/2026-06-06-workflow-run-attempts.sql`.

- [ ] **Step 1: Applicare la migration (idempotente, solo additiva)**

```sql
ALTER TABLE public.agent_workflow_runs
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.increment_workflow_run_attempts(p_run_id text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.agent_workflow_runs
  SET attempts = attempts + 1, updated_at = now()
  WHERE id = p_run_id
  RETURNING attempts;
$$;

REVOKE ALL ON FUNCTION public.increment_workflow_run_attempts(text) FROM anon, authenticated;
```

- [ ] **Step 2: Verifica** — `SELECT increment_workflow_run_attempts('wrun_test_inesistente');` → NULL (0 righe); colonna presente in information_schema.

---

### Task 2: runs.ts — incrementRunAttempts + getActiveRunForChat

**Files:**
- Modify: `src/lib/workflow/runs.ts`
- Test: `src/lib/workflow/runs.test.ts` (se esiste già un test, estendere; mock di `@/lib/supabase-server` come da pattern repo)

- [ ] **Step 1: Test fallente** per le 2 funzioni nuove (mock getSupabaseServer):
  - `incrementRunAttempts('id')` → chiama rpc `increment_workflow_run_attempts`, ritorna il numero; su null/error ritorna 1 (fail-open con warn — non deve MAI bloccare una run legittima per un errore DB).
  - `getActiveRunForChat('123')` → select su status='running' + chat_id + created_at > now-30min, ritorna la run o null; su errore null (fail-open).

- [ ] **Step 2: Implementazione**

```ts
/** Cost-control 6 giu: contatore tentativi per run. Atomico via RPC.
 *  Fail-open (ritorna 1) su errore: un problema DB non deve bloccare run legittime —
 *  il vero guard anti-loop è il confronto col cap fatto dal chiamante. */
export async function incrementRunAttempts(id: string): Promise<number> {
  try {
    const { data, error } = await getSupabaseServer()
      .rpc('increment_workflow_run_attempts', { p_run_id: id })
    if (error || data === null || data === undefined) {
      console.warn('[workflow runs] incrementRunAttempts fallback=1:', error?.message ?? 'run non trovata')
      return 1
    }
    return Number(data)
  } catch (err) {
    console.warn('[workflow runs] incrementRunAttempts unexpected, fallback=1:', err instanceof Error ? err.message : String(err))
    return 1
  }
}

const ACTIVE_RUN_WINDOW_MS = 30 * 60_000

/** Guard anti-paralleli: run 'running' fresca (<30 min) sulla stessa chat. */
export async function getActiveRunForChat(chatId: string): Promise<WorkflowRun | null> {
  try {
    const cutoff = new Date(Date.now() - ACTIVE_RUN_WINDOW_MS).toISOString()
    const { data, error } = await getSupabaseServer()
      .from('agent_workflow_runs')
      .select('id, channel, chat_id, conversation_id, status')
      .eq('status', 'running')
      .eq('chat_id', chatId)
      .gt('created_at', cutoff)
      .limit(1)
      .maybeSingle()
    if (error) { console.error('[workflow runs] getActiveRunForChat failed:', error.message); return null }
    return (data as WorkflowRun | null) ?? null
  } catch { return null }
}
```

- [ ] **Step 3: Test PASS + commit** `feat(durable): incrementRunAttempts (RPC atomica) + getActiveRunForChat`

---

### Task 3: Anti crash-restart loop nello step + fallback cablato

**Files:**
- Modify: `src/workflows/agent-task.ts` (passa runId+contesto agli step)
- Modify: `src/workflows/agent-task-steps.ts`
- Modify: `src/lib/run-budget.ts` (costanti)

- [ ] **Step 1: Costanti in run-budget.ts**

```ts
/** Path durable: task lunghe legittime (30-60 min) → budget dedicato. ~$3-4 max su Sonnet. */
export const MAX_DURABLE_RUN_TOKENS = 1_000_000
/** Anti crash-restart loop WDK: max esecuzioni dello step core per la stessa run. */
export const MAX_RUN_ATTEMPTS = 2
```

- [ ] **Step 2: agent-task-steps.ts — guard nello step core**

```ts
export async function runAgentJobStep(runId: string, input: AgentJobInput): Promise<void> {
  'use step'
  // Anti crash-restart loop (incidente $118 del 4 giu): se WDK ri-esegue questo step
  // dopo un crash dell'esecutore (800s kill), il contatore in DB lo rileva.
  // Al tentativo > MAX_RUN_ATTEMPTS: stop SENZA chiamare Claude.
  const attempts = await incrementRunAttempts(runId)
  if (attempts > MAX_RUN_ATTEMPTS) {
    console.error(`[durable] run ${runId} attempt ${attempts} > ${MAX_RUN_ATTEMPTS} — abort anti-loop`)
    await sendTelegramMessage(
      input.chatId,
      '⚠️ Ho interrotto la task: è stata riavviata troppe volte dall\'infrastruttura (probabile interruzione). Non ho riprovato per non consumare credito. La rilanci, magari spezzandola in passi più piccoli.'
    ).catch(() => {})
    await updateRunStatus(runId, 'error', telegramFallback(input))
    return
  }
  await runAgentJob(input)
}
runAgentJobStep.maxRetries = 0

export async function markRunStep(id: string, status: WorkflowRunStatus, input?: AgentJobInput): Promise<void> {
  'use step'
  await updateRunStatus(id, status, input ? telegramFallback(input) : undefined)
}

function telegramFallback(input: AgentJobInput) {
  return { channel: 'telegram' as const, chatId: String(input.chatId), conversationId: input.conversationId }
}
```

(import: `incrementRunAttempts, updateRunStatus` da runs, `MAX_RUN_ATTEMPTS` da run-budget, `sendTelegramMessage` da telegram-helpers.)

- [ ] **Step 3: agent-task.ts — wiring**

```ts
export async function runAgentTask(input: AgentJobInput): Promise<void> {
  'use workflow'
  const { workflowRunId } = getWorkflowMetadata()
  await markRunStep(workflowRunId, 'running', input)
  try {
    await runAgentJobStep(workflowRunId, input)
  } catch (err) {
    await markRunStep(workflowRunId, 'error', input)
    throw err
  }
  await markRunStep(workflowRunId, 'done', input)
}
```

- [ ] **Step 4: typecheck + commit** `fix(durable): anti crash-restart loop (attempts cap) + fallback tracking cablato`

---

### Task 4: Budget 1M per il path durable

**Files:**
- Modify: `src/lib/claude.ts` (ClaudeRequest + callClaudeStreamTelegram)
- Modify: `src/lib/agent-job.ts` (AgentJobInput + passthrough)
- Modify: `src/app/api/telegram/route.ts` (solo ramo durable)

- [ ] **Step 1: claude.ts** — `ClaudeRequest.maxRunTokens?: number` (JSDoc: budget token per run; default MAX_RUN_TOKENS; il path durable passa MAX_DURABLE_RUN_TOKENS). In `callClaudeStreamTelegram`: `const runBudget = request.maxRunTokens ?? MAX_RUN_TOKENS`, usare `isRunOverBudget(accUsage, runBudget)` nel guard del loop, nel messaggio warn e nel `meta.runAborted` del logApiUsage. (Gli altri 2 loop restano col default: il durable passa solo da Telegram.)
- [ ] **Step 2: agent-job.ts** — `AgentJobInput.maxRunTokens?: number` (serializzabile) e passthrough in `callClaudeStreamTelegram({ ..., maxRunTokens: input.maxRunTokens })`.
- [ ] **Step 3: route Telegram, SOLO ramo durable** — `const input: AgentJobInput = { ..., maxRunTokens: MAX_DURABLE_RUN_TOKENS }`.
- [ ] **Step 4: typecheck + test esistenti run-budget + commit** `feat(durable): budget dedicato 1M token per run durable`

---

### Task 5: Guard anti-paralleli stessa chat (ramo durable della route)

**Files:**
- Modify: `src/app/api/telegram/route.ts` (ramo durable, PRIMA di `start()`)

- [ ] **Step 1: Inserire il guard**

```ts
    if (await shouldUseDurable(userText, fileBlocks)) {
      // Guard anti-paralleli: il path durable rilascia subito il mutex per-chat,
      // quindi serializziamo qui — una sola task lunga 'running' fresca per chat.
      const activeRun = await getActiveRunForChat(String(chatId))
      if (activeRun) {
        await sendTelegramMessage(chatId, '⏳ Ho già una task lunga in corso per questa chat. Attenda che finisca (o usi /reset se è bloccata).')
        if (typingInterval) { clearInterval(typingInterval); typingInterval = null }
        await safeSupabase(() =>
          supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId).eq('request_id', requestId)
        )
        return NextResponse.json({ ok: true })
      }
      // ... resto del ramo durable invariato
```

(import `getActiveRunForChat` da '@/lib/workflow/runs'.)

- [ ] **Step 2: typecheck + commit** `feat(durable): guard anti-paralleli per chat nel ramo durable`

---

### Task 6: Verifica completa + deploy + flag ON

- [ ] **Step 1:** `npx tsc --noEmit` (8 errori pre-esistenti pdf-generator noti) + `npx vitest run` (29 fail pre-esistenti, zero nuovi) + `npm run build` PASS
- [ ] **Step 2:** Review subagent (spec + correttezza WDK: gli step ricevono argomenti serializzabili? il cambio firma runAgentJobStep è compatibile con journal/resume di run vecchie? — le run vecchie sono tutte done, nessuna resume pendente: ok)
- [ ] **Step 3:** push main → deploy → verify READY
- [ ] **Step 4:** Flag ON: `UPDATE cervellone_config SET value = to_jsonb('true'::text) WHERE key = 'durable_workflows_enabled';` + verifica SELECT
- [ ] **Step 5:** Smoke notturno parziale: verificare in `get_logs` Vercel che il deploy non abbia errori boot; smoke live completo (messaggio documentale da Telegram) → Raffaele domattina, con verifica `agent_workflow_runs` (run done, attempts=1) + `api_usage` (model sonnet, costo, runAborted false)
- [ ] **Step 6:** Report mattutino + aggiornamento memoria

**Rollback:** flag OFF (1 UPDATE) = path classico identico a oggi. Nessuna modifica al ramo flag-OFF.
