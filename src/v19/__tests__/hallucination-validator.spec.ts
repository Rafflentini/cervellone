import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  extractDriveUrls,
  runHallucinationValidator,
  defaultDriveChecker,
} from '../agent/hallucination-validator'
import { HallucinationError } from '../agent/types'
import { GoogleAuthDeadError } from '@/lib/google-token-health'

// ── Mock Google: NESSUNA rete in questi test ──
const mockFilesGet = vi.fn()
const mockGetAuthorizedClient = vi.fn()

vi.mock('googleapis', () => ({
  google: {
    drive: () => ({ files: { get: mockFilesGet } }),
  },
}))

vi.mock('@/lib/google-oauth', () => ({
  getAuthorizedClient: () => mockGetAuthorizedClient(),
}))

beforeEach(() => {
  mockFilesGet.mockReset()
  mockGetAuthorizedClient.mockReset()
  mockGetAuthorizedClient.mockResolvedValue({ __fakeOAuthClient: true })
})

/** Errore gaxios-like: quello che googleapis lancia davvero. */
function gaxiosError(status: number, body?: unknown): Error {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    status: number
    response: { status: number; data?: unknown }
  }
  err.status = status
  err.response = { status, data: body }
  return err
}

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

  // Caso 1: costo ZERO quando non ci sono link Drive.
  it('non chiama MAI il checker se il testo non contiene link Drive', async () => {
    const checker = vi.fn(async () => true)
    await expect(
      runHallucinationValidator(
        'Ecco il riepilogo. Vedi anche https://anthropic.com e https://example.com/file/d/abc',
        { checker },
      ),
    ).resolves.toBeUndefined()
    expect(checker).not.toHaveBeenCalled()
  })

  // Caso 3
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

  it("l'HallucinationError porta dentro l'URL incriminato", async () => {
    // NB: DRIVE_URL_RE matcha fino al fileId, il suffisso (/view) non fa parte
    // dell'URL riportato — è comunque sufficiente a identificare il file.
    const url = 'https://drive.google.com/file/d/INVENTED_ID_XYZ'
    const checker = vi.fn(async () => false)
    const err = await runHallucinationValidator(`PDF: ${url}/view`, { checker }).catch((e) => e)
    expect(err).toBeInstanceOf(HallucinationError)
    expect((err as HallucinationError).url).toBe(url)
    expect((err as HallucinationError).message).toContain(url)
  })

  // Caso 2
  it('passa se checker ritorna true', async () => {
    const checker = vi.fn(async () => true)
    await expect(
      runHallucinationValidator(
        'PDF: https://drive.google.com/file/d/REAL_ID/view',
        { checker },
      ),
    ).resolves.toBeUndefined()
  })

  // Caso 4 — guard anti falsi positivi
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

  it('non blocca se il checker lancia GoogleAuthDeadError (token morto ≠ file inesistente)', async () => {
    const checker = vi.fn(async () => {
      throw new GoogleAuthDeadError('dead')
    })
    await expect(
      runHallucinationValidator(
        'PDF: https://drive.google.com/file/d/SOME_ID/view',
        { checker },
      ),
    ).resolves.toBeUndefined()
  })

  // Caso 5
  it('deduplica: stesso fileId ripetuto 3 volte ⇒ una sola chiamata al checker', async () => {
    const checker = vi.fn(async () => true)
    const url = 'https://drive.google.com/file/d/DUP_ID_00001/view'
    await expect(
      runHallucinationValidator(`uno ${url}\ndue ${url}\ntre ${url}`, { checker }),
    ).resolves.toBeUndefined()
    expect(checker).toHaveBeenCalledTimes(1)
  })
})

