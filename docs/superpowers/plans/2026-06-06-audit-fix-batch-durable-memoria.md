# Audit Fix Batch: Durable + Memoria Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply 3 groups of fixes from post-audit (durable execution + memory) — zombie run cleanup, attempt cap reduction, WDK-native step counter, and imperative project/draft memory prompts.

**Architecture:** Three independent commit groups: (1) /reset clears zombie durable runs + cron expires stuck running workflows; (2) cap MAX_RUN_ATTEMPTS to 1, add WDK-native attempt counter via `getStepMetadata().attempt`, update abort message; (3) filter stale project_state after 7 days and make memory/draft prompt rules imperative.

**Tech Stack:** Next.js 16, TypeScript, Supabase (supabase-js), `workflow` npm package (WDK via `@workflow/core`), Vitest.

---

## Key Findings Before Coding

- `getStepMetadata` **exists** in `@workflow/core` and is exported from `workflow`. Signature: `getStepMetadata(): { stepName, stepId, stepStartedAt, attempt: number }`. The `attempt` field is the number of times this step has been executed (increases with each retry). Import path: `import { getStepMetadata } from 'workflow'`.
- `getSupabaseServer` is already imported at line 12 of `route.ts` — no dynamic import needed in /reset handler.
- `supabase` (anon client) is also imported at line 11 — the /reset handler currently uses `safeSupabase(() => supabase.from(...))`. The durable runs cleanup should use `getSupabaseServer()` for SERVICE_ROLE (can update system rows regardless of RLS).
- `MAX_RUN_ATTEMPTS = 2` in `run-budget.ts`. No test currently asserts this value directly.
- `run-budget.test.ts` does NOT test `MAX_RUN_ATTEMPTS` — no test changes needed there for the cap change.
- `runs.test.ts` does NOT assert `createRun` payload includes `status` — but the test for `createRun` does not exist yet. Task 5 adds `status: 'running'` to the insert and adds a test for it.
- `working-memory.test.ts` builder mock has `then` (thenable) but no `update` chain with `.eq().eq()` terminal — the stale filter uses JS-side date comparison after `getActiveProject()` reads, so no mock changes needed for the filter itself. New tests for fresh vs stale need a `updated_at` field in the mock data.

---

## File Map

| File | Action | Group |
|---|---|---|
| `src/app/api/telegram/route.ts` | Modify: /reset adds durable run cleanup | G1 |
| `src/app/api/cron/expire-pending/route.ts` | Modify: add zombie workflow run cleanup block | G1 |
| `src/lib/run-budget.ts` | Modify: MAX_RUN_ATTEMPTS 2→1, update comment | G2 |
| `src/workflows/agent-task-steps.ts` | Modify: WDK attempt counter, new abort message, resume notice | G2 |
| `src/lib/workflow/runs.ts` | Modify: createRun adds explicit `status: 'running'` | G2 |
| `src/lib/workflow/runs.test.ts` | Modify: add test for createRun payload | G2 |
| `src/lib/working-memory.ts` | Modify: stale filter in buildActiveProjectContext | G3 |
| `src/lib/working-memory.test.ts` | Modify: add stale/fresh tests | G3 |
| `src/lib/prompts.ts` | Modify: imperative memory/draft rules | G3 |

---

## GRUPPO 1 — P0-B: /reset + zombie cron

**Commit message:** `fix(durable): /reset chiude run durable + cleanup run zombie nel cron`

### Task 1: /reset handler — close zombie durable runs

**Files:**
- Modify: `src/app/api/telegram/route.ts` (~line 411-418)

- [ ] **Step 1.1: Locate the /reset handler block**

Open `src/app/api/telegram/route.ts`. The handler is at approximately lines 410-418:

```typescript
    // ── /reset — sblocca manualmente il mutex se il bot è bloccato ──
    if (userText.trim().toLowerCase() === '/reset') {
      // Azione MANUALE esplicita: delete per-chat (NON scoped per request_id) di
      // proposito. Sblocca la chat anche se c'è un job vivo, interrompendone il
      // mutex (il job, se ancora attivo, perde il lock e non potrà più rilasciarlo).
      await safeSupabase(() => supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId))
      await sendTelegramMessage(chatId, '✅ Sbloccato. Puoi rimandare il messaggio.')
      return NextResponse.json({ ok: true })
    }
```

`getSupabaseServer` is already imported at line 12 — no new import needed.

