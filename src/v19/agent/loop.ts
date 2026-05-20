/**
 * Cervellone V19 — Agent reasoning loop
 *
 * Conforme a spec sez. 5: adaptive thinking, output_config xhigh/high,
 * MAX_ITER 30, NO_TEXT 8, gestione pause_turn, capture output code_execution,
 * container persistence, hallucination validator runtime.
 *
 * Sostituisce src/lib/claude.ts (V18) per il dominio V19.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropicClient } from './anthropic-client'
import {
  loadContainerId,
  saveContainerId,
  startAgentRun,
  completeAgentRun,
  persistArtifact,
} from './persist'
import {
  runHallucinationValidator,
  type HallucinationCheckOptions,
} from './hallucination-validator'
import {
  isServerSideTool,
  type AgentArtifact,
  type AgentRequest,
  type AgentResponse,
  type Intent,
  type StopReason,
} from './types'

const MAX_ITERATIONS_DEFAULT = 30
const NO_TEXT_LIMIT_DEFAULT = 8
const MAX_TOKENS_OPUS = 64_000

export type ToolExecutor = (
  toolUse: Anthropic.ToolUseBlock,
  conversationId: string,
) => Promise<Anthropic.ToolResultBlockParam>

export type AgentRunOptions = {
  client?: Anthropic
  toolDefinitions?: Anthropic.Tool[]
  toolExecutor?: ToolExecutor
  hallucination?: HallucinationCheckOptions
  /** Per test: rendere deterministico il loop. */
  noPersist?: boolean
}

const MODEL = 'claude-opus-4-7'

export async function runAgent(
  req: AgentRequest,
  opts: AgentRunOptions = {},
): Promise<AgentResponse> {
  const client = opts.client ?? getAnthropicClient()
  const maxIterations = req.maxIterations ?? MAX_ITERATIONS_DEFAULT
  const noTextLimit = req.noTextLimit ?? NO_TEXT_LIMIT_DEFAULT
  const tools = opts.toolDefinitions ?? []
  const toolExecutor = opts.toolExecutor ?? defaultToolExecutorRejecting

  const runId = opts.noPersist
    ? null
    : await startAgentRun({
        conversationId: req.conversationId,
        parentRunId: req.parentRunId ?? null,
        kind: req.nesting === 1 ? 'parsing-files' /* placeholder for sub-agent */ : 'orchestrator',
        intent: req.intent,
      })

  let containerId = opts.noPersist
    ? null
    : await loadContainerId(req.conversationId)

  const messages: Anthropic.MessageParam[] = [...req.messages]
  let consecutiveNoText = 0
  let fullResponse = ''
  let iterations = 0
  let stopReason: StopReason | 'force_text_synthesis' = 'end_turn'
  let inputTokens = 0
  let outputTokens = 0
  let thinkingTokens = 0
  const artifacts: AgentArtifact[] = []

  try {
    for (let i = 0; i < maxIterations; i++) {
      iterations = i + 1

      const apiArgs = buildCreateArgs({
        model: MODEL,
        intent: req.intent,
        system: req.system,
        messages,
        tools,
        containerId,
      })

      const stream = await client.beta.messages.stream(apiArgs)

      let textInIter = false
      for await (const event of stream as AsyncIterable<Anthropic.MessageStreamEvent>) {
        if (event.type === 'content_block_delta') {
          const d: any = event.delta
          if (d.type === 'text_delta' && typeof d.text === 'string') {
            fullResponse += d.text
            textInIter = true
            req.telegramStream?.push(d.text)
          } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
            req.telegramStream?.thinking?.(d.thinking)
            thinkingTokens += approxTokens(d.thinking)
          }
        }
      }

      const final = await stream.finalMessage()
      stopReason = (final.stop_reason as StopReason) ?? 'end_turn'

      // Token accounting
      inputTokens += final.usage?.input_tokens ?? 0
      outputTokens += final.usage?.output_tokens ?? 0

      // Container persistence
      const newContainer = (final as any).container?.id
      if (typeof newContainer === 'string') containerId = newContainer

      // Append assistant content to history (cast: beta types include MCP variants
      // not in main ContentBlock union; safe per uso V19).
      messages.push({ role: 'assistant', content: final.content as any })

      // Capture code_execution output (file artifacts)
      await captureCodeExecutionArtifacts(client, final.content as any, {
        conversationId: req.conversationId,
        artifacts,
        noPersist: opts.noPersist,
      })

      // pause_turn: continue without modifications
      if (stopReason === 'pause_turn') {
        req.telegramStream?.signal?.('pause_turn')
        consecutiveNoText = textInIter ? 0 : consecutiveNoText + 1
        continue
      }

      // end_turn / stop_sequence / max_tokens / refusal: break
      if (stopReason === 'end_turn' || stopReason === 'stop_sequence' || stopReason === 'refusal' || stopReason === 'max_tokens') {
        break
      }

      // tool_use
      if (stopReason === 'tool_use') {
        const toolUseBlocks = final.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        )
        const clientTools = toolUseBlocks.filter((b) => !isServerSideTool(b.name))

        if (clientTools.length === 0) {
          // tutti server-side, continua loop senza pushare tool_result
          consecutiveNoText = textInIter ? 0 : consecutiveNoText + 1
          continue
        }

        const toolResults: Anthropic.ToolResultBlockParam[] = []
        for (const tu of clientTools) {
          req.telegramStream?.signal?.('tool_start', tu.name)
          try {
            const result = await toolExecutor(tu, req.conversationId)
            toolResults.push(result)
          } catch (err) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tu.id,
              is_error: true,
              content: `Tool ${tu.name} error: ${err instanceof Error ? err.message : String(err)}`,
            })
          } finally {
            req.telegramStream?.signal?.('tool_end', tu.name)
          }
        }
        messages.push({ role: 'user', content: toolResults })
        consecutiveNoText = textInIter ? 0 : consecutiveNoText + 1
        continue
      }

      // Stop reason sconosciuto: trattalo come end_turn (defensive)
      break
    }

    // NO_TEXT_LIMIT force-text synthesis
    if (consecutiveNoText >= noTextLimit && fullResponse.trim().length === 0) {
      const synth = await client.messages.create({
        model: MODEL,
        max_tokens: 8_000,
        system: req.system,
        messages: [
          ...messages,
          { role: 'user', content: 'Sintetizza ora una risposta finale per l\'utente in italiano (Lei).' },
        ],
        tool_choice: { type: 'none' },
      })
      const synthText = synth.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as any).text as string)
        .join('')
      fullResponse += synthText
      stopReason = 'force_text_synthesis'
    }

    // Hallucination validator (post-loop)
    await runHallucinationValidator(fullResponse, opts.hallucination)

    // Persist
    if (!opts.noPersist) {
      await saveContainerId(req.conversationId, containerId)
      await completeAgentRun({
        runId,
        status: 'completed',
        containerId,
        iterations,
        inputTokens,
        outputTokens,
        thinkingTokens,
        summary: req.nesting === 1 ? fullResponse : undefined,
      })
    }

    return {
      text: fullResponse,
      containerId,
      artifacts,
      iterations,
      stopReason,
      inputTokens,
      outputTokens,
      thinkingTokens,
    }
  } catch (err) {
    if (!opts.noPersist) {
      await completeAgentRun({
        runId,
        status: 'failed',
        containerId,
        iterations,
        inputTokens,
        outputTokens,
        thinkingTokens,
        errorMessage: err instanceof Error ? err.message : String(err),
      })
    }
    throw err
  }
}

