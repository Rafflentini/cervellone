import { describe, it, expect, vi, beforeEach } from 'vitest'

const insert = vi.fn(() => Promise.resolve({ data: null, error: null }))

// Catena permissiva: ogni metodo di lettura torna la catena stessa, che e'
// thenable. Serve perche' i tool-sonda fanno query vere (cervellone_info legge
// cervellone_config con .select().order()), e un mock che espone solo .insert
// li fa esplodere con "supabase.from(...).select is not a function".
function catena() {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like', 'in', 'order', 'limit', 'range', 'update', 'upsert', 'delete', 'not', 'or', 'match', 'contains']) c[m] = () => c
  c.single = () => Promise.resolve({ data: null, error: null })
  c.maybeSingle = () => Promise.resolve({ data: null, error: null })
  c.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  c.insert = insert
  return c
}
vi.mock('./supabase', () => ({ supabase: { from: () => catena() } }))
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => catena() }) }))

import { registraChiamataTool } from './tool-call-log'

describe('registro delle chiamate ai tool', () => {
  beforeEach(() => { insert.mockClear() })

  it('registra nome, conversazione, durata e riconoscimento', async () => {
    registraChiamataTool('read_email', '11111111-1111-1111-1111-111111111111', 42, true)
    await new Promise((r) => setImmediate(r))
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][0]).toMatchObject({
      nome: 'read_email',
      conversation_id: '11111111-1111-1111-1111-111111111111',
      durata_ms: 42,
      riconosciuto: true,
    })
  })

  it('NON lancia e NON restituisce una promessa se il database e giu', () => {
    insert.mockImplementationOnce(() => Promise.reject(new Error('supabase giu')))
    expect(() => registraChiamataTool('read_email', undefined, 1, true)).not.toThrow()
    expect(registraChiamataTool('x', undefined, 1, true)).toBeUndefined()
  })
})

describe('aggancio in executeTool', () => {
  it('registra il tool eseguito e restituisce il risultato invariato', async () => {
    const { executeTool } = await import('./tools')
    const out = await executeTool('cervellone_info', {}, undefined)
    expect(typeof out).toBe('string')
    await new Promise((r) => setImmediate(r))
    expect(insert.mock.calls.map((c) => (c[0] as { nome: string }).nome)).toContain('cervellone_info')
  })

  // CONTROLLO POSITIVO: prova che il test sopra saprebbe accorgersi di un nome
  // sbagliato. Senza questo, "contiene cervellone_info" passerebbe anche se
  // registrassimo sempre la stessa stringa fissa.
  it('un tool inesistente viene registrato come NON riconosciuto', async () => {
    const { executeTool } = await import('./tools')
    const out = await executeTool('tool_che_non_esiste_xyz', {}, undefined)
    expect(out).toContain('non riconosciuto')
    await new Promise((r) => setImmediate(r))
    const riga = insert.mock.calls.map((c) => c[0] as { nome: string; riconosciuto: boolean })
      .find((r) => r.nome === 'tool_che_non_esiste_xyz')
    expect(riga?.riconosciuto).toBe(false)
  })
})
