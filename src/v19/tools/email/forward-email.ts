// src/v19/tools/email/forward-email.ts
/**
 * Cervellone V19 — Tool forward_email.
 * Pipeline: fetch body originale (con allegati base64) → compose + send.
 * Verso destinatari esterni eredita la policy di send_email → pending+confirm.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { getEmailBody } from './get-email-body'
import { sendEmail } from './send-email'
import type { AccountKey } from './config'
import type { SendEmailResult, AttachmentInput } from './types'

export type ForwardEmailInput = {
  from_account: AccountKey
  source_uid: number
  source_folder?: string
  to: string[]
  extra_body_text?: string
  new_subject_prefix?: string
  auto_send_if_internal?: boolean
  routine_name?: string
}

type AttachmentWithBase64 = { filename: string | null; contentType: string; size: number; contentBase64: string }

function hasBase64(a: unknown): a is AttachmentWithBase64 {
  return typeof a === 'object' && a !== null && 'contentBase64' in (a as Record<string, unknown>)
}

export async function forwardEmail(input: ForwardEmailInput): Promise<SendEmailResult> {
  const folder = input.source_folder ?? 'INBOX'
  const body = await getEmailBody({
    account: input.from_account,
    uid: input.source_uid,
    folder,
    include_attachments: true,
  })
  const prefix = input.new_subject_prefix ?? '[Fwd] '
  const subject = prefix + (body.subject ?? '(senza oggetto)')
  const header = [
    '---------- Inoltro automatico Cervellone ----------',
    `Da: ${body.from ?? '?'}`,
    `Data: ${body.date ?? '?'}`,
    `Oggetto: ${body.subject ?? '?'}`,
    `A: ${body.to.join(', ')}`,
    '',
  ].join('\n')
  const bodyText = (input.extra_body_text ? input.extra_body_text + '\n\n' : '') + header + (body.text ?? '')

  const attachments: AttachmentInput[] = body.attachments
    .filter(hasBase64)
    .map((a) => ({
      filename: a.filename ?? 'allegato.bin',
      content_base64: a.contentBase64,
      contentType: a.contentType,
    }))

  return sendEmail({
    from_account: input.from_account,
    to: input.to,
    subject,
    body_text: bodyText,
    attachments,
    auto_send_if_internal: input.auto_send_if_internal,
    routine_name: input.routine_name,
  })
}

export const FORWARD_EMAIL_TOOL: Anthropic.Tool = {
  name: 'forward_email',
  description:
    'Inoltra mail (preserva allegati). Verso destinatari esterni ritorna pending (vedi send_email). Default prefix oggetto "[Fwd] ".',
  input_schema: {
    type: 'object',
    properties: {
      from_account: { type: 'string', enum: ['info', 'raffaele'] },
      source_uid: { type: 'integer' },
      source_folder: { type: 'string' },
      to: { type: 'array', items: { type: 'string' }, minItems: 1 },
      extra_body_text: { type: 'string' },
      new_subject_prefix: { type: 'string' },
      auto_send_if_internal: { type: 'boolean' },
      routine_name: { type: 'string' },
    },
    required: ['from_account', 'source_uid', 'to'],
  },
}

export async function executeForwardEmail(input: ForwardEmailInput): Promise<string> {
  try {
    return JSON.stringify({ ok: true, ...(await forwardEmail(input)) })
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
