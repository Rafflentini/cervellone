import { describe, it, expect, vi } from 'vitest'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { NUCLEO_TOOL } from './tool-nucleo'
import { getToolDefinitions } from './tools'

describe('il nucleo dei tool', () => {
  it('ogni nome del nucleo esiste davvero nel registro', () => {
    const esistenti = new Set((getToolDefinitions() as { name: string }[]).map((d) => d.name))
    for (const n of NUCLEO_TOOL) {
      expect(esistenti, `il nucleo nomina un tool inesistente: ${n}`).toContain(n)
    }
  })

  it('resta piccolo: un nucleo che cresce senza accorgersene annulla il guadagno', () => {
    expect(NUCLEO_TOOL.size).toBeLessThanOrEqual(15)
  })
})
