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

interface CervelloneConfig {
  model_default: string
  model_complex: string
  model_digest: string
  nome: string
  version: string
  descrizione: string
  thinking_budget_default: number
  thinking_budget_medium: number
  thinking_budget_high: number
  max_tokens_default: number
  max_tokens_medium: number
  max_tokens_high: number
  prompt_extra: string
}

// Cache config per 60 secondi (non query Supabase ad ogni messaggio)
let configCache: CervelloneConfig | null = null
let configCacheTime = 0
const CONFIG_TTL = 60_000

async function getConfig(): Promise<CervelloneConfig> {
  if (configCache && Date.now() - configCacheTime < CONFIG_TTL) return configCache

  const { data } = await supabase
    .from('cervellone_config')
    .select('key, value')

  const defaults: CervelloneConfig = {
    model_default: 'claude-sonnet-4-6',
    model_complex: 'claude-sonnet-4-6',
    model_digest: 'claude-sonnet-4-6',
    nome: 'Cervellone',
    version: '1.0.0',
    descrizione: 'CEO digitale di Restruktura SRL',
    thinking_budget_default: 4000,
    thinking_budget_medium: 32000,
    thinking_budget_high: 100000,
    max_tokens_default: 16000,
    max_tokens_medium: 48000,
    max_tokens_high: 128000,
    prompt_extra: '',
  }

  if (data) {
    for (const row of data) {
      if (row.key in defaults) {
        (defaults as Record<string, unknown>)[row.key] = row.value
      }
    }
  }

  configCache = defaults
  configCacheTime = Date.now()
  return defaults
}

// Esportata per il system prompt
export { getConfig }

// ── Routing intelligente basato sulla complessità ──

async function selectModel(userQuery: string, hasFiles: boolean): Promise<ModelConfig> {
  const cfg = await getConfig()
  const len = userQuery.length

  // ── RICHIESTA ESPLICITA DI POTENZA — sempre model_complex ──
  const wantsMax = /(?:opus|massima\s*potenza|ragionamento\s*profondo|usa\s+il\s+modello\s+(?:migliore|più\s+potente))/i.test(userQuery)
  if (wantsMax) {
    return { model: cfg.model_complex, thinkingBudget: cfg.thinking_budget_high, maxTokens: cfg.max_tokens_high }
  }

  // ── TASK STRUTTURATI — richiedono almeno model_complex ──
  // NB: "genera" da solo (senza contesto) matcha, ma va bene — meglio dare troppo che troppo poco
  const isStructuredTask =
    /(?:preventiv|computo|cme|cmE|c\.m\.e)/i.test(userQuery) ||
    /(?:redigi|scrivi|prepara|elabora|genera)\b/i.test(userQuery) ||
    /(?:relazione|perizia|parere|report|documento|lettera)\b/i.test(userQuery) ||
    /(?:calcol[oa]|dimension[ai]|verifica\s+struttur)/i.test(userQuery)

  if (isStructuredTask) {
    const complexitySignals = countComplexitySignals(userQuery, hasFiles)
    if (complexitySignals >= 4) {
      return { model: cfg.model_complex, thinkingBudget: cfg.thinking_budget_high, maxTokens: cfg.max_tokens_high }
    }
    return { model: cfg.model_complex, thinkingBudget: cfg.thinking_budget_medium, maxTokens: cfg.max_tokens_medium }
  }

  // ── SEGNALI DI COMPLESSITÀ — calcola SEMPRE, anche per messaggi brevi ──
  const complexitySignals = countComplexitySignals(userQuery, hasFiles)

  if (complexitySignals >= 4) {
    return { model: cfg.model_complex, thinkingBudget: cfg.thinking_budget_high, maxTokens: cfg.max_tokens_high }
  }
  if (complexitySignals >= 2) {
    return { model: cfg.model_complex, thinkingBudget: cfg.thinking_budget_medium, maxTokens: cfg.max_tokens_medium }
  }

  // ── MESSAGGI SEMPLICI — model_default ──
  if (len < 100 && !hasFiles && complexitySignals === 0) {
    return { model: cfg.model_default, thinkingBudget: 1024, maxTokens: 4096 }
  }
  if (complexitySignals >= 1 || len > 300 || hasFiles) {
    return { model: cfg.model_default, thinkingBudget: cfg.thinking_budget_default, maxTokens: cfg.max_tokens_default }
  }
  return { model: cfg.model_default, thinkingBudget: cfg.thinking_budget_default, maxTokens: cfg.max_tokens_default }
}

function countComplexitySignals(userQuery: string, hasFiles: boolean): number {
  const len = userQuery.length
  return [
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

  const modelConfig = await selectModel(userQuery, request.hasFiles || false)
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

  const modelConfig = await selectModel(userQuery, request.hasFiles || false)
  console.log(`MODEL TG: ${modelConfig.model} thinking=${modelConfig.thinkingBudget} for "${userQuery.slice(0, 50)}"`)

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
