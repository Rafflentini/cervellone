// src/lib/api-usage.ts — Logging consumi API Anthropic (Step 1 cost-control, 4 giu 2026)
//
// Best-effort: dopo ogni chiamata Claude scriviamo una riga in `api_usage` con token + costo
// stimato per entry_point. NON deve MAI lanciare o bloccare la UX: tutto avvolto in try/catch
// e l'errore Postgrest viene gestito via `{ error }` (NON `.catch` sul builder — lezione nota).

import { getSupabaseServer } from '@/lib/supabase-server'

// ── Tariffe per modello (USD per 1M token) ──────────────────────────────────────
// Match per sottostringa del nome modello. Default = opus (conservativo: tariffa più alta).

interface Rates {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

const RATES: Record<'opus' | 'sonnet' | 'haiku', Rates> = {
  opus: { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
}

function resolveRates(model: string): Rates {
  const m = (model || '').toLowerCase()
  if (m.includes('haiku')) return RATES.haiku
  if (m.includes('sonnet')) return RATES.sonnet
  if (m.includes('opus')) return RATES.opus
  // Default conservativo: opus (tariffa più alta, non sottostimiamo il costo)
  return RATES.opus
}

// ── Tipi e accumulo usage ───────────────────────────────────────────────────────

export type UsageTokens = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Somma due usage campo per campo (gestisce undefined). Per accumulare nel tool-loop. */
export function addUsage(acc: UsageTokens, u?: UsageTokens | null): UsageTokens {
  if (!u) return acc
  return {
    input_tokens: (acc.input_tokens ?? 0) + (u.input_tokens ?? 0),
    output_tokens: (acc.output_tokens ?? 0) + (u.output_tokens ?? 0),
    cache_read_input_tokens:
      (acc.cache_read_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (acc.cache_creation_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  }
}

/** Stima del costo in USD per la usage data, secondo le tariffe del modello. */
export function estimateCostUsd(model: string, t: UsageTokens): number {
  const r = resolveRates(model)
  const cost =
    ((t.input_tokens ?? 0) / 1e6) * r.input +
    ((t.output_tokens ?? 0) / 1e6) * r.output +
    ((t.cache_creation_input_tokens ?? 0) / 1e6) * r.cacheWrite +
    ((t.cache_read_input_tokens ?? 0) / 1e6) * r.cacheRead
  return cost
}

// ── Logging best-effort ─────────────────────────────────────────────────────────

/**
 * Inserisce una riga in `api_usage` via service_role. Best-effort: non lancia mai,
 * non blocca la UX. Sicuro da `await`.
 */
export async function logApiUsage(args: {
  entryPoint: string
  model: string
  usage: UsageTokens
  meta?: Record<string, unknown>
}): Promise<void> {
  try {
    const supabase = getSupabaseServer()
    const { entryPoint, model, usage, meta } = args
    const { error } = await supabase.from('api_usage').insert({
      entry_point: entryPoint,
      model,
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
      estimated_cost_usd: estimateCostUsd(model, usage),
      meta: meta ?? null,
    })
    if (error) {
      console.warn('[api-usage] insert failed:', error.message)
    }
  } catch (err) {
    console.warn('[api-usage] logApiUsage threw (swallowed):', err instanceof Error ? err.message : err)
  }
}
