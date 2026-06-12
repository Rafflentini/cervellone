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
import { recordOutcome, getActiveModel, detectHallucination, isCompletedOrConditional, type ModelOutcome } from './circuit-breaker'
import { sendTelegramMessage } from './telegram-helpers'
import { addUsage, logApiUsage, type UsageTokens } from './api-usage'
import { isRunOverBudget, runTokens, MAX_RUN_TOKENS } from './run-budget'
import { shouldUseCheapModel, CHEAP_MODEL } from './cheap-routing'
import { isOpusExpired, SONNET_MODEL } from './opus-ttl'
import { splitSystemPrompt } from './system-prompt-split'
import { truncateToolResult } from './tool-result-utils'
import { applyIncrementalCacheBreakpoint } from './cache-breakpoints'

const client = new Anthropic()
const ANTHROPIC_BILLING_ALERT_KEY = 'anthropic_billing_alerted'

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

function isBillingError(msg: string): boolean {
  const normalized = msg.toLowerCase()
  return normalized.includes('credit balance is too low') ||
    (normalized.includes('invalid_request_error') && normalized.includes('credit balance'))
}

function resolveAdminChatId(): number {
  let adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
  if (!adminChat) {
    const firstAllowed = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
    adminChat = parseInt(firstAllowed || '0', 10)
  }
  return adminChat
}

function errorDetails(err: unknown): { message: string; details: string } {
  const message = err instanceof Error ? err.message : String(err)
  if (!err || typeof err !== 'object') return { message, details: message }

  const obj = err as Record<string, unknown>
  const status = typeof obj.status === 'number' || typeof obj.status === 'string'
    ? String(obj.status)
    : ''
  const nestedError = obj.error && typeof obj.error === 'object'
    ? obj.error as Record<string, unknown>
    : undefined
  const errorType = typeof nestedError?.type === 'string' ? nestedError.type : ''
  const details = [
    message,
    status ? `status=${status}` : '',
    errorType ? `type=${errorType}` : '',
  ].filter(Boolean).join(' ')

  return { message, details }
}

