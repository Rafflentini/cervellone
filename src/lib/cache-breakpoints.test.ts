import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { applyIncrementalCacheBreakpoint } from './cache-breakpoints'

function msgs(): Anthropic.MessageParam[] {
  return [
    { role: 'user', content: 'ciao' },
    { role: 'assistant', content: [{ type: 'text', text: 'uso un tool' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }] as never },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'risultato' }] as never },
  ]
}

describe('applyIncrementalCacheBreakpoint', () => {
  it('mette cache_control SOLO sull ultimo blocco dell ultimo messaggio', () => {
    const m = msgs()
    applyIncrementalCacheBreakpoint(m)
    const last = m[m.length - 1].content as unknown as Array<Record<string, unknown>>
    expect(last[last.length - 1].cache_control).toEqual({ type: 'ephemeral' })
    // i blocchi precedenti NON hanno breakpoint
    const mid = m[1].content as unknown as Array<Record<string, unknown>>
    expect(mid[0].cache_control).toBeUndefined()
  })

  it('rimuove i breakpoint precedenti (mai più di 1 nei messages)', () => {
    const m = msgs()
    applyIncrementalCacheBreakpoint(m)
    m.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'y', input: {} }] as never })
    m.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'r2' }] as never })
    applyIncrementalCacheBreakpoint(m)
    let count = 0
    for (const msg of m) {
      if (!Array.isArray(msg.content)) continue
      for (const b of msg.content as unknown as Array<Record<string, unknown>>) {
        if (b.cache_control) count++
      }
    }
    expect(count).toBe(1)
    const last = m[m.length - 1].content as unknown as Array<Record<string, unknown>>
    expect(last[last.length - 1].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('ultimo messaggio con content string → no-op senza errori', () => {
    const m: Anthropic.MessageParam[] = [{ role: 'user', content: 'solo testo' }]
    expect(() => applyIncrementalCacheBreakpoint(m)).not.toThrow()
  })

  it('array vuoto → no-op senza errori', () => {
    expect(() => applyIncrementalCacheBreakpoint([])).not.toThrow()
  })
})
