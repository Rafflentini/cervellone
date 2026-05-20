// src/v19/tools/email/get-email-body.ts
/**
 * Cervellone V19 — Tool get_email_body
 * Fetch RFC822 di una specifica mail per UID + parse a JSON (mailparser).
 */
import type Anthropic from '@anthropic-ai/sdk'
import { openImap, closeImap } from './connection'
import { parseRfc822, type ParsedAttachment } from './parse-message'
import { logEmail } from './audit'
import type { AccountKey } from './config'

export type GetEmailBodyInput = {
  account: AccountKey
  uid: number
  folder?: string
  include_attachments?: boolean
}

export type GetEmailBodyResult = {
  uid: number
  folder: string
  message_id: string | null
  from: string | null
  to: string[]
  cc: string[]
  subject: string | null
  date: string | null
  text: string
  html: string | null
  attachments: Array<
    Partial<ParsedAttachment> & { filename: string | null; contentType: string; size: number }
  >
}

export async function getEmailBody(input: GetEmailBodyInput): Promise<GetEmailBodyResult> {
  const folder = input.folder ?? 'INBOX'
  const client = await openImap(input.account)
  try {
    await client.mailboxOpen(folder, { readOnly: true })
    const msg = await client.fetchOne(String(input.uid), { source: true }, { uid: true })
    if (!msg || !msg.source) {
      throw new Error(`UID ${input.uid} non trovato in ${folder}`)
    }
    const parsed = await parseRfc822(msg.source as Buffer)
    await logEmail({
      account: input.account,
      action: 'read',
      direction: 'in',
      message_id: parsed.messageId,
      subject: parsed.subject,
      from_addr: parsed.from,
      to_addrs: parsed.to,
      attachments_count: parsed.attachments.length,
      raw_meta: { uid: input.uid, folder },
    })
    return {
      uid: input.uid,
      folder,
      message_id: parsed.messageId,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      date: parsed.date?.toISOString() ?? null,
      text: parsed.text,
      html: parsed.html,
      attachments: input.include_attachments
        ? parsed.attachments
        : parsed.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
          })),
    }
  } finally {
    await closeImap(client)
  }
}

export const GET_EMAIL_BODY_TOOL: Anthropic.Tool = {
  name: 'get_email_body',
  description:
    'Leggi corpo + allegati di una specifica mail per UID. Se include_attachments=true ritorna anche il contenuto base64 (attenzione token).',
  input_schema: {
    type: 'object',
    properties: {
      account: { type: 'string', enum: ['info', 'raffaele'] },
      uid: { type: 'integer' },
      folder: { type: 'string' },
      include_attachments: { type: 'boolean' },
    },
    required: ['account', 'uid'],
  },
}

export async function executeGetEmailBody(input: GetEmailBodyInput): Promise<string> {
  try {
    return JSON.stringify({ ok: true, ...(await getEmailBody(input)) })
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