async function notifyAnthropicBillingIfNeeded(details: string): Promise<void> {
    const { data } = await supabase
      .from('cervellone_config')
      .select('value')
      .eq('key', ANTHROPIC_BILLING_ALERT_KEY)
      .maybeSingle()

    if (String(data?.value ?? '').replace(/"/g, '') === 'true') return

    const adminChat = resolveAdminChatId()
    if (!adminChat) {
      console.warn('[Anthropic billing] alert skipped: no admin chat configured')
      return
    }
    try {
      await sendTelegramMessage(
        adminChat,
        '⚠️ *Credito Anthropic esaurito* — l\'API rifiuta le richieste ("credit balance too low"). Il bot è di fatto fermo finché non ricarichi il credito su console.anthropic.com → Billing.'
      )
    } catch (err) {
      console.error('[Anthropic billing] Telegram alert failed:', err instanceof Error ? err.message : String(err))
      return
    }

    const { error } = await supabase.from('cervellone_config').upsert(
      { key: ANTHROPIC_BILLING_ALERT_KEY, value: 'true' },
      { onConflict: 'key' }
    )
    if (error) {
      console.error('[Anthropic billing] alert flag upsert failed:', error.message)
      return
    }

    console.warn(`[Anthropic billing] alerted admin for billing error: ${details.slice(0, 200)}`)
}

function resetAnthropicBillingAlertIfNeeded(): void {
  void (async () => {
    const { data } = await supabase
      .from('cervellone_config')
      .select('value')
      .eq('key', ANTHROPIC_BILLING_ALERT_KEY)
      .maybeSingle()

    if (String(data?.value ?? '').replace(/"/g, '') !== 'true') return

    await supabase.from('cervellone_config').upsert(
      { key: ANTHROPIC_BILLING_ALERT_KEY, value: 'false' },
      { onConflict: 'key' }
    )

    const adminChat = resolveAdminChatId()
    if (adminChat) {
      sendTelegramMessage(
        adminChat,
        '✅ Credito Anthropic ripristinato, bot di nuovo operativo.'
      ).catch(err => console.error('[Anthropic billing] recovery Telegram failed:', err))
    }
  })().catch(err => console.error('[Anthropic billing] reset flow failed:', err))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildModelOptions(model: string, thinkingBudget: number, deepThink = false): Promise<Record<string, any>> {
  const caps = await detectModelCapabilities(model)
  if (caps.supportsAdaptiveThinking) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: Record<string, any> = { thinking: { type: 'adaptive' } }
    // cost-control — xhigh solo on-demand via /think|pensa a fondo|massima potenza
    if (caps.supportsEffort) opts.output_config = { effort: deepThink ? 'xhigh' : 'high' }
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
let configCache: {
  model: string
  modelSubagentMail: string
  modelExtractFast: string
  modelAudit: string
} | null = null
let configCacheTime = 0
const CONFIG_TTL = 60_000

export async function getConfig(): Promise<{
  model: string
  modelSubagentMail: string
  modelExtractFast: string
  modelAudit: string
}> {
  if (configCache && Date.now() - configCacheTime < CONFIG_TTL) return configCache

  const { data } = await supabase
    .from('cervellone_config')
    .select('key, value')
    .in('key', ['model_default', 'model_subagent_mail', 'model_extract_fast', 'model_audit', 'opus_until'])

  // cost-control 5 giu 2026: default Sonnet, Opus solo on-demand via /opus
  let model = 'claude-sonnet-4-6'
  let modelSubagentMail = 'claude-sonnet-4-6'
  let modelExtractFast = 'claude-haiku-4-5'
  let modelAudit = 'claude-sonnet-4-6'
  let opusUntil: string | undefined

  if (data) {
    for (const row of data) {
      const v = String(row.value).replace(/"/g, '')
      if (row.key === 'model_default') model = v
      else if (row.key === 'model_subagent_mail') modelSubagentMail = v
      else if (row.key === 'model_extract_fast') modelExtractFast = v
      else if (row.key === 'model_audit') modelAudit = v
      else if (row.key === 'opus_until') opusUntil = v
    }
  }

  // /opus a tempo: se il TTL è scaduto e il default è ancora Opus, revert automatico a Sonnet.
  // INVARIANTE: opus_until DEVE esistere ogni volta che model è Opus.
  // Se manca (es. messo a mano via SQL), isOpusExpired(undefined)=true → revert.
  // Questo è VOLUTO: Opus senza scadenza non deve mai esistere (fail-safe verso Sonnet).
  if (model.includes('opus') && isOpusExpired(opusUntil, new Date())) {
    model = SONNET_MODEL
    // Best-effort: riallinea il DB (default + active) e pulisce il TTL. Non blocca la risposta.
    void (async () => {
      await supabase.from('cervellone_config').update({ value: SONNET_MODEL, updated_by: 'opus-ttl auto-revert' }).eq('key', 'model_default')
      await supabase.from('cervellone_config').update({ value: SONNET_MODEL, updated_by: 'opus-ttl auto-revert' }).eq('key', 'model_active')
      await supabase.from('cervellone_config').delete().eq('key', 'opus_until')
      const { invalidateCache } = await import('./circuit-breaker')
      invalidateCache()
      console.log('[opus-ttl] scaduto → revert a Sonnet (default+active)')
    })().catch(err => console.error('[opus-ttl] revert failed:', err))
  }

  configCache = { model, modelSubagentMail, modelExtractFast, modelAudit }
  configCacheTime = Date.now()
  return configCache
}

export function invalidateConfigCache(): void {
  configCache = null
  configCacheTime = 0
}

export interface ClaudeRequest {
  messages: Anthropic.MessageParam[]
  systemPrompt: string
  userQuery: string
  conversationId?: string
  hasFiles?: boolean
  /** Override entry_point per il logging consumi API (es. cron). Default: 'chat'/'telegram'. */
  entryPoint?: string
  /**
   * FASE 1 Memoria procedurale: blocco "PROCEDURA OBBLIGATORIA" NON cachato, iniettato
   * nel system prima del memoryContext. Popolato dai due entry-point SOLO se il flag
   * `working_memory_enabled` è ON. Undefined → buildCachedSystem invariato.
   */
  workingContext?: string
  /**
   * Budget token per run (input non-cached + cache_creation + output).
   * Default: MAX_RUN_TOKENS (200K). Il path durable passa MAX_DURABLE_RUN_TOKENS (1M)
   * per consentire task legittime lunghe 30-60 min senza triggering prematuro del guard.
   * Usato SOLO in callClaudeStreamTelegram; gli altri due loop usano il default fisso.
   */
  maxRunTokens?: number
}

export interface ClaudeStreamCallbacks {
  onText: (text: string) => void
  onToolStart?: (toolName: string) => void
}

// ── Cost control (26 mag 2026) ──
// Thinking budget DINAMICO: default basso per i task di routine; "massima potenza" on-demand
// se il messaggio contiene un trigger (/think, ultrathink, "pensa a fondo", "massima potenza", ...).
const DEEP_THINK_RE = /(^|\s)(\/think|\/ragiona|ultrathink|pensa(?:ci)?\s+a\s+fondo|ragiona\s+(?:bene|a\s+fondo)|massim[ao]\s+(?:potenza|ragionamento))\b/i

/** Restituisce true se il messaggio contiene un trigger "massima potenza" / deep-think. */
export function isDeepThink(userQuery: string): boolean {
  return DEEP_THINK_RE.test(userQuery || '')
}

function resolveThinkingBudget(userQuery: string, isOpus: boolean): number {
  if (DEEP_THINK_RE.test(userQuery || '')) return isOpus ? 16_000 : 10_000 // massima potenza on-demand
  return isOpus ? 2_000 : 1_500 // default ridotto (era 8000/4000) — taglia output (il thinking è fatturato come output)
}

// Estrae i blocchi-allegato (document/image) dal messaggio utente più recente.
// Usato dal cheap routing: se ci sono allegati resta Opus a prescindere.
function extractLatestFileBlocks(messages: Anthropic.MessageParam[]): unknown[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (!Array.isArray(m.content)) return []
    return m.content.filter(
      (b) => b && typeof b === 'object' && ((b as { type?: string }).type === 'document' || (b as { type?: string }).type === 'image')
    )
  }
  return []
}

// Prompt caching: cache del prefisso STATICO (tools + system prompt). La memoria RAG (variabile per
// messaggio) va in un blocco separato NON cachato dopo il breakpoint, così non invalida la cache.
// Il breakpoint sul system cacha l'intera catena tools→system. Hit garantiti nei giri del tool-loop
// e tra messaggi ravvicinati (TTL 5 min) → input ~‑80/90% sul prefisso fisso (~4-5K token).
function buildCachedSystem(systemPrompt: string, memoryContext: string, workingContext?: string): Anthropic.TextBlockParam[] {
  // Split STATICO (cachato 1h) / VARIABILE (non cachato). I builder (prompts.ts) inseriscono
  // SYSTEM_CACHE_SPLIT tra il BASE_PROMPT immutabile e data/ora/skill/prompt_extra.
  // Audit 10 giu: prima data+ora-al-minuto+skill stavano nel blocco cachato → si bustava
  // ~ogni minuto. Ora il prefisso grosso è davvero stabile → cache-hit anche su traffico sparso.
  // Fallback retrocompat: se il marker manca, tutto come statico.
  const { staticPart, variablePart } = splitSystemPrompt(systemPrompt)

  const blocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: staticPart, cache_control: { type: 'ephemeral', ttl: '1h' } },
  ]
  // Parte VARIABILE (data/ora/skill/prompt_extra): NON cachata, subito dopo il breakpoint.
  if (variablePart && variablePart.trim()) blocks.push({ type: 'text', text: variablePart })
  // Memoria procedurale + RAG: blocchi NON cachati (variabili per messaggio).
  if (workingContext && workingContext.trim()) blocks.push({ type: 'text', text: workingContext })
  if (memoryContext && memoryContext.trim()) blocks.push({ type: 'text', text: memoryContext })
  return blocks
}

// ── Streaming (chat web) ──

export async function callClaudeStream(
  request: ClaudeRequest,
  callbacks: ClaudeStreamCallbacks,
): Promise<string> {
  const { systemPrompt, userQuery, conversationId } = request

  const memoryContext = await searchMemory(userQuery).catch(() => '')
  const systemBlocks = buildCachedSystem(systemPrompt, memoryContext, request.workingContext)

  if (conversationId && userQuery) {
    saveMessageWithEmbedding(conversationId, 'user', userQuery).catch(() => {})
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = getToolDefinitions()
  let currentMessages = trimMessages([...request.messages])
  let fullResponse = ''
  let accUsage: UsageTokens = {}
  let iterations = 0
  let forcedAction = false // force-action: ri-prompt UNA volta se il modello promette un'azione senza chiamare tool
  const MAX_ITERATIONS = 10 // PER-004 fix

  const cfg = await getConfig()
  const fileBlocks = extractLatestFileBlocks(request.messages)
  const cheap = await shouldUseCheapModel(userQuery, fileBlocks)
  const effectiveModel = cheap ? CHEAP_MODEL : cfg.model
  const isOpus = effectiveModel.includes('opus')
  const modelConfig: ModelConfig = {
    model: effectiveModel,
    thinkingBudget: resolveThinkingBudget(userQuery, isOpus),
    maxTokens: isOpus ? 32_000 : 16_000,
  }
  console.log(`MODEL: ${effectiveModel} (cheap=${cheap}) for "${userQuery.slice(0, 50)}"`)
  const modelOpts = await buildModelOptions(modelConfig.model, modelConfig.thinkingBudget, isDeepThink(userQuery))

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterations = i + 1
    // REL-003: retry su errori transitori
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: systemBlocks,
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
    accUsage = addUsage(accUsage, final.usage as unknown as UsageTokens)
    // Guard rail cost-control: stop se la run ha superato il budget token
    if (isRunOverBudget(accUsage)) {
      console.warn(`run_aborted_budget: ${runTokens(accUsage)} > ${MAX_RUN_TOKENS} tokens (iter=${iterations})`)
      fullResponse += '\n\n⚠️ _Mi fermo qui: la richiesta ha superato il budget di elaborazione. La riformuli in modo più mirato o la spezzi in passi più piccoli._'
      break
    }
    const toolBlocks = final.content.filter(b => b.type === 'tool_use')

    if (toolBlocks.length === 0 || final.stop_reason === 'end_turn') {
      // FORCE-ACTION (parità con callClaudeStreamTelegram): se il modello ha PROMESSO
      // un'azione ma NON ha chiamato alcun tool, lo ri-promptiamo UNA volta perché esegua
      // davvero. Guard forcedAction = una sola volta → niente loop. Risolve gli stalli
      // "🔍 Cerco…"/promessa a vuoto sul path web.
      const iterText = final.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join(' ')
      if (toolBlocks.length === 0 && !forcedAction && detectHallucination(iterText, 0) && !isCompletedOrConditional(iterText)) {
        forcedAction = true
        console.log(`STREAM(web) force-action: promessa senza tool ("${iterText.slice(0, 60)}"), ri-prompt per eseguire`)
        currentMessages = [
          ...currentMessages,
          { role: 'assistant' as const, content: final.content },
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hai detto che avresti svolto un\'azione (cercare/controllare/leggere/inviare/recuperare…) ma NON hai chiamato nessuno strumento, quindi NON è stata eseguita. ESEGUI ORA: chiama i tool necessari e rispondi col risultato REALE. Non descrivere l\'intenzione, agisci.' }] },
        ]
        applyIncrementalCacheBreakpoint(currentMessages)
        continue
      }
      break
    }
    if (!iterationHasText && i > 0) break

    const toolResults = await executeToolBlocks(toolBlocks, conversationId)
    if (toolResults.length === 0) break

    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: final.content },
      { role: 'user' as const, content: toolResults },
    ]
    applyIncrementalCacheBreakpoint(currentMessages)
  }

  await logApiUsage({
    entryPoint: request.entryPoint ?? 'chat',
    model: modelConfig.model,
    usage: accUsage,
    meta: { iterations, runAborted: isRunOverBudget(accUsage) },
  })

  if (conversationId && fullResponse) {
    saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
  }

  return fullResponse
}

