import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { opzioniToolDaAmbiente } from './claude'

type Def = { name: string; defer_loading?: boolean; type?: string }

describe('interruttore del differimento', () => {
  afterEach(() => { delete process.env.TOOL_DEFER })

  it('spento (default): nessuna opzione, si comporta come oggi', () => {
    expect(opzioniToolDaAmbiente()).toBeUndefined()
  })

  it('acceso: nucleo e ricerca', () => {
    process.env.TOOL_DEFER = '1'
    const o = opzioniToolDaAmbiente()
    expect(o?.ricerca).toBe(true)
    expect(o?.nucleo?.has('cervellone_info')).toBe(true)
  })

  // CONTROLLO POSITIVO: prova che il test sopra saprebbe accorgersi che
  // l'interruttore non e' collegato. Un valore diverso da '1' deve spegnere.
  it('un valore qualsiasi diverso da 1 lascia spento', () => {
    process.env.TOOL_DEFER = 'true'
    expect(opzioniToolDaAmbiente()).toBeUndefined()
  })
})
