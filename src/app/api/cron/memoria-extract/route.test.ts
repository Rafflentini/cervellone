/**
 * Il cron elaborava SEMPRE e SOLO "ieri": il parametro ?date= veniva ignorato,
 * quindi una giornata saltata era persa per sempre e nemmeno a mano si poteva
 * recuperarla. Serve per ricostruire i mesi in cui l'estrazione girava a vuoto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runMemoriaExtractMock = vi.fn()
vi.mock('@/lib/memoria-extract', () => ({
  runMemoriaExtract: (...args: unknown[]) => runMemoriaExtractMock(...args),
}))

// config: silent_until assente, last_run configurabile
let lastRunValue: string | null = null
const updateSpy = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: (_col: string, key: string) => ({
          maybeSingle: async () => ({
            data: key === 'memoria_extract_last_run' ? { value: lastRunValue } : { value: null },
            error: null,
          }),
        }),
      }),
      update: (row: Record<string, unknown>) => ({
        eq: async (_c: string, key: string) => {
          updateSpy(key, row)
          return { data: null, error: null }
        },
      }),
    }),
  },
}))

function req(url: string, autorizzato = true) {
  return {
    url,
    headers: { get: () => (autorizzato ? `Bearer ${process.env.CRON_SECRET}` : 'Bearer sbagliato') },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('GET /api/cron/memoria-extract', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'segreto-di-test'
    lastRunValue = null
    runMemoriaExtractMock.mockReset()
    runMemoriaExtractMock.mockResolvedValue({
      ok: true, conversations: 1, entities: 2, tokens: 100, cost_usd: 0.01,
    })
    updateSpy.mockClear()
  })

  it('rielabora il giorno richiesto con ?date=', async () => {
    const { GET } = await import('./route')
    await GET(req('https://x/api/cron/memoria-extract?date=2026-08-05'))

    expect(runMemoriaExtractMock).toHaveBeenCalledWith('2026-08-05')
  })

  it('rifiuta una data malformata invece di elaborare ieri di nascosto', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('https://x/api/cron/memoria-extract?date=pippo'))

    expect(res.status).toBe(400)
    expect(runMemoriaExtractMock).not.toHaveBeenCalled()
  })

  it('con una data esplicita ignora il blocco di idempotenza', async () => {
    lastRunValue = '2026-08-05' // gia processato secondo il registro
    const { GET } = await import('./route')
    await GET(req('https://x/api/cron/memoria-extract?date=2026-08-05'))

    expect(runMemoriaExtractMock).toHaveBeenCalledWith('2026-08-05')
  })

  it('una rielaborazione manuale NON sposta il segnaposto del cron', async () => {
    const { GET } = await import('./route')
    await GET(req('https://x/api/cron/memoria-extract?date=2026-08-05'))

    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('senza ?date= elabora ieri e aggiorna il segnaposto', async () => {
    const ieri = new Date()
    ieri.setDate(ieri.getDate() - 1)
    const atteso = ieri.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })

    const { GET } = await import('./route')
    await GET(req('https://x/api/cron/memoria-extract'))

    expect(runMemoriaExtractMock).toHaveBeenCalledWith(atteso)
    expect(updateSpy).toHaveBeenCalled()
  })

  it('401 senza il segreto del cron', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('https://x/api/cron/memoria-extract', false))

    expect(res.status).toBe(401)
    expect(runMemoriaExtractMock).not.toHaveBeenCalled()
  })
})
