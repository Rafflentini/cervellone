import { describe, it, expect, vi, beforeAll } from 'vitest'

// tools.ts importa @/lib/supabase a livello di modulo: serve un URL/key valido
// per costruire il client (la logica share è mockata, quindi il client non viene usato).
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
})

vi.mock('@/lib/share-proposte', () => ({ createShareProposal: vi.fn(async () => 'P1') }))
vi.mock('./share-proposte', () => ({ createShareProposal: vi.fn(async () => 'P1') }))

describe('genera_link_condivisione (executor)', () => {
  it('crea la proposta e chiede conferma con /condividi_ok_<id>', async () => {
    const { executeTool } = await import('./tools')
    const res = await executeTool('genera_link_condivisione', { doc_id: 'd', giorni: 7 }, 'conv-1')
    expect(res).toContain('/condividi_ok_P1')
    expect(res).toContain('Confermi')
  }, 30000)

  it('errore se doc_id mancante', async () => {
    const { executeTool } = await import('./tools')
    const res = await executeTool('genera_link_condivisione', { doc_id: '' }, 'conv-1')
    expect(res).toContain('doc_id richiesto')
  })
})
