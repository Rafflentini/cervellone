// src/lib/audit-collector.ts — 5 funzioni raccolta dati per self-audit settimanale
// Spec: docs/superpowers/specs/2026-05-07-cervellone-self-audit-design.md §4
// Aggregazioni in TS (Supabase v2 non supporta GROUP BY via client)

import { supabase } from '@/lib/supabase'

// ── Result type uniforme ──────────────────────────────────────────────────────

export interface DimensionResult<T> {
  ok: boolean
  data?: T
  error?: string
}

// ── Helper: ISO date string per N giorni fa ───────────────────────────────────

function daysAgoISO(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString()
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function dateISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// ── D1: Model Health ─────────────────────────────────────────────────────────

export interface ModelHealthRow {
  model: string
  outcome: string
  n: number
}

export interface ModelHealthData {
  rows: ModelHealthRow[]
  total: number
  error_rate: number
  hallucination_rate: number
}

/**
 * Raccoglie errori modello (non-canary) degli ultimi 7 giorni.
 * Query §4 D1. Aggregazione group by (model, outcome) in TS.
 */
export async function collectModelHealth(): Promise<DimensionResult<ModelHealthData>> {
  const since = daysAgoISO(7)

  const { data, error } = await supabase
    .from('model_health')
    .select('model, outcome')
    .eq('is_canary', false)
    .gte('ts', since)
    .order('ts', { ascending: false })

  if (error) return { ok: false, error: error.message }

  const rows = data ?? []
  const total = rows.length

  // Aggregazione: group by (model, outcome)
  const countMap = new Map<string, number>()
  for (const r of rows) {
    const key = `${r.model}||${r.outcome}`
    countMap.set(key, (countMap.get(key) ?? 0) + 1)
  }

  const aggregated: ModelHealthRow[] = []
  for (const [key, n] of countMap) {
    const [model, outcome] = key.split('||')
    aggregated.push({ model, outcome, n })
  }

  const errorCount = rows.filter(r => r.outcome !== 'success' && r.outcome !== 'hallucination').length
  const hallucinationCount = rows.filter(r => r.outcome === 'hallucination').length

  const error_rate = total > 0 ? errorCount / total : 0
  const hallucination_rate = total > 0 ? hallucinationCount / total : 0

  return {
    ok: true,
    data: { rows: aggregated, total, error_rate, hallucination_rate },
  }
}

// ── D2: Circuit Breaker Events ────────────────────────────────────────────────

export interface BreakerEvent {
  model: string
  outcome: string
  details: unknown
  ts: string
}

export interface BreakerEventsData {
  events: BreakerEvent[]
  trip_count: number
  recovery_count: number
}

/**
 * Raccoglie eventi canary (api_error, timeout, empty) degli ultimi 7 giorni.
 * Query §4 D2.
 */
export async function collectBreakerEvents(): Promise<DimensionResult<BreakerEventsData>> {
  const since = daysAgoISO(7)

  const { data, error } = await supabase
    .from('model_health')
    .select('model, outcome, details, ts')
    .eq('is_canary', true)
    .gte('ts', since)
    .in('outcome', ['api_error', 'timeout', 'empty'])
    .order('ts', { ascending: false })

  if (error) return { ok: false, error: error.message }

  const events = (data ?? []) as BreakerEvent[]
  const trip_count = events.filter(e => ['api_error', 'timeout'].includes(e.outcome)).length
  const recovery_count = events.filter(e => e.outcome === 'empty').length

  return {
    ok: true,
    data: { events, trip_count, recovery_count },
  }
}

// ── D3: Gmail Health ──────────────────────────────────────────────────────────

export interface GmailDayRow {
  bot_action: string
  day: string // YYYY-MM-DD
  n: number
}

export interface GmailHealthData {
  rows: GmailDayRow[]
}

/**
 * Raccoglie elaborazioni mail degli ultimi 7 giorni.
 * Query §4 D3. Aggregazione group by (bot_action, day) in TS.
 * Graceful: tabella potrebbe non esistere.
 */
export async function collectGmailHealth(): Promise<DimensionResult<GmailHealthData>> {
  const since = daysAgoISO(7)

  const { data, error } = await supabase
    .from('gmail_processed_messages')
    .select('bot_action, ts')
    .gte('ts', since)
    .order('ts', { ascending: false })

  if (error) return { ok: false, error: error.message }

  const rows = data ?? []

  // Aggregazione: group by (bot_action, day in Rome time approx UTC+2)
  const countMap = new Map<string, number>()
  for (const r of rows) {
    // Approssimazione Rome: UTC+2 (accettato 1h drift per MVP)
    const d = new Date(r.ts)
    d.setHours(d.getHours() + 2)
    const day = dateISO(d)
    const key = `${r.bot_action}||${day}`
    countMap.set(key, (countMap.get(key) ?? 0) + 1)
  }

  const aggregated: GmailDayRow[] = []
  for (const [key, n] of countMap) {
    const [bot_action, day] = key.split('||')
    aggregated.push({ bot_action, day, n })
  }

  // Ordina per day DESC
  aggregated.sort((a, b) => b.day.localeCompare(a.day))

  return { ok: true, data: { rows: aggregated } }
}

// ── D4: Memoria Runs ──────────────────────────────────────────────────────────

export interface MemoriaRunRow {
  date_processed: string
  status: string
  conversations_count: number | null
  entities_count: number | null
  llm_cost_estimate_usd: number | null
  error_message: string | null
}

export interface MemoriaRunsData {
  runs: MemoriaRunRow[]
  ok_count: number
  error_count: number
  missing_dates: string[]
}

/**
 * Raccoglie run memoria-extract degli ultimi 7 giorni.
 * Calcola date mancanti rispetto ai 7gg attesi.
 * Query §4 D4.
 */
export async function collectMemoriaRuns(): Promise<DimensionResult<MemoriaRunsData>> {
  const today = todayISO()
  const since7 = new Date()
  since7.setDate(since7.getDate() - 7)
  const sinceStr = dateISO(since7)

  const { data, error } = await supabase
    .from('cervellone_memoria_extraction_runs')
    .select('date_processed, status, conversations_count, entities_count, llm_cost_estimate_usd, error_message')
    .gte('date_processed', sinceStr)
    .order('date_processed', { ascending: false })

  if (error) return { ok: false, error: error.message }

  const runs = (data ?? []) as MemoriaRunRow[]
  const ok_count = runs.filter(r => r.status === 'ok').length
  const error_count = runs.filter(r => r.status === 'error').length

  // Calcola date mancanti (ieri e ultimi 6 giorni lavorativi = semplificato: ultimi 7 gg)
  const foundDates = new Set(runs.map(r => r.date_processed))
  const missing_dates: string[] = []
  for (let i = 1; i <= 7; i++) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - i)
    const ds = dateISO(d)
    if (ds < today && !foundDates.has(ds)) {
      missing_dates.push(ds)
    }
  }

  return {
    ok: true,
    data: { runs, ok_count, error_count, missing_dates },
  }
}

