import { describe, it, expect, vi } from 'vitest'

// Carica il registry completo (tools.ts importa molti moduli con client supabase a
// load-time): mock di @supabase/supabase-js così ogni createClient non richiede env.
vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like', 'in', 'order', 'limit', 'range', 'insert', 'update', 'upsert', 'delete', 'not', 'or', 'match', 'contains']
  for (const m of methods) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { getToolDefinitions } from './tools'

describe('registry tool (post-refactor)', () => {
  it('espone un set di nomi non vuoto e senza duplicati', () => {
    const defs = getToolDefinitions() as { name: string }[]
    const names = defs.map(d => d.name)
    expect(names.length).toBeGreaterThan(40)
    expect(new Set(names).size).toBe(names.length) // nessun duplicato
  })

  it('contiene i tool chiave di ogni gruppo estratto (nessun tool perso nel refactor)', () => {
    const names = (getToolDefinitions() as { name: string }[]).map(d => d.name)
    for (const n of [
      'cerca_prezziario', 'genera_preventivo_completo', // studio-tecnico
      'cervellone_info', 'cervellone_check_aggiornamenti', // self
      'gmail_list_inbox', // mail (Gmail)
      'sal_calcola', // sal
      'genera_pdf', 'rivedi_immagine', // gruppi rimasti in tools.ts (pdf, image)
    ]) {
      expect(names, `manca il tool ${n}`).toContain(n)
    }
  })
})
