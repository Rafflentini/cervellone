/**
 * Cost-control 5 giu 2026: hard cap token per singola run dell'agente.
 * Impedisce che un runaway (loop tool infinito, tool result giganti) bruci
 * il credito API. Al superamento il loop si ferma e logga `run_aborted_budget`.
 *
 * Metrica: input non-cached + cache_creation + output. I cache_read sono
 * esclusi (costano ~10% dell'input: non sono il driver del runaway).
 */
import type { UsageTokens } from './api-usage'

export const MAX_RUN_TOKENS = 200_000

export function runTokens(u: UsageTokens): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0)
  )
}

export function isRunOverBudget(u: UsageTokens, max: number = MAX_RUN_TOKENS): boolean {
  return runTokens(u) > max
}
