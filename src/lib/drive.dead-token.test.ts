import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GoogleAuthDeadError } from './google-token-health'

/**
 * drive.ts getAuth(): OAuth-first → fallback Service Account.
 *
 * Il fallback SA è giusto SOLO nel caso "zero credenziali in DB". Su token morto
 * il SA è un principal DIVERSO che non vede le cartelle dell'utente: cadere lì
 * trasformerebbe un errore di autenticazione in una bugia ("file non trovato").
 *
 * Prima del fix il catch inghiottiva tutto e si cadeva sempre sul SA.
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

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = '{}'
})

describe('drive.ts su token Google morto', () => {
  it('listFiles spiega la causa vera invece di un errore generico', async () => {
    mockGetAuthorizedClient.mockRejectedValue(new GoogleAuthDeadError('dead'))

    const { listFiles } = await import('./drive')
    const out = await listFiles('1fPrUX_GTZVYITQVk-CW0VuXSGs1Db3If')

    expect(out).toContain('Token Google scaduto')
    expect(out).toContain('https://cervellone-five.vercel.app/api/auth/google')
  })

  it('il fallback Service Account è BYPASSATO (niente bugia "file non trovato")', async () => {
    mockGetAuthorizedClient.mockRejectedValue(new GoogleAuthDeadError('dead'))

    const { listFiles } = await import('./drive')
    await listFiles('qualsiasi')

    expect(GoogleAuthCtor).not.toHaveBeenCalled()
    expect(driveFactory).not.toHaveBeenCalled()
  })

  it('un errore NON di autenticazione lascia intatto il fallback SA', async () => {
    mockGetAuthorizedClient.mockRejectedValue(new Error('supabase timeout'))
    driveFactory.mockReturnValue({
      files: { list: vi.fn().mockResolvedValue({ data: { files: [] } }) },
    })

    const { listFiles } = await import('./drive')
    const out = await listFiles('qualsiasi')

    expect(GoogleAuthCtor).toHaveBeenCalledTimes(1)
    expect(out).toBe('Cartella vuota.')
  })
})
