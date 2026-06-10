import { describe, it, expect, vi, beforeEach } from 'vitest'
import { recordSentMail, buildSentMailPointer } from './sent-mail'

// Mock getSupabaseServer (stesso pattern di artifact-capture.test.ts).
const mockFrom = vi.fn()

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({ from: mockFrom }),
}))
vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({ from: mockFrom }),
}))

describe('recordSentMail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it("inserisce una riga type='mail-inviata' con name=oggetto e content con A:/Oggetto:/Inviata:", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    mockFrom.mockReturnValue({ insert })

    await recordSentMail('conv-1', { to: 'cliente@example.com', subject: 'Preventivo lavori' })

    expect(mockFrom).toHaveBeenCalledWith('documents')
    expect(insert).toHaveBeenCalledTimes(1)
    const arg = insert.mock.calls[0][0]
    expect(arg).toMatchObject({
      name: 'Preventivo lavori',
      conversation_id: 'conv-1',
      type: 'mail-inviata',
      metadata: { source: 'sent-mail' },
    })
    expect(arg.content).toContain('A: cliente@example.com')
    expect(arg.content).toContain('Oggetto: Preventivo lavori')
    expect(arg.content).toMatch(/Inviata: \d{4}-\d{2}-\d{2}T/)
  })

  it("oggetto vuoto → name='(senza oggetto)'", async () => {
    const insert = vi.fn().mockResolvedValue({ error: null })
    mockFrom.mockReturnValue({ insert })

    await recordSentMail('conv-1', { to: 'x@example.com' })

    const arg = insert.mock.calls[0][0]
    expect(arg.name).toBe('(senza oggetto)')
  })

  it('best-effort: non lancia se conversationId mancante (nessun insert)', async () => {
    await expect(recordSentMail('', { to: 'x@example.com', subject: 'a' })).resolves.toBeUndefined()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it("best-effort: non lancia se l'insert ritorna errore", async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'boom' } })
    mockFrom.mockReturnValue({ insert })
    await expect(
      recordSentMail('conv-1', { to: 'x@example.com', subject: 'a' }),
    ).resolves.toBeUndefined()
  })
})

describe('buildSentMailPointer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('con 1 mail inviata recente → blocco con oggetto, dest e data', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [
          {
            name: 'Preventivo lavori',
            content: 'A: cliente@example.com\nOggetto: Preventivo lavori\nInviata: 2026-06-10T08:00:00.000Z',
            created_at: '2026-06-10T08:00:00.000Z',
          },
        ],
        error: null,
      }),
    }
    mockFrom.mockReturnValue(chain)

    const out = await buildSentMailPointer('conv-1')
    expect(out).toContain('MAIL GIÀ INVIATE in questa chat')
    expect(out).toContain('NON re-inviarle senza richiesta ESPLICITA')
    expect(out).toContain('«Preventivo lavori»')
    expect(out).toContain('cliente@example.com')
    expect(out).toContain('inviata il 2026-06-10')
    expect(out).toContain('=== fine ===')
  })

  it("filtra a type='mail-inviata', conversation_id e recency 48h via .eq e .gt", async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    mockFrom.mockReturnValue(chain)

    await buildSentMailPointer('conv-1')

    expect(chain.eq).toHaveBeenCalledWith('type', 'mail-inviata')
    expect(chain.eq).toHaveBeenCalledWith('conversation_id', 'conv-1')
    expect(chain.gt).toHaveBeenCalledTimes(1)
    const gtArgs = chain.gt.mock.calls[0]
    expect(gtArgs[0]).toBe('created_at')
    const sinceMs = Date.parse(gtArgs[1] as string)
    expect(Number.isNaN(sinceMs)).toBe(false)
    // ~48h fa (entro qualche secondo di tolleranza).
    const expected = Date.now() - 48 * 60 * 60 * 1000
    expect(Math.abs(sinceMs - expected)).toBeLessThan(5000)
  })

  it('con 0 mail → stringa vuota', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    }
    mockFrom.mockReturnValue(chain)

    const out = await buildSentMailPointer('conv-1')
    expect(out).toBe('')
  })

  it('best-effort: errore di lettura → stringa vuota', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
    }
    mockFrom.mockReturnValue(chain)

    const out = await buildSentMailPointer('conv-1')
    expect(out).toBe('')
  })

  it('dest assente nel content → mostra ? come destinatario', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ name: 'Oggetto X', content: 'Oggetto: Oggetto X', created_at: '2026-06-10T08:00:00.000Z' }],
        error: null,
      }),
    }
    mockFrom.mockReturnValue(chain)

    const out = await buildSentMailPointer('conv-1')
    expect(out).toContain('«Oggetto X» → ?')
  })
})
