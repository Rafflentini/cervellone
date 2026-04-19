/**
 * lib/claude.ts — Motore Cervellone v2
 * 
 * Fix integrati: REL-003 (retry), PER-004 (max iterations 10),
 * sanitization, safe logging, fault tolerance.
 */

import Anthropic from '@anthropic-ai/sdk'
import { getToolDefinitions, executeTool } from './tools'
import { searchMemory, saveMessageWithEmbedding } from './memory'
import { sanitizeForStorage } from './sanitize'
import { logInfo, logWarn, logError } from './sanitize'
import { withRetry, safeSupabase } from './resilience'
import { supabase } from './supabase'

const client = new Anthropic()

// ── Config dinamica da Supabase ──

interface ModelConfig {
  model: string
  thinkingBudget: number
  maxTokens: number
}

// Cache config per 60 secondi
let configCache: { model: string } | null = null
let configCacheTime = 0
const CONFIG_TTL = 60_000

export async function getConfig(): Promise<{ model: string }> {
  if (configCache && Date.now() - configCacheTime < CONFIG_TTL) return configCache

  const { data } = await supabase
    .from('cervellone_config')
    .select('key, value')
    .in('key', ['model_default'])

  let model = 'claude-opus-4-6'
  if (data) {
    for (const row of data) {
      if (row.key === 'model_default') model = String(row.value).replace(/"/g, '')
    }
  }

  configCache = { model }
  configCacheTime = Date.now()
  return configCache
}

export function invalidateConfigCache() {
  configCache = null
  configCacheTime = 0
}

export interface ClaudeRequest {
  messages: Anthropic.MessageParam[]
  systemPrompt: string
  userQuery: string
  conversationId?: string
  hasFiles?: boolean
}

export interface ClaudeStreamCallbacks {
  onText: (text: string) => void
  onToolStart?: (toolName: string) => void
}

// ── Streaming (chat web) ──

export async function callClaudeStream(
  request: ClaudeRequest,
  callbacks: ClaudeStreamCallbacks,
): Promise<string> {
  const { systemPrompt, userQuery, conversationId } = request

  const memoryContext = await searchMemory(userQuery).catch(() => '')
  const fullSystemPrompt = systemPrompt + memoryContext

  if (conversationId && userQuery) {
    saveMessageWithEmbedding(conversationId, 'user', userQuery).catch(() => {})
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = getToolDefinitions()
  let currentMessages = [...request.messages]
  let fullResponse = ''
  const MAX_ITERATIONS = 10 // PER-004 fix

  const cfg = await getConfig()
  const isOpus = cfg.model.includes('opus')
  const modelConfig: ModelConfig = {
    model: cfg.model,
    thinkingBudget: isOpus ? 100_000 : 10_000,
    maxTokens: isOpus ? 128_000 : 32_000,
  }
  console.log(`MODEL: ${modelConfig.model} for "${userQuery.slice(0, 50)}"`)

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // REL-003: retry su errori transitori
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
        thinking: { type: 'enabled', budget_tokens: modelConfig.thinkingBudget },
      }))
    )

    let iterationHasText = false
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text
        callbacks.onText(event.delta.text)
        iterationHasText = true
      }
      if (event.type === 'content_block_start' && (event as any).content_block?.type === 'server_tool_use') {
        callbacks.onToolStart?.('web_search')
      }
    }

    const final = await stream.finalMessage()
    const toolBlocks = final.content.filter(b => b.type === 'tool_use')

    if (toolBlocks.length === 0 || final.stop_reason === 'end_turn') break
    if (!iterationHasText && i > 0) break

    const toolResults = await executeToolBlocks(toolBlocks, conversationId)
    if (toolResults.length === 0) break

    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: final.content },
      { role: 'user' as const, content: toolResults },
    ]
  }

  if (conversationId && fullResponse) {
    saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
  }

  return fullResponse
}

// ── Telegram (streaming internamente per evitare timeout 10min SDK) ──

