# Esecuzione Durable Fase 1 (Workflow DevKit) — Implementation Plan

> **For agentic workers:** usare superpowers:subagent-driven-development o executing-plans. Steps con checkbox per tracking. **NB Next.js non-standard**: prima di scrivere codice WDK, leggere la doc del pacchetto `workflow` installato e `node_modules/next/dist/docs/` (vedi AGENTS.md). Le firme API WDK nel piano sono indicative → verificarle contro il pacchetto reale.

**Goal:** spostare i task lunghi del bot fuori dalla funzione serverless (tetto 800s) in workflow durable WDK, zero-timeout, con progress + notifica fine, dietro feature flag OFF.

**Architecture:** classificatore all'ingresso (già esiste `classifyTask`); task veloci → path in-process attuale; task lunghi → `start(runAgentTask)` (`'use workflow'`), step checkpointati, notifica al canale d'origine. Flag `cervellone_config.durable_workflows_enabled` (default OFF → comportamento odierno invariato).

**Tech Stack:** Next.js (Vercel), Vercel Workflow DevKit (`workflow` SDK), Supabase, Anthropic SDK.

**Prerequisiti (mattino):** Supabase MCP autorizzato (per migrazione + flag).

---

### Task 1: Install Workflow SDK + scaffold + enable
**Files:** Modify `package.json` (autorizzato), Create `src/lib/workflow/hello.ts`, Modify `vercel.json` se richiesto da WDK.
- [ ] Leggere doc WDK ufficiale + pacchetto. `npm i workflow`.
- [ ] Creare un workflow "hello" minimo (`'use workflow'`) che ritorna una stringa, per validare build+deploy del runtime WDK su **preview**.
- [ ] Deploy preview → verificare che il workflow si registri/esegua. Acceptance: hello workflow eseguibile su preview, build verde.
- [ ] Commit.

### Task 2: Migrazione tabella run-tracking (richiede Supabase)
**Files:** Create `supabase/migrations/2026-06-03-agent-workflow-runs.sql`
- [ ] Tabella `agent_workflow_runs`: `id` (run id WDK), `channel` ('telegram'|'web'), `chat_id` text null, `conversation_id` uuid null, `status` ('running'|'paused'|'done'|'error'), `created_at`, `updated_at`. RLS abilitata (service_role only, coerente con hardening RLS).
- [ ] Applicare via Supabase MCP. Acceptance: tabella presente, RLS on.
- [ ] Commit (file SQL).

### Task 3: Feature flag + classificatore routing
**Files:** Modify `src/app/api/telegram/route.ts`, `src/app/api/chat/route.ts`, Create `src/lib/workflow/should-use-durable.ts`
- [ ] Helper `shouldUseDurable(userText, fileBlocks)`: legge `cervellone_config.durable_workflows_enabled` (default false se assente) AND `classifyTask(...) === long`.
- [ ] Nel route: se `shouldUseDurable` → `start(runAgentTask, input)` + rispondi "Ci penso, ti aggiorno"; else path attuale. Con flag OFF: SEMPRE path attuale (zero regressione).
- [ ] Test: con flag assente, comportamento identico a oggi. Acceptance: flag OFF = no-op.
- [ ] Commit.

### Task 4: runAgentTask come workflow durable
**Files:** Create `src/lib/workflow/agent-task.ts` (`'use workflow'`), estrarre il loop agentico riusabile da `bgProcess` in `src/app/api/telegram/route.ts`.
- [ ] Estrarre la logica del loop (Claude turn + executeToolBlocks) in una funzione riusabile, chiamabile sia da bgProcess (path veloce) sia dal workflow.
- [ ] `runAgentTask` esegue il loop come step durable (ogni turno Claude + ogni tool pesante = step con retry). Verificare API step WDK contro pacchetto.
- [ ] Acceptance: un task simulato lungo (>800s di lavoro spezzato in step) completa su preview senza timeout.
- [ ] Commit.

### Task 5: Progress + notifica fine
**Files:** Modify `src/lib/workflow/agent-task.ts`, Create `src/lib/workflow/notifier.ts`
- [ ] Step notifier: invia update al canale d'origine (telegram chat_id o web conversation_id) a milestone + risultato finale. Aggiorna `agent_workflow_runs.status`.
- [ ] Acceptance: su preview, progress visibile + notifica finale fire-and-forget.
- [ ] Commit.

### Task 6: Validazione preview + stage
- [ ] Deploy preview, run end-to-end del task "upload multi-file Drive" (il caso Ducato): > vecchio 800s, completa, notifica.
- [ ] Crash simulato a metà → resume da checkpoint.
- [ ] Lasciare flag `durable_workflows_enabled` OFF in prod. Acceptance: prod invariato (flag off); preview valida.

### Fase 1.5 (dopo v1)
- Hook `Approval.wait` per `/fic_ok_`, `/ok2_`, `/accesso_ok_` (pausa senza compute).
- Cap costo/step per-workflow → pausa-e-chiede.

## Self-review
- Copertura spec: classificatore (T3), durable loop (T4), progress/notifica (T5), flag/rollout (T3/T6), hook+cap (1.5 differita). OK.
- Dipendenze: T2 (Supabase) e T1 (package.json) sono prerequisiti autorizzati. T4 richiede verifica API WDK reale.
- Rischio: API WDK esatte da verificare in implementazione (segnalato nell'header).

## Esecuzione (domani)
Manovalanza: Codex (.loop/queue) o subagenti; Claude rivede/mergia/valida preview. Flag acceso dall'utente dopo validazione.
