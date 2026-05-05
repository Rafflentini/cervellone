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