describe('defaultDriveChecker (checker Drive vero)', () => {
  it('ritorna true e interroga Drive in modo leggero (fields=id, supportsAllDrives)', async () => {
    mockFilesGet.mockResolvedValue({ data: { id: 'REAL_ID' } })
    await expect(defaultDriveChecker('REAL_ID')).resolves.toBe(true)
    expect(mockFilesGet).toHaveBeenCalledWith({
      fileId: 'REAL_ID',
      fields: 'id',
      supportsAllDrives: true,
    })
  })

  it('ritorna false su 404 (file davvero inesistente = allucinazione)', async () => {
    mockFilesGet.mockRejectedValue(gaxiosError(404, { error: { code: 404, message: 'File not found' } }))
    await expect(defaultDriveChecker('GHOST_ID')).resolves.toBe(false)
  })

  it('LANCIA su 401 (non verificabile, non allucinazione)', async () => {
    mockFilesGet.mockRejectedValue(gaxiosError(401, { error: 'invalid_token' }))
    await expect(defaultDriveChecker('SOME_ID')).rejects.toThrow()
  })

  it('LANCIA su 403 permessi insufficienti', async () => {
    mockFilesGet.mockRejectedValue(
      gaxiosError(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }),
    )
    await expect(defaultDriveChecker('SOME_ID')).rejects.toThrow()
  })

  it('LANCIA su rate limit / quota (403 rateLimitExceeded)', async () => {
    mockFilesGet.mockRejectedValue(
      gaxiosError(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }),
    )
    await expect(defaultDriveChecker('SOME_ID')).rejects.toThrow()
  })

  it('LANCIA su errore di rete (ECONNRESET)', async () => {
    const netErr = new Error('socket hang up') as Error & { code: string }
    netErr.code = 'ECONNRESET'
    mockFilesGet.mockRejectedValue(netErr)
    await expect(defaultDriveChecker('SOME_ID')).rejects.toThrow()
  })

  it('LANCIA se il token Google è morto (GoogleAuthDeadError da getAuthorizedClient)', async () => {
    mockGetAuthorizedClient.mockRejectedValue(new GoogleAuthDeadError('dead'))
    await expect(defaultDriveChecker('SOME_ID')).rejects.toBeInstanceOf(GoogleAuthDeadError)
    expect(mockFilesGet).not.toHaveBeenCalled()
  })

  it('LANCIA se non esiste alcun client OAuth (nessun fallback Service Account)', async () => {
    mockGetAuthorizedClient.mockResolvedValue(null)
    await expect(defaultDriveChecker('SOME_ID')).rejects.toThrow()
    expect(mockFilesGet).not.toHaveBeenCalled()
  })
})

describe('runHallucinationValidator + defaultDriveChecker (integrazione, Drive mockato)', () => {
  it('404 ⇒ HallucinationError', async () => {
    mockFilesGet.mockRejectedValue(gaxiosError(404))
    await expect(
      runHallucinationValidator('PDF: https://drive.google.com/file/d/GHOST_ID_001/view'),
    ).rejects.toBeInstanceOf(HallucinationError)
  })

  it('401 ⇒ NESSUN errore propagato (guard anti falsi positivi)', async () => {
    mockFilesGet.mockRejectedValue(gaxiosError(401, { error: 'invalid_token' }))
    await expect(
      runHallucinationValidator('PDF: https://drive.google.com/file/d/SOME_ID_001/view'),
    ).resolves.toBeUndefined()
  })

  it('file esistente ⇒ nessun errore', async () => {
    mockFilesGet.mockResolvedValue({ data: { id: 'REAL_ID_001' } })
    await expect(
      runHallucinationValidator('PDF: https://drive.google.com/file/d/REAL_ID_001/view'),
    ).resolves.toBeUndefined()
  })

  it('testo senza link Drive ⇒ Drive mai interrogato', async () => {
    await expect(runHallucinationValidator('Nessun link qui, solo testo.')).resolves.toBeUndefined()
    expect(mockGetAuthorizedClient).not.toHaveBeenCalled()
    expect(mockFilesGet).not.toHaveBeenCalled()
  })
})
