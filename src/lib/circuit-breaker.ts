/**
 * lib/circuit-breaker.ts — Circuit Breaker per modello Anthropic.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cervellone-circuit-breaker-design.md
 *
 * In stato NORMAL il bot usa model_default (alias claude-opus-latest).
 * Quando 3+ outcome falliti su ultimi 5 → trip a model_stable (config manuale).
 * Cron canary ogni 30 min ritenta latest, dopo 3 OK consecutive resetta.
 */

import { supabase } from './supabase'
import { sendTelegramMessage } from './telegram-helpers'

// ── Types ──

export type ModelOutcome =
  | 'success'
  | 'empty'
  | 'force_text'
  | 'hallucination'
  | 'api_error'
  | 'timeout'

export interface OutcomeDetails {
  fullLen?: number
  consecutiveNoText?: number
  details?: string
  isCanary?: boolean
  requestId?: string
}

export type CircuitStateValue = 'NORMAL' | 'ROLLED_BACK'

export interface CircuitState {
  state: CircuitStateValue
  tripped_at: string | null
  reason: string | null
  canary_consecutive_ok: number
}

// ── Costanti ──

const FAILURE_THRESHOLD = 3
const SAMPLE_WINDOW = 5
const CANARY_OK_TARGET = 3
const NOTIFY_THROTTLE_MS = 60 * 60 * 1000  // 1 ora

// Pattern italiani di promesse-azione senza tool corrispondente.
// Usati da detectHallucination per identificare hallucinations.
const PROMISE_PATTERNS: RegExp[] = [
  /\b(lo|la)\s+(cerco|controllo|leggo|scarico|guardo|verifico|trovo|prendo)\b/i,
  /\b(ora|adesso|subito)\s+(cerco|controllo|leggo|scarico|guardo|verifico)\b/i,
  /\bfaccio\s+(subito|adesso|ora)\b/i,
  /\bvado\s+a\s+(leggere|scaricare|cercare|guardare|verificare)\b/i,
  /\b(cerco|leggo|verifico)\s+subito\b/i,
]

// ── Cache stato breaker ──

interface BreakerCache {
  activeModel: string
  state: CircuitState
  cachedAt: number
}

let cache: BreakerCache | null = null
const CACHE_TTL_MS = 60_000  // 60s

export function invalidateCache(): void {
  cache = null
}

/**
 * Rileva hallucination: il modello promette un'azione concreta nel testo
 * ma non emette il tool_use corrispondente nello stesso turno.
 */
export function detectHallucination(text: string, toolCount: number): boolean {
  if (toolCount > 0) return false  // tool chiamato → no hallucination
  if (!text || text.length === 0) return false
  return PROMISE_PATTERNS.some(p => p.test(text))
}

async function loadConfig(): Promise<{ activeModel: string; state: CircuitState } | null> {
  const { data, error } = await supabase
    .from('cervellone_config')
    .select('key, value')
    .in('key', ['model_active', 'circuit_state'])
  if (error || !data) return null
  let activeModel = 'claude-opus-latest'
  let state: CircuitState = { state: 'NORMAL', tripped_at: null, reason: null, canary_consecutive_ok: 0 }
  for (const row of data) {
    if (row.key === 'model_active') {
      activeModel = String(row.value).replace(/"/g, '')
    } else if (row.key === 'circuit_state') {
      try {
        const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
        if (parsed && typeof parsed === 'object') {
          state = parsed as CircuitState
        }
      } catch {
        // value malformato, usa default
      }
    }
  }
  return { activeModel, state }
}

/**
 * Restituisce il modello attualmente attivo. Cached 60s.
 * Chiamato dal hot path di ogni request — deve essere veloce.
 */
export async function getActiveModel(): Promise<string> {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.activeModel
  }
  const loaded = await loadConfig()
  if (loaded) {
    cache = { ...loaded, cachedAt: Date.now() }
    return loaded.activeModel
  }
  return 'claude-opus-4-7'
}