- [ ] **Step 1.2: Add the durable run cleanup inside the /reset block**

Replace the /reset handler block with:

```typescript
    // ── /reset — sblocca manualmente il mutex se il bot è bloccato ──
    if (userText.trim().toLowerCase() === '/reset') {
      // Azione MANUALE esplicita: delete per-chat (NON scoped per request_id) di
      // proposito. Sblocca la chat anche se c'è un job vivo, interrompendone il
      // mutex (il job, se ancora attivo, perde il lock e non potrà più rilasciarlo).
      await safeSupabase(() => supabase.from('telegram_active_jobs').delete().eq('chat_id', chatId))
      // Audit 6 giu (P0-B): /reset deve sbloccare anche le run durable rimaste 'running'
      // (workflow morto senza catch) — altrimenti il guard anti-paralleli blocca la chat 30 min.
      await getSupabaseServer()
        .from('agent_workflow_runs')
        .update({ status: 'error', updated_at: new Date().toISOString() })
        .eq('chat_id', String(chatId))
        .eq('status', 'running')
        .catch((err: unknown) => {
          console.error('[/reset] durable run cleanup failed (best-effort):', err instanceof Error ? err.message : String(err))
        })
      await sendTelegramMessage(chatId, '✅ Sbloccato. Puoi rimandare il messaggio.')
      return NextResponse.json({ ok: true })
    }
```

- [ ] **Step 1.3: Verify TypeScript compiles — no new errors**

```bash
npx tsc --noEmit 2>&1 | grep -v "pdf-generator" | grep "error TS" | head -20
```

Expected: no new errors (8 pre-existing pdf-generator errors are acceptable).

---

### Task 2: expire-pending cron — add zombie workflow run cleanup

**Files:**
- Modify: `src/app/api/cron/expire-pending/route.ts`

- [ ] **Step 2.1: Read the current file structure**

The file currently imports only `expirePendingOlderThan` from email pending tools. It needs a new import for `getSupabaseServer` and a new block inside the `try` that cleans up zombie `agent_workflow_runs`.

- [ ] **Step 2.2: Add the import and zombie cleanup block**

Replace the entire file with:

```typescript
/**
 * Cron: pulizia pending email scaduti + run durable zombie.
 *
 * 1) Marca come 'expired' le righe di cervellone_email_pending_send che hanno
 *    superato il TTL (default 30 min). `fetchPending()` già le ignora a runtime,
 *    ma senza questo cron le righe restavano indefinitamente in DB.
 *
 * 2) Audit 6 giu (P0-B zombie cleanup): marca 'error' le agent_workflow_runs con
 *    status='running' e created_at < now()-2h. Queste sono run durable morte
 *    (crash senza catch) che altrimenti bloccherebbero la chat per 30 min
 *    (ACTIVE_RUN_WINDOW_MS). Ogni 6h è sufficiente per il clean.
 *
 * Auth: Bearer ${CRON_SECRET} (pattern condiviso con altri cron Cervellone,
 * vedi `api/cron/monthly-foreign-invoices/route.ts`).
 *
 * Schedule (vercel.json): `0 * /6 * * *` — ogni 6 ore.
 *
 * NOTA: Vercel UI "Run now" NON inietta il Bearer CRON_SECRET, quindi smoke
 * affidabili solo via curl con secret esplicito OPPURE attendendo lo scheduler
 * reale. Vedi `feedback_vercel_cron_run_now.md` (lezione 7 mag).
 */
import { NextRequest, NextResponse } from 'next/server'
import { expirePendingOlderThan } from '@/v19/tools/email/pending'
import { getSupabaseServer } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Zombie threshold: 2 hours. Una run legittima non supera mai 800s (Fluid max). */
const ZOMBIE_THRESHOLD_HOURS = 2

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  try {
    const { expired } = await expirePendingOlderThan(30)

    // Zombie workflow run cleanup (P0-B audit 6 giu)
    const cutoff = new Date(Date.now() - ZOMBIE_THRESHOLD_HOURS * 60 * 60 * 1000).toISOString()
    const { data: zombieRows, error: zombieError } = await getSupabaseServer()
      .from('agent_workflow_runs')
      .update({ status: 'error', updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('status', 'running')
      .lt('created_at', cutoff)

    if (zombieError) {
      console.error('[expire-pending] zombie workflow cleanup error:', zombieError.message)
    } else {
      const zombieCount = Array.isArray(zombieRows) ? zombieRows.length : 0
      if (zombieCount > 0) {
        console.log(`[expire-pending] zombie workflow runs closed: ${zombieCount}`)
      }
    }

    return NextResponse.json({ ok: true, expired })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
```

