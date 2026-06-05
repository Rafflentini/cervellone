import { describe, it, expect } from 'vitest'
import { runTokens, isRunOverBudget, MAX_RUN_TOKENS } from './run-budget'

describe('run-budget', () => {
  it('somma input + cache_creation + output (esclude cache_read, già quasi gratis)', () => {
    expect(runTokens({
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 999_999,
    })).toBe(3500)
  })

  it('usage vuoto = 0, non over budget', () => {
    expect(runTokens({})).toBe(0)
    expect(isRunOverBudget({})).toBe(false)
  })

  it('oltre il cap → over budget', () => {
    expect(isRunOverBudget({ input_tokens: MAX_RUN_TOKENS + 1 })).toBe(true)
  })

  it('cap custom rispettato', () => {
    expect(isRunOverBudget({ input_tokens: 50 }, 49)).toBe(true)
    expect(isRunOverBudget({ input_tokens: 50 }, 51)).toBe(false)
  })
})
