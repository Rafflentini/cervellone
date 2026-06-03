/**
 * src/workflows/agent-task.ts — Fase 1b
 *
 * Workflow durable WDK dell'agent. Orchestrazione PURA: nessun I/O nel body,
 * solo chiamate a step.
 *
 * Flusso: status 'running' → runAgentJobStep(input) → 'done'.
 * Su throw: status 'error' poi rethrow (così WDK marca il run come failed e
 * l'errore resta visibile in observability).
 *
 * Il run nel DB (tabella agent_workflow_runs) è già creato dal chiamante
 * (route Telegram) via createRun({ id: run.runId, ... }) subito dopo start().
 * Qui ci limitiamo agli UPDATE di status, sempre dentro step (markRunStep).
 */

import { getWorkflowMetadata } from 'workflow'

import type { AgentJobInput } from '@/lib/agent-job'
import { runAgentJobStep, markRunStep } from './agent-task-steps'

export async function runAgentTask(input: AgentJobInput): Promise<void> {
  'use workflow'

  const { workflowRunId } = getWorkflowMetadata()

  await markRunStep(workflowRunId, 'running')

  try {
    await runAgentJobStep(input)
  } catch (err) {
    await markRunStep(workflowRunId, 'error')
    throw err
  }

  await markRunStep(workflowRunId, 'done')
}
