/**
 * src/workflows/agent-task-steps.ts — Fase 1b
 *
 * Step WDK del workflow durable dell'agent. Tutto ciò che fa I/O / DB / invii
 * Telegram vive in uno step (mai nel body del workflow).
 */

import { runAgentJob, type AgentJobInput } from '@/lib/agent-job'
import { updateRunStatus, type WorkflowRunStatus } from '@/lib/workflow/runs'

/**
 * Step che esegue il lavoro core dell'agent (loop Claude + invio Telegram +
 * documenti + embedding).
 *
 * maxRetries = 0: il loop NON è idempotente — invia messaggi Telegram ed
 * esegue tool con side-effect. Un retry rifarebbe quegli invii / azioni.
 * Mai ritentare.
 *
 * Nota: nessun hook onStreamSettled — nel path durable non esistono
 * heartbeat/typing legati alla request (li possedeva bgProcess).
 */
export async function runAgentJobStep(input: AgentJobInput): Promise<void> {
  'use step'
  await runAgentJob(input)
}
runAgentJobStep.maxRetries = 0

/**
 * Step che aggiorna lo status del run nel DB (createRun/updateRunStatus sono
 * scritture DB e devono stare in uno step, non nel body del workflow).
 */
export async function markRunStep(id: string, status: WorkflowRunStatus): Promise<void> {
  'use step'
  await updateRunStatus(id, status)
}
