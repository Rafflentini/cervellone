import { describe, it, expect, vi } from 'vitest'
import { extractDriveUrls, runHallucinationValidator } from '../agent/hallucination-validator'
import { HallucinationError } from '../agent/types'

describe('extractDriveUrls', () => {
  it('estrae URL Drive file/d/', () => {
    const text = 'Ho generato il PDF: https://drive.google.com/file/d/1abc-DEF_xyz123XYZ/view e basta'
    const urls = extractDriveUrls(text)
    expect(urls).toHaveLength(1)
    expect(urls[0].fileId).toBe('1abc-DEF_xyz123XYZ')
  })

  it('estrae URL Google Sheets/Docs', () => {
    const text = 'Sheet: https://docs.google.com/spreadsheets/d/SHEET_ID_001/edit'
    const urls = extractDriveUrls(text)
    expect(urls).toHaveLength(1)
    expect(urls[0].fileId).toBe('SHEET_ID_001')
  })

  it('non matcha link generici', () => {
    const text = 'https://anthropic.com e https://example.com'
    expect(extractDriveUrls(text)).toHaveLength(0)
  })
})

describe('runHallucinationValidator', () => {
  it('non fa nulla se opts.skip=true', async () => {
    await expect(
      runHallucinationValidator(
        'https://drive.google.com/file/d/INVENTED_ID_XYZ/view',
        { skip: true },
      ),
    ).resolves.toBeUndefined()
  })

  it('throw HallucinationError se checker ritorna false', async () => {
    const checker = vi.fn(async () => false)
    await expect(
      runHallucinationValidator(
        'PDF: https://drive.google.com/file/d/INVENTED_ID_XYZ/view',
        { checker },
      ),
    ).rejects.toBeInstanceOf(HallucinationError)
    expect(checker).toHaveBeenCalledWith('INVENTED_ID_XYZ')
  })

  it('passa se checker ritorna true', async () => {
    const checker = vi.fn(async () => true)
    await expect(
      runHallucinationValidator(
        'PDF: https://drive.google.com/file/d/REAL_ID/view',
        { checker },
      ),
    ).resolves.toBeUndefined()
  })

  it('non blocca su errore checker (logga e continua)', async () => {
    const checker = vi.fn(async () => {
      throw new Error('rete down')
    })
    await expect(
      runHallucinationValidator(
        'PDF: https://drive.google.com/file/d/SOME_ID/view',
        { checker },
      ),
    ).resolves.toBeUndefined()
  })
})
