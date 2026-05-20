import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMail = vi.fn()
vi.mock('../tools/email/connection', () => ({
  makeSmtp: () => ({ sendMail, verify: vi.fn().mockResolvedValue(true) }),
  fromHeader: () => '"Restruktura" <info@restruktura.it>',
  openImap: vi.fn(),
  closeImap: vi.fn(),
}))
vi.mock('../tools/email/append-sent', () => ({
  appendToSent: vi.fn().mockResolvedValue({ path: 'Sent', uid: 42 }),
}))
vi.mock('../tools/email/audit', () => ({ logEmail: vi.fn() }))
vi.mock('../tools/email/pending', () => ({
  createPendingSend: vi.fn().mockResolvedValue({ uuid: 'uuid-pending', expires_at: '2026-05-11T11:00:00Z' }),
}))

import { sendEmail, sendEmailInternal, SEND_EMAIL_TOOL } from '../tools/email/send-email'
import { createPendingSend } from '../tools/email/pending'
import { appendToSent } from '../tools/email/append-sent'

describe('send_email', () => {
  beforeEach(() => vi.clearAllMocks())

  it('crea pending quando destinatario esterno e non auto_send_if_internal', async () => {
    const res = await sendEmail({
      from_account: 'info',
      to: ['cliente@gmail.com'],
      subject: 'Test',
      body_text: 'ciao',
    })
    expect(res.status).toBe('pending')
    if (res.status === 'pending') expect(res.uuid).toBe('uuid-pending')
    expect(createPendingSend).toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('invia direttamente se tutti destinatari interni @restruktura.it', async () => {
    sendMail.mockResolvedValue({
      messageId: '<msg-internal@x>',
      envelope: { from: 'info@restruktura.it', to: ['raffaele.lentini@restruktura.it'] },
      raw: Buffer.from('raw'),
    })
    const res = await sendEmail({
      from_account: 'info',
      to: ['raffaele.lentini@restruktura.it'],
      subject: 'Interno',
      body_text: 'x',
    })
    expect(res.status).toBe('sent')
    if (res.status === 'sent') expect(res.message_id).toBe('<msg-internal@x>')
    expect(appendToSent).toHaveBeenCalledWith('info', expect.any(Buffer))
  })

  it('auto_send_if_internal + dest esterno → comunque pending (flag vale solo se interno)', async () => {
    const res = await sendEmail({
      from_account: 'info',
      to: ['estraneo@gmail.com'],
      subject: 'X',
      body_text: 'y',
      auto_send_if_internal: true,
    })
    expect(res.status).toBe('pending')
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('sendEmailInternal con bypassUserConfirmation=true invia subito anche verso esterni', async () => {
    sendMail.mockResolvedValue({
      messageId: '<bypass@x>',
      envelope: {},
      raw: Buffer.from('raw'),
    })
    const res = await sendEmailInternal(
      {
        from_account: 'info',
        to: ['external@x.com'],
        subject: 's',
        body_text: 'b',
      },
      { bypassUserConfirmation: true },
    )
    expect(res.status).toBe('sent')
    expect(createPendingSend).not.toHaveBeenCalled()
    expect(sendMail).toHaveBeenCalled()
  })

  it('sendEmail (tool pubblico) crea SEMPRE pending verso esterni — nessun bypass possibile', async () => {
    // Anche se un caller maligno tentasse di passare il legacy field
    // `bypass_user_confirmation` (ancora presente in SendEmailInput type per
    // backward-compat ma rimosso dallo input_schema del tool), sendEmail
    // chiama sendEmailInternal con bypassUserConfirmation=false hardcoded.
    // Defense in depth: anche un input "sporco" non bypassa.
    const inputWithLegacyBypass = {
      from_account: 'info' as const,
      to: ['external@x.com'],
      subject: 's',
      body_text: 'b',
      bypass_user_confirmation: true, // legacy field — sendEmail lo ignora
    }
    const res = await sendEmail(inputWithLegacyBypass)
    expect(res.status).toBe('pending')
    expect(createPendingSend).toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('SEND_EMAIL_TOOL.input_schema NON espone bypass_user_confirmation', () => {
    const props = (SEND_EMAIL_TOOL.input_schema as { properties: Record<string, unknown> })
      .properties
    expect(props).not.toHaveProperty('bypass_user_confirmation')
    expect(props).not.toHaveProperty('bypassUserConfirmation')
  })

  it('atomicità: appendToSent fallisce → ok=true, append_failed=true, warning, no throw', async () => {
    sendMail.mockResolvedValue({
      messageId: '<append-fail@x>',
      envelope: {},
      raw: Buffer.from('raw'),
    })
    ;(appendToSent as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('IMAP quota exceeded'),
    )
    const res = await sendEmailInternal(
      {
        from_account: 'info',
        to: ['raffaele.lentini@restruktura.it'],
        subject: 's',
        body_text: 'b',
      },
      { bypassUserConfirmation: false },
    )
    expect(res.status).toBe('sent')
    if (res.status === 'sent') {
      expect(res.message_id).toBe('<append-fail@x>')
      expect(res.append_failed).toBe(true)
      expect(res.warning).toMatch(/non salvata in Sent/i)
      expect(res.sent_uid).toBeNull()
    }
  })

  it('atomicità: append ok → append_failed assente/false, warning undefined', async () => {
    sendMail.mockResolvedValue({
      messageId: '<ok@x>',
      envelope: {},
      raw: Buffer.from('raw'),
    })
    const res = await sendEmailInternal(
      {
        from_account: 'info',
        to: ['raffaele.lentini@restruktura.it'],
        subject: 's',
        body_text: 'b',
      },
      { bypassUserConfirmation: false },
    )
    expect(res.status).toBe('sent')
    if (res.status === 'sent') {
      expect(res.append_failed).toBeFalsy()
      expect(res.warning).toBeUndefined()
      expect(res.sent_folder).toBe('Sent')
      expect(res.sent_uid).toBe(42)
    }
  })
})