type CreateArgsInput = {
  model: string
  intent: Intent
  system: string
  messages: Anthropic.MessageParam[]
  tools: Anthropic.Tool[]
  containerId: string | null
}

function buildCreateArgs(input: CreateArgsInput): any {
  // Opus 4.7 NON accetta thinking.budget_tokens ne' temperature/top_p/top_k.
  // Usa thinking adaptive + output_config.effort.
  const args: any = {
    model: input.model,
    max_tokens: MAX_TOKENS_OPUS,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: {
      effort: input.intent === 'chat' ? 'high' : 'xhigh',
    },
    system: input.system,
    messages: input.messages,
    tools: input.tools,
  }
  if (input.containerId) {
    args.container = input.containerId
  }
  return args
}

async function captureCodeExecutionArtifacts(
  client: Anthropic,
  content: Anthropic.ContentBlock[],
  args: { conversationId: string; artifacts: AgentArtifact[]; noPersist?: boolean },
): Promise<void> {
  for (const block of content) {
    if ((block as any).type !== 'code_execution_tool_result') continue
    const results = (block as any).content?.content ?? []
    for (const item of results) {
      if (item.type !== 'file') continue
      const fileId: string = item.file_id
      try {
        let bytes = 0
        let filename: string | undefined
        let mimeType: string | undefined
        if (!args.noPersist) {
          const resp = await (client as any).beta.files.retrieveMetadata?.(fileId)
          filename = resp?.filename
          mimeType = resp?.mime_type
          bytes = resp?.size_bytes ?? 0
        }
        const artifact: AgentArtifact = { fileId, filename, mimeType, bytes }
        args.artifacts.push(artifact)
        if (!args.noPersist) {
          await persistArtifact(args.conversationId, artifact)
        }
      } catch (err) {
        console.warn('[v19/loop] captureCodeExecution failed for file', fileId, err)
      }
    }
  }
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

async function defaultToolExecutorRejecting(
  toolUse: Anthropic.ToolUseBlock,
): Promise<Anthropic.ToolResultBlockParam> {
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    is_error: true,
    content: `Nessun executor registrato per il tool '${toolUse.name}' nel loop V19.`,
  }
}
