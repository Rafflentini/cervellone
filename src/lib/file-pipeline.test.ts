import { describe, it, expect, beforeEach, vi } from 'vitest'
import { detectStrategy, processNative } from './file-pipeline'

describe('detectStrategy', () => {
  it.each([
    // NATIVE — whitelist explicit
    ['application/pdf', 'doc.pdf', 'native'],
    ['image/jpeg', 'foto.jpg', 'native'],
    ['image/png', 'screenshot.png', 'native'],
    ['image/webp', 'foto.webp', 'native'],
    ['image/heic', 'apple.heic', 'native'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx', 'native'],
    ['application/msword', 'old.doc', 'native'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet.xlsx', 'native'],
    ['application/vnd.ms-excel', 'old.xls', 'native'],
    ['application/vnd.oasis.opendocument.spreadsheet', 'sheet.ods', 'native'],
    ['text/plain', 'note.txt', 'native'],
    ['text/csv', 'data.csv', 'native'],
    ['text/markdown', 'README.md', 'native'],
    // CUSTOM — Files API
    ['application/octet-stream', 'DURC.pdf.p7m', 'files-api'],
    ['application/dxf', 'tavola.dxf', 'files-api'],
    ['application/acad', 'pianta.dwg', 'files-api'],
    ['application/xml', 'fattura.xml', 'files-api'],
    ['text/xml', 'fattura.xml', 'files-api'],
    ['application/zip', 'archive.zip', 'files-api'],
    ['message/rfc822', 'email.eml', 'files-api'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'slides.pptx', 'files-api'],
    ['', 'unknown.xyz', 'files-api'],
    ['application/octet-stream', 'random.bin', 'files-api'],
  ])('%s + %s → %s', (mime, name, expected) => {
    expect(detectStrategy(mime, name)).toBe(expected)
  })
})

describe('processNative', () => {
  it('PDF → document base64 block', async () => {
    const buffer = Buffer.from('%PDF-1.4 fake pdf content')
    const result = await processNative({
      buffer,
      fileName: 'test.pdf',
      mimeType: 'application/pdf',
    })
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].type).toBe('document')
    expect(result.blocks[0].source.type).toBe('base64')
    expect(result.blocks[0].source.media_type).toBe('application/pdf')
    expect(result.strategy).toBe('native')
  })

  it('image/* → image base64 block', async () => {
    const buffer = Buffer.from([0xff, 0xd8, 0xff]) // JPEG header
    const result = await processNative({
      buffer,
      fileName: 'foto.jpg',
      mimeType: 'image/jpeg',
    })
    expect(result.blocks[0].type).toBe('image')
    expect(result.strategy).toBe('native')
  })

  it('CSV → text block', async () => {
    const text = 'col1,col2\nval1,val2\n' + 'data,'.repeat(100)
    const buffer = Buffer.from(text)
    const result = await processNative({
      buffer,
      fileName: 'data.csv',
      mimeType: 'text/csv',
    })
    expect(result.blocks[0].type).toBe('text')
    expect(result.blocks[0].text).toContain('data.csv')
    expect(result.blocks[0].text).toContain('col1,col2')
    expect(result.strategy).toBe('native')
  })

  it('formato non riconosciuto + binary → metadata-only', async () => {
    // Binary non printable
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0xff, 0xfe, 0xfd])
    const result = await processNative({
      buffer,
      fileName: 'random.bin',
      mimeType: 'application/octet-stream',
    })
    expect(result.blocks[0].type).toBe('text')
    expect(result.blocks[0].text).toContain('[File binario:')
    expect(result.strategy).toBe('metadata-only')
  })

  it('formato non riconosciuto + ASCII printable → fallback text', async () => {
    const text = 'Questo è un file di testo con contenuto valido. '.repeat(20)
    const buffer = Buffer.from(text)
    const result = await processNative({
      buffer,
      fileName: 'unknown.xyz',
      mimeType: 'application/octet-stream',
    })
    expect(result.blocks[0].type).toBe('text')
    expect(result.blocks[0].text).toContain('Questo è un file di testo')
    expect(result.strategy).toBe('fallback-text')
  })
})

// ─── uploadToAnthropic ────────────────────────────────────────────────────────

const mockUpload = vi.fn()
const mockSupabaseInsert = vi.fn()

vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk')
  return {
    ...actual,
    default: vi.fn().mockImplementation(() => ({
      beta: { files: { upload: mockUpload } },
    })),
  }
})

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: mockSupabaseInsert.mockResolvedValue({ error: null }),
    })),
  },
}))

describe('uploadToAnthropic', () => {
  beforeEach(() => {
    mockUpload.mockReset()
    mockSupabaseInsert.mockReset().mockResolvedValue({ error: null })
  })

  it('upload riuscito → ritorna file_id e traccia in DB', async () => {
    mockUpload.mockResolvedValue({ id: 'file_abc123', filename: 'DURC.p7m', mime_type: 'application/octet-stream', size_bytes: 12345 })

    const { uploadToAnthropic } = await import('./file-pipeline')
    const result = await uploadToAnthropic({
      buffer: Buffer.from('fake p7m bytes'),
      fileName: 'DURC.p7m',
      mimeType: 'application/octet-stream',
    })

    expect(result.fileId).toBe('file_abc123')
    expect(mockUpload).toHaveBeenCalledOnce()
    // Verifica beta header passato
    const callArgs = mockUpload.mock.calls[0]
    expect(callArgs[1]?.headers?.['anthropic-beta']).toContain('files-api-2025-04-14')
    // Verifica DB insert
    expect(mockSupabaseInsert).toHaveBeenCalledOnce()
  })

  it('upload fallito → throw + nessun insert DB', async () => {
    mockUpload.mockRejectedValue(new Error('Files API down'))

    const { uploadToAnthropic } = await import('./file-pipeline')
    await expect(uploadToAnthropic({
      buffer: Buffer.from('test'),
      fileName: 'test.bin',
      mimeType: 'application/octet-stream',
    })).rejects.toThrow('Files API down')

    expect(mockSupabaseInsert).not.toHaveBeenCalled()
  })

  it('upload ok ma DB fail → ritorna fileId, non throw, warn loggato', async () => {
    mockUpload.mockResolvedValue({ id: 'file_xyz', filename: 'f.bin', mime_type: 'application/octet-stream', size_bytes: 1 })
    mockSupabaseInsert.mockReset().mockResolvedValue({ error: { message: 'relation does not exist' } })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { uploadToAnthropic } = await import('./file-pipeline')
    const result = await uploadToAnthropic({
      buffer: Buffer.from('x'),
      fileName: 'f.bin',
      mimeType: 'application/octet-stream',
    })

    expect(result.fileId).toBe('file_xyz')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('DB tracking insert failed'))
    warnSpy.mockRestore()
  })
})
