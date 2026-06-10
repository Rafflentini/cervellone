// src/v19/__tests__/email-pending.spec.ts
/**
 * Test V19 — race condition fix su markPendingSent / markPendingCancelled
 * e nuova expirePendingOlderThan() per il cron /api/cron/expire-pending.
 *
 * Pattern mock supabase coerente con monthly-foreign-invoices.spec.ts:
 * un client a fluent chain (update/eq/select/lt/insert) che ritorna self
 * e termina con un thenable mockato per call.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- mock supabase: una builder factory configurabile per test ---
type FinalResult = { data: unknown; error: { message: string } | null }

interface Builder {
  update: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  select: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  lt: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
  single: ReturnType<typeof vi.fn>
  then: (resolve: (v: FinalResult) => unknown) => Promise<unknown>
  __final: FinalResult
}

function makeBuilder(final: FinalResult): Builder {
  const b: Partial<Builder> = {}
  b.__final = final
  b.update = vi.fn(() => b as Builder)
  b.insert = vi.fn(() => b as Builder)
  b.select = vi.fn(() => b as Builder)
  b.eq = vi.fn(() => b as Builder)
  b.lt = vi.fn(() => b as Builder)
  b.maybeSingle = vi.fn(() => Promise.resolve(final))
  b.single = vi.fn(() => Promise.resolve(final))
  // `await builder` — thenable per terminare la chain senza .single/.maybeSingle
  b.then = (resolve: (v: FinalResult) => unknown) => Promise.resolve(resolve(final))
  return b as Builder
}

let currentBuilder: Builder = makeBuilder({ data: [], error: null })
const fromSpy = vi.fn((..._args: unknown[]) => currentBuilder)

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (...args: unknown[]) => fromSpy(...args),
  },
}))

import {
  markPendingSent,
  markPendingCancelled,
  expirePendingOlderThan,
  updatePendingMessageId,
} from '../tools/email/pending'

beforeEach(() => {
  fromSpy.mockClear()
})

describe('markPendingSent — race condition guard', () => {
  it('happy path: pending → sent, ritorna ok:true', async () => {
    currentBuilder = makeBuilder({ data: [{ uuid: 'u1' }], error: null })
    const res = await markPendingSent('u1', '<msg-1@x>')
    expect(res).toEqual({ ok: true })
    // verifica che la guardia WHERE status='pending' sia stata applicata
    expect(currentBuilder.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'sent', sent_message_id: '<msg-1@x>' }),
    )
    expect(currentBuilder.eq).toHaveBeenCalledWith('uuid', 'u1')
    expect(currentBuilder.eq).toHaveBeenCalledWith('status', 'pending')
    expect(currentBuilder.select).toHaveBeenCalledWith('uuid')
  })

  it('pending già processato (status="sent" in DB → WHERE non match): ritorna already_processed', async () => {
    // Simula race: webhook #2 arriva dopo che webhook #1 ha già fatto UPDATE.
    // La query .update().eq('status','pending') non trova righe, data=[].
    currentBuilder = makeBuilder({ data: [], error: null })
    const res = await markPendingSent('u1', '<msg-dup@x>')
    expect(res).toEqual({ ok: false, reason: 'already_processed' })
  })

  it('race condition simulata (data: []) → NO seconda UPDATE riuscita', async () => {
    currentBuilder = makeBuilder({ data: [], error: null })
    const res = await markPendingSent('u1', '<msg@x>')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('already_processed')
    // Una sola chiamata a .update() in questa invocazione (verifica side-effect)
    expect(currentBuilder.update).toHaveBeenCalledTimes(1)
  })

  it('errore Supabase: ritorna db_error con message', async () => {
    currentBuilder = makeBuilder({ data: null, error: { message: 'connection refused' } })
    const res = await markPendingSent('u1', '<msg@x>')
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe('db_error')
      expect(res.error).toBe('connection refused')
    }
  })
})

describe('markPendingCancelled — race condition guard', () => {
  it('happy path: pending → cancelled, ritorna ok:true', async () => {
    currentBuilder = makeBuilder({ data: [{ uuid: 'u2' }], error: null })
    const res = await markPendingCancelled('u2')
    expect(res).toEqual({ ok: true })
    expect(currentBuilder.update).toHaveBeenCalledWith({ status: 'cancelled' })
    expect(currentBuilder.eq).toHaveBeenCalledWith('uuid', 'u2')
    expect(currentBuilder.eq).toHaveBeenCalledWith('status', 'pending')
  })

  it('già cancellato/inviato: ritorna already_processed (no doppia transizione)', async () => {
    currentBuilder = makeBuilder({ data: [], error: null })
    const res = await markPendingCancelled('u2')
    expect(res).toEqual({ ok: false, reason: 'already_processed' })
  })

  it('errore Supabase: ritorna db_error', async () => {
    currentBuilder = makeBuilder({ data: null, error: { message: 'rls denied' } })
    const res = await markPendingCancelled('u2')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('db_error')
  })
})

describe('updatePendingMessageId — best-effort update reale del messageId post-claim', () => {
  it('happy path: chiama supabase.update({sent_message_id}).eq(uuid).eq(status=sent)', async () => {
    currentBuilder = makeBuilder({ data: null, error: null })
    const res = await updatePendingMessageId('u-claim', '<real-msg-id@x>')
    expect(res).toEqual({ ok: true })
    expect(currentBuilder.update).toHaveBeenCalledWith({ sent_message_id: '<real-msg-id@x>' })
    expect(currentBuilder.eq).toHaveBeenCalledWith('uuid', 'u-claim')
    expect(currentBuilder.eq).toHaveBeenCalledWith('status', 'sent')
  })

  it('errore Supabase: NON throw, ritorna ok:false con error message (best-effort)', async () => {
    currentBuilder = makeBuilder({ data: null, error: { message: 'rls denied' } })
    const res = await updatePendingMessageId('u-claim', '<real@x>')
    expect(res.ok).toBe(false)
    expect(res.error).toBe('rls denied')
  })
})

describe('confirmPendingSend — claim atomico chiude race SMTP', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('pending con conversation_id e status sent → recordSentMail chiamato con to/subject', async () => {
    const fetchPendingMock = vi.fn(async () => ({
      uuid: 'u-conv',
      from_account: 'restruktura',
      to_addrs: ['cliente@esterno.it', 'altro@esterno.it'],
      cc_addrs: null,
      bcc_addrs: null,
      subject: 'Preventivo lavori',
      body_text: 'body',
      body_html: null,
      attachments: null,
      in_reply_to: null,
      status: 'pending',
      sent_message_id: null,
      sent_at: null,
      created_at: '2026-06-10T00:00:00Z',
      expires_at: '2026-06-10T00:30:00Z',
      conversation_id: 'conv-42',
    }))
    const recordSentMailMock = vi.fn(async () => undefined)

    vi.doMock('../tools/email/pending', () => ({
      fetchPending: fetchPendingMock,
      markPendingSent: vi.fn(async () => ({ ok: true })),
      markPendingCancelled: vi.fn(),
      updatePendingMessageId: vi.fn(async () => ({ ok: true })),
    }))
    vi.doMock('../tools/email/send-email', () => ({
      sendEmailInternal: vi.fn(async () => ({
        status: 'sent',
        message_id: '<real-smtp-id@x>',
        sent_folder: 'INBOX.Sent',
        sent_uid: 7,
        append_failed: false,
      })),
    }))
    vi.doMock('../tools/email/audit', () => ({ logEmail: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/sent-mail', () => ({ recordSentMail: recordSentMailMock }))

    const { confirmPendingSend } = await import('../tools/email/telegram-confirm')
    const res = await confirmPendingSend('u-conv')

    expect(res.ok).toBe(true)
    expect(recordSentMailMock).toHaveBeenCalledTimes(1)
    expect(recordSentMailMock).toHaveBeenCalledWith('conv-42', {
      to: 'cliente@esterno.it, altro@esterno.it',
      subject: 'Preventivo lavori',
    })
  })

  it('pending SENZA conversation_id e status sent → recordSentMail NON chiamato, nessun crash', async () => {
    const fetchPendingMock = vi.fn(async () => ({
      uuid: 'u-noconv',
      from_account: 'restruktura',
      to_addrs: ['cliente@esterno.it'],
      cc_addrs: null,
      bcc_addrs: null,
      subject: 'Senza conv',
      body_text: 'body',
      body_html: null,
      attachments: null,
      in_reply_to: null,
      status: 'pending',
      sent_message_id: null,
      sent_at: null,
      created_at: '2026-06-10T00:00:00Z',
      expires_at: '2026-06-10T00:30:00Z',
      conversation_id: null,
    }))
    const recordSentMailMock = vi.fn(async () => undefined)

    vi.doMock('../tools/email/pending', () => ({
      fetchPending: fetchPendingMock,
      markPendingSent: vi.fn(async () => ({ ok: true })),
      markPendingCancelled: vi.fn(),
      updatePendingMessageId: vi.fn(async () => ({ ok: true })),
    }))
    vi.doMock('../tools/email/send-email', () => ({
      sendEmailInternal: vi.fn(async () => ({
        status: 'sent',
        message_id: '<real-smtp-id@x>',
        sent_folder: 'INBOX.Sent',
        sent_uid: 8,
        append_failed: false,
      })),
    }))
    vi.doMock('../tools/email/audit', () => ({ logEmail: vi.fn(async () => undefined) }))
    vi.doMock('@/lib/sent-mail', () => ({ recordSentMail: recordSentMailMock }))

    const { confirmPendingSend } = await import('../tools/email/telegram-confirm')
    const res = await confirmPendingSend('u-noconv')

    expect(res.ok).toBe(true)
    expect(recordSentMailMock).not.toHaveBeenCalled()
  })

  it('race: 2 webhook simultanei per stesso uuid → solo 1 chiama sendEmailInternal', async () => {
    const fetchPendingMock = vi.fn(async () => ({
      uuid: 'u-race',
      from_account: 'restruktura',
      to_addrs: ['cliente@esterno.it'],
      cc_addrs: null,
      bcc_addrs: null,
      subject: 'Test race',
      body_text: 'body',
      body_html: null,
      attachments: null,
      in_reply_to: null,
      status: 'pending',
      sent_message_id: null,
      sent_at: null,
      created_at: '2026-05-20T00:00:00Z',
      expires_at: '2026-05-20T00:30:00Z',
    }))
    // Webhook #1 vince il claim; webhook #2 trova status già 'sent' → already_processed.
    const markPendingSentMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, reason: 'already_processed' })
    const updatePendingMessageIdMock = vi.fn(async () => ({ ok: true }))
    const markPendingCancelledMock = vi.fn()

    const sendEmailInternalMock = vi.fn(async () => ({
      status: 'sent',
      message_id: '<real-smtp-id@x>',
      sent_folder: 'INBOX.Sent',
      sent_uid: 42,
      append_failed: false,
    }))
    const logEmailMock = vi.fn(async () => undefined)

    vi.doMock('../tools/email/pending', () => ({
      fetchPending: fetchPendingMock,
      markPendingSent: markPendingSentMock,
      markPendingCancelled: markPendingCancelledMock,
      updatePendingMessageId: updatePendingMessageIdMock,
    }))
    vi.doMock('../tools/email/send-email', () => ({
      sendEmailInternal: sendEmailInternalMock,
    }))
    vi.doMock('../tools/email/audit', () => ({
      logEmail: logEmailMock,
    }))

    const { confirmPendingSend } = await import('../tools/email/telegram-confirm')

    // Webhook #1 e #2 in rapida successione (simulazione del doppio-tap)
    const [r1, r2] = await Promise.all([
      confirmPendingSend('u-race'),
      confirmPendingSend('u-race'),
    ])

    // claim atomico chiamato 2 volte (una per webhook)
    expect(markPendingSentMock).toHaveBeenCalledTimes(2)
    // ma sendEmailInternal chiamato UNA SOLA volta (solo chi ha vinto il claim)
    expect(sendEmailInternalMock).toHaveBeenCalledTimes(1)
    // updatePendingMessageId scritto solo dal vincitore col message-id reale
    expect(updatePendingMessageIdMock).toHaveBeenCalledTimes(1)
    expect(updatePendingMessageIdMock).toHaveBeenCalledWith('u-race', '<real-smtp-id@x>')

    // Uno dei due esiti è ok:true, l'altro segnala "già processato"
    const okCount = [r1, r2].filter((r) => r.ok).length
    const dupCount = [r1, r2].filter(
      (r) => !r.ok && /già processato/i.test(r.message),
    ).length
    expect(okCount).toBe(1)
    expect(dupCount).toBe(1)
  })

  it('claim vince ma SMTP throw: messaggio errore esplicito + log con placeholder', async () => {
    const fetchPendingMock = vi.fn(async () => ({
      uuid: 'u-smtp-fail',
      from_account: 'restruktura',
      to_addrs: ['cliente@esterno.it'],
      cc_addrs: null,
      bcc_addrs: null,
      subject: 'Test smtp fail',
      body_text: 'body',
      body_html: null,
      attachments: null,
      in_reply_to: null,
      status: 'pending',
      sent_message_id: null,
      sent_at: null,
      created_at: '2026-05-20T00:00:00Z',
      expires_at: '2026-05-20T00:30:00Z',
    }))
    const markPendingSentMock = vi.fn(async () => ({ ok: true }))
    const updatePendingMessageIdMock = vi.fn(async () => ({ ok: true }))
    const sendEmailInternalMock = vi.fn(async () => {
      throw new Error('SMTP 535 auth failed')
    })
    const logEmailMock = vi.fn(async () => undefined)

    vi.doMock('../tools/email/pending', () => ({
      fetchPending: fetchPendingMock,
      markPendingSent: markPendingSentMock,
      markPendingCancelled: vi.fn(),
      updatePendingMessageId: updatePendingMessageIdMock,
    }))
    vi.doMock('../tools/email/send-email', () => ({
      sendEmailInternal: sendEmailInternalMock,
    }))
    vi.doMock('../tools/email/audit', () => ({
      logEmail: logEmailMock,
    }))

    const { confirmPendingSend } = await import('../tools/email/telegram-confirm')
    const res = await confirmPendingSend('u-smtp-fail')

    expect(res.ok).toBe(false)
    expect(res.message).toMatch(/Errore SMTP/)
    expect(res.message).toMatch(/SMTP 535 auth failed/)
    expect(res.message).toMatch(/placeholder/i)
    // updatePendingMessageId NON chiamato (send fallito)
    expect(updatePendingMessageIdMock).not.toHaveBeenCalled()
    // logEmail chiamato col claim_placeholder=true
    expect(logEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        raw_meta: expect.objectContaining({
          uuid: 'u-smtp-fail',
          send_error: 'SMTP 535 auth failed',
          claim_placeholder: true,
        }),
      }),
    )
  })
})

describe('expirePendingOlderThan', () => {
  it('default 30 min: filtra con expires_at < now(), ritorna count corretto', async () => {
    currentBuilder = makeBuilder({
      data: [{ uuid: 'old-1' }, { uuid: 'old-2' }, { uuid: 'old-3' }],
      error: null,
    })
    const res = await expirePendingOlderThan()
    expect(res).toEqual({ expired: 3 })
    expect(currentBuilder.update).toHaveBeenCalledWith({ status: 'expired' })
    expect(currentBuilder.eq).toHaveBeenCalledWith('status', 'pending')
    expect(currentBuilder.lt).toHaveBeenCalledWith('expires_at', expect.any(String))
    expect(currentBuilder.select).toHaveBeenCalledWith('uuid')
  })

  it('soglia custom (60 min): filtra con created_at < cutoff', async () => {
    currentBuilder = makeBuilder({ data: [{ uuid: 'x' }], error: null })
    const res = await expirePendingOlderThan(60)
    expect(res).toEqual({ expired: 1 })
    expect(currentBuilder.lt).toHaveBeenCalledWith('created_at', expect.any(String))
  })

  it('nessun pending scaduto: ritorna { expired: 0 }', async () => {
    currentBuilder = makeBuilder({ data: [], error: null })
    const res = await expirePendingOlderThan()
    expect(res).toEqual({ expired: 0 })
  })

  it('errore Supabase: lancia eccezione (cron deve fallire visibilmente)', async () => {
    currentBuilder = makeBuilder({ data: null, error: { message: 'timeout' } })
    await expect(expirePendingOlderThan()).rejects.toThrow(/timeout/)
  })
})
