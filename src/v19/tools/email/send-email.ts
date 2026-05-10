// src/v19/tools/email/send-email.ts
/**
 * Cervellone V19 — Tool send_email.
 *
 * Policy conferma utente:
 *   - Tutti destinatari @restruktura.it → invia direttamente
 *   - Tutti destinatari @restruktura.it + auto_send_if_internal=true → invia direttamente
 *   - Almeno un destinatario esterno → crea pending, ritorna uuid, NON invia
 *   - bypass_user_confirmation=true (interno, non esposto al modello) → invia direttamente
 *     (usato dal flow di conferma Telegram dopo /invia_<uuid>)
 *
 * Dopo SMTP send → APPEND copia in folder Sent del mittente.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { makeSmtp, fromHeader } from './connection'
import { appendToSent } from './append-sent'
import { logEmail } from './audit'
import { createPendingSend } from './pending'
import type { AccountKey } from './config'
import type { SendEmailInput, SendEmailResult, AttachmentInput } from './types'

export type { SendEmailInput, SendEmailResult, AttachmentInput } from './types'

const INTERNAL_DOMAIN = 'restruktura.it'

function isInternal(addrs: string[]): boolean {
  if (addrs.length === 0) return false
  return addrs.every((a) => a.toLowerCase().endsWith('@' + INTERNAL_DOMAIN))
}

function buildAttachments(input: SendEmailInput) {
  return (input.attachments ?? []).map((a: AttachmentInput) => ({
    filename: a.filename,
    content: Buffer.from(a.content_base64, 'base64'),
    contentType: a.contentType,
  }))
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]
  const internalOnly = isInternal(recipients)
  const allowAutoSend = input.auto_send_if_internal === true && internalOnly

  // Policy gate: outbound esterno richiede conferma utente
  if (!input.bypass_user_confirmation && !allowAutoSend && !internalOnly) {
    const pending = await createPendingSend(input)
    await logEmail({
      account: input.from_account,
      action: 'pending_created',
      direction: 'out',
      subject: input.subject,
      from_addr: null,
      to_addrs: input.to,
      cc_addrs: input.cc,
      bcc_addrs: input.bcc,
      attachments_count: input.attachments?.length ?? 0,
      request_id: input.request_id ?? null,
      raw_meta: { uuid: pending.uuid },
    })
    return {
      status: 'pending',
      uuid: pending.uuid,
      reason: 'recipients include external addresses; user confirmation required',
    }
  }

  const transporter = makeSmtp(input.from_account)
  const message = {
    from: fromHeader(input.from_account),
    to: input.to.join(', '),
    cc: input.cc?.join(', '),
    bcc: input.bcc?.join(', '),
    subject: input.subject,
    text: input.body_text,
    html: input.body_html,
    attachments: buildAttachments(input),
    inReplyTo: input.in_reply_to?.message_id,
    references: input.in_reply_to?.message_id,
  }
  const info = (await transporter.sendMail(message)) as {
    messageId?: string
    raw?: Buffer
    message?: string
    envelope?: unknown
  }
  const raw = info.raw ?? Buffer.from(info.message ?? '')
  const append = await appendToSent(input.from_account, raw)
  await logEmail({
    account: input.from_account,
    action: 'send',
    direction: 'out',
    message_id: info.messageId ?? null,
    subject: input.subject,
    from_addr: fromHeader(input.from_account),
    to_addrs: input.to,
    cc_addrs: input.cc,
    bcc_addrs: input.bcc,
    attachments_count: input.attachments?.length ?? 0,
    attachments_summary: input.attachments?.map((a) => ({
      filename: a.filename,
      size: Buffer.from(a.content_base64, 'base64').length,
      contentType: a.contentType ?? 'application/octet-stream',
    })),
    request_id: input.request_id ?? null,
    routine_name: input.routine_name ?? null,
    raw_meta: { sent_folder: append.path, sent_uid: append.uid },
  })
  return {
    status: 'sent',
    message_id: info.messageId ?? '',
    sent_folder: append.path,
    sent_uid: append.uid,
  }
}

export const SEND_EMAIL_TOOL: Anthropic.Tool = {
  name: 'send_email',
  description:
    'Invia mail da un account TopHost (info|raffaele). Verso destinatari ESTERNI a @restruktura.it ritorna status="pending" + uuid: l\'utente conferma via Telegram /invia_<uuid>. Verso destinatari interni con auto_send_if_internal=true invia subito. Salva sempre copia in Sent del mittente.',
  input_schema: {
    type: 'object',
    properties: {
      from_account: { type: 'string', enum: ['info', 'raffaele'] },
      to: { type: 'array', items: { type: 'string' }, minItems: 1 },
      cc: { type: 'array', items: { type: 'string' } },
      bcc: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      body_text: { type: 'string' },
      body_html: { type: 'string' },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            filename: { type: 'string' },
            content_base64: { type: 'string' },
            contentType: { type: 'string' },
          },
          required: ['filename', 'content_base64'],
        },
      },
      in_reply_to: {
        type: 'object',
        properties: {
          uid: { type: 'integer' },
          folder: { type: 'string' },
          message_id: { type: 'string' },
        },
        required: ['uid', 'folder'],
      },
      auto_send_if_internal: { type: 'boolean' },
      routine_name: { type: 'string' },
    },
    required: ['from_account', 'to', 'subject', 'body_text'],
  },
}

export async function executeSendEmail(input: SendEmailInput): Promise<string> {
  try {
    return JSON.stringify({ ok: true, ...(await sendEmail(input)) })
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
