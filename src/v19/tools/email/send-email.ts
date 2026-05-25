// src/v19/tools/email/send-email.ts
/**
 * Cervellone V19 — Tool send_email.
 *
 * Policy conferma utente:
 *   - Tutti destinatari @restruktura.it → invia direttamente
 *   - Tutti destinatari @restruktura.it + auto_send_if_internal=true → invia direttamente
 *   - Almeno un destinatario esterno → crea pending, ritorna uuid, NON invia
 *
 * Bypass conferma:
 *   - `sendEmailInternal(input, { bypassUserConfirmation: true })` invia direttamente
 *     anche verso esterni. NON esposta come tool al modello — usata solo dal flow
 *     Telegram (`confirmPendingSend`) dopo che l'utente ha digitato /invia_<uuid>.
 *   - `sendEmail(input)` (tool pubblico) chiama sempre `sendEmailInternal` con
 *     bypassUserConfirmation=false. Anche se l'input contenesse legacy
 *     `bypass_user_confirmation`, viene ignorato qui — defense in depth.
 *
 * Dopo SMTP send → APPEND copia in folder Sent del mittente.
 * Se SMTP riesce ma APPEND fallisce: la mail è inviata, segnaliamo warning
 * (impossibile rollback) e logghiamo `append_failed=true`.
 */
import type Anthropic from '@anthropic-ai/sdk'
import nodemailer from 'nodemailer'
import { makeSmtp, fromHeader } from './connection'
import { appendToSent } from './append-sent'
import { logEmail } from './audit'
import { createPendingSend } from './pending'
import type { AccountKey } from './config'
import type { SendEmailInput, SendEmailResult, AttachmentInput } from './types'

export type { SendEmailInput, SendEmailResult, AttachmentInput } from './types'

const INTERNAL_DOMAIN = 'restruktura.it'

export type SendEmailInternalOpts = {
  /** Bypassa la policy di conferma utente. SOLO per confirmPendingSend (Telegram). */
  bypassUserConfirmation: boolean
}

/**
 * Estensione locale di SendEmailResult con campi diagnostici per atomicità
 * SMTP→IMAP. Non vivono in types.ts per evitare churn cross-modulo.
 */
export type SendEmailResultExt =
  | { status: 'pending'; uuid: string; reason: string }
  | {
      status: 'sent'
      message_id: string
      sent_folder: string
      sent_uid: number | null
      /** True se SMTP ok ma APPEND a Sent fallito. */
      append_failed?: boolean
      /** Warning user-facing presente solo se append_failed=true. */
      warning?: string
    }

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

/**
 * Tool pubblico esposto al modello via SEND_EMAIL_TOOL.
 * Bypass MAI consentito: sempre subject a policy gate.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResultExt> {
  return sendEmailInternal(input, { bypassUserConfirmation: false })
}

/**
 * Implementazione interna. NON esporre come tool al modello.
 * `bypassUserConfirmation` è un secondo parametro (non parte di SendEmailInput)
 * proprio per impedire al modello di settarlo via tool_use.
 */
export async function sendEmailInternal(
  input: SendEmailInput,
  opts: SendEmailInternalOpts,
): Promise<SendEmailResultExt> {
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]
  const internalOnly = isInternal(recipients)
  const allowAutoSend = input.auto_send_if_internal === true && internalOnly

  // Policy gate: outbound esterno richiede conferma utente
  if (!opts.bypassUserConfirmation && !allowAutoSend && !internalOnly) {
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

  // Bug-fix 24 mag: Nodemailer SMTP transport NON popola automaticamente info.raw o
  // info.message dopo sendMail. Senza questo, raw è 0 byte e IMAP APPEND fallisce con
  // "NO Can't save a zero byte message" (server Dovecot TopHost). Soluzione canonica:
  // generare il raw RFC822 separatamente via streamTransport (buffer:true) DOPO l'invio
  // SMTP riuscito, usando lo stesso message object. Costo: extra MIME compose ~10ms,
  // zero rete (streamTransport non invia, solo serializza).
  let raw: Buffer = info.raw ?? Buffer.from(info.message ?? '')
  if (raw.length === 0) {
    try {
      const composer = nodemailer.createTransport({ streamTransport: true, buffer: true })
      const composed = (await composer.sendMail({
        ...message,
        messageId: info.messageId, // mantieni stesso Message-ID dell'SMTP send
      })) as { message?: Buffer | string }
      if (composed.message) {
        raw = Buffer.isBuffer(composed.message)
          ? composed.message
          : Buffer.from(composed.message)
      }
    } catch (composeErr) {
      console.warn('[mail] raw compose for IMAP APPEND failed:', composeErr)
    }
  }

  // Atomicità SMTP→IMAP: se SMTP ok ma APPEND fallisce, la mail è già partita
  // e non possiamo rollbackare. Segnaliamo warning + log, ma NON throw.
  let appendPath: string | null = null
  let appendUid: number | null = null
  let appendFailed = false
  let appendError: string | undefined
  try {
    const append = await appendToSent(input.from_account, raw)
    appendPath = append.path
    appendUid = append.uid
  } catch (e) {
    appendFailed = true
    appendError = e instanceof Error ? e.message : String(e)
    console.warn('[mail] appendToSent failed after SMTP success', {
      account: input.from_account,
      message_id: info.messageId,
      error: appendError,
    })
  }

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
    raw_meta: {
      sent_folder: appendPath,
      sent_uid: appendUid,
      append_failed: appendFailed,
      append_error: appendError ?? null,
    },
    append_failed: appendFailed,
  })

  return {
    status: 'sent',
    message_id: info.messageId ?? '',
    sent_folder: appendPath ?? '',
    sent_uid: appendUid,
    append_failed: appendFailed,
    warning: appendFailed
      ? 'Mail inviata ma NON salvata in Sent IMAP — verifica manualmente su Outlook'
      : undefined,
  }
}

export const SEND_EMAIL_TOOL: Anthropic.Tool = {
  name: 'send_email',
  description:
    'Invia mail da un account TopHost (info@restruktura.it o raffaele.lentini@restruktura.it). NON per Gmail restruktura.drive@gmail.com: per quello usa i tool gmail_*. Verso destinatari ESTERNI a @restruktura.it ritorna status="pending" + uuid: l\'utente conferma via Telegram /invia_<uuid>. Verso destinatari interni con auto_send_if_internal=true invia subito. Salva sempre copia in Sent del mittente.',
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
