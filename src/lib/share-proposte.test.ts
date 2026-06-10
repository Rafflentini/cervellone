import { describe, it, expect, vi, beforeAll } from 'vitest'
beforeAll(() => { process.env.AUTH_SECRET = 'test-secret'; process.env.APP_BASE_URL = 'https://cervellone-five.vercel.app' })
const store: any = {}
vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      insert: (r: any) => ({ select: () => ({ single: async () => { store.row = { id: 'p1', ...r }; return { data: { id: 'p1' }, error: null } } }) }),
      select: () => ({ eq: () => ({ single: async () => ({ data: store.row, error: null }) }) }),
      update: (u: any) => ({ eq: () => { store.row = { ...store.row, ...u }; return Promise.resolve({ error: null }) } }),
    }),
  }),
}))

describe('share-proposte', () => {
  it('createShareProposal salva e ritorna id; confirmShareProposal ritorna URL firmato verificabile', async () => {
    const { createShareProposal, confirmShareProposal } = await import('./share-proposte')
    const id = await createShareProposal('doc-9', 7)
    expect(id).toBe('p1')
    const url = await confirmShareProposal('p1')
    expect(url).toContain('/doc/doc-9?t=')
    expect(url).toContain('exp=')
    const { verifyShareToken } = await import('./doc-access')
    const u = new URL(url!)
    expect(verifyShareToken('doc-9', u.searchParams.get('t')!, Number(u.searchParams.get('exp')))).toBe(true)
  })
})
