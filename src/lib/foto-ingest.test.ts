// Test di regressione sui QUATTRO rami che oggi perdono foto in silenzio.
// Incidenti 12 e 14 giugno 2026: la modalita di guasto che fa danno non e l'errore visibile,
// e la foto che sparisce senza che nessuno se ne accorga.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockUploadBinaryToDrive = vi.fn()
const mockGetTelegramInboxFolderId = vi.fn()
const mockSingle = vi.fn()
const mockInsert = vi.fn()

vi.mock('./drive', () => ({
  uploadBinaryToDrive: (...args: unknown[]) => mockUploadBinaryToDrive(...args),
  getTelegramInboxFolderId: () => mockGetTelegramInboxFolderId(),
}))

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: (row: Record<string, unknown>) => {
        mockInsert(row)
        return { select: () => ({ single: () => mockSingle() }) }
      },
    })),
  },
}))

function item(filename: string, mimeType: string) {
  return { buffer: Buffer.from('x'), mimeType, filename }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetTelegramInboxFolderId.mockResolvedValue('inbox-folder-id')
  let n = 0
  mockUploadBinaryToDrive.mockImplementation(async () => {
    n += 1
    return { id: `drive-${n}`, webViewLink: `https://drive/${n}` }
  })
  mockSingle.mockResolvedValue({ data: { id: 'row-1' }, error: null })
})

describe('ingestPhotoUpload — ramo 2: mime non-immagine', () => {
  it('application/octet-stream → NON carica su Drive ma lo dichiara in skipped', async () => {
    const { ingestPhotoUpload } = await import('./foto-ingest')
    const res = await ingestPhotoUpload({
      canale: 'telegram',
      chatId: 'chat-1',
      items: [item('IMG_4821', 'application/octet-stream')],
    })
    expect(mockUploadBinaryToDrive).not.toHaveBeenCalled()
    expect(res.records).toEqual([])
    expect(res.skipped).toHaveLength(1)
    expect(res.skipped[0].filename).toBe('IMG_4821')
    expect(res.skipped[0].reason).toBe('mime-non-immagine')
  })

  it('controprova: image/heic → upload chiamato 1 volta, skipped vuoto', async () => {
    const { ingestPhotoUpload } = await import('./foto-ingest')
    const res = await ingestPhotoUpload({
      canale: 'telegram',
      chatId: 'chat-1',
      items: [item('IMG_4821.heic', 'image/heic')],
    })
    expect(mockUploadBinaryToDrive).toHaveBeenCalledTimes(1)
    expect(res.skipped).toEqual([])
    expect(res.records).toHaveLength(1)
    expect(res.records[0].driveFileId).toBe('drive-1')
  })
})

describe('ingestPhotoUpload — ramo 3: insert Supabase fallita (byte su Drive, riga assente)', () => {
  it('records vuoto ma upload eseguito e orfano dichiarato con il driveFileId', async () => {
    mockSingle.mockResolvedValueOnce({ data: null, error: { message: 'insert boom' } })
    const { ingestPhotoUpload } = await import('./foto-ingest')
    const res = await ingestPhotoUpload({
      canale: 'telegram',
      chatId: 'chat-1',
      items: [item('foto.jpg', 'image/jpeg')],
    })
    expect(mockUploadBinaryToDrive).toHaveBeenCalledTimes(1)
    expect(res.records).toEqual([])
    expect(res.orphans).toHaveLength(1)
    expect(res.orphans[0].driveFileId).toBe('drive-1')
    expect(res.orphans[0].filename).toBe('foto.jpg')
    expect(res.orphans[0].reason).toBe('db-insert')
  })
})

describe('ingestPhotoUpload — ramo 1: Inbox Drive non disponibile', () => {
  it('getTelegramInboxFolderId che rifiuta → fatal, niente upload, records vuoto', async () => {
    mockGetTelegramInboxFolderId.mockRejectedValueOnce(new Error('token OAuth scaduto'))
    const { ingestPhotoUpload } = await import('./foto-ingest')
    const res = await ingestPhotoUpload({
      canale: 'telegram',
      chatId: 'chat-1',
      items: [item('a.jpg', 'image/jpeg'), item('b.jpg', 'image/jpeg')],
    })
    expect(mockUploadBinaryToDrive).not.toHaveBeenCalled()
    expect(res.records).toEqual([])
    expect(res.fatal).toBe('inbox-non-disponibile')
  })
})