/**
 * Restituisce lo stato breaker corrente. Cached 60s (stessa cache di getActiveModel).
 */
export async function getCircuitState(): Promise<CircuitState> {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.state
  }
  const loaded = await loadConfig()
  if (loaded) {
    cache = { ...loaded, cachedAt: Date.now() }
    return loaded.state
  }
  return { state: 'NORMAL', tripped_at: null, reason: null, canary_consecutive_ok: 0 }
}

/**
 * Registra l'outcome di una request modello. Fire-and-forget — non blocca.
 * Se non canary e outcome != success, verifica il threshold (3 fail su 5)
 * e in caso scatta tripBreaker.
 */
export async function recordOutcome(
  model: string,
  outcome: ModelOutcome,
  details?: OutcomeDetails,
): Promise<void> {
  // INSERT fire-and-forget — errori non devono bloccare
  supabase
    .from('model_health')
    .insert({
      model,
      request_id: details?.requestId || null,
      is_canary: details?.isCanary || false,
      outcome,
      full_len: details?.fullLen ?? null,
      consecutive_no_text: details?.consecutiveNoText ?? null,
      details: details?.details ?? null,
    })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) console.error('[CB] recordOutcome insert failed:', error.message)
    })

  // Threshold check: solo se non canary e outcome è fail
  if (details?.isCanary || outcome === 'success') return

  try {
    const { data } = await supabase
      .from('model_health')
      .select('outcome')
      .eq('model', model)
      .eq('is_canary', false)
      .order('ts', { ascending: false })
      .limit(SAMPLE_WINDOW)

    if (!data || data.length < SAMPLE_WINDOW) return

    const failures = data.filter((r: { outcome: string }) => r.outcome !== 'success').length
    if (failures >= FAILURE_THRESHOLD) {
      const reason = `${failures} fail su ${data.length} ultimi: ${data.map((r: { outcome: string }) => r.outcome).join(',')}`
      console.log(`[CB] threshold tripped for ${model}: ${reason}`)
      await tripBreaker(reason)
    }
  } catch (err) {
    console.error('[CB] threshold check failed:', err instanceof Error ? err.message : err)
  }
}

let lastNotifyAt = 0

async function notifyAdmin(text: string, force = false): Promise<void> {
  const now = Date.now()
  if (!force && now - lastNotifyAt < NOTIFY_THROTTLE_MS) {
    console.log('[CB] notify throttled (lastNotifyAt < 1h fa)')
    return
  }
  lastNotifyAt = now
  console.log(`[CB] notify: ${text.slice(0, 100)}`)

  const adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
  if (adminChat) {
    await sendTelegramMessage(adminChat, text).catch(err =>
      console.error('[CB] notify Telegram failed:', err)
    )
  }

  try {
    const { data } = await supabase
      .from('conversations')
      .select('id')
      .neq('title', '💬 Telegram')
      .order('created_at', { ascending: false })
      .limit(5)
    if (data && data.length > 0) {
      await supabase.from('messages').insert(
        data.map((c: { id: string }) => ({
          conversation_id: c.id,
          role: 'assistant',
          content: text,
        }))
      )
    }
  } catch (err) {
    console.error('[CB] notify webchat failed:', err)
  }
}

/**
 * Forza rollback al modello stabile. Idempotente: se già ROLLED_BACK, skip.
 */
