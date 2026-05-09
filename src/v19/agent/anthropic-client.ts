/**
 * Cervellone V19 — Anthropic client singleton
 *
 * Centralizza configurazione SDK e beta headers per tutto il loop V19.
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 4-5
 */

import Anthropic from '@anthropic-ai/sdk'

let cached: Anthropic | null = null

export const V19_BETAS = [
  'code-execution-2025-08-25',
  'files-api-2025-04-14',
] as const

export function getAnthropicClient(): Anthropic {
  if (cached) return cached
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY non configurata')
  }
  cached = new Anthropic({
    apiKey,
    defaultHeaders: {
      'anthropic-beta': V19_BETAS.join(','),
    },
  })
  return cached
}

/** Reset cached client (per test). */
export function resetAnthropicClientForTest(): void {
  cached = null
}
