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
import { consumeStreamWithRetry } from './stream-retry'
import { supabase } from './supabase'
import { recordOutcome, getActiveModel, detectHallucination, isCompletedOrConditional, claimsArchiveCompletion, type ModelOutcome } from './circuit-breaker'
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
   * Onorato da tutti i canali (fino al 3 set 2026 il loop web lo ignorava).
   */
  maxRunTokens?: number
}

export interface ClaudeStreamCallbacks {
  onText: (text: string) => void
  onToolStart?: (toolName: string) => void
  /**
   * Il turno non e' lavoro compiuto: il testo che arriva e' un messaggio del
   * loop (errore API, turno muto, budget esaurito), non una risposta. Il
   * chiamante NON deve archiviarlo — bozze, documenti, memoria immagini,
   * debrief.
   */
  onTurnFailed?: (motivo: MotivoFallimento) => void
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

/**
 * Anti-bugia archiviazione: true se nel turno corrente una chiamata ad
 * archivia_foto / archivia_documento è andata a buon fine REALMENTE (esito letto dal
 * tool_result, non da stato in-memory). archivia_foto ritorna JSON {ok:true};
 * archivia_documento ritorna una stringa ("…spostato…" su successo, "Errore…"/"🔒" su errore).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function archiveToolSucceededIn(toolBlocks: any[], toolResults: any[]): boolean {
  for (const tr of toolResults) {
    if (tr?.type !== 'tool_result') continue
    const tb = toolBlocks.find((b: any) => b?.id === tr.tool_use_id)
    const name = tb?.name
    const content = typeof tr.content === 'string' ? tr.content : ''
    // archivia_foto E archivia_documento ritornano entrambi JSON {ok:true} su successo reale
    // (archivia_foto: foto-archive-tools ok(); archivia_documento: archiveDocumentToDrive).
    // Il fallimento ritorna {ok:false}/Errore → NON matcha. NB: evitare il pattern "spostat"
    // perché la stringa di fallimento "non risulta spostato" lo conterrebbe (falso positivo).
    if ((name === 'archivia_foto' || name === 'archivia_documento') && /"ok"\s*:\s*true/.test(content)) return true
  }
  return false
}

// ── Il loop agentico: uno solo, per tutti i canali ──
//
// Fino al 3 settembre 2026 questa parte era scritta DUE volte, una per la chat
// web e una per Telegram, piu' una terza copia non-streaming che nessuno
// chiamava. Le tre copie divergevano: il 2 settembre la chat web moriva a meta'
// turno per un `break` che Telegram si era tolto il 24 maggio.
//
// Da qui in avanti il turno e' uno. Del canale restano due cose sole: dove esce
// il testo (`ChannelSink`) e quattro scelte esplicite (`ChannelPolicy`).
// La prova che non si ri-biforchino sta in `claude.loop-parity.test.ts`, che
// esegue gli stessi casi su entrambi gli entry-point.

/** Numero massimo di giri modello→tool→modello in un turno (PER-004). */
const MAX_ITERATIONS = 10
/**
 * Giri consecutivi senza testo dopo i quali si forza la sintesi con
 * tool_choice=none. Sotto questo valore i flussi legittimi a piu' tool si
 * romperebbero (il self-heal ne usa fino a 5: read_file + propose_fix + status).
 */
const NO_TEXT_LIMIT = 5

/**
 * Perche' il turno non e' arrivato a destinazione:
 * - `api_error`: l'API ha smesso di rispondere (404, 529, timeout, credito)
 * - `empty`: il modello non ha mai prodotto testo, l'utente riceve una scusa
 * - `budget`: la run ha sfondato il tetto di token ed e' stata troncata
 */
export type MotivoFallimento = 'api_error' | 'empty' | 'budget'

/**
 * Dove esce quello che il modello produce. E' l'unica cosa che i due canali
 * fanno davvero diversa: il web appende i delta allo stream HTTP, Telegram
 * riscrive lo stesso messaggio ogni pochi secondi.
 */
export interface ChannelSink {
  /**
   * Testo prodotto dal modello (o dal loop stesso: errori, fallback, avvisi di
   * budget). `delta` e' il solo incremento, `accumulated` tutto il turno finora.
   * Il web usa `delta`, Telegram `accumulated`.
   */
  onText(delta: string, accumulated: string): void | Promise<void>
  /** Progresso durante il reasoning. Chiamato SOLO finche' non c'e' ancora testo. */
  onThinking?(chars: number): void | Promise<void>
  /** Un tool eseguito da Anthropic (web_search, code_execution) e' partito. */
  onServerTool?(name: string): void | Promise<void>
  /**
   * Sta per partire un tentativo di stream, e il parziale dell'iterazione e'
   * stato riportato all'inizio.
   *
   * ATTENZIONE: scatta prima di OGNI tentativo, incluso il primo, e a ogni
   * iterazione del tool-loop (vedi `stream-retry.ts`) — non solo sui
   * ri-tentativi. Serve per azzerare stato per-iterazione (timer di throttling).
   * NON usarlo per annullare testo gia' consegnato all'utente: cancellerebbe
   * anche quello delle iterazioni precedenti, che era corretto.
   */
  onAttemptStart?(): void
  /**
   * Il turno NON e' stato consegnato come lavoro compiuto: quello che l'utente
   * legge e' un messaggio del loop, non una risposta finita.
   *
   * Serve al chiamante per non archiviarlo. Entrambe le pipeline post-turno
   * (web e Telegram) salvano bozze, documenti, "conoscenza file", memoria
   * immagini e debrief: senza questo segnale una risposta troncata a meta' — o
   * un "non sono riuscito a sintetizzare" — finisce archiviata come se fosse il
   * lavoro richiesto. Caso reale misurato: la memoria immagini legava i
   * `drive_file_id` veri delle foto a un messaggio di scusa, e per 24 ore il
   * bot "sapeva" di aver estratto quello.
   */
  onTurnFailed?(motivo: MotivoFallimento): void
  /** Consegna finale, per i canali che riscrivono il messaggio invece di appendere. */
  onFinal?(text: string): void | Promise<void>
}

/** Le uniche scelte per-canale che restano. Quattro, non trecento. */
export interface ChannelPolicy {
  /** Etichetta nei log: 'web' | 'tg'. */
  tag: string
  /** entry_point di default per il logging consumi API. */
  entryPoint: string
  /** Scrivere il messaggio UTENTE a DB. Il web no: lo fa gia' il browser (altrimenti due righe). */
  persistUserMessage: boolean
  /** Scrivere la risposta ASSISTANT a DB. Idem. */
  persistAssistantMessage: boolean
}

/** Traduce un errore API in una frase che l'utente possa capire. */
function messaggioErroreUtente(message: string, details: string): string {
  if (/not_found_error|404/i.test(message)) {
    return '⚠️ Modello AI temporaneamente non disponibile. Il sistema sta cercando di recuperare automaticamente, riprovi tra un momento.'
  }
  if (/overloaded|529/i.test(message)) return '⚠️ Servizio AI sovraccarico. Riprovi tra qualche secondo.'
  if (isBillingError(details)) return '⚠️ Crediti API esauriti. L\'Ingegnere è stato avvisato.'
  if (/rate.?limit|429/i.test(message)) return '⚠️ Troppe richieste al servizio AI. Attenda un momento.'
  return '⚠️ Errore temporaneo del servizio AI. Riprovi tra qualche secondo.'
}

export async function runAgentTurn(
  request: ClaudeRequest,
  sink: ChannelSink,
  policy: ChannelPolicy,
): Promise<string> {
  const { systemPrompt, userQuery, conversationId } = request

  const memoryContext = await searchMemory(userQuery).catch(() => '')
  const systemBlocks = buildCachedSystem(systemPrompt, memoryContext, request.workingContext)

  if (policy.persistUserMessage && conversationId && userQuery) {
    saveMessageWithEmbedding(conversationId, 'user', userQuery).catch(() => {})
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = getToolDefinitions()
  let currentMessages = trimMessages([...request.messages])
  let fullResponse = ''
  let accUsage: UsageTokens = {}
  let iterations = 0
  let forcedAction = false // force-action: ri-prompt UNA volta se il modello promette un'azione senza chiamare tool
  let forcedArchiveCorrection = false // anti-bugia: ri-prompt UNA volta se afferma archiviazione senza esito reale
  let archiveToolSucceeded = false // true se archivia_foto/archivia_documento è andato a buon fine nel turno
  let consecutiveNoText = 0 // iterazioni di fila senza testo: oltre NO_TEXT_LIMIT si forza la sintesi
  // Serve a detectHallucination: senza, "ho cercato il file" verrebbe giudicato
  // una promessa a vuoto anche quando i tool sono stati eseguiti davvero.
  let totalToolCalls = 0
  let apiErrorOccurred = false
  let apiErrorRecordDetails = ''
  let runAbortedBudget = false
  /** True appena il loop scrive al posto del modello: il turno non e' lavoro compiuto. */
  let turnoNonConsegnato = false

  /**
   * Avvisa il canale che il turno non e' lavoro compiuto. Va chiamato in TUTTI
   * e tre i punti in cui il loop scrive al posto del modello (errore API, turno
   * muto, budget esaurito): coprirne solo uno lascia le pipeline post-turno ad
   * archiviare gli altri due.
   */
  const segnalaFallimento = (motivo: MotivoFallimento) => {
    turnoNonConsegnato = true
    try { sink.onTurnFailed?.(motivo) } catch { /* la notifica non deve rompere il turno */ }
  }

  /**
   * Testo che aggiunge il LOOP, non il modello: budget esaurito, errore API,
   * fallback per turno muto. Va fatto uscire dal sink, o su un canale che
   * appende (il web) l'utente non lo vedrebbe mai — restava nel valore di
   * ritorno e basta.
   *
   * La consegna non puo' far fallire il turno. `emit` viene usato anche DENTRO
   * il catch dell'errore API, e li' il sink web scrive su uno stream HTTP che
   * spesso e' gia' chiuso — e' la disconnessione del client a causare l'errore.
   * Un throw qui salterebbe recordOutcome e logApiUsage: il circuit breaker
   * resterebbe cieco proprio sui turni finiti male, cioe' l'unico caso per cui
   * esiste. Il testo resta comunque in `fullResponse`.
   */
  const consegnaSicura = async (cosa: string, fn: () => void | Promise<void>) => {
    // try/catch e non `Promise.resolve(fn()).catch()`: `controller.enqueue` di
    // uno stream chiuso lancia in modo SINCRONO, quindi l'eccezione uscirebbe
    // prima ancora che ci sia una Promise da agganciare.
    try {
      await fn()
    } catch (err) {
      console.warn(`STREAM(${policy.tag}) consegna fallita (${cosa}):`, err instanceof Error ? err.message : err)
    }
  }

  const emit = async (testo: string) => {
    fullResponse += testo
    await consegnaSicura('testo del loop', () => sink.onText(testo, fullResponse))
  }

  const cfg = await getConfig()
  // Se il circuit breaker ha fatto rollback, `model_active` e' il modello buono
  // e `model_default` puo' essere quello rotto: leggere solo cfg.model lascia il
  // canale fermo sul rotto mentre l'altro e' gia' tornato a funzionare.
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
  // FIX W1: budget thinking ridotto. V10 lasciava 100_000 = il modello pensava
  // per minuti e la function veniva killata da Vercel prima del primo text_delta.
  const modelConfig: ModelConfig = {
    model: effectiveModel,
    thinkingBudget: resolveThinkingBudget(userQuery, isOpus),
    maxTokens: isOpus ? 32_000 : 16_000,
  }
  console.log(`MODEL(${policy.tag}): ${effectiveModel} (cheap=${cheap}) thinking=${modelConfig.thinkingBudget} for "${userQuery.slice(0, 50)}"`)
  const modelOpts = await buildModelOptions(modelConfig.model, modelConfig.thinkingBudget, isDeepThink(userQuery))
  // Il path durable alza il budget (MAX_DURABLE_RUN_TOKENS) per le task lunghe.
  const runBudget = request.maxRunTokens ?? MAX_RUN_TOKENS

  // Senza questo try, un errore API risale alla route e `recordOutcome` in fondo
  // non viene MAI eseguito — cioe' proprio il caso (modello rotto, 404) per cui
  // il circuit breaker esiste.
  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      iterations = i + 1
      const iterStartLen = fullResponse.length // confine per scartare il testo-promessa se ri-promptiamo
      let thinkingChars = 0
      // Tool server-side visti in QUESTA iterazione. Sommati a totalToolCalls solo
      // quando lo stream e' andato a buon fine: contarli dentro onEvent li faceva
      // contare di nuovo a ogni ri-tentativo.
      let serverToolsIter = 0
      // REL-003 + resilienza mid-stream: consumo con retry su errori transitori
      // (overloaded/529/rete/timeout) → un blip a meta' non uccide piu' il turno.
      // onAttemptStart riporta il parziale all'inizio dell'iterazione, cosi' il
      // valore RESTITUITO non contiene il tentativo buttato.
      //
      // ATTENZIONE, e non e' un dettaglio: questo NON basta sul canale web. Il
      // browser ha gia' ricevuto quei delta e persiste cio' che ha ricevuto
      // (chat/page.tsx), non cio' che questa funzione restituisce. Quindi sul web
      // il testo scartato — dal ri-tentativo, ma anche dal force-action e
      // dall'anti-bugia poco sotto — resta nella conversazione salvata e rientra
      // come contesto nei turni successivi. E' un difetto noto e precedente a
      // questo refactor; la cura e' spostare la persistenza web sul server.
      // Vedi docs/superpowers/specs/2026-09-03-loop-unificato-design.md.
      const final = await consumeStreamWithRetry({
        createStream: () => client.messages.stream({
          model: modelConfig.model,
          max_tokens: modelConfig.maxTokens,
          system: systemBlocks,
          messages: currentMessages,
          tools,
          ...modelOpts,
        }, {
          headers: { 'anthropic-beta': 'files-api-2025-04-14' },
        }),
        onAttemptStart: () => {
          fullResponse = fullResponse.slice(0, iterStartLen)
          thinkingChars = 0
          // Anche i tool server-side vanno riazzerati: un web_search gia'
          // annunciato prima che lo stream cadesse verrebbe riemesso dal
          // tentativo successivo e contato due volte. Il conteggio gonfio rende
          // detectHallucination MENO propenso a scattare, cioe' fa passare per
          // riuscito un turno che era una promessa a vuoto.
          serverToolsIter = 0
          sink.onAttemptStart?.()
        },
        onRetry: (n, err) => console.warn(`STREAM(${policy.tag}) retry ${n}: ${err instanceof Error ? err.message : err}`),
        onEvent: async (event) => {
          if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              fullResponse += event.delta.text
              await sink.onText(event.delta.text, fullResponse)
            }
            // Progresso durante il reasoning: solo finche' non c'e' testo (poi il
            // testo prevale). Il canale decide se mostrarlo.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            else if ((event.delta as any).type === 'thinking_delta' && fullResponse === '') {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const td = (event.delta as any).thinking
              thinkingChars += typeof td === 'string' ? td.length : 0
              await sink.onThinking?.(thinkingChars)
            }
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (event.type === 'content_block_start' && (event as any).content_block?.type === 'server_tool_use') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const serverToolName = (event as any).content_block?.name ?? 'server_tool'
            // Contati anche questi: web_search e code_execution girano lato
            // Anthropic e non passano da executeToolBlocks, quindi un turno
            // risolto solo con una ricerca ("Verifico la normativa...") avrebbe
            // totalToolCalls a zero e sarebbe giudicato una promessa a vuoto.
            serverToolsIter += 1
            await sink.onServerTool?.(serverToolName)
          }
        },
      })
      totalToolCalls += serverToolsIter
      accUsage = addUsage(accUsage, final.usage as unknown as UsageTokens)
      const toolBlocks = final.content.filter(b => b.type === 'tool_use')
      // Il modello ha chiuso da solo: non ha chiesto altri tool, il turno e' suo
      // e finito. Serve al guard rail qui sotto per distinguere "tronco un lavoro
      // a meta'" da "il lavoro era gia' finito".
      const modelloHaChiuso = toolBlocks.length === 0 || final.stop_reason === 'end_turn'
      // Guard rail cost-control: il budget serve a fermare una run che sta
      // scappando, non a bocciare un lavoro CONCLUSO che per sua natura costava
      // tanto. Senza `&& !modelloHaChiuso`, un turno completo — documento chiuso,
      // stop_reason end_turn — che sfiorava il tetto veniva dichiarato fallito:
      // il chiamante saltava l'archiviazione, la riga in `documents` non veniva
      // scritta e all'utente arrivava il markup ~~~document grezzo invece del
      // link. E capita proprio sulle richieste pesanti (preventivo, computo,
      // POS, SAL), cioe' quelle che non si vogliono perdere.
      if (isRunOverBudget(accUsage, runBudget) && !modelloHaChiuso) {
        console.warn(`run_aborted_budget: ${runTokens(accUsage)} > ${runBudget} tokens (iter=${iterations})`)
        segnalaFallimento('budget')
        runAbortedBudget = true
        await emit('\n\n⚠️ _Mi fermo qui: la richiesta ha superato il budget di elaborazione. La riformuli in modo più mirato o la spezzi in passi più piccoli._')
        break
      }
      totalToolCalls += toolBlocks.length
      const textBlocks = final.content.filter(b => b.type === 'text')
      // Il contatore va aggiornato PRIMA del ramo di uscita: le iterazioni che
      // fanno `continue` (anti-bugia, force-action) hanno sempre testo, quindi
      // devono azzerarlo. Aggiornandolo dopo, restavano fuori dal conteggio.
      if (textBlocks.length === 0) consecutiveNoText++
      else consecutiveNoText = 0
      const toolNames = toolBlocks
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map(b => b.name)
        .join(',')
      console.log(`STREAM(${policy.tag}) iter=${i} stop=${final.stop_reason} tools=${toolBlocks.length} toolNames=[${toolNames}] texts=${textBlocks.length} fullLen=${fullResponse.length} thinkingChars=${thinkingChars} consNoText=${consecutiveNoText}`)

      // Break naturale: modello soddisfatto (nessun tool richiesto, turno finito)
      if (toolBlocks.length === 0 || final.stop_reason === 'end_turn') {
        const iterText = textBlocks.map(b => (b as Anthropic.TextBlock).text).join(' ')
        // ANTI-BUGIA archiviazione: afferma di aver archiviato/spostato file ma in questo turno
        // nessun archivia_foto/archivia_documento è andato a buon fine → ri-prompt UNA volta.
        // Indipendente dal force-action (scatta anche dopo tool di sola lettura). Guard one-shot.
        if (!forcedArchiveCorrection && claimsArchiveCompletion(iterText) && !archiveToolSucceeded) {
          forcedArchiveCorrection = true
          fullResponse = fullResponse.slice(0, iterStartLen)
          console.log(`STREAM(${policy.tag}) anti-bugia: claim archiviazione senza esito reale ("${iterText.slice(0, 60)}")`)
          currentMessages = [
            ...currentMessages,
            { role: 'assistant' as const, content: final.content },
            { role: 'user' as const, content: [{ type: 'text' as const, text: 'Hai detto che le foto/i file sono stati archiviati/spostati, ma in questo turno NON è andata a buon fine alcuna chiamata ad archivia_foto/archivia_documento. NON dichiarare un archivio che non è avvenuto: O chiami ORA archivia_foto/archivia_documento e riporti l\'esito REALE, oppure dici onestamente che NON sono ancora archiviati e cosa manca.' }] },
          ]
          applyIncrementalCacheBreakpoint(currentMessages)
          continue
        }
        // FORCE-ACTION: il modello ha PROMESSO un'azione ("ora cerco", "glielo invio subito"…)
        // ma NON ha chiamato alcun tool in questo turno → l'azione non è stata eseguita.
        // Invece di consegnare la promessa a vuoto, lo ri-promptiamo UNA volta perché esegua
        // davvero. Guard forcedAction = una sola volta → nessun loop.
        if (toolBlocks.length === 0 && !forcedAction && detectHallucination(iterText, 0) && !isCompletedOrConditional(iterText)) {
          forcedAction = true
          fullResponse = fullResponse.slice(0, iterStartLen) // scarta il testo-promessa dalla persistenza/ritorno
          console.log(`STREAM(${policy.tag}) force-action: promessa senza tool ("${iterText.slice(0, 60)}"), ri-prompt per eseguire`)
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

      // I tool dell'iterazione corrente si ESEGUONO sempre, prima di valutare se
      // forzare la sintesi. Qui c'era `if (!iterationHasText && i > 0) break`, che
      // interrompeva PRIMA di eseguirli: incatenare due tool senza scrivere testo
      // in mezzo — leggi intestazione del Registro, poi scrivi la riga — e'
      // comportamento normale del modello, e faceva morire il turno in silenzio.
      const toolResults = await executeToolBlocks(toolBlocks, conversationId)
      if (toolResults.length === 0) break
      if (archiveToolSucceededIn(toolBlocks, toolResults)) archiveToolSucceeded = true

      currentMessages = [
        ...currentMessages,
        { role: 'assistant' as const, content: final.content },
        { role: 'user' as const, content: toolResults },
      ]
      applyIncrementalCacheBreakpoint(currentMessages)

      // La seconda meta' del fix, quella che conta. Togliere il break senza
      // questa lascia un rischio preciso: un modello che si impunta su una
      // scrittura (scrivi_riga_registro, archivia_foto, invio mail) arriverebbe a
      // 10 esecuzioni REALI. Righe duplicate sul Registro e foto doppie sono
      // guasti gia' visti in produzione. Dopo NO_TEXT_LIMIT giri muti si forza
      // una sintesi con tool_choice=none: il modello non puo' piu' chiamare tool
      // e DEVE rispondere.
      if (consecutiveNoText >= NO_TEXT_LIMIT) {
        console.log(`STREAM(${policy.tag}) force-text: ${consecutiveNoText} iter consecutive senza testo, forzo tool_choice=none`)
        try {
          const synthStartLen = fullResponse.length
          const synthFinal = await consumeStreamWithRetry({
            createStream: () => client.messages.stream({
              model: modelConfig.model,
              max_tokens: modelConfig.maxTokens,
              system: systemBlocks,
              messages: currentMessages,
              tools,
              tool_choice: { type: 'none' as const },
              ...modelOpts,
            }, {
              headers: { 'anthropic-beta': 'files-api-2025-04-14' },
            }),
            onAttemptStart: () => {
              fullResponse = fullResponse.slice(0, synthStartLen)
              sink.onAttemptStart?.()
            },
            onRetry: (n, err) => console.warn(`STREAM(${policy.tag}) force-text retry ${n}: ${err instanceof Error ? err.message : err}`),
            onEvent: async (event) => {
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                fullResponse += event.delta.text
                await sink.onText(event.delta.text, fullResponse)
              }
            },
          })
          accUsage = addUsage(accUsage, synthFinal.usage as unknown as UsageTokens)
          const synthTexts = synthFinal.content.filter(b => b.type === 'text').length
          console.log(`STREAM(${policy.tag}) force-text done texts=${synthTexts} fullLen=${fullResponse.length}`)
        } catch (err) {
          console.warn(`STREAM(${policy.tag}) force-text FAIL:`, err instanceof Error ? err.message : err)
        }
        break
      }
    }
  } catch (err) {
    // Errori API (404 model not found, 529 overloaded, timeout): (a) l'outcome
    // va tracciato sul circuit breaker e (b) l'utente deve leggere una frase
    // comprensibile, non il messaggio tecnico grezzo.
    apiErrorOccurred = true
    const apiError = errorDetails(err)
    apiErrorRecordDetails = apiError.details
    // `details` e non `message`: contiene anche status= e type=, che sono la
    // differenza fra "so cos'e' successo" e "un 404 generico". Prima finivano
    // solo in recordOutcome, che dai log non si legge.
    console.warn(`[STREAM(${policy.tag}) API ERROR] model=${modelConfig.model}: ${apiErrorRecordDetails.slice(0, 300)}`)
    // Il chiamante deve sapere che quello che segue e' un errore, non una
    // risposta: sul web la pipeline post-stream archivia bozze e documenti.
    segnalaFallimento('api_error')
    if (isBillingError(apiErrorRecordDetails)) {
      // Il .catch() e' necessario: siamo gia' dentro un catch, un errore qui
      // sfuggirebbe e ucciderebbe il turno al posto del messaggio d'errore.
      await notifyAnthropicBillingIfNeeded(apiErrorRecordDetails).catch(() => {})
    }
    const errMsg = messaggioErroreUtente(apiError.message, apiErrorRecordDetails)
    if (fullResponse.length > 0) {
      // Preserva il parziale invece di sovrascriverlo: se l'errore arriva a meta'
      // streaming (es. dopo aver letto 5 mail), la consegna finale cancellerebbe
      // tutto il testo gia' prodotto sostituendolo col messaggio d'errore.
      fullResponse = fullResponse.trimEnd()
      await emit('\n\n' + errMsg + '\n_(quanto sopra è la risposta parziale prima dell\'errore; riprovi per completarla)_')
    } else {
      await emit(errMsg)
    }
  }

  // Se per qualunque motivo il loop finisce senza che il modello abbia mai
  // prodotto testo, l'utente riceverebbe ZERO caratteri — indistinguibile da un
  // bot che ignora. Meglio dirlo.
  if (fullResponse.length === 0) {
    console.warn(`STREAM(${policy.tag}) EMPTY: fullResponse vuoto dopo ${iterations} iter, applicato fallback`)
    segnalaFallimento('empty')
    await emit('⚠️ Non sono riuscito a sintetizzare una risposta. Riformuli la richiesta o specifichi il file/contesto, per favore.')
  }
  console.log(`STREAM(${policy.tag}) done fullLen=${fullResponse.length} apiError=${apiErrorOccurred}`)
  // Stessa ragione di `emit`: la consegna finale non deve poter impedire la
  // registrazione dell'esito qui sotto.
  await consegnaSicura('consegna finale', () => sink.onFinal?.(fullResponse))

  // La condizione era `!apiErrorOccurred`, cioe' copriva un motivo su tre: il
  // testo di un turno muto ("non sono riuscito a sintetizzare") e quello di una
  // run troncata finivano in `messages` e, superando MIN_EMBEDDING_LENGTH,
  // venivano EMBEDDATI — quindi recuperabili da searchMemory come se fossero
  // conoscenza. E' la stessa malattia curata a valle nei chiamanti, lasciata
  // viva alla sorgente.
  // NB: cosi' un parziale che l'utente ha letto non entra in memoria. E' una
  // perdita nota e voluta qui: persistere i parziali marcandoli come tali e'
  // una decisione a parte (vedi la spec del 3 set).
  if (policy.persistAssistantMessage && conversationId && fullResponse && !turnoNonConsegnato) {
    saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
  }

  const FALLBACK_PREFIX = '⚠️ Non sono riuscito a sintetizzare'
  const outcome: ModelOutcome = apiErrorOccurred
    ? 'api_error'
    : fullResponse.startsWith(FALLBACK_PREFIX)
      ? 'empty'
      // Troncato dal guard rail di costo. NON e' 'success' — un runaway da 200K
      // token non e' un turno riuscito e sparirebbe dalla telemetria — ma non e'
      // nemmeno un guasto del MODELLO: e' la richiesta a essere grossa. Contarlo
      // fra i fallimenti farebbe scattare il rollback su un modello sano dopo
      // tre richieste pesanti di fila, che e' lo stesso difetto (falso segnale →
      // rollback immotivato) chiuso oggi su web_search e sulle promesse
      // mantenute. `run_aborted` e' escluso dal conteggio in circuit-breaker.
      : runAbortedBudget
        ? 'run_aborted'
      // Un turno che ha dovuto forzare la sintesi e' degradato, non riuscito.
      // Classificarlo 'success' INIETTA successi proprio nei turni andati male,
      // rendendo il breaker piu' difficile da far scattare invece che piu' facile.
      : consecutiveNoText >= NO_TEXT_LIMIT
        ? 'force_text'
        // `isCompletedOrConditional` e' lo stesso guard che il force-action applica
        // sopra: senza, "Ho preparato il documento. Se vuole glielo mando" viene
        // contato come promessa mancata. Misurato: 6 falsi positivi su 8.
        : detectHallucination(fullResponse, totalToolCalls) && !isCompletedOrConditional(fullResponse)
          ? 'hallucination'
          : 'success'

  if (outcome === 'success') resetAnthropicBillingAlertIfNeeded()

  recordOutcome(modelConfig.model, outcome, {
    fullLen: fullResponse.length,
    consecutiveNoText,
    requestId: conversationId,
    details: apiErrorOccurred ? apiErrorRecordDetails.slice(0, 500) : undefined,
  }).catch(err => console.error(`[CB] recordOutcome(${policy.tag}) failed:`, err))

  await logApiUsage({
    entryPoint: request.entryPoint ?? policy.entryPoint,
    model: modelConfig.model,
    usage: accUsage,
    meta: {
      iterations,
      consecutiveNoText,
      outcome,
      totalToolCalls,
      apiError: apiErrorOccurred,
      runAborted: isRunOverBudget(accUsage, runBudget),
    },
    // Un blip di Supabase sulla contabilita' consumi non deve far fallire un
    // turno gia' consegnato all'utente: senza il .catch(), la route ci
    // metterebbe sopra un banner d'errore su una risposta perfettamente
    // riuscita.
  }).catch(err => console.error('[api-usage] logApiUsage fallita:', err instanceof Error ? err.message : err))

  return fullResponse
}