> **Note on count:** The Supabase JS client `.update(..., { count: 'exact' })` returns `{ data, count, error }` — `count` is the number of rows affected, not in `data`. If the count approach proves tricky with TypeScript types, use `data` length as fallback (the above uses `data` as fallback since `count` is in the destructured response but TS may complain). If TypeScript complains about `data` not having `.length`, destructure `count` instead:

```typescript
    const { count: zombieCount, error: zombieError } = await getSupabaseServer()
      .from('agent_workflow_runs')
      .update({ status: 'error', updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('status', 'running')
      .lt('created_at', cutoff)

    if (zombieError) {
      console.error('[expire-pending] zombie workflow cleanup error:', zombieError.message)
    } else if ((zombieCount ?? 0) > 0) {
      console.log(`[expire-pending] zombie workflow runs closed: ${zombieCount}`)
    }
```

Use whichever compiles cleanly. The important part: log the count, continue on error.

- [ ] **Step 2.3: Verify TypeScript compiles — no new errors**

```bash
npx tsc --noEmit 2>&1 | grep -v "pdf-generator" | grep "error TS" | head -20
```

Expected: no new errors.

---

### Task 3: Commit Group 1

- [ ] **Step 3.1: Run the durable/working-memory tests to verify no regressions**

```bash
npx vitest run src/lib/workflow src/lib/working-memory.test.ts src/lib/run-budget.test.ts 2>&1 | tail -20
```

Expected: all pass (no changes to those files yet).

- [ ] **Step 3.2: Commit Group 1**

```bash
git add src/app/api/telegram/route.ts src/app/api/cron/expire-pending/route.ts
git commit -m "fix(durable): /reset chiude run durable + cleanup run zombie nel cron"
```

---

## GRUPPO 2 — P1-C/D/E: cap attempts=1 + WDK counter + avviso ripresa

**Commit message:** `fix(durable): cap attempts=1 + guard WDK-nativo + avviso ripresa tentativo`

### Task 4: run-budget.ts — MAX_RUN_ATTEMPTS 2 → 1

**Files:**
- Modify: `src/lib/run-budget.ts`

- [ ] **Step 4.1: Update the constant and comment**

In `src/lib/run-budget.ts`, replace the line:

```typescript
/** Anti crash-restart loop WDK: max esecuzioni dello step core per la stessa run. */
export const MAX_RUN_ATTEMPTS = 2
```

With:

```typescript
/** 1 = al secondo ingresso dello step la run viene abortita: paga al massimo UNA esecuzione completa. Scelta post-audit 6 giu (P1-C). */
export const MAX_RUN_ATTEMPTS = 1
```

- [ ] **Step 4.2: Check run-budget.test.ts for any assertion on MAX_RUN_ATTEMPTS**

Open `src/lib/run-budget.test.ts`. The test file only tests `runTokens`, `isRunOverBudget`, and `MAX_RUN_TOKENS`. It does NOT import or assert `MAX_RUN_ATTEMPTS`. No test changes needed.

- [ ] **Step 4.3: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep -v "pdf-generator" | grep "error TS" | head -20
```

Expected: no new errors.

---

### Task 5: runs.ts — explicit status:'running' in createRun

**Files:**
- Modify: `src/lib/workflow/runs.ts`
- Modify: `src/lib/workflow/runs.test.ts`

- [ ] **Step 5.1: Write the failing test for createRun payload**

In `src/lib/workflow/runs.test.ts`, add a new `describe('createRun', ...)` block BEFORE the `describe('incrementRunAttempts', ...)` block:

```typescript
describe('createRun', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('inserisce status running esplicitamente (hardening P0-A)', async () => {
    const insertMock = vi.fn().mockResolvedValue({ error: null })
    mockFrom.mockReturnValue({ insert: insertMock })

    const { createRun } = await import('./runs')
    await createRun({ id: 'run-1', channel: 'telegram', chatId: '42', conversationId: 'conv-1' })

    expect(mockFrom).toHaveBeenCalledWith('agent_workflow_runs')
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }))
  })
})
```

- [ ] **Step 5.2: Run the test to confirm it FAILS**

```bash
npx vitest run src/lib/workflow/runs.test.ts 2>&1 | tail -20
```

Expected: the new test fails with "expected ... to contain status: 'running'" (or similar).

- [ ] **Step 5.3: Add status:'running' to the createRun insert**

In `src/lib/workflow/runs.ts`, in `createRun`, change the insert payload from:

```typescript
      .insert({
        id: input.id,
        channel: input.channel,
        chat_id: input.chatId ?? null,
        conversation_id: input.conversationId ?? null,
      })