export async function callClaude(request: ClaudeRequest): Promise<string> {
  const { systemPrompt, userQuery, conversationId } = request

  const memoryContext = await searchMemory(userQuery).catch(() => '')
  const fullSystemPrompt = systemPrompt + memoryContext

  if (conversationId && userQuery) {
    saveMessageWithEmbedding(conversationId, 'user', userQuery).catch(() => {})
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = getToolDefinitions()
  let currentMessages = [...request.messages]
  let fullResponse = ''
  const MAX_ITERATIONS = 10

  const cfg = await getConfig()
  const isOpus = cfg.model.includes('opus')
  const modelConfig: ModelConfig = {
    model: cfg.model,
    thinkingBudget: isOpus ? 100_000 : 10_000,
    maxTokens: isOpus ? 128_000 : 32_000,
  }
  console.log(`MODEL TG: ${modelConfig.model} for "${userQuery.slice(0, 50)}"`)

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // FIX V8: usa stream() invece di create() — evita "Streaming is required for >10min"
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
        thinking: { type: 'enabled', budget_tokens: modelConfig.thinkingBudget },
      }))
    )

    // Consuma lo stream senza callback (Telegram non ha streaming UI)
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text
      }
    }

    const final = await stream.finalMessage()
    const toolBlocks = final.content.filter(b => b.type === 'tool_use')

    if (toolBlocks.length === 0 || final.stop_reason === 'end_turn') break
    if (i > 0 && !final.content.some(b => b.type === 'text')) break

    const toolResults = await executeToolBlocks(toolBlocks, conversationId)
    if (toolResults.length === 0) break

    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: final.content },
      { role: 'user' as const, content: toolResults },
    ]
  }

  if (conversationId && fullResponse) {
    saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
  }

  return fullResponse
}

// ── Streaming Telegram (edit messaggio ogni 3 sec) ──

export async function callClaudeStreamTelegram(
  request: ClaudeRequest,
  onChunk: (accumulated: string) => void,
): Promise<string> {
  const { systemPrompt, userQuery, conversationId } = request

  const memoryContext = await searchMemory(userQuery).catch(() => '')
  const fullSystemPrompt = systemPrompt + memoryContext

  if (conversationId && userQuery) {
    saveMessageWithEmbedding(conversationId, 'user', userQuery).catch(() => {})
  }

  const tools: any[] = getToolDefinitions()
  let currentMessages = [...request.messages]
  let fullResponse = ''
  const MAX_ITERATIONS = 10

  const cfg = await getConfig()
  const isOpus = cfg.model.includes('opus')
  const modelConfig: ModelConfig = {
    model: cfg.model,
    thinkingBudget: isOpus ? 100_000 : 10_000,
    maxTokens: isOpus ? 128_000 : 32_000,
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
        thinking: { type: 'enabled', budget_tokens: modelConfig.thinkingBudget },
      }))
    )

    let lastChunkTime = 0
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text
        const now = Date.now()
        if (now - lastChunkTime > 3000) {
          onChunk(fullResponse)
          lastChunkTime = now
        }
      }
    }

    const final = await stream.finalMessage()
    const toolBlocks = final.content.filter(b => b.type === 'tool_use')

    if (toolBlocks.length === 0 || final.stop_reason === 'end_turn') break
    if (i > 0 && !final.content.some(b => b.type === 'text')) break

    const toolResults = await executeToolBlocks(toolBlocks, conversationId)
    if (toolResults.length === 0) break

    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: final.content },
      { role: 'user' as const, content: toolResults },
    ]
  }

  onChunk(fullResponse)

  if (conversationId && fullResponse) {
    saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
  }

  return fullResponse
}

// ── Helpers ──

async function executeToolBlocks(toolBlocks: any[], conversationId?: string): Promise<any[]> {
  const results: any[] = []
  for (const block of toolBlocks) {
    if (block.type !== 'tool_use') continue
    if (block.name === 'web_search') continue // server-side

    try {
      const result = await executeTool(block.name, block.input as Record<string, unknown>, conversationId)
      results.push({ type: 'tool_result', tool_use_id: block.id, content: result })
    } catch (err) {
      logError(`Tool ${block.name} error`, err)
      results.push({ type: 'tool_result', tool_use_id: block.id, content: `Errore: ${(err as Error).message}` })
    }
  }
  return results
}

const MAX_CONTEXT_CHARS = 500_000

export function trimMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length <= 1) return messages
  let totalChars = charCount(messages[messages.length - 1].content)
  let startIdx = messages.length - 1

  for (let i = messages.length - 2; i >= 0; i--) {
    const chars = charCount(messages[i].content)
    if (totalChars + chars > MAX_CONTEXT_CHARS) break
    totalChars += chars
    startIdx = i
  }

  if (startIdx > 0) {
    const trimmed = messages.slice(startIdx)
    if (trimmed[0]?.role !== 'user') {
      trimmed.unshift({ role: 'user', content: '(conversazione precedente omessa)' })
    }
    return trimmed
  }
  return messages
}

function charCount(content: Anthropic.MessageParam['content']): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) return JSON.stringify(content).length
  return 0
}
