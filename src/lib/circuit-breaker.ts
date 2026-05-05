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
