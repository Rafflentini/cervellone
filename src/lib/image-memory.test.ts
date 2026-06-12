import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFrom = vi.fn()

vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({
    from: mockFrom,
  }),
}))

import { captureImageExtraction, buildImagesPointer } from './image-memory'

beforeEach(() => {
  mockFrom.mockReset()
})

describe('captureImageExtraction', () => {
  it('non salva senza immagini', async () => {
    const r = await captureImageExtraction('conv1', 'testo lungo abbastanza per superare la soglia minima', [])
    expect(r.saved).toBe(false)
    expect(r.reason).toBe('no-images')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('non salva con estrazione troppo corta', async () => {
    const r = await captureImageExtraction('conv1', 'corto', [{ driveFileId: 'd1', filename: 'a.jpg' }])
    expect(r.saved).toBe(false)
    expect(r.reason).toBe('empty-extraction')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('non salva senza conversation', async () => {
    const r = await captureImageExtraction('', 'x'.repeat(50), [{ driveFileId: 'd1', filename: 'a.jpg' }])
    expect(r.saved).toBe(false)
    expect(r.reason).toBe('no-conversation')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('salva estrazione immagine su documents con type image-extraction', async () => {
    const insertSingle = vi.fn().mockResolvedValue({ data: { id: 'imgmem-1' }, error: null })
    const insertChain = {
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({ single: insertSingle }),
      }),
    }
    mockFrom.mockReturnValueOnce(insertChain)

    const r = await captureImageExtraction('conv1', 'x'.repeat(50), [
      { driveFileId: 'd1', filename: 'a.jpg', driveUrl: 'https://drive/a' },
    ])

    expect(r).toEqual({ saved: true, id: 'imgmem-1' })
    expect(mockFrom).toHaveBeenCalledWith('documents')
    expect(insertChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: 'conv1',
        content: 'x'.repeat(50),
        type: 'image-extraction',
        metadata: {
          source: 'image-memory',
          filenames: ['a.jpg'],
          drive_file_ids: ['d1'],
          drive_urls: ['https://drive/a'],
        },
      }),
    )
  })

  it('non lancia mai (best-effort) su errore interno', async () => {
    mockFrom.mockImplementation(() => { throw new Error('boom') })
    const r = await captureImageExtraction('conv1', 'x'.repeat(50), [{ driveFileId: 'd1', filename: 'a.jpg' }])
    expect(r.saved).toBe(false)
  })
})

describe('buildImagesPointer', () => {
  it('ritorna stringa vuota senza conversation', async () => {
    expect(await buildImagesPointer('')).toBe('')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('filtra conversation, type image-extraction e recency 24h', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    mockFrom.mockReturnValue(chain)

    await buildImagesPointer('conv1')

    expect(mockFrom).toHaveBeenCalledWith('documents')
    expect(chain.eq).toHaveBeenCalledWith('conversation_id', 'conv1')
    expect(chain.eq).toHaveBeenCalledWith('type', 'image-extraction')
    expect(chain.gt).toHaveBeenCalledTimes(1)
    const gtArgs = chain.gt.mock.calls[0]
    expect(gtArgs[0]).toBe('created_at')
    const sinceMs = Date.parse(gtArgs[1] as string)
    expect(Number.isNaN(sinceMs)).toBe(false)
    expect(Math.abs(sinceMs - (Date.now() - 24 * 60 * 60 * 1000))).toBeLessThan(5000)
    expect(chain.limit).toHaveBeenCalledWith(8)
  })

  it('costruisce pointer con file, drive id ed estratto', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            content: 'Dati estratti dalla foto '.repeat(30),
            metadata: { filenames: ['a.jpg'], drive_file_ids: ['d1'] },
          },
        ],
        error: null,
      }),
    }
    mockFrom.mockReturnValue(chain)

    const out = await buildImagesPointer('conv1')

    expect(out).toContain('IMMAGINI/DOCUMENTI GIÀ CARICATI')
    expect(out).toContain('a.jpg')
    expect(out).toContain('[drive: d1]')
    expect(out).toContain('Dati già estratti')
    expect(out).toContain('=== fine immagini ===')
  })
})
