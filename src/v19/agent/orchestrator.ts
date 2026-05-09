/**
 * Cervellone V19 — Multi-agent orchestrator
 *
 * Pattern: parent agent (capo) delega via tool spawn_subagent a sub-agent
 * specialist (parsing/numerical/document/domain/web/gmail). Sub-agent ritornano
 * SOLO summary (no transcript). Nesting cap a 1 livello.
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 6
 */

import type Anthropic from '@anthropic-ai/sdk'
import { runAgent, type AgentRunOptions, type ToolExecutor } from './loop'
import { filterToolsForSubagent, getSubagentDefinition } from './subagent-registry'
import type { AgentArtifact, AgentRequest, SubagentKind } from './types'

export type SpawnSubagentInput = {
  kind: SubagentKind
  task: string
  input_files?: string[] // Anthropic file_id da passare come container_upload
}

export type SpawnSubagentResult = {
  summary: string
  artifacts: AgentArtifact[]
  iterations: number
  inputTokens: number
  outputTokens: number
}

/** Definizione del tool spawn_subagent visibile all'orchestrator. */
export const SPAWN_SUBAGENT_TOOL: Anthropic.Tool = {
  name: 'spawn_subagent',
  description:
    'Spawn sub-agent specializzato per task indipendente. Ritorna SOLO summary, non transcript completo. Usa per task con >3 step o tool molto specializzati. Nesting massimo 1 livello (i sub-agent NON possono spawnare altri sub-agent).',
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['parsing-files', 'numerical-engine', 'document-render', 'domain-italiano', 'web-research', 'gmail-router'],
        description: 'Specialità del sub-agent.',
      },
      task: {
        type: 'string',
        description: 'Descrizione completa del task da delegare. Includi tutto il contesto necessario, perché il sub-agent NON vede il resto della conversazione.',
      },
      input_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Eventuali file_id Anthropic da passare al sub-agent (opzionale).',
      },
    },
    required: ['kind', 'task'],
  },
}

export type OrchestratorContext = {
  /** Tool definitions disponibili nell'orchestrator (per filtraggio sub-agent). */
  allToolDefinitions: Anthropic.Tool[]
  /** Tool executor che dispatcha le tool calls non server-side. */
  toolExecutor: ToolExecutor
  /** ID conversazione Telegram/web (per persistence). */
  conversationId: string
  /** ID utente (per memory namespacing). */
  userId: string
  /** Per test: noPersist + skip hallucination. */
  testMode?: boolean
}

/**
 * Esegui sub-agent in contesto isolato. Hard cap nesting=1.
 */
export async function spawnSubagent(
  input: SpawnSubagentInput,
  parent: { runId?: string | null; ctx: OrchestratorContext },
): Promise<SpawnSubagentResult> {
  const def = getSubagentDefinition(input.kind)
  const subTools = filterToolsForSubagent(parent.ctx.allToolDefinitions, input.kind)
  const subMessages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: [
        ...(input.input_files ?? []).map((fid) => ({
          type: 'container_upload' as const,
          file_id: fid,
        })),
        { type: 'text' as const, text: input.task },
      ],
    },
  ]

  const subReq: AgentRequest = {
    conversationId: `${parent.ctx.conversationId}::sub::${input.kind}::${Date.now()}`,
    messages: subMessages,
    system: def.systemPrompt,
    intent: 'agentic',
    userId: parent.ctx.userId,
    nesting: 1,
    parentRunId: parent.runId ?? null,
  }

  const opts: AgentRunOptions = {
    toolDefinitions: subTools,
    toolExecutor: makeNoSpawnExecutor(parent.ctx.toolExecutor),
    noPersist: parent.ctx.testMode,
    hallucination: parent.ctx.testMode ? { skip: true } : undefined,
  }

  const res = await runAgent(subReq, opts)

  return {
    summary: res.text,
    artifacts: res.artifacts,
    iterations: res.iterations,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  }
}

/**
 * Wrapper sopra il toolExecutor base che blocca chiamate a spawn_subagent
 * (i sub-agent NON possono spawnare altri sub-agent).
 */
function makeNoSpawnExecutor(base: ToolExecutor): ToolExecutor {
  return async (toolUse, conversationId) => {
    if (toolUse.name === 'spawn_subagent') {
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        is_error: true,
        content: 'Nesting cap raggiunto: i sub-agent NON possono spawnare altri sub-agent. Risolvi il task inline o ritorna al parent.',
      }
    }
    return base(toolUse, conversationId)
  }
}

/**
 * Costruisce il toolExecutor dell'orchestrator: gestisce spawn_subagent
 * trasformandolo in chiamata a `spawnSubagent`, e delega tutto il resto al
 * baseExecutor.
 */
export function buildOrchestratorExecutor(
  ctx: OrchestratorContext,
  parentRunId: string | null,
  baseExecutor: ToolExecutor,
): ToolExecutor {
  return async (toolUse, conversationId) => {
    if (toolUse.name === 'spawn_subagent') {
      try {
        const input = toolUse.input as unknown as SpawnSubagentInput
        const res = await spawnSubagent(input, { runId: parentRunId, ctx })
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: [
            { type: 'text', text: `Sub-agent ${input.kind} completato in ${res.iterations} iter (${res.inputTokens}+${res.outputTokens} tok).` },
            { type: 'text', text: `\n\nSUMMARY:\n${res.summary}` },
            ...(res.artifacts.length > 0
              ? [{ type: 'text' as const, text: `\n\nArtifacts: ${res.artifacts.map(a => a.fileId).join(', ')}` }]
              : []),
          ],
        }
      } catch (err) {
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          is_error: true,
          content: `spawn_subagent error: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
    return baseExecutor(toolUse, conversationId)
  }
}

/** Aggiungi spawn_subagent ai tool definitions dell'orchestrator. */
export function withSpawnSubagentTool(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.some((t) => t.name === 'spawn_subagent')) return tools
  return [...tools, SPAWN_SUBAGENT_TOOL]
}
