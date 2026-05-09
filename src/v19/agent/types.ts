/**
 * Cervellone V19 — Agent loop types
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 5
 */

import type Anthropic from '@anthropic-ai/sdk'

export type Intent = 'chat' | 'generation' | 'agentic'

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'pause_turn'
  | 'stop_sequence'
  | 'refusal'

export type SubagentKind =
  | 'parsing-files'
  | 'numerical-engine'
  | 'document-render'
  | 'domain-italiano'
  | 'web-research'
  | 'gmail-router'

export type AgentRequest = {
  conversationId: string
  messages: Anthropic.MessageParam[]
  system: string
  intent: Intent
  userId: string
  /** Nesting level. 0 = top-level orchestrator, 1 = sub-agent. Hard cap at 1. */
  nesting?: 0 | 1
  parentRunId?: string | null
  /** Optional Telegram streaming sink. */
  telegramStream?: TelegramStreamSink
  /** Optional override of MAX_ITERATIONS (default 30). */
  maxIterations?: number
  /** Optional override of NO_TEXT_LIMIT (default 8). */
  noTextLimit?: number
}

export type AgentResponse = {
  text: string
  containerId: string | null
  artifacts: AgentArtifact[]
  iterations: number
  stopReason: StopReason | 'force_text_synthesis'
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
}

export type AgentArtifact = {
  fileId: string
  filename?: string
  mimeType?: string
  bytes: number
}

/** Streaming sink for Telegram (token deltas + thinking summary + signals). */
export type TelegramStreamSink = {
  push: (text: string) => void
  thinking?: (text: string) => void
  signal?: (kind: 'pause_turn' | 'tool_start' | 'tool_end', label?: string) => void
}

/** Server-side tools (run inside Anthropic infrastructure, not client). */
export const SERVER_SIDE_TOOLS: ReadonlySet<string> = new Set([
  'web_search',
  'web_fetch',
  'code_execution',
  'memory',
])

export function isServerSideTool(name: string): boolean {
  return SERVER_SIDE_TOOLS.has(name)
}

export class HallucinationError extends Error {
  constructor(message: string, public readonly url: string) {
    super(message)
    this.name = 'HallucinationError'
  }
}

export class AgentLoopError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'AgentLoopError'
  }
}
