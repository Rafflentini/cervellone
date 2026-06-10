# Durable Fase 2 — Eliminazione del timeout su task lunghe

**Data:** 2026-06-10
**Binario:** B (durable). Indipendente dal binario A (auto-debrief).
**Flag:** `durable_workflows_enabled` (già esistente, default OFF in prod).
**Decisioni brainstorming (Raffaele, 10 giu):** step per iterazione WDK-nativo · heartbeat +
messaggio finale (no streaming live sul durable) · idempotenza mirata sui tool irreversibili.

## Problema

La Fase 1 durable (in prod, flag OFF) è **un solo step monolitico** `runAgentJobStep`
(`src/workflows/agent-task-steps.ts`) che racchiude l'intero loop agentico a 10 iterazioni
(`callClaudeStreamTelegram` in `src/lib/claude.ts`). **Zero checkpoint tra i turni del modello.**
Se Vercel uccide lo step a 800s (`vercel.json` `maxDuration: 800`), WDK ri-esegue lo step **da
zero**, e il guard `MAX_RUN_ATTEMPTS=1` lo aborta al 2° ingresso (il cerotto che fermò i $118 del
4 giu). Risultato: una task lunga **o finisce in un colpo <800s, o viene abortita**. Non è
zero-timeout.

## Fatti accertati (recon 10 giu)

- **Il WDK Vercel è reale e installato**: `workflow@4.3.1` + `@workflow/core@4.3.1`. Primitive
  disponibili: direttive `'use workflow'`/`'use step'`, `start()` (`workflow/api`),
  `getStepMetadata()` (`.attempt`, `.stepId`), `getWorkflowMetadata()`, `createHook()/resumeHook()`,
  `sleep()`. Proprietà step: `maxRetries`, `timeout`, `maxDuration`. Trigger.dev è in package.json
  ma **abbandonato/inutilizzato**.
- **Garanzia event-sourcing WDK**: il valore di ritorno di uno step committato è journaled e
  **replay-ato** al resume — lo step NON viene ri-eseguito (niente seconda chiamata Claude). È il
  cardine dell'intera soluzione → **task-0 lo verifica sul campo** prima del refactor vero.
- **Cucitura naturale del loop**: fine di ogni iterazione (`src/lib/claude.ts:693-698`). Stato
  serializzabile: `currentMessages[]`, `accUsage`, `iterations`, `fullResponse`, `totalToolCalls`.
- **Ostacoli**: (a) streaming `onChunk` non serializzabile; (b) tool-write non idempotenti
  (`uploadBinaryToDrive` crea un file nuovo a ogni run, invio mail); (c) budget cumulativo tra step.

## Soluzione: un `'use step'` per iterazione

Il loop agentico monolitico diventa una sequenza di step WDK, **uno per iterazione del modello**.
Il journal WDK committa ogni turno; al crash WDK replay-a le iterazioni già fatte (senza
ri-chiamare Claude) e riparte dall'ultima. Ogni step sta sotto 800s → il workflow dura quanto
serve. Elimina **insieme** il timeout e il re-run-da-zero.

### 1. Refactor `claude.ts`: estrarre l'iterazione pura

Estrarre il corpo di **una singola iterazione** del loop in una funzione riusabile:
```ts
runOneIteration(params: {
  model, systemBlocks, messages, tools, runBudgetState, ...
}): Promise<{
  assistantMessage: Anthropic.MessageParam,   // assistant content (text + tool_use)
  toolResults: Anthropic.MessageParam | null,  // user/tool_result, null se end_turn
  usageDelta: UsageTokens,
  stopReason: string,
  text: string,                                 // testo prodotto in questa iterazione
}>
```
- **Path veloce (non-durable): INVARIATO.** `callClaudeStreamTelegram`/`callClaudeStream` continuano
  a chiamare il loop in-process con streaming live `onChunk`. Si rifattorizzano internamente per
  usare `runOneIteration`, ma comportamento esterno identico (regressione zero — copertura test).
- **Path durable:** ogni `runOneIteration` viene avvolta in uno step (sotto).

`runOneIteration` deve essere **pura** rispetto allo streaming: non chiama `onChunk` (lo streaming
resta nel wrapper veloce). Restituisce il testo, il chiamante decide cosa farne.

### 2. Workflow body orchestratore

`runAgentTask(input)` (`src/workflows/agent-task.ts`, `'use workflow'`):
```
markRunStep('running')
messages = buildInitialMessages(input)
accUsage = {}
for (i = 0; i < MAX_ITERATIONS; i++) {
  if (isRunOverBudget(accUsage, input.maxRunTokens)) break         // budget cumulativo nel body
  const r = await runAgentIterationStep(runId, i, { messages, ... }) // 'use step', committato
  messages.push(r.assistantMessage)
  if (r.toolResults) messages.push(r.toolResults)
  accUsage = addUsage(accUsage, r.usageDelta)
  await heartbeat(input, statusFor(r))                             // aggiornamento di stato robusto
  if (!r.toolResults || r.stopReason === 'end_turn') break
}
await sendFinalMessage(input, messages)                            // messaggio completo a fine lavoro
recordOutcome(...)                                                  // una volta sola, qui
markRunStep('done')
```
Lo **stato vive nel journal del workflow body** (`messages`, `accUsage`), non in Supabase: nessun
contatore custom, il budget cumulativo è corretto attraverso gli step.

