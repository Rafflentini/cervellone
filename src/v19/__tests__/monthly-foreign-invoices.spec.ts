import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../tools/email/read-email', () => ({ readEmail: vi.fn() }))
vi.mock('../tools/email/forward-email', () => ({ forwardEmail: vi.fn() }))
vi.mock('../tools/email/mark-email', () => ({ markEmail: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null }),
      insert: vi.fn().mockResolvedValue({ error: null }),
    })),
  },
}))

import { runMonthlyForeignInvoices } from '../routines/monthly-foreign-invoices'
import { readEmail } from '../tools/email/read-email'
import { forwardEmail } from '../tools/email/forward-email'

describe('routine monthly-foreign-invoices', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dry_run NON invia, ritorna lista candidati', async () => {
    ;(readEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      folder: 'INBOX',
      messages: [
        {
          uid: 1,
          from: 'billing@anthropic.com',
          subject: 'Invoice',
          date: '2026-04-15T10:00:00Z',
          has_attachments: true,
          message_id: '<m1>',
          to: [],
          seen: false,
          flagged: false,
          size: 1000,
        },
      ],
    })
    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-04',
      dry_run: true,
      senders: ['billing@anthropic.com'],
    })
    expect(r.candidates.length).toBe(1)
    expect(forwardEmail).not.toHaveBeenCalled()
  })

  it('inoltra solo candidati con PDF + mittente in whitelist', async () => {
    ;(readEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      folder: 'INBOX',
      messages: [
        {
          uid: 1,
          from: 'billing@anthropic.com',
          subject: 'Invoice',
          date: '2026-04-15T10:00:00Z',
          has_attachments: true,
          message_id: '<m1>',
          to: [],
          seen: false,
          flagged: false,
          size: 100,
        },
        {
          uid: 2,
          from: 'rando@spam.com',
          subject: 'Invoice spam',
          date: '2026-04-16T10:00:00Z',
          has_attachments: true,
          message_id: '<m2>',
          to: [],
          seen: false,
          flagged: false,
          size: 100,
        },
      ],
    })
    ;(forwardEmail as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'sent',
      message_id: '<fwd1>',
      sent_folder: 'Sent',
      sent_uid: 99,
    })
    const r = await runMonthlyForeignInvoices({
      month_ref: '2026-04',
      dry_run: false,
      senders: ['billing@anthropic.com'],
    })
    expect(forwardEmail).toHaveBeenCalledTimes(1)
    expect(r.forwarded.length).toBe(1)
    // mittente NOT whitelisted + PDF + keyword "invoice" → fallback_warnings
    expect(r.fallback_warnings.length).toBe(1)
    expect(r.skipped_not_whitelisted.length).toBe(1)
  })
})
