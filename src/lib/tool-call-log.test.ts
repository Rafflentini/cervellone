import { describe, it, expect, vi, beforeEach } from 'vitest'

type RigaRegistro = { nome: string; conversation_id: string | null; durata_ms: number; riconosciuto: boolean }

const insert = vi.fn((_riga: RigaRegistro) => Promise.resolve({ data: null, error: null }))

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
import { executeTool } from './tools'

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
  beforeEach(() => { insert.mockClear() })

  it('registra il tool eseguito e restituisce il risultato invariato', async () => {
    const out = await executeTool('cervellone_info', {}, undefined)
    expect(typeof out).toBe('string')
    expect(out).not.toContain('non riconosciuto')
    await new Promise((r) => setImmediate(r))
    expect(insert.mock.calls.map((c) => c[0].nome)).toContain('cervellone_info')
  })

  // CONTROLLO POSITIVO: prova che il test sopra saprebbe accorgersi di un nome
  // sbagliato. Senza questo, "contiene cervellone_info" passerebbe anche se
  // registrassimo sempre la stessa stringa fissa.
  it('un tool inesistente viene registrato come NON riconosciuto', async () => {
    const out = await executeTool('tool_che_non_esiste_xyz', {}, undefined)
    expect(out).toContain('non riconosciuto')
    await new Promise((r) => setImmediate(r))
    const riga = insert.mock.calls.map((c) => c[0])
      .find((r) => r.nome === 'tool_che_non_esiste_xyz')
    expect(riga?.riconosciuto).toBe(false)
  })
})

describe('il registro non tace se e rotto', () => {
  // `giaAvvisato` e' un guard in-memory DENTRO il modulo tool-call-log: il test
  // 'NON lancia...' qui sopra fa gia' scattare un rifiuto, quindi arrivando qui
  // il guard e' gia' true e il test sotto vedrebbe 0 avvisi invece di 1 — non
  // perche' il codice sia sbagliato, ma perche' il flag e' condiviso da tutto il
  // file. Si reimporta SOLO tool-call-log (leggero: importa solo ./supabase) per
  // ripartire dal guard azzerato — './tools' resta l'import statico in cima al
  // file, la correzione appena fatta contro il timeout non si tocca.
  let registraChiamataToolFresco: typeof registraChiamataTool

  beforeEach(async () => {
    insert.mockClear()
    vi.resetModules()
    ;({ registraChiamataTool: registraChiamataToolFresco } = await import('./tool-call-log'))
  })

  it('avvisa in console UNA volta sola quando la scrittura fallisce', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    insert.mockImplementation(() => Promise.reject(new Error('relation "cervellone_tool_calls" does not exist')))
    registraChiamataToolFresco('a', undefined, 1, true)
    registraChiamataToolFresco('b', undefined, 1, true)
    registraChiamataToolFresco('c', undefined, 1, true)
    await new Promise((r) => setImmediate(r))
    // Una sola volta: un avviso per ogni chiamata a tool inonderebbe i log di Vercel.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('tool_call_log')
    warn.mockRestore()
    insert.mockImplementation(() => Promise.resolve({ data: null, error: null }))
  })
})
