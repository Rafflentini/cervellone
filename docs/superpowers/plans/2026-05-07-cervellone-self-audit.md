# Cervellone — Cron Self-Audit Settimanale (Sub-progetto G)

> **Per agenti:** SKILL OBBLIGATORIA `superpowers:subagent-driven-development` o `superpowers:executing-plans`. Task bite-sized.

**Goal:** Cron Vercel `0 6 * * 1` (lun 8:00 Rome) → report self-audit settimanale strutturato Telegram. Report-only, mai azione autonoma. Pattern identico a memoria-extract.

**Spec:** `docs/superpowers/specs/2026-05-07-cervellone-self-audit-design.md`

**Tech Stack:** Next.js 16, TypeScript, Supabase service key, Anthropic Sonnet 4.6, Vercel cron, vitest.

## File Structure

| File | Tipo | Responsabilità |
|---|---|---|
| `supabase/migrations/2026-05-07-cervellone-self-audit.sql` | Create | Tabella + 3 config keys |
| `src/lib/audit-collector.ts` | Create | 5 funzioni raccolta dati per dimensione |
| `src/lib/audit-collector.test.ts` | Create | Mock supabase per ogni dimensione |
| `src/lib/audit-analyzer.ts` | Create | Thresholds + format Markdown (pure logic) |
| `src/lib/audit-analyzer.test.ts` | Create | Pure logic test (no mock) |
| `src/lib/audit-runner.ts` | Create | Orchestrator: collector + analyzer + Sonnet + Telegram |
| `src/lib/audit-runner.test.ts` | Create | Mock Anthropic + sendTelegramMessage |
| `src/app/api/cron/self-audit/route.ts` | Create | Route Next.js auth + idempotency week-aware |
| `src/app/api/cron/self-audit/route.test.ts` | Create | Test handler |
| `vercel.json` | Modify | Aggiungere `0 6 * * 1` |

## Task 1: Migration SQL

**Files:** Create `supabase/migrations/2026-05-07-cervellone-self-audit.sql`

Contenuto identico §3 spec.

Step 1: crea file. Step 2 (utente): apply via Supabase SQL editor.

Verifica: tabella `cervellone_audit_runs` visibile + 3 row in `cervellone_config` con key `audit_*`.

## Task 2: TDD `audit-collector.ts` — 5 funzioni

**Files:** Create `audit-collector.ts` + `audit-collector.test.ts`

Step 1 RED: 5 describe block:
- `collectModelHealth()` — group by (model, outcome)
- `collectBreakerEvents()` — outcome canary 7gg
- `collectGmailHealth()` — group by (bot_action, day)
- `collectMemoriaRuns()` — runs 7gg + missing dates
- `collectCostEstimate()` — sum llm_cost_estimate_usd 7gg + canary fixed

Per ogni: 2 test (happy + error graceful).

Step 2: implementare con pattern Supabase v2 `{data, error}`. Output:
```ts
export interface DimensionResult<T> { ok: boolean; data?: T; error?: string }
```

Aggregazioni in TS (no GROUP BY in supabase-js — fetch raw + reduce).

## Task 3: TDD `audit-analyzer.ts` — pure logic

**Files:** Create `audit-analyzer.ts` + `audit-analyzer.test.ts`

Step 1: types
```ts
export type Severity = 'high' | 'medium' | 'info'
export interface Anomaly {
  code: string
  severity: Severity
  description: string
  proposed_action: string
  raw?: unknown
}
export interface AnalysisInput {
  modelHealth: ...
  breakerEvents: ...
  gmailHealth: ...
  memoriaRuns: ...
  costEstimate: ...
}
export interface AnalysisResult {
  anomalies: Anomaly[]
  summary: { error_rate_pct: number; total_cost: number; ... }
}
```

