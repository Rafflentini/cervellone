import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * BUG D: `listSubfolders` chiedeva una sola pagina da 200 e non domandava
 * nemmeno `nextPageToken` fra i `fields`. Con `orderBy: 'name'` il troncamento
 * era deterministico e silenzioso: oltre la 200esima sottocartella sparivano
 * tutte quelle alfabeticamente successive, e la commessa risultava
 * 'non_trovata' in `archivia_foto`.
 */

const mockGetAuthorizedClient = vi.fn()

vi.mock('./google-oauth', () => ({
  getAuthorizedClient: mockGetAuthorizedClient,
}))

const GoogleAuthCtor = vi.fn()
const driveFactory = vi.fn()
const sheetsFactory = vi.fn()

vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: GoogleAuthCtor },
    drive: driveFactory,
    sheets: sheetsFactory,
  },
}))

vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = '{}'
  // null => niente OAuth, si cade sul service account mockato senza log d'errore
  mockGetAuthorizedClient.mockResolvedValue(null)
})

describe('listSubfolders', () => {
  it('segue nextPageToken invece di fermarsi alla prima pagina (BUG D)', async () => {
    const pagina1 = Array.from({ length: 200 }, (_, i) => ({
      id: `f${i}`, name: `Commessa ${String(i).padStart(3, '0')}`,
    }))
    const mockList = vi.fn()
      .mockResolvedValueOnce({ data: { files: pagina1, nextPageToken: 'TK2' } })
      .mockResolvedValueOnce({ data: { files: [{ id: 'f200', name: 'ZZZ Commessa 2026-201' }] } })
    driveFactory.mockReturnValue({ files: { list: mockList } })

    const { listSubfolders } = await import('./drive')
    const result = await listSubfolders('root-id')

    expect(mockList.mock.calls[0][0].fields).toContain('nextPageToken')
    expect(mockList).toHaveBeenCalledTimes(2)
    expect(mockList.mock.calls[1][0].pageToken).toBe('TK2')
    expect(result).toHaveLength(201)
    expect(result.map(f => f.name)).toContain('ZZZ Commessa 2026-201')
  })

  it("si ferma quando non c'e nextPageToken (BUG D - controprova)", async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: { files: [{ id: 'f1', name: 'Commessa A' }] },
    })
    driveFactory.mockReturnValue({ files: { list: mockList } })

    const { listSubfolders } = await import('./drive')
    const result = await listSubfolders('root-id')

    expect(mockList).toHaveBeenCalledTimes(1)
    expect(result).toHaveLength(1)
  })
})
