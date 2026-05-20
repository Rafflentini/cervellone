// src/v19/tools/email/parse-message.ts
/**
 * Cervellone V19 — RFC822 → JSON wrapper su mailparser.
 * Estrae header, body text/html, allegati (base64) e snippet.
 */
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser'

export type ParsedEmail = {
  messageId: string | null
  from: string | null
  to: string[]
  cc: string[]
  subject: string | null
  date: Date | null
  text: string
  html: string | null
  attachments: ParsedAttachment[]
}

export type ParsedAttachment = {
  filename: string | null
  contentType: string
  size: number
  contentBase64: string
}

function flatAddrs(addr?: AddressObject | AddressObject[]): string[] {
  if (!addr) return []
  const arr = Array.isArray(addr) ? addr : [addr]
  return arr.flatMap((a) => a.value.map((v) => v.address ?? '').filter(Boolean))
}

export async function parseRfc822(raw: Buffer): Promise<ParsedEmail> {
  const m: ParsedMail = await simpleParser(raw, { skipHtmlToText: false })
  return {
    messageId: m.messageId ?? null,
    from: m.from?.value?.[0]?.address ?? null,
    to: flatAddrs(m.to),
    cc: flatAddrs(m.cc),
    subject: m.subject ?? null,
    date: m.date ?? null,
    text: m.text ?? '',
    html: typeof m.html === 'string' ? m.html : null,
    attachments: (m.attachments ?? []).map((a) => ({
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
      contentBase64: a.content.toString('base64'),
    })),
  }
}

export function toSnippet(text: string, max = 200): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned
}