```

to:

```typescript
      .insert({
        id: input.id,
        channel: input.channel,
        chat_id: input.chatId ?? null,
        conversation_id: input.conversationId ?? null,
        status: 'running',
      })
```

- [ ] **Step 5.4: Run the test again to confirm it PASSES**

```bash
npx vitest run src/lib/workflow/runs.test.ts 2>&1 | tail -20
```

Expected: all tests pass.

---

### Task 6: agent-task-steps.ts — WDK attempt counter + updated messages

**Files:**
- Modify: `src/workflows/agent-task-steps.ts`

- [ ] **Step 6.1: Add the WDK import**

`getStepMetadata` is exported from `workflow` (the package), confirmed via `node_modules/@workflow/core/dist/index.d.ts`. Add the import at the top of `src/workflows/agent-task-steps.ts`:

Change the existing imports block from:

```typescript
import { runAgentJob, type AgentJobInput } from '@/lib/agent-job'
import { updateRunStatus, incrementRunAttempts, type WorkflowRunStatus } from '@/lib/workflow/runs'
import { MAX_RUN_ATTEMPTS } from '@/lib/run-budget'
import { sendTelegramMessage } from '@/lib/telegram-helpers'
```

to:

```typescript
import { getStepMetadata } from 'workflow'
import { runAgentJob, type AgentJobInput } from '@/lib/agent-job'
import { updateRunStatus, incrementRunAttempts, type WorkflowRunStatus } from '@/lib/workflow/runs'
import { MAX_RUN_ATTEMPTS } from '@/lib/run-budget'
import { sendTelegramMessage } from '@/lib/telegram-helpers'
```

- [ ] **Step 6.2: Update runAgentJobStep with dual counter + new messages**

Replace the `runAgentJobStep` function body with:

```typescript
export async function runAgentJobStep(runId: string, input: AgentJobInput): Promise<void> {
  'use step'
  // Anti crash-restart loop (incidente $118 del 4 giu): se WDK ri-esegue questo step
  // dopo un crash dell'esecutore (800s kill), il contatore in DB lo rileva.
  // Al tentativo > MAX_RUN_ATTEMPTS: stop SENZA chiamare Claude.
  const dbAttempts = await incrementRunAttempts(runId)

  // Doppio contatore: DB (sopravvive ai crash) + WDK nativo (sopravvive al DB down) — audit P1-D.
  // getStepMetadata().attempt = quante volte questo step è stato eseguito (1 = prima volta).
  let wdkAttempt = 1
  try {
    wdkAttempt = getStepMetadata().attempt
  } catch {
    // fuori dallo step-context (es. test) → fallback 1
  }
  const attempts = Math.max(dbAttempts, wdkAttempt)

  if (attempts > MAX_RUN_ATTEMPTS) {
    console.error(`[durable] run ${runId} attempt ${attempts} > ${MAX_RUN_ATTEMPTS} — abort anti-loop`)
    await sendTelegramMessage(
      input.chatId,
      '⚠️ Ho interrotto la task: l\'esecuzione è stata interrotta dall\'infrastruttura e non l\'ho riavviata per non consumare credito. Se la richiesta era molto lunga (>10 minuti di lavoro), la spezzi in passi più piccoli e la rilanci.'
    ).catch(() => {})
    await updateRunStatus(runId, 'error', telegramFallback(input))
    return
  }

  // Se siamo in una ri-esecuzione (attempts > 1) ma sotto il cap: avvisa l'utente che stiamo
  // riprendendo. Con MAX_RUN_ATTEMPTS=1 questo ramo non scatterà mai; è qui per robustezza
  // nel caso il cap venga alzato in futuro.
  if (attempts > 1) {
    await sendTelegramMessage(
      input.chatId,
      '🔄 Riprendo la task interrotta (tentativo ' + attempts + ')...'
    ).catch(() => {})
  }

  await runAgentJob(input)
}
```

- [ ] **Step 6.3: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep -v "pdf-generator" | grep "error TS" | head -20
```

