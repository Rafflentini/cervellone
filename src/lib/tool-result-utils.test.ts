import { describe, it, expect } from 'vitest'
import { truncateToolResult, MAX_TOOL_RESULT_CHARS } from './tool-result-utils'

describe('truncateToolResult', () => {
  it('lascia intatti i risultati sotto soglia', () => {
    expect(truncateToolResult('breve')).toBe('breve')
  })

  it('tronca oltre soglia con marker esplicito', () => {
    const big = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 5000)
    const out = truncateToolResult(big) as string
    expect(out.length).toBeLessThan(big.length)
    expect(out).toContain('[output troncato')
    expect(out).toContain(String(big.length))
  })

  it('soglia custom', () => {
    expect(truncateToolResult('abcdef', 3)).toContain('[output troncato')
  })

  it('non-string passa invariato', () => {
    const blocks = [{ type: 'text', text: 'ciao' }]
    expect(truncateToolResult(blocks as unknown as string)).toBe(blocks)
  })
})
