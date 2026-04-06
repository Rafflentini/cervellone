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

// ── Routing intelligente basato sulla complessità ──

interface ModelConfig {
  model: string
  thinkingBudget: number
  maxTokens: number
}

function selectModel(userQuery: string, hasFiles: boolean): ModelConfig {
  const len = userQuery.length

  // Messaggi brevi/conversazionali: Sonnet veloce, thinking minimo
  if (len < 100 && !hasFiles) {
    return { model: 'claude-sonnet-4-6', thinkingBudget: 1024, maxTokens: 4096 }
  }

  // ── SEGNALI DI COMPLESSITÀ (indipendenti dal dominio) ──
  const complexitySignals = [
    /(?:approfond|dettagliat|(?:analisi|indagine|studio)\s+complet|esaustiv|accurata|minuziosa)/i.test(userQuery),
    /(?:opus|massima\s*potenza|ragionamento\s*profondo|analisi\s*complessa)/i.test(userQuery),
    (userQuery.match(/(?:analizza|confronta|verifica|valuta|esamina|studia|indaga|investiga|redigi|prepara|elabora)/gi) || []).length >= 2,
    /(?:redigi|scrivi|prepara|elabora)\s+(?:un[ao']?\s+)?(?:relazione|perizia|parere|report|analisi|studio|indagine|piano|strategia|documento)/i.test(userQuery),
    /(?:norma|legge|decreto|regolament|codice|testo unico|direttiva|circolare|D\.?M\.?|D\.?Lgs|NTC|GDPR|CCNL)/i.test(userQuery),
    len > 500,
    hasFiles && /(?:analizza|verifica|confronta|controlla|esamina|valuta)/i.test(userQuery),
    /(?:calcol[oa]|verifica|dimension[ai]|stima|quantific)/i.test(userQuery) && len > 150,
    /(?:confronta|compara|paragona|differenz[ae]|vs\.?|rispetto a)/i.test(userQuery) && len > 100,
    /(?:strategia|piano\s+(?:di|per)|business\s*plan|marketing|posizionament|analisi\s+(?:di\s+)?mercato|target|competitor)/i.test(userQuery),
  ].filter(Boolean).length

  // Opus Extended (100K thinking): task davvero complessi (4+ segnali)
  if (complexitySignals >= 4) {
    return { model: 'claude-opus-4-6', thinkingBudget: 100_000, maxTokens: 16000 }
  }
  // Opus (32K thinking): task complessi (2-3 segnali)
  if (complexitySignals >= 2) {
    return { model: 'claude-opus-4-6', thinkingBudget: 32_000, maxTokens: 16000 }
  }
  // Sonnet con thinking alto: task medio (1 segnale, file, msg lungo)
  if (complexitySignals >= 1 || len > 300 || hasFiles) {
    return { model: 'claude-sonnet-4-6', thinkingBudget: 10000, maxTokens: 16000 }
  }
  // Sonnet standard: tutto il resto
  return { model: 'claude-sonnet-4-6', thinkingBudget: 4000, maxTokens: 8000 }
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

  const modelConfig = selectModel(userQuery, request.hasFiles || false)
  console.log(`MODEL: ${modelConfig.model} thinking=${modelConfig.thinkingBudget} for "${userQuery.slice(0, 50)}"`)

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

    const toolResults = await executeToolBlocks(toolBlocks)
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

// ── Non-streaming (Telegram) ──

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

  const modelConfig = selectModel(userQuery, request.hasFiles || false)
  console.log(`MODEL TG: ${modelConfig.model} thinking=${modelConfig.thinkingBudget} for "${userQuery.slice(0, 50)}"`)

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await withRetry(() =>
      client.messages.create({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
        thinking: { type: 'enabled', budget_tokens: modelConfig.thinkingBudget },
      })
    )

    let hasText = false
    for (const block of response.content) {
      if (block.type === 'text') { fullResponse += block.text; hasText = true }
    }

    const toolBlocks = response.content.filter(b => b.type === 'tool_use')
    if (toolBlocks.length === 0 || response.stop_reason === 'end_turn') break
    if (!hasText && i > 0) break

    const toolResults = await executeToolBlocks(toolBlocks)
    if (toolResults.length === 0) break

    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: response.content },
      { role: 'user' as const, content: toolResults },
    ]
  }

  if (conversationId && fullResponse) {
    saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
  }

  return fullResponse
}

// ── Helpers ──

async function executeToolBlocks(toolBlocks: any[]): Promise<any[]> {
  const results: any[] = []
  for (const block of toolBlocks) {
    if (block.type !== 'tool_use') continue
    if (block.name === 'web_search') continue // server-side

    try {
      const result = await executeTool(block.name, block.input as Record<string, unknown>)
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