Expected: no new errors. If `getStepMetadata` is not found, verify the import path: it may need `import { getStepMetadata } from '@workflow/core'` instead of `'workflow'`. Check `node_modules/workflow/dist/index.d.ts` re-exports from `@workflow/core`. The re-export chain is: `workflow` → `@workflow/core` → `@workflow/core/dist/index.d.ts` which exports `getStepMetadata`. Either path works; prefer `'workflow'` for consistency with how `start` and step declarations are done in the file.

- [ ] **Step 6.4: Run tests**

```bash
npx vitest run src/lib/workflow src/lib/run-budget.test.ts 2>&1 | tail -20
```

Expected: all pass.

---

### Task 7: Commit Group 2

- [ ] **Step 7.1: Final test run for Group 2 files**

```bash
npx vitest run src/lib/workflow src/lib/run-budget.test.ts src/lib/working-memory.test.ts 2>&1 | tail -30
```

Expected: all pass.

- [ ] **Step 7.2: Commit Group 2**

```bash
git add src/lib/run-budget.ts src/workflows/agent-task-steps.ts src/lib/workflow/runs.ts src/lib/workflow/runs.test.ts
git commit -m "fix(durable): cap attempts=1 + guard WDK-nativo + avviso ripresa tentativo"
```

---

## GRUPPO 3 — Memoria: stale filter + prompt imperativo

**Commit message:** `fix(memoria): project_state stale dopo 7gg + regole tool progetto/bozze imperative`

### Task 8: working-memory.ts — stale project filter

**Files:**
- Modify: `src/lib/working-memory.ts`

- [ ] **Step 8.1: Write the failing tests first**

In `src/lib/working-memory.test.ts`, add a new `describe` block AFTER the existing `describe('buildActiveProjectContext', ...)` block:

```typescript
describe('buildActiveProjectContext — stale filter', () => {
  it('progetto aggiornato oggi → viene iniettato', async () => {
    const now = new Date().toISOString()
    setTable('project_state', {
      data: {
        conversation_id: 'conv-fresh',
        status: 'active',
        project_name: 'POS Recente',
        cliente: null,
        cantiere: null,
        task_type: null,
        key_files: {},
        done: [],
        pending: [],
        decisions: [],
        updated_at: now,
      },
      error: null,
    })

    const out = await buildActiveProjectContext('conv-fresh')
    expect(out).toContain('=== PROGETTO ATTIVO')
    expect(out).toContain('POS Recente')
  })

  it('progetto con updated_at 8 giorni fa → stringa vuota (stale)', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    setTable('project_state', {
      data: {
        conversation_id: 'conv-stale',
        status: 'active',
        project_name: 'POS Vecchio',
        cliente: null,
        cantiere: null,
        task_type: null,
        key_files: {},
        done: [],
        pending: [],
        decisions: [],
        updated_at: eightDaysAgo,
      },
      error: null,
    })

    const out = await buildActiveProjectContext('conv-stale')
    expect(out).toBe('')
  })

  it('progetto senza updated_at → viene iniettato (fail-open: data mancante non è stale)', async () => {
    setTable('project_state', {
      data: {
        conversation_id: 'conv-nodate',
        status: 'active',
        project_name: 'POS Senza Data',
        cliente: null,
        cantiere: null,
        task_type: null,
        key_files: {},
        done: [],
        pending: [],
        decisions: [],
        updated_at: null,
      },
      error: null,
    })

    const out = await buildActiveProjectContext('conv-nodate')
    expect(out).toContain('=== PROGETTO ATTIVO')
  })
})
```

- [ ] **Step 8.2: Run tests to confirm the stale tests FAIL**

```bash
npx vitest run src/lib/working-memory.test.ts 2>&1 | tail -20
```

Expected: the two new stale-filter tests fail (project always injected regardless of date).

- [ ] **Step 8.3: Implement the stale filter in buildActiveProjectContext**

In `src/lib/working-memory.ts`, in `buildActiveProjectContext`, add the stale check AFTER `const proj = await getActiveProject(conversationId)`:

Change from:

```typescript
export async function buildActiveProjectContext(conversationId?: string): Promise<string> {
  try {
    if (!conversationId) return ''
    const proj = await getActiveProject(conversationId)
    if (!proj) return ''

    const lines: string[] = []
```

