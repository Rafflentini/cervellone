import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * sendTelegramMessageChecked: l'esito dell'invio deve essere VERIFICABILE.
 *
 * `sendTelegramMessage` non rigetta mai — senza token fa `return` muto e su
 * 4xx/429 la fetch risolve comunque — quindi chi latcha uno stato su "l'ho già
 * detto all'utente" (markGoogleTokenDead, i due cron gmail) non può usarla:
 * brucerebbe il latch su un messaggio mai arrivato.
 */

const mockFetch = vi.fn()
const originalFetch = globalThis.fetch
const originalToken = process.env.TELEGRAM_BOT_TOKEN

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.TELEGRAM_BOT_TOKEN = 'test-telegram-bot-token'
  globalThis.fetch = mockFetch as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  process.env.TELEGRAM_BOT_TOKEN = originalToken
})

describe('sendTelegramMessageChecked', () => {
  it('true quando Telegram risponde {ok:true}', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ok: true }))
    const { sendTelegramMessageChecked } = await import('./telegram-helpers')
    await expect(sendTelegramMessageChecked(1, 'ciao')).resolves.toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('false quando manca TELEGRAM_BOT_TOKEN (nessun messaggio è mai partito)', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN
    const { sendTelegramMessageChecked } = await import('./telegram-helpers')
    await expect(sendTelegramMessageChecked(1, 'ciao')).resolves.toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('false su 429: la fetch RISOLVE, solo lo status dice che non è arrivato', async () => {
    mockFetch.mockResolvedValue(jsonResponse(429, { ok: false, description: 'Too Many Requests' }))
    const { sendTelegramMessageChecked } = await import('./telegram-helpers')
    await expect(sendTelegramMessageChecked(1, 'ciao')).resolves.toBe(false)
  })

  it('false su HTTP 200 con {ok:false} (errore applicativo Telegram)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ok: false, description: 'chat not found' }))
    const { sendTelegramMessageChecked } = await import('./telegram-helpers')
    await expect(sendTelegramMessageChecked(1, 'ciao')).resolves.toBe(false)
  })

  it('Markdown rifiutato ⇒ ritenta senza parse_mode e riporta true se passa', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(400, { ok: false, description: "can't parse entities" }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
    const { sendTelegramMessageChecked } = await import('./telegram-helpers')
    await expect(sendTelegramMessageChecked(1, 'testo *rotto')).resolves.toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse((mockFetch.mock.calls[1][1] as { body: string }).body) as Record<string, unknown>
    expect(secondBody.parse_mode).toBeUndefined()
  })

  it('false se la rete rigetta su entrambi i tentativi', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'))
    const { sendTelegramMessageChecked } = await import('./telegram-helpers')
    await expect(sendTelegramMessageChecked(1, 'ciao')).resolves.toBe(false)
  })

  it('sendTelegramMessage resta silenziosa (non rigetta) anche se tutto fallisce', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'))
    const { sendTelegramMessage } = await import('./telegram-helpers')
    await expect(sendTelegramMessage(1, 'ciao')).resolves.toBeUndefined()
  })

  it('testo lungo: false se anche un solo chunk non è passato', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }))
      .mockResolvedValue(jsonResponse(500, { ok: false }))
    const { sendTelegramMessageChecked } = await import('./telegram-helpers')
    const long = `${'a'.repeat(4200)}\n\n${'b'.repeat(100)}`
    await expect(sendTelegramMessageChecked(1, long)).resolves.toBe(false)
  })
})
