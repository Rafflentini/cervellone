/**
 * lib/claude.ts — Motore Cervellone v2
 * 
 * Fix integrati: REL-003 (retry), PER-004 (max iterations 10),
 * sanitization, safe logging, fault tolerance.
 */

import Anthropic from '@anthropic-ai/sdk'
import { getToolDefinitions, executeTool } from './tools'
import { searchMemory, saveMessageWithEmbedding } from './memory'
import { logError } from './sanitize'
import { withRetry } from './resilience'
import { supabase } from './supabase'
import { recordOutcome, getActiveModel, detectHallucination, type ModelOutcome } from './circuit-breaker'

const client = new Anthropic()

/**
 * FIX W1.1: capability detection runtime per i parametri thinking/effort.
 *
 * Opus 4.7+ e Sonnet 4.6+ richiedono `thinking: { type: 'adaptive' }`.
 * Modelli più vecchi (Opus 4.5 e prima, Sonnet 4.5 e prima) usano `thinking: { type: 'enabled', budget_tokens: N }`.
 *
 * Strategia future-proof:
 * 1. Cache in-memory delle capability per 24h (lifetime Lambda)
 * 2. Prima chiamata: client.models.retrieve(model) per scoprire capability vere
 * 3. Fallback: regex su modelli legacy noti (assumiamo che TUTTI i modelli futuri
 *    sconosciuti supportino adaptive, perché Anthropic ha annunciato che adaptive
 *    è il futuro)
 *
 * Quando esce Opus 4.8/5.0/ecc., il codice si adatta da solo senza modifiche.
 *
 * Doc: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking
 */
interface ModelCaps {
  supportsAdaptiveThinking: boolean
  supportsEffort: boolean
  cachedAt: number
}

const CAPS_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const capsCache = new Map<string, ModelCaps>()

// Pattern legacy: modelli che richiedono enabled+budget_tokens.
// IMPORTANTE: lista esplicita di modelli VECCHI. Tutti i modelli più recenti
// (Opus 4.6+, Sonnet 4.6+, e qualunque modello futuro non in questa lista)
// vengono trattati come adaptive. Questo è il default sicuro per il futuro.
const LEGACY_THINKING_PATTERN =
  /claude-opus-4-[01345](?!\d)|claude-opus-[123]|claude-sonnet-4-[01345](?!\d)|claude-sonnet-[123]|claude-haiku-[1234]|claude-3-/

async function detectModelCapabilities(model: string): Promise<ModelCaps> {
  const cached = capsCache.get(model)
  if (cached && Date.now() - cached.cachedAt < CAPS_TTL_MS) return cached

  // 1. Tentativo API capability lookup (autoritative, future-proof)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = await (client as any).models.retrieve(model)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const caps = (m?.capabilities ?? {}) as Record<string, any>
    const adaptive = caps?.thinking?.types?.adaptive?.supported
    const effort = caps?.effort?.supported
    if (typeof adaptive === 'boolean') {
      const result: ModelCaps = {
        supportsAdaptiveThinking: adaptive,
        supportsEffort: effort === true,
        cachedAt: Date.now(),
      }
      capsCache.set(model, result)
      console.log(`MODEL CAPS [${model}]: adaptive=${adaptive} effort=${effort} (api)`)
      return result
    }
  } catch (err) {
    // API endpoint non disponibile o modello sconosciuto — fallback regex
    console.warn(`MODEL CAPS [${model}]: api lookup failed, fallback regex`, err instanceof Error ? err.message : err)
  }

  // 2. Fallback regex: assume adaptive per tutti i modelli NON-legacy
  const isLegacy = LEGACY_THINKING_PATTERN.test(model)
  const result: ModelCaps = {
    supportsAdaptiveThinking: !isLegacy,
    supportsEffort: !isLegacy,
    cachedAt: Date.now(),
  }
  capsCache.set(model, result)
  console.log(`MODEL CAPS [${model}]: adaptive=${!isLegacy} effort=${!isLegacy} (regex fallback)`)
  return result
}