export async function tripBreaker(reason: string): Promise<void> {
  const current = await getCircuitState()
  if (current.state === 'ROLLED_BACK') {
    console.log('[CB] tripBreaker skipped: already ROLLED_BACK')
    return
  }

  const { data: stableRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'model_stable')
    .maybeSingle()
  const stableModel = stableRow?.value
    ? String(stableRow.value).replace(/"/g, '')
    : 'claude-opus-4-7'

  const { data: defaultRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'model_default')
    .maybeSingle()
  const defaultModel = defaultRow?.value
    ? String(defaultRow.value).replace(/"/g, '')
    : 'claude-opus-latest'

  const newState: CircuitState = {
    state: 'ROLLED_BACK',
    tripped_at: new Date().toISOString(),
    reason,
    canary_consecutive_ok: 0,
  }

  await supabase
    .from('cervellone_config')
    .update({ value: stableModel })
    .eq('key', 'model_active')

  await supabase
    .from('cervellone_config')
    .update({ value: newState })
    .eq('key', 'circuit_state')

  invalidateCache()

  await notifyAdmin(
    `⚠️ *Rollback automatico* — rilevata regressione su \`${defaultModel}\`.\n` +
    `Bot tornato a \`${stableModel}\` (stable).\n` +
    `Motivo: ${reason}\n\n` +
    `Il canary ritenterà \`${defaultModel}\` ogni 30 min e tornerà al default quando 3 canary consecutivi vanno OK.`,
    true,
  )
}

/**
 * Resetta lo stato a NORMAL e ritorna a model_default. Chiamato dal canary
 * dopo CANARY_OK_TARGET success consecutivi.
 */
export async function resetBreaker(): Promise<void> {
  const current = await getCircuitState()
  if (current.state === 'NORMAL') {
    console.log('[CB] resetBreaker skipped: already NORMAL')
    return
  }

  const { data: defaultRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'model_default')
    .maybeSingle()
  const defaultModel = defaultRow?.value
    ? String(defaultRow.value).replace(/"/g, '')
    : 'claude-opus-latest'

  const newState: CircuitState = {
    state: 'NORMAL',
    tripped_at: null,
    reason: null,
    canary_consecutive_ok: 0,
  }

  await supabase
    .from('cervellone_config')
    .update({ value: defaultModel })
    .eq('key', 'model_active')

  await supabase
    .from('cervellone_config')
    .update({ value: newState })
    .eq('key', 'circuit_state')

  invalidateCache()

  await notifyAdmin(
    `✅ *Recovery automatico* — \`${defaultModel}\` torna stabile dopo ${CANARY_OK_TARGET} canary OK consecutivi. Bot riattivato sul default.`,
    true,
  )
}

/**
 * Promuove un nuovo modello a default. Il vecchio default diventa stable.
 */
export async function promoteModel(newDefault: string): Promise<{
  oldDefault: string
  oldStable: string
  newDefault: string
  newStable: string
}> {
  if (!newDefault || !newDefault.startsWith('claude-')) {
    throw new Error(`Modello non valido: "${newDefault}". Deve iniziare con "claude-".`)
  }

  const { data } = await supabase
    .from('cervellone_config')
    .select('key, value')
    .in('key', ['model_default', 'model_stable'])
  const map: Record<string, string> = {}
  for (const r of data || []) {
    map[r.key] = String(r.value).replace(/"/g, '')
  }
  const oldDefault = map.model_default || 'claude-opus-latest'
  const oldStable = map.model_stable || 'claude-opus-4-7'
  const newStable = oldDefault

  await supabase
    .from('cervellone_config')
    .update({ value: newDefault })
    .eq('key', 'model_default')
  await supabase
    .from('cervellone_config')
    .update({ value: newStable })
    .eq('key', 'model_stable')
  await supabase
    .from('cervellone_config')
    .update({ value: newDefault })
    .eq('key', 'model_active')
  await supabase
    .from('cervellone_config')
    .update({
      value: { state: 'NORMAL', tripped_at: null, reason: null, canary_consecutive_ok: 0 },
    })
    .eq('key', 'circuit_state')

  invalidateCache()

  await notifyAdmin(
    `🚀 *Promozione modello* — \`${newDefault}\` è il nuovo default.\n` +
    `\`${newStable}\` ora è il fallback stable di backup.\n` +
    `Vecchio stable \`${oldStable}\` non è più usato.`,
    true,
  )

  return { oldDefault, oldStable, newDefault, newStable }
}
