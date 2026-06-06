/**
 * src/workflows/agent-task-steps.ts — Fase 1b
 *
 * Step WDK del workflow durable dell'agent. Tutto ciò che fa I/O / DB / invii
 * Telegram vive in uno step (mai nel body del workflow).
 */

import { getStepMetadata } from 'workflow'
import { runAgentJob, type AgentJobInput } from '@/lib/agent-job'
import { updateRunStatus, incrementRunAttempts, type WorkflowRunStatus } from '@/lib/workflow/runs'
import { MAX_RUN_ATTEMPTS } from '@/lib/run-budget'
import { sendTelegramMessage } from '@/lib/telegram-helpers'

function telegramFallback(input: AgentJobInput) {
  return { channel: 'telegram' as const, chatId: String(input.chatId), conversationId: input.conversationId }
}

/**
 * Step che esegue il lavoro core dell'agent (loop Claude + invio Telegram +
 * documenti + embedding).
 *
 * maxRetries = 0: il loop NON è idempotente — invia messaggi Telegram ed
 * esegue tool con side-effect. Un retry rifarebbe quegli invii / azioni.
 * Mai ritentare.
 *
 * Anti crash-restart loop (incidente $118 del 4 giu): se WDK ri-esegue questo
 * step dopo un crash dell'esecutore (800s kill), il contatore in DB lo rileva.
 * Al tentativo > MAX_RUN_ATTEMPTS: stop SENZA chiamare Claude.
 *
 * Nota: nessun hook onStreamSettled — nel path durable non esistono
 * heartbeat/typing legati alla request (li possedeva bgProcess).
 */
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
runAgentJobStep.maxRetries = 0

/**
 * Step che aggiorna lo status del run nel DB (createRun/updateRunStatus sono
 * scritture DB e devono stare in uno step, non nel body del workflow).
 *
 * Il fallback cablato garantisce che il recovery insert-then-update di
 * updateRunStatus si attivi in caso di race con createRun.
 */
export async function markRunStep(id: string, status: WorkflowRunStatus, input?: AgentJobInput): Promise<void> {
  'use step'
  await updateRunStatus(id, status, input ? telegramFallback(input) : undefined)
}
