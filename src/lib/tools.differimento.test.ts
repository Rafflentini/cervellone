import { describe, it, expect, vi } from 'vitest'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { getToolDefinitions } from './tools'

type Def = { name: string; defer_loading?: boolean; type?: string }

describe('differimento delle definizioni dei tool', () => {
  it('SENZA opzioni l output e identico a prima: nessun defer_loading, nessuna ricerca', () => {
    const defs = getToolDefinitions() as Def[]
    expect(defs.some((d) => d.defer_loading !== undefined)).toBe(false)
    expect(defs.some((d) => d.type?.startsWith('tool_search'))).toBe(false)
  })

  it('col nucleo, i tool fuori dal nucleo sono differiti e quelli dentro no', () => {
    const nucleo = new Set(['cervellone_info', 'cerca_documenti'])
    const defs = getToolDefinitions({ nucleo }) as Def[]
    const dentro = defs.find((d) => d.name === 'cervellone_info')
    const fuori = defs.find((d) => d.name === 'read_email')
    expect(dentro?.defer_loading).toBeUndefined()
    expect(fuori?.defer_loading).toBe(true)
  })

  it('i due tool server non vengono MAI differiti', () => {
    const defs = getToolDefinitions({ nucleo: new Set<string>() }) as Def[]
    for (const n of ['web_search', 'code_execution']) {
      expect(defs.find((d) => d.name === n)?.defer_loading).toBeUndefined()
    }
  })

  it('con ricerca:true dichiara il tool di ricerca in testa', () => {
    const defs = getToolDefinitions({ nucleo: new Set(['cervellone_info']), ricerca: true }) as Def[]
    expect(defs[0].type).toBe('tool_search_tool_bm25_20251119')
    expect(defs[0].name).toBe('tool_search_tool_bm25')
  })

  // L'API rifiuta con 400 una richiesta in cui TUTTO e differito. Il nucleo
  // vuoto piu ricerca deve restare legale grazie ai due tool server.
  it('non differisce mai tutto: resta sempre almeno un tool caricato', () => {
    const defs = getToolDefinitions({ nucleo: new Set<string>(), ricerca: true }) as Def[]
    expect(defs.filter((d) => !d.defer_loading).length).toBeGreaterThanOrEqual(2)
  })
})
