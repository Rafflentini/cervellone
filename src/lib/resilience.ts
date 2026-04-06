/**
 * lib/resilience.ts — REL-001, REL-002, REL-003 fix
 * Fault tolerance per Supabase, retry per Anthropic, health tracking.
 */

import { supabase } from './supabase'
import { logWarn } from './sanitize'

// ── REL-001: Safe Supabase wrapper ──

export async function safeSupabase<T>(
  operation: () => Promise<{ data: T | null; error: any }>,
  fallback: T | null = null
): Promise<T | null> {
  try {
    const { data, error } = await operation()
    if (error) {
      logWarn(`Supabase error (non-fatal): ${error.message}`)
      return fallback
    }
    return data
  } catch (err) {
    logWarn(`Supabase unreachable (non-fatal): ${(err as Error).message}`)
    return fallback
  }
}

// ── REL-003: Retry con exponential backoff ──

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      const status = err?.status || err?.error?.status
      const isRetryable = [429, 503, 529].includes(status)
      if (!isRetryable || attempt === maxRetries) throw err
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500
      logWarn(`API ${status}, retry ${attempt + 1}/${maxRetries} in ${Math.round(delay)}ms`)
      await new Promise(r => setTimeout(r, delay))
    }
  }
  throw new Error('Unreachable')
}

// ── REL-002: Health tracking per embedding service ──

let embeddingFailCount = 0
let lastAlertSent = 0

export function trackEmbeddingFailure(sendAlert: (msg: string) => Promise<void>) {
  embeddingFailCount++
  const now = Date.now()
  if (embeddingFailCount >= 3 && now - lastAlertSent > 3600_000) {
    lastAlertSent = now
    sendAlert('🚨 Embedding service fallito 3+ volte. RAG degradato. Verificare OpenAI API key.').catch(() => {})
  }
}

export function resetEmbeddingFailure() {
  embeddingFailCount = 0
}

// ── MNT-002: Health check data ──

export async function getHealthStatus(): Promise<Record<string, string>> {
  const checks: Record<string, string> = {
    status: 'ok',
    version: 'v2.0',
    timestamp: new Date().toISOString(),
  }

  try {
    const { count } = await supabase
      .from('prezziario')
      .select('*', { count: 'exact', head: true })
    checks.supabase = 'ok'
    checks.prezziario_count = String(count || 0)
  } catch {
    checks.supabase = 'error'
    checks.status = 'degraded'
  }

  checks.anthropic_key = process.env.ANTHROPIC_API_KEY ? 'configured' : 'MISSING'
  checks.openai_key = process.env.OPENAI_API_KEY ? 'configured' : 'MISSING'
  checks.auth_secret = process.env.AUTH_SECRET ? 'configured' : 'MISSING'
  checks.webhook_secret = process.env.TELEGRAM_WEBHOOK_SECRET ? 'configured' : 'MISSING'

  if (checks.anthropic_key === 'MISSING') checks.status = 'critical'

  return checks
}
