import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loadCategories, buildPrompt, type Category } from './gmail-classify'

const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockOrder = vi.fn()

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: mockSelect.mockReturnValue({
        eq: mockEq.mockReturnValue({
          order: mockOrder,
        }),
      }),
    })),
  },
}))

beforeEach(() => {
  mockSelect.mockClear()
  mockEq.mockClear()
  mockOrder.mockClear()
})

describe('loadCategories', () => {
  it('returns enabled categories sorted by id', async () => {
    mockOrder.mockResolvedValue({
      data: [
        { name: 'Cliente', description: 'desc cliente' },
        { name: 'Fornitore', description: 'desc fornitore' },
      ],
      error: null,
    })

    const result = await loadCategories()
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Cliente')
    expect(mockEq).toHaveBeenCalledWith('enabled', true)
    expect(mockOrder).toHaveBeenCalledWith('id')
  })

  it('returns empty array on no data', async () => {
    mockOrder.mockResolvedValue({ data: null, error: null })
    const result = await loadCategories()
    expect(result).toEqual([])
  })

  it('throws on supabase error', async () => {
    mockOrder.mockResolvedValue({ data: null, error: { message: 'connection refused' } })
    await expect(loadCategories()).rejects.toThrow('connection refused')
  })
})

describe('buildPrompt', () => {
  it('includes all category names and descriptions in markdown bullet form', () => {
    const cats: Category[] = [
      { name: 'Cliente', description: 'Mail da committenti' },
      { name: 'Fornitore', description: 'Mail da fornitori' },
      { name: 'DURC', description: 'Mail DURC' },
    ]
    const prompt = buildPrompt(cats)
    expect(prompt).toContain('- Cliente: Mail da committenti')
    expect(prompt).toContain('- Fornitore: Mail da fornitori')
    expect(prompt).toContain('- DURC: Mail DURC')
    expect(prompt).toContain('classificatore di mail')
    expect(prompt).toContain('Output JSON')
    expect(prompt).toContain('confidence')
  })

  it('throws if categories empty', () => {
    expect(() => buildPrompt([])).toThrow('No categories configured')
  })

  it('produces stable structure regardless of category count', () => {
    const single: Category[] = [{ name: 'X', description: 'desc' }]
    const prompt = buildPrompt(single)
    expect(prompt).toContain('- X: desc')
    expect(prompt.split('\n').filter(l => l.startsWith('- '))).toHaveLength(1)
  })
})
