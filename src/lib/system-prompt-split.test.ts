import { describe, it, expect } from 'vitest'
import { SYSTEM_CACHE_SPLIT, splitSystemPrompt } from './system-prompt-split'

describe('splitSystemPrompt', () => {
  it('con marker: separa statico e variabile', () => {
    const out = splitSystemPrompt('BASE STATICO' + SYSTEM_CACHE_SPLIT + 'data ore 10:31 + skill')
    expect(out.staticPart).toBe('BASE STATICO')
    expect(out.variablePart).toBe('data ore 10:31 + skill')
  })

  it('senza marker: tutto statico, variabile vuota (retrocompat)', () => {
    const out = splitSystemPrompt('prompt senza separatore')
    expect(out.staticPart).toBe('prompt senza separatore')
    expect(out.variablePart).toBe('')
  })

  it('lo statico NON cambia al cambiare della parte variabile (cache-hit cross-messaggio)', () => {
    const a = splitSystemPrompt('BASE' + SYSTEM_CACHE_SPLIT + 'ore 10:31')
    const b = splitSystemPrompt('BASE' + SYSTEM_CACHE_SPLIT + 'ore 10:32, skill Drive')
    expect(a.staticPart).toBe(b.staticPart) // stesso prefisso cachato → stessa cache key
    expect(a.variablePart).not.toBe(b.variablePart)
  })
})
