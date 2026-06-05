/**
 * src/workflows/agent-task.ts — Fase 1b
 *
 * Workflow durable WDK dell'agent. Orchestrazione PURA: nessun I/O nel body,
 * solo chiamate a step.
 *
 * Flusso: status 'running' → runAgentJobStep(runId, input) → 'done'.
 * Su throw: status 'error' poi rethrow (così WDK marca il run come failed e
 * l'errore resta visibile in observability).
 *
 * Il run nel DB (tabella agent_workflow_runs) è già creato dal chiamante
 * (route Telegram) via createRun({ id: run.runId, ... }) subito dopo start().
 * Qui ci limitiamo agli UPDATE di status, sempre dentro step (markRunStep).
 *
 * Il run può anche essere ricreato dal fallback cablato in markRunStep (race
 * createRun rilevato da updateRunStatus). Lo step core ha guard anti-loop
 * (incrementRunAttempts + cap MAX_RUN_ATTEMPTS) che impedisce crash-restart loop.
 */

import { getWorkflowMetadata } from 'workflow'

import type { AgentJobInput } from '@/lib/agent-job'
import { runAgentJobStep, markRunStep } from './agent-task-steps'

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
