import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock Supabase
const mockInsert = vi.fn()
const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockMaybeSingle = vi.fn()
const mockIlike = vi.fn()
const mockOrder = vi.fn()
const mockLimit = vi.fn()
const mockDelete = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: mockInsert,
      select: mockSelect,
      delete: mockDelete,
    })),
  },
}))

// Patch chaining
beforeEach(() => {
  vi.clearAllMocks()
  mockInsert.mockResolvedValue({ data: [{ id: 'test-uuid-1234' }], error: null })
  mockSelect.mockReturnValue({ eq: mockEq, ilike: mockIlike })
  mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle, order: mockOrder, ilike: mockIlike })
  mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  mockIlike.mockReturnValue({ order: mockOrder, limit: mockLimit })
  mockOrder.mockReturnValue({ limit: mockLimit })
  mockLimit.mockResolvedValue({ data: [], error: null })
  mockDelete.mockReturnValue({ eq: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue({ data: [], error: null }) }) })
})

describe('ricorda', () => {
  it('inserisce correttamente nella tabella', async () => {
    const { ricorda } = await import('./memoria-tools')
    const result = await ricorda({ testo: 'Test memoria', tag: 'cliente' })
    expect(result.ok).toBe(true)
    expect(result.id).toBeDefined()
  })

  it('fallisce con errore Supabase', async () => {
    mockInsert.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } })
    const { ricorda } = await import('./memoria-tools')
    const result = await ricorda({ testo: 'Test' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('DB error')
  })

  it('richiede testo non vuoto', async () => {
    const { ricorda } = await import('./memoria-tools')
    const result = await ricorda({ testo: '' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('testo')
  })
})