// ── Gli adattatori: tutto quello che resta di specifico per canale ──

/**
 * Chat web. Appende ogni delta allo stream HTTP: l'utente vede il testo
 * comparire mentre viene generato. Non scrive a DB — la riga la scrive il
 * browser con una POST separata, e scriverla anche qui produceva due righe.
 */
export async function callClaudeStream(
  request: ClaudeRequest,
  callbacks: ClaudeStreamCallbacks,
): Promise<string> {
  return runAgentTurn(
    request,
    {
      onText: (delta) => { callbacks.onText(delta) },
      onServerTool: (nome) => { callbacks.onToolStart?.(nome) },
      onTurnFailed: (motivo) => { callbacks.onTurnFailed?.(motivo) },
    },
    { tag: 'web', entryPoint: 'chat', persistUserMessage: false, persistAssistantMessage: false },
  )
}

/** Ogni quanto riscrivere il messaggio Telegram: sotto, si sbatte contro i rate limit. */
const TELEGRAM_TEXT_EDIT_MS = 3000
const TELEGRAM_THINKING_EDIT_MS = 5000

/**
 * Telegram. Non ha streaming: riscrive lo STESSO messaggio a intervalli, quindi
 * riceve il testo accumulato e non i delta. Finche' non c'e' testo mostra un
 * segnale di vita col conteggio del reasoning, altrimenti l'utente resta davanti
 * a un messaggio fermo per minuti.
 */