### 3. `runAgentIterationStep` — `'use step'`

```ts
async function runAgentIterationStep(runId, iter, state): Promise<IterationResult> {
  'use step'
  return await runOneIteration(state)   // I/O reale (Claude + tool) qui dentro
}
runAgentIterationStep.maxRetries = 0    // no auto-retry: un crash → resume fresco, non loop
```
Il risultato (serializzabile) viene committato dal WDK. Al replay, ritorna dal journal.

### 4. Heartbeat + messaggio finale (no streaming live sul durable)

- Tra gli step, `heartbeat()` manda/edita un messaggio di stato robusto e idempotente per step
  (`⚙️ Sto leggendo il DVR…`, `Genero il PDF…`) — testo derivato dai tool dell'iterazione, così un
  replay produce lo stesso heartbeat (nessun duplicato problematico).
- A fine workflow, `sendFinalMessage` invia il testo completo accumulato.
- Lo streaming token-per-token resta **solo** sul path veloce interattivo.

### 5. Idempotenza mirata sui tool irreversibili

Nuova tabella `tool_idempotency (run_id text, iteration int, tool_use_id text, result jsonb,
created_at timestamptz, PRIMARY KEY (run_id, tool_use_id))`. Wrapper `withIdempotency(key, fn)`:
- Solo i tool con effetti irreversibili: `uploadBinaryToDrive` (PDF/DOCX/XLSX → Drive),
  `send_email`/forward (V19 IMAP/SMTP + Gmail), trasmissione bozze.
- Prima dell'esecuzione: se la key esiste → ritorna `result` salvato (no ri-esecuzione).
- Dopo l'esecuzione: salva `result` sotto la key.
- I tool di sola lettura **non** sono wrappati (re-run innocuo).

### 6. Task-0 — hello-workflow di prova (PRIMA del refactor vero)

Micro workflow `src/workflows/hello-replay.ts` con 2 step: step1 logga un timestamp/contatore in
una tabella e ritorna un valore; il workflow body lo chiama, poi un secondo step. Test sul campo
(preview): forzare un kill tra step1 e step2 (o redeploy) e verificare nei log/DB che **step1 NON
viene ri-eseguito** al resume (il contatore non incrementa due volte). Conferma la garanzia di
replay prima di investire nel refactor del loop. Rimovibile dopo la verifica.

## File toccati (binario B — NON tocca `working-memory.ts`)

- `src/lib/claude.ts` — estrazione `runOneIteration`; `callClaude*` rifattorizzate internamente,
  comportamento esterno invariato.
- `src/workflows/agent-task.ts` — workflow body orchestratore a step + heartbeat + finale +
  budget cumulativo.
- `src/workflows/agent-task-steps.ts` — `runAgentIterationStep` (`'use step'`); guard
  `MAX_RUN_ATTEMPTS` resta come rete globale.
- `src/lib/agent-job.ts` — separazione del ramo durable (orchestrazione via workflow) dal ramo
  veloce (loop in-process). **Hook auto-debrief del binario A resta a fine `runAgentJob`,
  intoccato.**
- `src/lib/tools.ts` — wrapper `withIdempotency` sui soli tool-write (sezione tool-write;
  **nessun** tocco alla sezione working-memory del binario A).
- `src/lib/run-budget.ts` — eventuale helper budget cumulativo (la logica resta).
- `src/workflows/hello-replay.ts` — **nuovo**, task-0, rimovibile.
- `supabase/migrations/2026-06-10-tool-idempotency.sql` — tabella `tool_idempotency`.

## Testing (TDD)

Unit (Claude mockato, zero API vere):
- `runOneIteration` deterministica: dato un mock di risposta modello → result atteso (assistant +
  toolResults + usageDelta + stopReason).
- accumulo `messages`/budget attraverso step simulati (3 iterazioni mockate → messages corretto,
  budget cumulativo, break su end_turn).
- `withIdempotency`: miss → esegue e salva; hit → ritorna cached, NON esegue.
- heartbeat: replay della stessa iterazione → stesso heartbeat (no duplicato).
- Riuso/estensione delle spec **S1** già in `COLLAB.md` per lo stress test anti-runaway.

Stress (test-only + task-0 sul campo): kill a metà iterazione → resume riparte dall'ultima
committata, zero ri-chiamate Claude sulle iterazioni precedenti, zero tool-write duplicati.

## Rollout

Dietro `durable_workflows_enabled` + classificatore `shouldUseDurable` (solo task lunghe). Path
veloce interattivo **identico**. `MAX_RUN_ATTEMPTS` resta come rete di sicurezza (ora quasi mai
necessaria). Rollback = flag OFF. Ordine: **task-0 (prova replay) → refactor `runOneIteration` →
workflow a step → idempotenza → stress test**.
