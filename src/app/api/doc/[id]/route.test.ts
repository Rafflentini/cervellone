import { describe, it, expect, vi, beforeAll } from 'vitest'
import { getAuthToken, signShareToken } from '@/lib/doc-access'

beforeAll(() => { process.env.AUTH_SECRET = 'test-secret' })
vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { content: '<h1>ok</h1>' }, error: null }) }) }) }) },
}))

function req(url: string, cookie?: string): any {
  return { url, cookies: { get: (n: string) => (cookie ? { value: cookie } : undefined) } }
}

describe('GET /api/doc/[id]', () => {
  it('401 senza auth', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('https://x/api/doc/d'), { params: Promise.resolve({ id: 'd' }) })
    expect(res.status).toBe(401)
  })
  it('200 con cookie valido', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('https://x/api/doc/d', getAuthToken()), { params: Promise.resolve({ id: 'd' }) })
    expect(res.status).toBe(200)
  })
  it('200 con share token valido', async () => {
    const { GET } = await import('./route')
    const exp = Math.floor(Date.now() / 1000) + 3600
    const tok = signShareToken('d', exp)
    const res = await GET(req(`https://x/api/doc/d?t=${tok}&exp=${exp}`), { params: Promise.resolve({ id: 'd' }) })
    expect(res.status).toBe(200)
  })
})