Step 2 RED — test pure logic (input/output, no mock):
- error_rate 6% → 1 MODEL_ERROR_HIGH high
- error_rate 4% → 0 anomaly
- 0 notified_critical 5gg working → 1 GMAIL_ALERTS_DEAD
- memoria 1 day error → 1 MEMORIA_ERROR
- missing memoria days → 1 MEMORIA_GAP
- cost > $1/giorno → 1 COST_HIGH
- cost > $10 7d → 1 COST_BUDGET_BREACH
- input clean → 0 anomaly

Step 3: implementare `analyze(input): AnalysisResult` (pure).

Step 4: implementare `formatReport(result, isoWeek, narrative, runId): string` (pure, da template §5 spec).

## Task 4: TDD `audit-runner.ts` — orchestrator

**Files:** Create `audit-runner.ts` + `audit-runner.test.ts`

Step 1 RED — mock collector + Anthropic + sendTelegramMessage + supabase:
- happy path: 2 anomalie → narrative LLM ok → telegram inviato → run status='ok'
- LLM error: Anthropic throw → fallback narrative → telegram inviato → status='ok'
- collector error: 1 dim fail → log warn + procede con 4 → no abort
- 0 anomalie: report "Nessuna anomalia rilevata" → telegram inviato

Step 2: implementare `runAudit(): {ok, run_id, anomalies_count, error?}`:
1. Compute iso_week (`YYYY-Www`)
2. INSERT cervellone_audit_runs (status='started', iso_week)
3. `Promise.allSettled` 5 collector
4. analyze(input) → AnalysisResult
5. Sonnet narrative (try/catch → fallback statico)
6. formatReport(...)
7. sendTelegramMessage(chatId, report)
8. UPDATE run status='ok', anomalies_count, dimensions_json, anomalies_json, report_text, llm_tokens_used, llm_cost_estimate_usd
9. Return

Su throw post-INSERT: UPDATE status='error', error_message.

Sonnet prompt:
```
Sei un assistente che produce sintesi tecniche concise.
Dato l'input strutturato, genera 2-4 frasi in italiano che descrivono
lo stato della settimana, indicando anomalie principali se presenti.
NON inventare anomalie: usa solo quelle nell'input. Tono neutro fattuale.
Input: { iso_week, anomalies: [...], summary: {...} }
Output: solo testo markdown-safe, no JSON, no code block.
```
max_tokens 400.

Fallback narrative se LLM fail: `anomalies.length>0 ? "Settimana con N anomalie rilevate (vedi sotto)." : "Settimana stabile, nessuna anomalia."`

## Task 5: Route `/api/cron/self-audit/route.ts`

**Files:** Create + test.

Pattern identico a `memoria-extract/route.ts`:
- Auth Bearer CRON_SECRET (401 else)
- Silent mode (`audit_silent_until`)
- Idempotency week-aware: ISO week(today) vs `audit_last_run_week` config
- `runAudit()`
- UPDATE config `audit_last_run_week = currentISOWeek`

Helper `getISOWeek(date: Date): string` → `YYYY-Www`.

## Task 6: vercel.json schedule

Aggiungi:
```json
{ "path": "/api/cron/self-audit", "schedule": "0 6 * * 1" }
```

Validazione: `crons` array di 6 entry totali (5 esistenti + audit).

## Task 7: Push + verifica deploy + smoke

Step 1: `npx vitest run` su tutti i nuovi test → green.
Step 2: `npx tsc --noEmit` → clean.
Step 3: commit + push.
Step 4: verifica deploy READY.
Step 5: smoke T1-T7 §7 spec.
Step 6: DoD checklist §8 spec.

**Effort totale stimato: ~3.5 ore.**

## Stima Effort per Task

| Task | Effort |
|---|---|
| 1 Migration | 10 min |
| 2 collector + test | 50 min |
| 3 analyzer + format + test | 45 min |
| 4 runner + test | 45 min |
| 5 route + test | 25 min |
| 6 vercel.json | 5 min |
| 7 push + DoD | 30 min |
| **Totale** | **~3.5h** |
