import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * markGoogleTokenDead: ordine send→flag (copiato da gmail-alerts/route.ts:36-49)
 * + guardia in-memory contro la concorrenza dentro la stessa istanza lambda.
 *
 * Il latch DB sopravvive ai cold start; la guardia in-memory copre le chiamate
 * concorrenti che partono prima che il flag sia scritto.
 */

const mockMaybeSingle = vi.fn()
const mockUpsert = vi.fn()
const mockSend = vi.fn()

vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: mockMaybeSingle }) }),
      upsert: mockUpsert,
    }),
  }),
}))

vi.mock('./telegram-helpers', () => ({
  sendTelegramMessageChecked: mockSend,
}))

beforeEach(() => {
  vi.clearAllMocks()
  // resetModules azzera la guardia in-memory `lastNotifyAt` fra un test e l'altro
  vi.resetModules()
  mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  mockUpsert.mockResolvedValue({ error: null })
  mockSend.mockResolvedValue(true) // invio verificato = recapitato
  process.env.ADMIN_CHAT_ID = '123456'
})

describe('markGoogleTokenDead', () => {
  it('flag già "true" ⇒ NESSUN alert (latch DB sopravvive ai cold start)', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { value: 'true' }, error: null })
    const { markGoogleTokenDead } = await import('./google-token-health')
    await markGoogleTokenDead('dead')
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('flag già \'"true"\' (con virgolette JSON nel valore) ⇒ NESSUN alert', async () => {
    mockMaybeSingle.mockResolvedValue({ data: { value: '"true"' }, error: null })
    const { markGoogleTokenDead } = await import('./google-token-health')
    await markGoogleTokenDead('dead')
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('flag assente ⇒ un alert + scrittura del flag', async () => {
    const { markGoogleTokenDead } = await import('./google-token-health')
    await markGoogleTokenDead('dead')

    expect(mockSend).toHaveBeenCalledTimes(1)
    const [chatId, text] = mockSend.mock.calls[0] as [number, string]
    expect(chatId).toBe(123456)
    expect(text).toContain('Token Google')
    expect(text).toContain('https://cervellone-five.vercel.app/api/auth/google')

    expect(mockUpsert).toHaveBeenCalledTimes(1)
    const [row, opts] = mockUpsert.mock.calls[0] as [Record<string, string>, Record<string, string>]
    expect(row).toEqual({ key: 'google_token_dead', value: 'true' })
    expect(opts).toEqual({ onConflict: 'key' })
  })

  // Test NON vacuo: il vecchio codice si affidava a un try/catch attorno a
  // sendTelegramMessage, che non rigetta MAI (token assente ⇒ return muto,
  // 4xx/429 ⇒ la fetch risolve comunque). Il catch era codice morto e il flag
  // veniva scritto anche su un messaggio mai recapitato ⇒ latch permanente.
  it('invio NON recapitato (ritorna false) ⇒ flag NON scritto (il latch non si brucia)', async () => {
    mockSend.mockResolvedValue(false)
    const { markGoogleTokenDead } = await import('./google-token-health')
    await markGoogleTokenDead('dead')

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('invio non recapitato ⇒ il tentativo successivo NON è throttlato (si riprova)', async () => {
    mockSend.mockResolvedValue(false)
    const { markGoogleTokenDead } = await import('./google-token-health')
    await markGoogleTokenDead('dead')
    expect(mockUpsert).not.toHaveBeenCalled()

    // secondo giro: Telegram è tornato su
    mockSend.mockResolvedValue(true)
    await markGoogleTokenDead('dead')
    expect(mockSend).toHaveBeenCalledTimes(2)
    expect(mockUpsert).toHaveBeenCalledTimes(1)
  })

  it('send che RIFIUTA ⇒ flag NON scritto (il latch non si brucia)', async () => {
    mockSend.mockRejectedValue(new Error('telegram 500'))
    const { markGoogleTokenDead } = await import('./google-token-health')
    await markGoogleTokenDead('dead')

    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('due chiamate nello stesso tick ⇒ UN SOLO send', async () => {
    const { markGoogleTokenDead } = await import('./google-token-health')
    await Promise.all([markGoogleTokenDead('dead'), markGoogleTokenDead('dead')])
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockUpsert).toHaveBeenCalledTimes(1)
  })

  it('kind transient/other ⇒ nessun alert e nessun latch (flakiness di rete)', async () => {
    const { markGoogleTokenDead } = await import('./google-token-health')
    await markGoogleTokenDead('transient')
    await markGoogleTokenDead('other')
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockUpsert).not.toHaveBeenCalled()
  })

  it('nessun admin chat configurato ⇒ nessun send e nessun latch', async () => {
    process.env.ADMIN_CHAT_ID = '0'
    const prevAllowed = process.env.TELEGRAM_ALLOWED_IDS
    process.env.TELEGRAM_ALLOWED_IDS = ''
    try {
      const { markGoogleTokenDead } = await import('./google-token-health')
      await markGoogleTokenDead('dead')
      expect(mockSend).not.toHaveBeenCalled()
      expect(mockUpsert).not.toHaveBeenCalled()
    } finally {
      process.env.TELEGRAM_ALLOWED_IDS = prevAllowed
    }
  })

  it('fallback su TELEGRAM_ALLOWED_IDS quando ADMIN_CHAT_ID manca', async () => {
    process.env.ADMIN_CHAT_ID = '0'
    const prevAllowed = process.env.TELEGRAM_ALLOWED_IDS
    process.env.TELEGRAM_ALLOWED_IDS = '999888,111'
    try {
      const { markGoogleTokenDead } = await import('./google-token-health')
      await markGoogleTokenDead('dead')
      expect(mockSend).toHaveBeenCalledTimes(1)
      expect(mockSend.mock.calls[0][0]).toBe(999888)
    } finally {
      process.env.TELEGRAM_ALLOWED_IDS = prevAllowed
    }
  })

  it('un errore Supabase in lettura non fa esplodere il chiamante', async () => {
    mockMaybeSingle.mockRejectedValue(new Error('supabase down'))
    const { markGoogleTokenDead } = await import('./google-token-health')
    await expect(markGoogleTokenDead('dead')).resolves.toBeUndefined()
  })
})