// ── Telegram (streaming internamente per evitare timeout 10min SDK) ──

export async function callClaude(request: ClaudeRequest): Promise<string> {
  const { systemPrompt, userQuery, conversationId } = request

  const memoryContext = await searchMemory(userQuery).catch(() => '')
  const systemBlocks = buildCachedSystem(systemPrompt, memoryContext, request.workingContext)

  if (conversationId && userQuery) {
    saveMessageWithEmbedding(conversationId, 'user', userQuery).catch(() => {})
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = getToolDefinitions()
  let currentMessages = trimMessages([...request.messages])
  let fullResponse = ''
  let accUsage: UsageTokens = {}
  let iterations = 0
  const MAX_ITERATIONS = 10

  const cfg = await getConfig()
  const fileBlocks = extractLatestFileBlocks(request.messages)
  const cheap = await shouldUseCheapModel(userQuery, fileBlocks)
  const effectiveModel = cheap ? CHEAP_MODEL : cfg.model
  const isOpus = effectiveModel.includes('opus')
  const modelConfig: ModelConfig = {
    model: effectiveModel,
    thinkingBudget: resolveThinkingBudget(userQuery, isOpus),
    maxTokens: isOpus ? 32_000 : 16_000,
  }
  console.log(`MODEL TG: ${effectiveModel} (cheap=${cheap}) for "${userQuery.slice(0, 50)}"`)
  const modelOpts = await buildModelOptions(modelConfig.model, modelConfig.thinkingBudget, isDeepThink(userQuery))

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterations = i + 1
    // FIX V8: usa stream() invece di create() — evita "Streaming is required for >10min"
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: systemBlocks,
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
    accUsage = addUsage(accUsage, final.usage as unknown as UsageTokens)
    // Guard rail cost-control: stop se la run ha superato il budget token
    if (isRunOverBudget(accUsage)) {
      console.warn(`run_aborted_budget: ${runTokens(accUsage)} > ${MAX_RUN_TOKENS} tokens (iter=${iterations})`)
      fullResponse += '\n\n⚠️ _Mi fermo qui: la richiesta ha superato il budget di elaborazione. La riformuli in modo più mirato o la spezzi in passi più piccoli._'
      break
    }
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
    applyIncrementalCacheBreakpoint(currentMessages)
  }

  await logApiUsage({
    entryPoint: request.entryPoint ?? 'telegram',
    model: modelConfig.model,
    usage: accUsage,
    meta: { iterations, runAborted: isRunOverBudget(accUsage) },
  })

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
  const systemBlocks = buildCachedSystem(systemPrompt, memoryContext, request.workingContext)

  if (conversationId && userQuery) {
    saveMessageWithEmbedding(conversationId, 'user', userQuery).catch(() => {})
  }

  const tools: any[] = getToolDefinitions()
  let currentMessages = trimMessages([...request.messages])
  let fullResponse = ''
  let accUsage: UsageTokens = {}
  let iterations = 0
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
  // Cheap routing: per le chat semplici (no allegati, no task documentale) e flag on,
  // scala su Sonnet. Applicato sul modello attivo (post circuit-breaker) come base.
  const fileBlocks = extractLatestFileBlocks(request.messages)
  const cheap = await shouldUseCheapModel(userQuery, fileBlocks)
  const effectiveModel = cheap ? CHEAP_MODEL : activeModel
  const isOpus = effectiveModel.includes('opus')
  // FIX W1: budget thinking drasticamente ridotto. V10 lasciava 100_000 = il modello
  // pensava per minuti, function killata da Vercel a 300s prima del primo text_delta.
  const modelConfig: ModelConfig = {
    model: effectiveModel,
    thinkingBudget: resolveThinkingBudget(userQuery, isOpus),
    maxTokens: isOpus ? 32_000 : 16_000,
  }
  console.log(`MODEL TG: ${effectiveModel} (cheap=${cheap}) thinking=${modelConfig.thinkingBudget} for "${userQuery.slice(0, 50)}"`)
  const modelOpts = await buildModelOptions(modelConfig.model, modelConfig.thinkingBudget, isDeepThink(userQuery))

  const runBudget = request.maxRunTokens ?? MAX_RUN_TOKENS
  let totalToolCalls = 0
  let forcedAction = false // force-action: ri-prompt UNA volta se il modello promette un'azione senza chiamare tool
  let apiErrorOccurred = false
  let apiErrorMsg = ''
  let apiErrorRecordDetails = ''
  try {
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    iterations = i + 1
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: systemBlocks,
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
    accUsage = addUsage(accUsage, final.usage as unknown as UsageTokens)
    // Guard rail cost-control: stop se la run ha superato il budget token
    if (isRunOverBudget(accUsage, runBudget)) {
      console.warn(`run_aborted_budget: ${runTokens(accUsage)} > ${runBudget} tokens (iter=${iterations})`)
      fullResponse += '\n\n⚠️ _Mi fermo qui: la richiesta ha superato il budget di elaborazione. La riformuli in modo più mirato o la spezzi in passi più piccoli._'
      break
    }
    const toolBlocks = final.content.filter(b => b.type === 'tool_use')
    totalToolCalls += toolBlocks.length
    const textBlocks = final.content.filter(b => b.type === 'text')
    const toolNames = toolBlocks
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map(b => b.name)
      .join(',')

    if (textBlocks.length === 0) consecutiveNoText++
    else consecutiveNoText = 0

    console.log(`STREAM iter=${i} stop=${final.stop_reason} tools=${toolBlocks.length} toolNames=[${toolNames}] texts=${textBlocks.length} fullLen=${fullResponse.length} thinkingChars=${thinkingChars} consNoText=${consecutiveNoText}`)

    // Break naturale: modello soddisfatto (no tool richiesti, conversazione finita)
    if (toolBlocks.length === 0 || final.stop_reason === 'end_turn') {
      // FORCE-ACTION: il modello ha PROMESSO un'azione ("ora cerco", "glielo invio subito"…)
      // ma NON ha chiamato alcun tool in questo turno → l'azione non è stata eseguita.
      // Invece di consegnare la promessa a vuoto, lo ri-promptiamo UNA volta perché esegua
      // davvero. detectHallucination riusa i pattern già tarati (076/077). Guard forcedAction
      // = una sola volta → nessun loop. Risolve il "dice che fa ma non fa".
      const iterText = textBlocks.map(b => (b as Anthropic.TextBlock).text).join(' ')
      if (toolBlocks.length === 0 && !forcedAction && detectHallucination(iterText, 0) && !isCompletedOrConditional(iterText)) {
        forcedAction = true
        console.log(`STREAM force-action: promessa senza tool ("${iterText.slice(0, 60)}"), ri-prompt per eseguire`)
        currentMessages = [
          ...currentMessages,
          { role: 'assistant' as const, content: final.content },
          { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hai detto che avresti svolto un\'azione (cercare/controllare/leggere/inviare/recuperare…) ma NON hai chiamato nessuno strumento, quindi NON è stata eseguita. ESEGUI ORA: chiama i tool necessari e rispondi col risultato REALE. Non descrivere l\'intenzione, agisci.' }] },
        ]
        applyIncrementalCacheBreakpoint(currentMessages)
        continue
      }
      break
    }

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
    applyIncrementalCacheBreakpoint(currentMessages)

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
            system: systemBlocks,
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
        accUsage = addUsage(accUsage, synthFinal.usage as unknown as UsageTokens)
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
    const apiError = errorDetails(err)
    apiErrorMsg = apiError.message
    apiErrorRecordDetails = apiError.details
    console.warn(`[STREAM API ERROR] model=${modelConfig.model}: ${apiErrorMsg.slice(0, 200)}`)

    if (isBillingError(apiErrorRecordDetails)) {
      await notifyAnthropicBillingIfNeeded(apiErrorRecordDetails)
    }

    // Mappa errori comuni a messaggi user-friendly
    let errMsg: string
    if (/not_found_error|404/i.test(apiErrorMsg)) {
      errMsg = '⚠️ Modello AI temporaneamente non disponibile. Il sistema sta cercando di recuperare automaticamente, riprovi tra un momento.'
    } else if (/overloaded|529/i.test(apiErrorMsg)) {
      errMsg = '⚠️ Servizio AI sovraccarico. Riprovi tra qualche secondo.'
    } else if (isBillingError(apiErrorRecordDetails)) {
      errMsg = '⚠️ Crediti API esauriti. L\'Ingegnere è stato avvisato.'
    } else if (/rate.?limit|429/i.test(apiErrorMsg)) {
      errMsg = '⚠️ Troppe richieste al servizio AI. Attenda un momento.'
    } else {
      errMsg = `⚠️ Errore temporaneo del servizio AI. Riprovi tra qualche secondo.`
    }
    // FIX 24 mag: preserve partial response invece di sovrascriverla. Prima quando
    // l'errore API arrivava a metà streaming (es. dopo aver già letto 5 mail via
    // read_email e iniziato sintesi), editTelegramMessage finale cancellava tutto
    // il testo già streamato sostituendolo con il msg di errore. Ora se c'è già
    // contenuto parziale, lo manteniamo e appendiamo l'avviso in coda.
    if (fullResponse.length > 0) {
      fullResponse = fullResponse.trim() + '\n\n' + errMsg + '\n_(quanto sopra è la risposta parziale prima dell\'errore; riprovi per completarla)_'
    } else {
      fullResponse = errMsg
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

  if (outcome === 'success') {
    resetAnthropicBillingAlertIfNeeded()
  }

  recordOutcome(modelConfig.model, outcome, {
    fullLen: fullResponse.length,
    consecutiveNoText,
    requestId: conversationId,
    details: apiErrorOccurred ? apiErrorRecordDetails.slice(0, 500) : undefined,
  }).catch(err => console.error('[CB] recordOutcome failed:', err))

  await logApiUsage({
    entryPoint: request.entryPoint ?? 'telegram',
    model: modelConfig.model,
    usage: accUsage,
    meta: { iterations, outcome, totalToolCalls, apiError: apiErrorOccurred, runAborted: isRunOverBudget(accUsage, runBudget) },
  })

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
      results.push({ type: 'tool_result', tool_use_id: block.id, content: truncateToolResult(result) })
    } catch (err) {
      logError(`Tool ${block.name} error`, err)
      results.push({ type: 'tool_result', tool_use_id: block.id, content: `Errore: ${(err as Error).message}` })
    }
  }
  return results
}

// cost-control 5 giu 2026: 500K char ≈ 125K token di input A OGNI messaggio web.
// 120K char ≈ 30K token: ampiamente sufficiente (Telegram usa già solo 6 messaggi di history).
const MAX_CONTEXT_CHARS = 120_000

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