to:

```typescript
/** 7 giorni: oltre questa soglia un progetto 'active' dimenticato non viene più iniettato.
 *  Audit 6 giu (P1): un progetto 'active' dimenticato sopravvive a /nuova per sempre
 *  (conversationId deterministico); oltre 7gg di inattività non viene più iniettato. */
const STALE_PROJECT_MS = 7 * 24 * 60 * 60 * 1000

export async function buildActiveProjectContext(conversationId?: string): Promise<string> {
  try {
    if (!conversationId) return ''
    const proj = await getActiveProject(conversationId)
    if (!proj) return ''

    // Stale filter: progetto non aggiornato da più di 7 giorni → non iniettare.
    // Fail-open: se updated_at mancante, lasciamo passare (non sappiamo quando è stato toccato).
    if (proj.updated_at) {
      const age = Date.now() - new Date(proj.updated_at).getTime()
      if (age > STALE_PROJECT_MS) return ''
    }

    const lines: string[] = []
```

> **Important:** Place the `STALE_PROJECT_MS` constant OUTSIDE the function (module-level), before `buildActiveProjectContext`. Do not place it inside the function body.

- [ ] **Step 8.4: Run tests to confirm all pass**

```bash
npx vitest run src/lib/working-memory.test.ts 2>&1 | tail -20
```

Expected: all tests pass (old + 3 new stale-filter tests).

---

### Task 9: prompts.ts — imperative memory/draft rules

**Files:**
- Modify: `src/lib/prompts.ts`

- [ ] **Step 9.1: Locate the existing rules to replace**

The current rules are at approximately lines 254-257:

```typescript
MEMORIA PROCEDURALE: se nel contesto è presente un blocco '=== PROCEDURA OBBLIGATORIA ===', seguilo come checklist vincolante: vai a prendere i dati dalle fonti indicate (leggi DVR/PSC/contratto su Drive con i tool) PRIMA di chiedere all'utente; chiedi solo ciò che davvero manca dopo. Quando l'Ingegnere ti corregge su COME si fa un lavoro, proponi a parole l'apprendimento e, dopo il suo OK, chiama registra_apprendimento(task_type, lesson) per non ripetere l'errore.

MEMORIA DI PROGETTO: se nel contesto c'è '=== PROGETTO ATTIVO ===', continua QUEL lavoro senza ripartire da zero. All'inizio di un lavoro nuovo e articolato chiama imposta_progetto_attivo; man mano aggiorna con aggiorna_progetto (cosa fatto/manca/deciso, file chiave). Vale per POS, preventivi, CME, perizie, relazioni, DDT, pratiche e qualsiasi altra cosa.
GESTIONE BOZZE/DOCUMENTI: NON rigenerare mai un documento da zero se ne esiste già uno — usa lista_bozze e ritrova_bozza per ritrovarlo. Per MODIFICARLO (es. 'aggiungi un paragrafo', 'cambia una voce') usa ritrova_bozza per avere il contenuto, applica SOLO la modifica richiesta preservando tutto il resto, poi aggiorna_bozza(doc_id, contenuto_completo): stesso documento, stesso link. Per SALVARLO/consegnarlo usa salva_bozza_pdf(doc_id, folder_id): NON cercare il file su Drive, NON salvare testo piatto.
```

- [ ] **Step 9.2: Replace the MEMORIA DI PROGETTO and GESTIONE BOZZE rules**

Replace only those two rules (keep MEMORIA PROCEDURALE). Change from:

```typescript
MEMORIA DI PROGETTO: se nel contesto c'è '=== PROGETTO ATTIVO ===', continua QUEL lavoro senza ripartire da zero. All'inizio di un lavoro nuovo e articolato chiama imposta_progetto_attivo; man mano aggiorna con aggiorna_progetto (cosa fatto/manca/deciso, file chiave). Vale per POS, preventivi, CME, perizie, relazioni, DDT, pratiche e qualsiasi altra cosa.
GESTIONE BOZZE/DOCUMENTI: NON rigenerare mai un documento da zero se ne esiste già uno — usa lista_bozze e ritrova_bozza per ritrovarlo. Per MODIFICARLO (es. 'aggiungi un paragrafo', 'cambia una voce') usa ritrova_bozza per avere il contenuto, applica SOLO la modifica richiesta preservando tutto il resto, poi aggiorna_bozza(doc_id, contenuto_completo): stesso documento, stesso link. Per SALVARLO/consegnarlo usa salva_bozza_pdf(doc_id, folder_id): NON cercare il file su Drive, NON salvare testo piatto.
```