describe('ingestPhotoUpload — ramo 4 / album: il conteggio non deve mentire', () => {
  it('album di 3 con la SECONDA insert fallita → 2 record, 3 upload, 1 orfano', async () => {
    mockSingle
      .mockResolvedValueOnce({ data: { id: 'row-1' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'insert boom' } })
      .mockResolvedValueOnce({ data: { id: 'row-3' }, error: null })
    const { ingestPhotoUpload } = await import('./foto-ingest')
    const res = await ingestPhotoUpload({
      canale: 'telegram',
      chatId: 'chat-1',
      items: [item('a.jpg', 'image/jpeg'), item('b.jpg', 'image/jpeg'), item('c.jpg', 'image/jpeg')],
    })
    expect(mockUploadBinaryToDrive).toHaveBeenCalledTimes(3)
    expect(res.records.map(r => r.id)).toEqual(['row-1', 'row-3'])
    expect(res.records.map(r => r.filename)).toEqual(['a.jpg', 'c.jpg'])
    expect(res.orphans).toHaveLength(1)
    expect(res.orphans[0].filename).toBe('b.jpg')
    expect(res.orphans[0].driveFileId).toBe('drive-2')
  })

  it('upload che esplode → item in failed (non sparisce)', async () => {
    mockUploadBinaryToDrive.mockRejectedValueOnce(new Error('drive 500'))
    const { ingestPhotoUpload } = await import('./foto-ingest')
    const res = await ingestPhotoUpload({
      canale: 'telegram',
      chatId: 'chat-1',
      items: [item('a.jpg', 'image/jpeg')],
    })
    expect(res.records).toEqual([])
    expect(res.failed).toHaveLength(1)
    expect(res.failed[0].filename).toBe('a.jpg')
    expect(res.failed[0].reason).toBe('upload')
  })

  it('nessun problema → tutti gli elenchi di perdita vuoti', async () => {
    const { ingestPhotoUpload } = await import('./foto-ingest')
    const res = await ingestPhotoUpload({
      canale: 'web',
      chatId: null,
      items: [item('a.jpg', 'image/jpeg')],
    })
    expect(res.records).toHaveLength(1)
    expect(res.skipped).toEqual([])
    expect(res.orphans).toEqual([])
    expect(res.failed).toEqual([])
    expect(res.fatal).toBeUndefined()
  })
})

describe('formatFotoIngestWarning', () => {
  it('ingest pulito → null (nessun avviso)', async () => {
    const { formatFotoIngestWarning } = await import('./foto-ingest')
    expect(formatFotoIngestWarning({ records: [{ id: 'r', driveFileId: 'd', driveUrl: null, filename: 'a.jpg' }], skipped: [], orphans: [], failed: [] })).toBeNull()
  })

  it('fatal → dice che NON sono state salvate e che vanno rimandate', async () => {
    const { formatFotoIngestWarning } = await import('./foto-ingest')
    const msg = formatFotoIngestWarning({
      records: [], skipped: [], orphans: [], failed: [], fatal: 'inbox-non-disponibile',
    })
    expect(msg).toBeTruthy()
    expect(msg).toMatch(/NON.*salvat/i)
    expect(msg).toMatch(/rimand/i)
  })

  it('orfani → dice che la foto e su Drive ma archivia_foto non la vede', async () => {
    const { formatFotoIngestWarning } = await import('./foto-ingest')
    const msg = formatFotoIngestWarning({
      records: [],
      skipped: [],
      orphans: [{ driveFileId: 'd1', driveUrl: null, filename: 'b.jpg', reason: 'db-insert' }],
      failed: [],
    })
    expect(msg).toContain('b.jpg')
    expect(msg).toMatch(/archivia_foto/)
  })

  it('skipped e failed → riporta quante e quali', async () => {
    const { formatFotoIngestWarning } = await import('./foto-ingest')
    const msg = formatFotoIngestWarning({
      records: [],
      skipped: [{ filename: 's.bin', reason: 'mime-non-immagine' }],
      orphans: [],
      failed: [{ filename: 'f.jpg', reason: 'upload' }],
    })
    expect(msg).toContain('s.bin')
    expect(msg).toContain('f.jpg')
  })
})
