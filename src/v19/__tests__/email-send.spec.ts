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

import { sendEmail } from '../tools/email/send-email'
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

  it('bypass_user_confirmation invia subito anche verso esterni', async () => {
    sendMail.mockResolvedValue({
      messageId: '<bypass@x>',
      envelope: {},
      raw: Buffer.from('raw'),
    })
    const res = await sendEmail({
      from_account: 'info',
      to: ['external@x.com'],
      subject: 's',
      body_text: 'b',
      bypass_user_confirmation: true,
    })
    expect(res.status).toBe('sent')
  })
})