export function invalidateModelCapsCache(): void {
  capsCache.clear()
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildModelOptions(model: string, thinkingBudget: number): Promise<Record<string, any>> {
  const caps = await detectModelCapabilities(model)
  if (caps.supportsAdaptiveThinking) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: Record<string, any> = { thinking: { type: 'adaptive' } }
    if (caps.supportsEffort) opts.output_config = { effort: 'high' }
    return opts
  }
  // Legacy: enabled + budget_tokens
  return {
    thinking: { type: 'enabled', budget_tokens: thinkingBudget },
  }
}

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

  let model = 'claude-opus-4-7'
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
    thinkingBudget: isOpus ? 8_000 : 4_000,
    maxTokens: isOpus ? 32_000 : 16_000,
  }
  console.log(`MODEL: ${modelConfig.model} for "${userQuery.slice(0, 50)}"`)
  const modelOpts = await buildModelOptions(modelConfig.model, modelConfig.thinkingBudget)

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // REL-003: retry su errori transitori
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
        ...modelOpts,
      }, {
        headers: { 'anthropic-beta': 'files-api-2025-04-14' },
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
        const serverToolName = (event as any).content_block?.name ?? 'server_tool'
        callbacks.onToolStart?.(serverToolName)
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
    thinkingBudget: isOpus ? 8_000 : 4_000,
    maxTokens: isOpus ? 32_000 : 16_000,
  }
  console.log(`MODEL TG: ${modelConfig.model} for "${userQuery.slice(0, 50)}"`)
  const modelOpts = await buildModelOptions(modelConfig.model, modelConfig.thinkingBudget)

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // FIX V8: usa stream() invece di create() — evita "Streaming is required for >10min"
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
        ...modelOpts,
      }, {
        headers: { 'anthropic-beta': 'files-api-2025-04-14' },
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
  onChunk: (accumulated: string) => void | Promise<void>,
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
  // FIX Bug 5: counter di iter consecutivi senza text_delta. Opus 4.7 chiama
  // più tool_use legittimi in catena (es. fan-out drive_search dopo miss).
  // Il vecchio break "i>0 && no text" era troppo aggressivo: interrompeva
  // il modello PRIMA di eseguire i tool dell'iter corrente, sprecando lavoro.
  // Nuovo approccio: lascia esplorare fino a 3 round, poi forza sintesi.
  let consecutiveNoText = 0
  const NO_TEXT_LIMIT = 5 // Fix H: self-heal flow usa fino a 5 iter consecutive (read_file + propose_fix + status)

  const cfg = await getConfig()
  // Bug 5/Circuit Breaker: getActiveModel può sovrascrivere cfg.model se rolled back
  const activeModel = await getActiveModel().catch(() => cfg.model)
  if (activeModel !== cfg.model) {
    console.log(`[CB] active=${activeModel} differs from default=${cfg.model}`)
  }
  const isOpus = activeModel.includes('opus')
  // FIX W1: budget thinking drasticamente ridotto. V10 lasciava 100_000 = il modello
  // pensava per minuti, function killata da Vercel a 300s prima del primo text_delta.
  const modelConfig: ModelConfig = {
    model: activeModel,
    thinkingBudget: isOpus ? 8_000 : 4_000,
    maxTokens: isOpus ? 32_000 : 16_000,
  }
  console.log(`MODEL TG: ${modelConfig.model} thinking=${modelConfig.thinkingBudget} for "${userQuery.slice(0, 50)}"`)
  const modelOpts = await buildModelOptions(modelConfig.model, modelConfig.thinkingBudget)

  let totalToolCalls = 0
  let apiErrorOccurred = false
  let apiErrorMsg = ''
  try {
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
        ...modelOpts,
      }, {
        headers: { 'anthropic-beta': 'files-api-2025-04-14' },
      }))
    )

    let lastTextEdit = 0
    let lastThinkingEdit = 0
    let thinkingChars = 0

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          fullResponse += event.delta.text
          const now = Date.now()
          if (now - lastTextEdit > 3000) {
            await onChunk(fullResponse)
            lastTextEdit = now
          }
        }
        // FIX W1: stream del thinking. Aggiorna placeholder Telegram con counter
        // così l'utente vede progresso anche durante il reasoning.
        // Solo finché non c'è ancora testo (poi il testo prevale).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        else if ((event.delta as any).type === 'thinking_delta' && fullResponse === '') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const td = (event.delta as any).thinking
          thinkingChars += typeof td === 'string' ? td.length : 0
          const now = Date.now()
          if (now - lastThinkingEdit > 5000) {
            await onChunk(`🧠 Sto pensando... (${thinkingChars} char di reasoning)`)
            lastThinkingEdit = now
          }
        }
      }
    }

    const final = await stream.finalMessage()
    const toolBlocks = final.content.filter(b => b.type === 'tool_use')
    totalToolCalls += toolBlocks.length
    const textBlocks = final.content.filter(b => b.type === 'text')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolNames = toolBlocks.map(b => (b as any).name).join(',')

    if (textBlocks.length === 0) consecutiveNoText++
    else consecutiveNoText = 0

    console.log(`STREAM iter=${i} stop=${final.stop_reason} tools=${toolBlocks.length} toolNames=[${toolNames}] texts=${textBlocks.length} fullLen=${fullResponse.length} thinkingChars=${thinkingChars} consNoText=${consecutiveNoText}`)

    // Break naturale: modello soddisfatto (no tool richiesti, conversazione finita)
    if (toolBlocks.length === 0 || final.stop_reason === 'end_turn') break

    // FIX Bug 5: ESEGUI sempre i tool dell'iter corrente PRIMA di valutare se
    // forzare sintesi. Il modello li ha richiesti, eseguirli arricchisce il
    // contesto per l'iter successivo (anche se quella sarà la sintesi forzata).
    const toolResults = await executeToolBlocks(toolBlocks, conversationId)
    if (toolResults.length === 0) break

    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: final.content },
      { role: 'user' as const, content: toolResults },
    ]

    // FIX Bug 5: dopo NO_TEXT_LIMIT iter consecutivi senza text, forza una
    // sintesi finale con tool_choice=none. Il modello DEVE rispondere con
    // text in quel turno, non può più chiamare tool. Garantisce che l'utente
    // riceva sempre qualcosa di leggibile invece di "..." silenzioso.
    if (consecutiveNoText >= NO_TEXT_LIMIT) {
      console.log(`STREAM force-text: ${consecutiveNoText} consecutive no-text iters, forcing tool_choice=none`)
      try {
        const synthStream = await withRetry(() =>
          Promise.resolve(client.messages.stream({
            model: modelConfig.model,
            max_tokens: modelConfig.maxTokens,
            system: fullSystemPrompt,
            messages: currentMessages,
            tools,
            tool_choice: { type: 'none' as const },
            ...modelOpts,
          }, {
            headers: { 'anthropic-beta': 'files-api-2025-04-14' },
          }))
        )
        let synthLastEdit = 0
        for await (const event of synthStream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            fullResponse += event.delta.text
            const now = Date.now()
            if (now - synthLastEdit > 3000) {
              await onChunk(fullResponse)
              synthLastEdit = now
            }
          }
        }
        const synthFinal = await synthStream.finalMessage()
        const synthTexts = synthFinal.content.filter(b => b.type === 'text').length
        console.log(`STREAM force-text done texts=${synthTexts} fullLen=${fullResponse.length}`)
      } catch (err) {
        console.warn(`STREAM force-text FAIL:`, err instanceof Error ? err.message : err)
      }
      break
    }
  }
  } catch (err) {
    // FIX Bug 7: catch errori API Anthropic (404 model not found, 529 overloaded,
    // timeout) per (a) tracciare outcome=api_error sul circuit breaker e (b)
    // mostrare messaggio user-friendly invece dell'errore tecnico raw.
    apiErrorOccurred = true
    apiErrorMsg = err instanceof Error ? err.message : String(err)
    console.warn(`[STREAM API ERROR] model=${modelConfig.model}: ${apiErrorMsg.slice(0, 200)}`)

    // Mappa errori comuni a messaggi user-friendly
    if (/not_found_error|404/i.test(apiErrorMsg)) {
      fullResponse = '⚠️ Modello AI temporaneamente non disponibile. Il sistema sta cercando di recuperare automaticamente, riprovi tra un momento.'
    } else if (/overloaded|529/i.test(apiErrorMsg)) {
      fullResponse = '⚠️ Servizio AI sovraccarico. Riprovi tra qualche secondo.'
    } else if (/credit|billing/i.test(apiErrorMsg)) {
      fullResponse = '⚠️ Crediti API esauriti. L\'Ingegnere è stato avvisato.'
    } else if (/rate.?limit|429/i.test(apiErrorMsg)) {
      fullResponse = '⚠️ Troppe richieste al servizio AI. Attenda un momento.'
    } else {
      fullResponse = `⚠️ Errore temporaneo del servizio AI. Riprovi tra qualche secondo.`
    }
  }

  // FIX W1: await esplicito sull'edit finale (era fire-and-forget — se la function
  // moriva subito dopo il loop, l'edit non partiva).
  // FIX Bug 5: fallback se per qualsiasi motivo (errore force-text, MAX_ITERATIONS,
  // ecc.) il modello non ha mai prodotto text. Meglio onestà esplicita di "..." muto.
  if (fullResponse.length === 0) {
    fullResponse = '⚠️ Non sono riuscito a sintetizzare una risposta. Riformuli la richiesta o specifichi il file/contesto, per favore.'
    console.warn(`STREAM EMPTY: fullResponse vuoto dopo loop, applicato fallback`)
  }
  console.log(`STREAM done fullLen=${fullResponse.length} apiError=${apiErrorOccurred}`)
  await onChunk(fullResponse)

  if (conversationId && fullResponse && !apiErrorOccurred) {
    saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
  }

  // Determina outcome per circuit breaker
  let outcome: ModelOutcome = 'success'
  const FALLBACK_PREFIX = '⚠️ Non sono riuscito a sintetizzare'
  if (apiErrorOccurred) {
    outcome = 'api_error'
  } else if (fullResponse.startsWith(FALLBACK_PREFIX)) {
    outcome = 'empty'
  } else if (consecutiveNoText >= NO_TEXT_LIMIT) {
    outcome = 'force_text'
  } else if (detectHallucination(fullResponse, totalToolCalls)) {
    outcome = 'hallucination'
  }

  recordOutcome(modelConfig.model, outcome, {
    fullLen: fullResponse.length,
    consecutiveNoText,
    requestId: conversationId,
    details: apiErrorOccurred ? apiErrorMsg.slice(0, 500) : undefined,
  }).catch(err => console.error('[CB] recordOutcome failed:', err))

  return fullResponse
}

// ── Helpers ──

async function executeToolBlocks(toolBlocks: any[], conversationId?: string): Promise<any[]> {
  const results: any[] = []
  for (const block of toolBlocks) {
    if (block.type !== 'tool_use') continue
    if (block.name === 'web_search' || block.name === 'code_execution') continue // server-side

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
