/**
 * src/workflows/agent-task-steps.ts — Fase 1b
 *
 * Step WDK del workflow durable dell'agent. Tutto ciò che fa I/O / DB / invii
 * Telegram vive in uno step (mai nel body del workflow).
 */

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
