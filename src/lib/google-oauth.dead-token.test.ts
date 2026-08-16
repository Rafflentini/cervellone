import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * getAuthorizedClient() è il choke point unico di TUTTI i client Google del repo.
 * Prima di questo fix faceva solo setCredentials(): un refresh_token revocato
 * produceva un client formalmente valido e l'errore esplodeva pigramente dentro
 * la prima chiamata API, mascherato da "file non trovato".
 *
 * Qui si prova la credenziale con getAccessToken() e si distingue:
 *  - dead/scope/config ⇒ alert + throw GoogleAuthDeadError
 *  - transient/other   ⇒ si ritorna comunque il client (niente alert su flakiness)
 */

process.env.GOOGLE_OAUTH_CLIENT_ID ??= 'test-client-id'
process.env.GOOGLE_OAUTH_CLIENT_SECRET ??= 'test-client-secret'

let getAccessTokenImpl: () => Promise<{ token: string | null | undefined }> = async () => ({ token: 'fresh' })

const oauth2Constructed = vi.fn()
const setCredentialsSpy = vi.fn()
const onSpy = vi.fn()
const getAccessTokenSpy = vi.fn(() => getAccessTokenImpl())

class FakeOAuth2Client {
  constructor(clientId: string, clientSecret: string, redirectUri: string) {
    oauth2Constructed(clientId, clientSecret, redirectUri)
  }
  setCredentials = setCredentialsSpy
  on = onSpy
  getAccessToken = getAccessTokenSpy
}

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: FakeOAuth2Client },
  },
}))

const mockSingle = vi.fn()
const mockUpsert = vi.fn()

vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      select: () => ({
        order: () => ({ limit: () => ({ single: mockSingle }) }),
      }),
      upsert: mockUpsert,
      update: () => ({ eq: vi.fn().mockResolvedValue({ error: null }) }),
    }),
  }),
}))

const markGoogleTokenDeadSpy = vi.fn()

vi.mock('./google-token-health', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./google-token-health')>()
  return {
    ...actual,
    markGoogleTokenDead: markGoogleTokenDeadSpy,
  }
})

function gaxiosLike(message: string, extra: Record<string, unknown>): Error {
  return Object.assign(new Error(message), extra)
}

beforeEach(() => {
  vi.clearAllMocks()
  getAccessTokenImpl = async () => ({ token: 'fresh' })
  mockSingle.mockResolvedValue({
    data: { refresh_token: 'rt-abc', access_token: 'at-abc', access_token_expires_at: null },
    error: null,
  })
  mockUpsert.mockResolvedValue({ error: null })
  markGoogleTokenDeadSpy.mockResolvedValue(undefined)
})

describe('getAuthorizedClient — token morto', () => {
  it('invalid_grant sul refresh ⇒ REJECTS con GoogleAuthDeadError + alert', async () => {
    getAccessTokenImpl = () => Promise.reject(new Error('invalid_grant'))

    const { getAuthorizedClient } = await import('./google-oauth')
    const { GoogleAuthDeadError } = await import('./google-token-health')

    await expect(getAuthorizedClient()).rejects.toBeInstanceOf(GoogleAuthDeadError)
    expect(markGoogleTokenDeadSpy).toHaveBeenCalledWith('dead')
  })

  it('il messaggio dell errore spiega COSA fare (URL di riautorizzazione)', async () => {
    getAccessTokenImpl = () =>
      Promise.reject(
        new Error(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked. ReAuth required.',
          }),
        ),
      )

    const { getAuthorizedClient } = await import('./google-oauth')
    await expect(getAuthorizedClient()).rejects.toThrow(/\/api\/auth\/google/)
    await expect(getAuthorizedClient()).rejects.toThrow(/Token Google scaduto o revocato/)
  })

  it('la credenziale viene DAVVERO esercitata (getAccessToken chiamato)', async () => {
    const { getAuthorizedClient } = await import('./google-oauth')
    const client = await getAuthorizedClient()
    expect(client).not.toBeNull()
    expect(setCredentialsSpy).toHaveBeenCalledTimes(1)
    expect(getAccessTokenSpy).toHaveBeenCalledTimes(1)
    // il listener 'tokens' è registrato PRIMA della prova, così un refresh
    // riuscito durante la prova persiste comunque l'access_token nuovo
    expect(onSpy).toHaveBeenCalledWith('tokens', expect.any(Function))
    const onOrder = onSpy.mock.invocationCallOrder[0]
    const probeOrder = getAccessTokenSpy.mock.invocationCallOrder[0]
    expect(onOrder).toBeLessThan(probeOrder)
    expect(markGoogleTokenDeadSpy).not.toHaveBeenCalled()
  })
})

describe('getAuthorizedClient — errori NON di autenticazione', () => {
  it('503 durante la prova ⇒ RISOLVE col client e NESSUN alert', async () => {
    getAccessTokenImpl = () =>
      Promise.reject(gaxiosLike('Service Unavailable', { status: 503, response: { status: 503, data: {} } }))

    const { getAuthorizedClient } = await import('./google-oauth')
    const client = await getAuthorizedClient()
    expect(client).not.toBeNull()
    expect(markGoogleTokenDeadSpy).not.toHaveBeenCalled()
  })

  it('ECONNRESET durante la prova ⇒ RISOLVE col client e NESSUN alert', async () => {
    getAccessTokenImpl = () => Promise.reject(gaxiosLike('socket hang up', { code: 'ECONNRESET' }))

    const { getAuthorizedClient } = await import('./google-oauth')
    const client = await getAuthorizedClient()
    expect(client).not.toBeNull()
    expect(markGoogleTokenDeadSpy).not.toHaveBeenCalled()
  })
})

describe('getAuthorizedClient — nessuna credenziale in DB', () => {
  it('zero righe ⇒ null (path Service Account invariato)', async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: 'no rows' } })

    const { getAuthorizedClient } = await import('./google-oauth')
    await expect(getAuthorizedClient()).resolves.toBeNull()
    expect(oauth2Constructed).not.toHaveBeenCalled()
    expect(markGoogleTokenDeadSpy).not.toHaveBeenCalled()
  })
})
