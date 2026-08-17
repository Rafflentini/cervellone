import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { GoogleAuthDeadError } from '@/lib/google-token-health'

/**
 * I due cron Gmail devono ancora accorgersi del token morto.
 *
 * REGRESSIONE CHIUSA QUI: cercavano la stringa `invalid_grant` nel messaggio
 * d'errore. Da quando `getAuthorizedClient()` lancia `GoogleAuthDeadError` —
 * il cui messaggio è il testo ITALIANO di riautorizzazione — quella sottostringa
 * non compare più e i due rami di alert erano diventati IRRAGGIUNGIBILI.
 * Sommato al latch che si bruciava su invii mai recapitati, il risultato era
 * silenzio totale su token morto.
 */

const mockUpsert = vi.fn()
const mockSendChecked = vi.fn()
const mockBuildDailySummary = vi.fn()
const mockCheckCriticalAlerts = vi.fn()

// Valori di cervellone_config letti dalle route (chiave → valore).
let configRows: Record<string, unknown> = {}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: (_column: string, key: string) => ({
          maybeSingle: async () => ({
            data: key in configRows ? { value: configRows[key] } : null,
            error: null,
          }),
        }),
      }),
      upsert: (...args: unknown[]) => mockUpsert(...args),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  },
}))

// NB: i riferimenti ai mock sono avvolti in arrow function — le factory di
// vi.mock sono hoistate sopra le `const`, quindi vanno letti solo alla chiamata.
vi.mock('@/lib/telegram-helpers', () => ({
  sendTelegramMessage: vi.fn(async () => undefined),
  sendTelegramMessageChecked: (...args: unknown[]) => mockSendChecked(...args),
}))

vi.mock('@/lib/gmail-tools', () => ({
  recordBotAction: vi.fn(async () => undefined),
}))

vi.mock('@/lib/gmail-summary', () => ({
  buildDailySummary: (...args: unknown[]) => mockBuildDailySummary(...args),
  checkCriticalAlerts: (...args: unknown[]) => mockCheckCriticalAlerts(...args),
}))

function cronRequest(): NextRequest {
  return {
    headers: { get: (name: string) => (name === 'authorization' ? `Bearer ${process.env.CRON_SECRET}` : null) },
  } as unknown as NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  configRows = {}
  mockUpsert.mockResolvedValue({ error: null })
  mockSendChecked.mockResolvedValue(true)
  process.env.ADMIN_CHAT_ID = '123456'
})

const flagWrites = () =>
  mockUpsert.mock.calls.filter(
    (c) => (c[0] as { key?: string } | undefined)?.key === 'google_token_dead',
  )

describe.each([
  ['gmail-morning', () => import('./gmail-morning/route'), () => mockBuildDailySummary],
  ['gmail-alerts', () => import('./gmail-alerts/route'), () => mockCheckCriticalAlerts],
] as const)('cron %s su token Google morto', (_name, loadRoute, failingCall) => {
  it('GoogleAuthDeadError ⇒ alert inviato e flag latchato', async () => {
    failingCall().mockRejectedValue(new GoogleAuthDeadError('dead'))

    const { GET } = await loadRoute()
    const res = await GET(cronRequest())

    expect(res.status).toBe(500)
    expect(mockSendChecked).toHaveBeenCalledTimes(1)
    expect(mockSendChecked.mock.calls[0][0]).toBe(123456)
    expect(mockSendChecked.mock.calls[0][1]).toContain('Token Google')
    expect(flagWrites()).toHaveLength(1)
    expect(flagWrites()[0][0]).toEqual({ key: 'google_token_dead', value: 'true' })
  })

  it("il messaggio di GoogleAuthDeadError NON contiene 'invalid_grant' (perché il match su stringa non basta più)", () => {
    expect(new GoogleAuthDeadError('dead').message.toLowerCase()).not.toContain('invalid_grant')
  })

  it('errore invalid_grant grezzo ⇒ ancora riconosciuto (compatibilità)', async () => {
    failingCall().mockRejectedValue(new Error('invalid_grant'))

    const { GET } = await loadRoute()
    await GET(cronRequest())

    expect(mockSendChecked).toHaveBeenCalledTimes(1)
    expect(flagWrites()).toHaveLength(1)
  })

  it('errore transitorio (fetch failed) ⇒ NESSUN alert, nessun latch', async () => {
    failingCall().mockRejectedValue(new Error('fetch failed'))

    const { GET } = await loadRoute()
    await GET(cronRequest())

    expect(mockSendChecked).not.toHaveBeenCalled()
    expect(flagWrites()).toHaveLength(0)
  })

  it('flag già a true ⇒ nessun secondo alert (latch DB)', async () => {
    configRows.google_token_dead = 'true'
    failingCall().mockRejectedValue(new GoogleAuthDeadError('dead'))

    const { GET } = await loadRoute()
    await GET(cronRequest())

    expect(mockSendChecked).not.toHaveBeenCalled()
    expect(flagWrites()).toHaveLength(0)
  })

  it('alert NON recapitato ⇒ flag NON scritto (il latch non si brucia)', async () => {
    mockSendChecked.mockResolvedValue(false)
    failingCall().mockRejectedValue(new GoogleAuthDeadError('dead'))

    const { GET } = await loadRoute()
    await GET(cronRequest())

    expect(mockSendChecked).toHaveBeenCalledTimes(1)
    expect(flagWrites()).toHaveLength(0)
  })
})