export async function callClaudeStreamTelegram(
  request: ClaudeRequest,
  onChunk: (accumulated: string) => void | Promise<void>,
  callbacks?: Pick<ClaudeStreamCallbacks, 'onTurnFailed'>,
): Promise<string> {
  let lastTextEdit = 0
  let lastThinkingEdit = 0
  return runAgentTurn(
    request,
    {
      onTurnFailed: (motivo) => { callbacks?.onTurnFailed?.(motivo) },
      onAttemptStart: () => { lastTextEdit = 0; lastThinkingEdit = 0 },
      onText: async (_delta, accumulated) => {
        const now = Date.now()
        if (now - lastTextEdit > TELEGRAM_TEXT_EDIT_MS) {
          await onChunk(accumulated)
          lastTextEdit = now
        }
      },
      onThinking: async (chars) => {
        const now = Date.now()
        if (now - lastThinkingEdit > TELEGRAM_THINKING_EDIT_MS) {
          await onChunk(`🧠 Sto pensando... (${chars} char di reasoning)`)
          lastThinkingEdit = now
        }
      },
      // L'edit finale e' atteso esplicitamente: se la function muore subito dopo
      // il loop, un fire-and-forget non partirebbe e l'utente resterebbe col
      // parziale.
      onFinal: async (testo) => { await onChunk(testo) },
    },
    { tag: 'tg', entryPoint: 'telegram', persistUserMessage: true, persistAssistantMessage: true },
  )
}

// ── Helpers ──

async function executeToolBlocks(toolBlocks: any[], conversationId?: string): Promise<any[]> {
  const results: any[] = []
  for (const block of toolBlocks) {
    if (block.type !== 'tool_use') continue
    if (block.name === 'web_search' || block.name === 'code_execution') continue // server-side

    try {
      const result = await executeTool(block.name, block.input as Record<string, unknown>, conversationId)
      if (block.name === 'rivedi_immagine') {
        // Tool result speciale: ri-aggancia i pixel come blocco immagine vero.
        let parsed: { ok?: boolean; base64?: string; mimeType?: string; filename?: string; message?: string }
        try { parsed = JSON.parse(result) } catch { parsed = { ok: false, message: result } }
        if (parsed?.ok && parsed.base64 && parsed.mimeType) {
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: [
              { type: 'image', source: { type: 'base64', media_type: parsed.mimeType, data: parsed.base64 } },
              { type: 'text', text: `Immagine ri-agganciata: ${parsed.filename ?? ''}` },
            ],
          })
        } else {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: parsed?.message ?? 'Errore nel recupero immagine.' })
        }
        continue
      }
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
