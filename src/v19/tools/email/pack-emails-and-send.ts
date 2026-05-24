// src/v19/tools/email/pack-emails-and-send.ts
/**
 * Cervellone V19 — Tool pack_emails_and_send.
 *
 * Pattern server-side: il LLM passa solo riferimenti UID (zero base64 nel context),
 * il server fetcha gli allegati via IMAP, opzionalmente li zippa, e invia tutto
 * in una sola mail. Risolve il limite di send_email che richiedeva il LLM di
 * costruire l'attachments[] passando i contenuti base64 nel suo contesto
 * (esplodeva memory/token su 5+ PDF).
 *
 * Modes:
 * - 'separate': mail con N allegati separati (uno per file estratto)
 * - 'zip': zippa tutti gli allegati in un singolo file zip, mail con 1 allegato
 *
 * Verso destinatari esterni eredita la policy di send_email → pending+confirm.
 */
import type Anthropic from '@anthropic-ai/sdk'
import JSZip from 'jszip'
import { getEmailBody } from './get-email-body'
import { sendEmail } from './send-email'
import type { AccountKey } from './config'
import type { SendEmailResult, AttachmentInput } from './types'

export type PackEmailRef = {
  account: AccountKey
  uid: number
  folder?: string
}

export type PackEmailsAndSendInput = {
  from_account: AccountKey
  source_emails: PackEmailRef[]
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body_text: string
  body_html?: string
  pack_mode: 'separate' | 'zip'
  zip_filename?: string
  auto_send_if_internal?: boolean
}

export type PackEmailsAndSendResult = SendEmailResult & {
  packed_count: number
  total_size_bytes: number
  pack_mode: 'separate' | 'zip'
}

type AttachmentWithBase64 = {
  filename: string | null
  contentType: string
  size: number
  contentBase64: string
}

function hasBase64(a: unknown): a is AttachmentWithBase64 {
  return typeof a === 'object' && a !== null && 'contentBase64' in (a as Record<string, unknown>)
}

export async function packEmailsAndSend(
  input: PackEmailsAndSendInput,
): Promise<PackEmailsAndSendResult> {
  // 1. Fetch allegati di tutte le mail sorgenti (server-side, no LLM context)
  const collected: AttachmentInput[] = []
  let attIndex = 0

  for (const ref of input.source_emails) {
    const body = await getEmailBody({
      account: ref.account,
      uid: ref.uid,
      folder: ref.folder ?? 'INBOX',
      include_attachments: true,
    })
    for (const att of body.attachments) {
      if (hasBase64(att) && att.contentBase64) {
        collected.push({
          filename: att.filename ?? `allegato_uid${ref.uid}_${attIndex}.bin`,
          content_base64: att.contentBase64,
          contentType: att.contentType ?? 'application/octet-stream',
        })
        attIndex++
      }
    }
  }

  if (collected.length === 0) {
    throw new Error('Nessun allegato trovato nelle mail sorgenti specificate.')
  }

  // 2. Costruisci attachment finale in base a pack_mode
  let finalAttachments: AttachmentInput[]
  let totalSize = 0

  if (input.pack_mode === 'zip') {
    const zip = new JSZip()
    // Deduplica filename per evitare collisioni nel zip
    const usedNames = new Set<string>()
    for (const a of collected) {
      const buf = Buffer.from(a.content_base64, 'base64')
      totalSize += buf.length
      let name = a.filename ?? 'file.bin'
      let suffix = 1
      while (usedNames.has(name)) {
        const dot = name.lastIndexOf('.')
        const base = dot > 0 ? name.slice(0, dot) : name
        const ext = dot > 0 ? name.slice(dot) : ''
        name = `${base}_${suffix}${ext}`
        suffix++
      }
      usedNames.add(name)
      zip.file(name, buf)
    }
    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })
    const zipName =
      input.zip_filename ??
      `allegati_${new Date().toISOString().slice(0, 10)}.zip`
    finalAttachments = [
      {
        filename: zipName,
        content_base64: zipBuffer.toString('base64'),
        contentType: 'application/zip',
      },
    ]
  } else {
    for (const a of collected) {
      totalSize += Buffer.from(a.content_base64, 'base64').length
    }
    finalAttachments = collected
  }

  // 3. Send (eredita policy pending+confirm per destinatari esterni)
  const result = await sendEmail({
    from_account: input.from_account,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body_text: input.body_text,
    body_html: input.body_html,
    attachments: finalAttachments,
    auto_send_if_internal: input.auto_send_if_internal,
  })

  return {
    ...result,
    packed_count: collected.length,
    total_size_bytes: totalSize,
    pack_mode: input.pack_mode,
  }
}

export const PACK_EMAILS_AND_SEND_TOOL: Anthropic.Tool = {
  name: 'pack_emails_and_send',
  description:
    'Invia mail con allegati estratti server-side da N mail sorgenti (per UID). Il LLM NON passa binari base64 — solo riferimenti UID, il server fetcha via IMAP. Usalo per richieste tipo "manda le fatture estere come allegati" o "mandami tutti i PDF di queste mail in uno zip". pack_mode="separate" allega ogni file individualmente; pack_mode="zip" comprime tutto in un singolo .zip (consigliato se >5 allegati o per UX). Verso destinatari esterni ritorna pending+uuid come send_email.',
  input_schema: {
    type: 'object',
    properties: {
      from_account: {
        type: 'string',
        enum: ['info', 'raffaele'],
        description: 'Account TopHost mittente: info | raffaele',
      },
      source_emails: {
        type: 'array',
        description:
          'Array di mail sorgente da cui estrarre allegati (ogni elemento: account+uid+folder).',
        items: {
          type: 'object',
          properties: {
            account: { type: 'string', enum: ['info', 'raffaele'] },
            uid: { type: 'integer' },
            folder: { type: 'string', description: 'default INBOX' },
          },
          required: ['account', 'uid'],
        },
        minItems: 1,
        maxItems: 50,
      },
      to: { type: 'array', items: { type: 'string' }, minItems: 1 },
      cc: { type: 'array', items: { type: 'string' } },
      bcc: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      body_text: { type: 'string' },
      body_html: { type: 'string' },
      pack_mode: {
        type: 'string',
        enum: ['separate', 'zip'],
        description:
          'separate=ogni allegato come file singolo; zip=tutti in un .zip unico (consigliato per >5 file)',
      },
      zip_filename: {
        type: 'string',
        description:
          'Nome del file zip (solo se pack_mode=zip). Default: "allegati_YYYY-MM-DD.zip"',
      },
      auto_send_if_internal: {
        type: 'boolean',
        description: 'Se tutti i destinatari sono @restruktura.it, invia senza pending',
      },
    },
    required: ['from_account', 'source_emails', 'to', 'subject', 'body_text', 'pack_mode'],
  },
}

export async function executePackEmailsAndSend(
  input: PackEmailsAndSendInput,
): Promise<string> {
  try {
    return JSON.stringify({ ok: true, ...(await packEmailsAndSend(input)) })
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
