// src/v19/tools/email/read-email.ts
/**
 * Cervellone V19 — Tool read_email
 * Lista metadata di messaggi da una folder IMAP (no body). Per il body usa
 * get_email_body. Supporta filtri (unread/since/from/subject_contains).
 */
import type Anthropic from '@anthropic-ai/sdk'
import { openImap, closeImap } from './connection'
import { logEmail } from './audit'
import type { AccountKey } from './config'

export type ReadEmailInput = {
  account: AccountKey
  folder?: string
  unread_only?: boolean
  since?: string
  before?: string
  from?: string
  subject_contains?: string
  limit?: number
}

export type ReadEmailMessage = {
  uid: number
  from: string | null
  to: string[]
  subject: string | null
  date: string | null
  message_id: string | null
  seen: boolean
  flagged: boolean
  size: number
  has_attachments: boolean
}

export type ReadEmailResult = { folder: string; messages: ReadEmailMessage[]; truncated: boolean; total_matched: number }

function hasAttachments(bodyStructure: unknown): boolean {
  if (!bodyStructure || typeof bodyStructure !== 'object') return false
  const node = bodyStructure as { childNodes?: unknown[]; disposition?: string }
  if (Array.isArray(node.childNodes)) {
    return node.childNodes.some((n) => {
      const child = n as { disposition?: string }
      return child.disposition === 'attachment' || hasAttachments(n)
    })
  }
  return node.disposition === 'attachment'
}

export async function readEmail(input: ReadEmailInput): Promise<ReadEmailResult> {
  const folder = input.folder ?? 'INBOX'
  const limit = Math.min(input.limit ?? 20, 500)
  const client = await openImap(input.account)
  try {
    await client.mailboxOpen(folder, { readOnly: true })
    const criteria: Record<string, unknown> = { all: true }
    if (input.unread_only) criteria.seen = false
    if (input.since) criteria.since = new Date(input.since)
    if (input.before) criteria.before = new Date(input.before)
    if (input.from) criteria.from = input.from
    if (input.subject_contains) criteria.subject = input.subject_contains
    const uids = await client.search(criteria, { uid: true })
    const allUids = Array.isArray(uids) ? uids : []
    const tail = allUids.slice(-limit)
    const messages: ReadEmailMessage[] = []
    if (tail.length > 0) {
      for await (const msg of client.fetch(
        tail,
        { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
        { uid: true },
      )) {
        const env = (msg.envelope ?? {}) as {
          from?: Array<{ address?: string }>
          to?: Array<{ address?: string }>
          subject?: string
          date?: string | Date
          messageId?: string
        }
        messages.push({
          uid: msg.uid,
          from: env.from?.[0]?.address ?? null,
          to: (env.to ?? []).map((a) => a.address ?? '').filter(Boolean),
          subject: env.subject ?? null,
          date: env.date ? new Date(env.date).toISOString() : null,
          message_id: env.messageId ?? null,
          seen: msg.flags?.has('\\Seen') ?? false,
          flagged: msg.flags?.has('\\Flagged') ?? false,
          size: msg.size ?? 0,
          has_attachments: hasAttachments(msg.bodyStructure),
        })
      }
    }
    await logEmail({
      account: input.account,
      action: 'read',
      direction: 'in',
      raw_meta: { folder, count: messages.length, total_matched: allUids.length, truncated: allUids.length > limit, criteria },
    })
    return { folder, messages, truncated: allUids.length > limit, total_matched: allUids.length }
  } finally {
    await closeImap(client)
  }
}

export const READ_EMAIL_TOOL: Anthropic.Tool = {
  name: 'read_email',
  description:
    'Lista messaggi (metadata, no body) da una cartella IMAP di un account TopHost (info@restruktura.it o raffaele.lentini@restruktura.it). NON per Gmail restruktura.drive@gmail.com: per quello usa i tool gmail_*. Per leggere il body usa get_email_body. Default folder INBOX, default limit 20 (max 500). Per un intervallo di date usa since (dal) E before (prima di), es. since=2026-01-01 before=2026-06-01 per gennaio-maggio. Se i risultati matchati superano il limit la risposta ha truncated=true e total_matched: restringi l intervallo o aumenta limit.',
  input_schema: {
    type: 'object',
    properties: {
      account: { type: 'string', enum: ['info', 'raffaele'] },
      folder: { type: 'string', description: 'Default INBOX. Es: INBOX, Sent, INBOX.Fatture-Estere.2026-04' },
      unread_only: { type: 'boolean' },
      since: { type: 'string', description: 'YYYY-MM-DD (dal, incluso)' },
      before: { type: 'string', description: 'YYYY-MM-DD (prima di questa data) — combina con since per un intervallo' },
      from: { type: 'string', description: 'filtra mittente (substring/exact)' },
      subject_contains: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
    required: ['account'],
  },
}

export async function executeReadEmail(input: ReadEmailInput): Promise<string> {
  try {
    return JSON.stringify({ ok: true, ...(await readEmail(input)) })
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
