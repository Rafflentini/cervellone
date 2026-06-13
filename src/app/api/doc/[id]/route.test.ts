import { describe, it, expect, vi, beforeAll } from 'vitest'
import { getAuthToken, signShareToken } from '@/lib/doc-access'

beforeAll(() => { process.env.AUTH_SECRET = 'test-secret' })

// La route filtra le image-extraction con .neq('type','image-extraction'): il mock
// simula questo comportamento — la riga viene servita solo se il filtro NON la esclude.
// Per default il documento NON è una image-extraction, quindi .single() ritorna content.
// Override globale mutabile per il caso "riga image-extraction → esclusa (404)".
let mockSingleResult: { data: { content: string } | null; error: unknown } = {
  data: { content: '<h1>ok</h1>' },
  error: null,
}
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          neq: () => ({ single: async () => mockSingleResult }),
        }),
      }),
    }),
  },
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
  it('404 se la riga è una image-extraction (esclusa dal .neq → nessun dato)', async () => {
    const prev = mockSingleResult
    // Il filtro .neq('type','image-extraction') esclude la riga: la query non trova nulla.
    mockSingleResult = { data: null, error: null }
    try {
      const { GET } = await import('./route')
      const res = await GET(req('https://x/api/doc/d', getAuthToken()), { params: Promise.resolve({ id: 'd' }) })
      expect(res.status).toBe(404)
    } finally {
      mockSingleResult = prev
    }
  })
})