// ── D5: Cost Estimate ─────────────────────────────────────────────────────────

export interface CostEstimateData {
  memoria_7d: number
  canary_fixed: number
  total_7d: number
  avg_per_day: number
}

/**
 * Stima costo Anthropic degli ultimi 7 giorni.
 * Somma llm_cost_estimate_usd da memoria runs + stima fissa canary ($0.34/settimana).
 * Query §4 D5.
 */
export async function collectCostEstimate(): Promise<DimensionResult<CostEstimateData>> {
  const since7 = new Date()
  since7.setDate(since7.getDate() - 7)
  const sinceStr = dateISO(since7)

  const { data, error } = await supabase
    .from('cervellone_memoria_extraction_runs')
    .select('date_processed, llm_cost_estimate_usd')
    .gte('date_processed', sinceStr)
    .order('date_processed', { ascending: false })

  if (error) return { ok: false, error: error.message }

  const rows = data ?? []
  const memoria_7d = rows.reduce((sum: number, r: { llm_cost_estimate_usd: number | null }) => {
    return sum + (Number(r.llm_cost_estimate_usd) || 0)
  }, 0)

  const canary_fixed = 0.34 // stima fissa cron canary (~$0.34/settimana)
  const total_7d = parseFloat((memoria_7d + canary_fixed).toFixed(6))
  const avg_per_day = parseFloat((total_7d / 7).toFixed(6))

  return {
    ok: true,
    data: { memoria_7d, canary_fixed, total_7d, avg_per_day },
  }
}