to:

```typescript
MEMORIA DI PROGETTO: Quando inizi un lavoro su un documento/cantiere (POS, preventivo, perizia, pratica): chiama SUBITO imposta_progetto_attivo con nome, cliente e cantiere. Quando scopri dati chiave (file letti, decisioni, dati anagrafici), chiama aggiorna_progetto. NON è opzionale: è il modo in cui non perdi il lavoro tra i messaggi. Se nel contesto c'è '=== PROGETTO ATTIVO ===', continua QUEL lavoro senza ripartire da zero.
GESTIONE BOZZE/DOCUMENTI: PRIMA di generare un documento che potrebbe già esistere: chiama lista_bozze. Se esiste una bozza, usa ritrova_bozza + aggiorna_bozza (modifica in-place). RIGENERARE da zero un documento esistente è un errore grave: perde le correzioni dell'utente. Per MODIFICARLO (es. 'aggiungi un paragrafo', 'cambia una voce') usa ritrova_bozza per avere il contenuto, applica SOLO la modifica richiesta preservando tutto il resto, poi aggiorna_bozza(doc_id, contenuto_completo): stesso documento, stesso link. Per SALVARLO/consegnarlo usa salva_bozza_pdf(doc_id, folder_id): NON cercare il file su Drive, NON salvare testo piatto.
```

- [ ] **Step 9.3: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep -v "pdf-generator" | grep "error TS" | head -20
```

Expected: no errors (prompts.ts is a string file, TypeScript won't error on string content changes).

---

### Task 10: Commit Group 3

- [ ] **Step 10.1: Run all target tests**

```bash
npx vitest run src/lib/workflow src/lib/working-memory.test.ts src/lib/run-budget.test.ts 2>&1 | tail -30
```

Expected: all pass.

- [ ] **Step 10.2: Commit Group 3**

```bash
git add src/lib/working-memory.ts src/lib/working-memory.test.ts src/lib/prompts.ts
git commit -m "fix(memoria): project_state stale dopo 7gg + regole tool progetto/bozze imperative"
```

---

## Final Verification

### Task 11: Full build + test suite

- [ ] **Step 11.1: Run all target tests one final time**

```bash
npx vitest run src/lib/workflow src/lib/working-memory.test.ts src/lib/run-budget.test.ts 2>&1 | tail -40
```

Expected: all pass (no failures, no new skips).

- [ ] **Step 11.2: Full TypeScript check**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "pdf-generator" | head -20
```

Expected: 0 new errors.

- [ ] **Step 11.3: Production build**

```bash
npm run build 2>&1 | tail -30
```

Expected: build completes successfully (same warnings as before, no new errors).

- [ ] **Step 11.4: Report results**

Report:
- Status of 3 commits (SHA)
- `getStepMetadata` WDK verification: EXISTS — `getStepMetadata(): StepMetadata` where `StepMetadata.attempt: number` is the execution count (1=first run). Export: `workflow` package (via `@workflow/core`).
- Test results summary
- Build result (PASS/FAIL)
- Any doubts or deviations from the plan

---

## Self-Review

**Spec coverage:**
- P0-B /reset zombie run cleanup → Task 1 ✓
- P0-B cron zombie cleanup → Task 2 ✓
- P1-C MAX_RUN_ATTEMPTS=1 → Task 4 ✓
- P1-D WDK native attempt counter → Task 6 ✓
- P1-E abort message update → Task 6 ✓
- P1-E resume notice → Task 6 ✓
- P0-A createRun explicit status → Task 5 ✓
- Memoria stale filter 7gg → Task 8 ✓
- Memoria tests fresh/stale → Task 8 ✓
- Prompt rules imperative → Task 9 ✓

**Placeholders:** None — all code blocks are complete.

**Type consistency:**
- `getStepMetadata` imported from `'workflow'` (verified in node_modules)
- `attempts > MAX_RUN_ATTEMPTS` guard unchanged in logic (cap now=1 means at attempt=2 it aborts, which is "al secondo ingresso" as required)
- `STALE_PROJECT_MS` placed at module level — consistent with other module-level constants in the file
- `count` destructuring in expire-pending — noted two variants; use the one TypeScript accepts cleanly
