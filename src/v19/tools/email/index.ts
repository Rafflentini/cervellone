// src/v19/tools/email/index.ts
/**
 * Cervellone V19 — Barrel del modulo mail.
 * Esporta tool definitions + executor map per la registrazione nell'orchestrator.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { READ_EMAIL_TOOL, executeReadEmail } from './read-email'
import { GET_EMAIL_BODY_TOOL, executeGetEmailBody, getEmailBody } from './get-email-body'
import { SEND_EMAIL_TOOL, executeSendEmail, sendEmailInternal } from './send-email'
import { FORWARD_EMAIL_TOOL, executeForwardEmail } from './forward-email'
import { MARK_EMAIL_TOOL, executeMarkEmail } from './mark-email'
import { PACK_EMAILS_AND_SEND_TOOL, executePackEmailsAndSend } from './pack-emails-and-send'
import { uploadBinaryToDrive, downloadFileBase64 } from '@/lib/drive'
import { READ_SCAN_DRIVE_TOOL, executeReadScanFromDrive } from '@/lib/scan-ocr'
import type { AccountKey } from './config'
import type { SendEmailInput, AttachmentInput } from './types'

export { READ_EMAIL_TOOL, executeReadEmail } from './read-email'
export { GET_EMAIL_BODY_TOOL, executeGetEmailBody } from './get-email-body'
export { SEND_EMAIL_TOOL, executeSendEmail } from './send-email'
export { FORWARD_EMAIL_TOOL, executeForwardEmail } from './forward-email'
export { MARK_EMAIL_TOOL, executeMarkEmail } from './mark-email'
export { PACK_EMAILS_AND_SEND_TOOL, executePackEmailsAndSend } from './pack-emails-and-send'
export type { AccountKey, EmailAccountConfig } from './config'
export { EmailConfigError } from './config'
export type { SendEmailInput, SendEmailResult, AttachmentInput } from './types'
// Connection helpers.
export { openImap, closeImap, makeSmtp, fromHeader } from './connection'

/* ─────────────────────────────────────────────────────────────────────
 * Tool: save_email_attachments_to_drive
 *
 * Pattern server-side gemello di pack_emails_and_send: il LLM passa SOLO i
 * riferimenti della mail sorgente (account+uid+folder) e la cartella Drive di
 * destinazione. Il server fetcha gli allegati via IMAP (base64 lato server,
 * zero binari nel context del LLM) e li carica su Google Drive uno per uno.
 *
 * Risolve il limite per cui salvare allegati di una mail su Drive obbligava il
 * LLM a passare il contenuto base64 dentro drive_upload_binary — operazione che
 * su immagini/PDF reali (>100KB) satura il context e produce file segnaposto
 * vuoti.
 *
 * Definito inline qui (non in file separato) perché il tooling di PR del bot
 * modifica solo file già esistenti su main.
 * ───────────────────────────────────────────────────────────────────── */

export type SaveEmailAttachmentsInput = {
  account: AccountKey
  uid: number
  folder?: string
  dest_folder_id: string
  rename_base?: string
  filename_pattern?: string
  filename_exclude_pattern?: string
}

type AttachmentWithBase64 = {
  filename: string | null
  contentType: string
  size: number
  contentBase64: string
}

function _hasBase64(a: unknown): a is AttachmentWithBase64 {
  return typeof a === 'object' && a !== null && 'contentBase64' in (a as Record<string, unknown>)
}

function _compileRegex(pattern: string | undefined): RegExp | null {
  if (!pattern) return null
  try {
    return new RegExp(pattern, 'i')
  } catch {
    throw new Error(`Pattern regex non valido: ${pattern}`)
  }
}

/** Estrae l'estensione (con il punto) dal filename originale, '' se assente. */
function _extFromName(name: string | null): string {
  if (!name) return ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot) // include il punto
}

export type SavedAttachment = {
  filename: string
  size_bytes: number
  web_view_link: string
  file_id: string
}

export type SaveEmailAttachmentsResult = {
  dest_folder_id: string
  saved: SavedAttachment[]
  saved_count: number
  skipped_by_filter: number
}

export async function saveEmailAttachmentsToDrive(
  input: SaveEmailAttachmentsInput,
): Promise<SaveEmailAttachmentsResult> {
  if (!input.dest_folder_id) {
    throw new Error('dest_folder_id richiesto (ID cartella Drive di destinazione).')
  }

  const includeRx = _compileRegex(input.filename_pattern)
  const excludeRx = _compileRegex(input.filename_exclude_pattern)

  const body = await getEmailBody({
    account: input.account,
    uid: input.uid,
    folder: input.folder ?? 'INBOX',
    include_attachments: true,
  })

  // Filtra gli allegati con contenuto base64 effettivo + applica filtri filename
  let skippedByFilter = 0
  const usable: AttachmentWithBase64[] = []
  let idx = 0
  for (const att of body.attachments) {
    if (!_hasBase64(att) || !att.contentBase64) continue
    const name = att.filename ?? `allegato_uid${input.uid}_${idx}.bin`
    idx++
    if (includeRx && !includeRx.test(name)) {
      skippedByFilter++
      continue
    }
    if (excludeRx && excludeRx.test(name)) {
      skippedByFilter++
      continue
    }
    usable.push(att)
  }

  if (usable.length === 0) {
    throw new Error(
      skippedByFilter > 0
        ? `Nessun allegato matcha i filtri (scartati ${skippedByFilter}).`
        : 'Nessun allegato con contenuto trovato nella mail sorgente.',
    )
  }

  const saved: SavedAttachment[] = []
  let n = 0
  for (const att of usable) {
    n++
    const origName = att.filename ?? `allegato_uid${input.uid}_${n}.bin`
    let finalName: string
    if (input.rename_base) {
      const ext = _extFromName(origName)
      finalName = `${input.rename_base}-${n}${ext}`
    } else {
      finalName = origName
    }
    const buffer = Buffer.from(att.contentBase64, 'base64')
    const mimeType = att.contentType || 'application/octet-stream'
    const { id, webViewLink } = await uploadBinaryToDrive(
      buffer,
      finalName,
      mimeType,
      input.dest_folder_id,
    )
    saved.push({
      filename: finalName,
      size_bytes: buffer.length,
      web_view_link: webViewLink,
      file_id: id,
    })
  }

  return {
    dest_folder_id: input.dest_folder_id,
    saved,
    saved_count: saved.length,
    skipped_by_filter: skippedByFilter,
  }
}

export const SAVE_EMAIL_ATTACHMENTS_TOOL: Anthropic.Tool = {
  name: 'save_email_attachments_to_drive',
  description:
    "Salva su Google Drive gli allegati di UNA mail (per UID) di un account TopHost (info@restruktura.it o raffaele.lentini@restruktura.it). Pattern server-side: il LLM passa SOLO il riferimento della mail (account+uid+folder) e la cartella Drive di destinazione (dest_folder_id) — il server fetcha gli allegati via IMAP e li carica su Drive senza far transitare i binari base64 nel context. USA QUESTO al posto di get_email_body+drive_upload_binary quando l'utente chiede di salvare/archiviare gli allegati di una mail su Drive (allegati reali >100KB saturano il context se passati a mano). Rinomina opzionale con rename_base: 'polizza-2026' -> 'polizza-2026-1.jpg', 'polizza-2026-2.jpg' (estensione presa dall'originale). Filtri opzionali filename_pattern / filename_exclude_pattern (regex case-insensitive). La cartella destinazione deve essere autorizzata in scrittura (policy Drive), altrimenti il tool fallisce con un lucchetto. NON per Gmail restruktura.drive@gmail.com.",
  input_schema: {
    type: 'object',
    properties: {
      account: {
        type: 'string',
        enum: ['info', 'raffaele'],
        description: 'Account TopHost sorgente: info | raffaele',
      },
      uid: { type: 'integer', description: 'UID IMAP della mail sorgente' },
      folder: { type: 'string', description: 'Cartella IMAP sorgente, default INBOX' },
      dest_folder_id: {
        type: 'string',
        description: 'ID della cartella Google Drive di destinazione (deve essere autorizzata in scrittura)',
      },
      rename_base: {
        type: 'string',
        description:
          "OPZIONALE — base per rinominare gli allegati: 'polizza-2026' produce 'polizza-2026-1.<ext>', 'polizza-2026-2.<ext>', ... L'estensione è presa dal filename originale. Se omesso, conserva i nomi originali.",
      },
      filename_pattern: {
        type: 'string',
        description: 'OPZIONALE — regex case-insensitive: include SOLO allegati il cui filename matcha.',
      },
      filename_exclude_pattern: {
        type: 'string',
        description: 'OPZIONALE — regex case-insensitive: ESCLUDE allegati il cui filename matcha.',
      },
    },
    required: ['account', 'uid', 'dest_folder_id'],
  },
}

export async function executeSaveEmailAttachmentsToDrive(
  input: SaveEmailAttachmentsInput,
): Promise<string> {
  try {
    return JSON.stringify({ ok: true, ...(await saveEmailAttachmentsToDrive(input)) })
  } catch (e) {
    return JSON.stringify({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Tool: send_email_with_attachments
 *
 * Invia una mail (da account TopHost) componendo gli allegati server-side da
 * DUE fonti combinabili nello stesso messaggio:
 *   - drive_file_ids[]   → byte scaricati via downloadFileBase64 (lib/drive)
 *   - email_attachments[] → allegati estratti da mail sorgenti via getEmailBody
 *                           (filtro opzionale filename_pattern, regex i)
 *
 * I binari NON transitano nel context del modello: il LLM passa solo ID/UID.
 * L'invio passa per sendEmailInternal con la stessa policy di send_email:
 *   - destinatari esterni → status='pending' + uuid (conferma utente Telegram)
 *   - destinatari interni @restruktura.it + auto_send_if_internal=true → invio
 *     diretto, con copia in Sent del mittente.
 *
 * Definito inline qui per lo stesso motivo di save_email_attachments_to_drive.
 * ───────────────────────────────────────────────────────────────────── */

export type EmailAttachmentRef = {
  account: AccountKey
  uid: number
  folder?: string
  filename_pattern?: string
}

export type SendEmailWithAttachmentsInput = {
  from_account: AccountKey
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body_text: string
  body_html?: string
  drive_file_ids?: string[]
  email_attachments?: EmailAttachmentRef[]
  auto_send_if_internal?: boolean
}

export async function sendEmailWithAttachments(input: SendEmailWithAttachmentsInput) {
  if (!input.to || input.to.length === 0) throw new Error('Destinatario (to) richiesto.')
  if (!input.subject) throw new Error('subject richiesto.')
  if (!input.body_text) throw new Error('body_text richiesto.')

  const attachments: AttachmentInput[] = []
  const collected: { filename: string; size_bytes: number; source: string }[] = []

  // Fonte 1: file Drive (download byte server-side)
  for (const fileId of input.drive_file_ids ?? []) {
    if (!fileId) continue
    const { base64, mimeType, name } = await downloadFileBase64(fileId)
    attachments.push({ filename: name, content_base64: base64, contentType: mimeType })
    collected.push({ filename: name, size_bytes: Buffer.from(base64, 'base64').length, source: `drive:${fileId}` })
  }

  // Fonte 2: allegati estratti da mail sorgenti
  for (const ref of input.email_attachments ?? []) {
    const includeRx = _compileRegex(ref.filename_pattern)
    const body = await getEmailBody({
      account: ref.account,
      uid: ref.uid,
      folder: ref.folder ?? 'INBOX',
      include_attachments: true,
    })
    let idx = 0
    for (const att of body.attachments) {
      if (!_hasBase64(att) || !att.contentBase64) continue
      const name = att.filename ?? `allegato_uid${ref.uid}_${idx}.bin`
      idx++
      if (includeRx && !includeRx.test(name)) continue
      attachments.push({
        filename: name,
        content_base64: att.contentBase64,
        contentType: att.contentType || 'application/octet-stream',
      })
      collected.push({
        filename: name,
        size_bytes: Buffer.from(att.contentBase64, 'base64').length,
        source: `mail:${ref.account}/${ref.uid}`,
      })
    }
  }

  if (attachments.length === 0) {
    throw new Error('Nessun allegato raccolto: verifica drive_file_ids e email_attachments / filename_pattern.')
  }

  const sendInput: SendEmailInput = {
    from_account: input.from_account,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body_text: input.body_text,
    body_html: input.body_html,
    attachments,
    auto_send_if_internal: input.auto_send_if_internal,
  }

  const result = await sendEmailInternal(sendInput, { bypassUserConfirmation: false })
  return { ...result, attachments_built: collected, attachments_count: collected.length }
}

export const SEND_EMAIL_WITH_ATTACHMENTS_TOOL: Anthropic.Tool = {
  name: 'send_email_with_attachments',
  description:
    "Invia una mail da un account TopHost (info | raffaele) componendo gli ALLEGATI server-side da due fonti combinabili nello stesso messaggio: (1) drive_file_ids[] = file presi da Google Drive (passa solo gli ID, i byte sono scaricati lato server), (2) email_attachments[] = allegati estratti da altre mail (account+uid+folder, con filename_pattern opzionale per scegliere il PDF giusto in mail multi-allegato). USA QUESTO quando devi mandare in un'unica mail file che stanno parte su Drive e parte dentro altre mail, senza far transitare base64 nel context. Stessa policy di send_email: destinatari ESTERNI → status='pending'+uuid (conferma /invia_<uuid>); destinatari INTERNI @restruktura.it con auto_send_if_internal=true → invio diretto + copia in Sent. NON per Gmail restruktura.drive@gmail.com.",
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
      drive_file_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'ID dei file Google Drive da allegare (i byte sono scaricati server-side).',
      },
      email_attachments: {
        type: 'array',
        description: 'Allegati da estrarre da altre mail.',
        items: {
          type: 'object',
          properties: {
            account: { type: 'string', enum: ['info', 'raffaele'] },
            uid: { type: 'integer' },
            folder: { type: 'string', description: 'Default INBOX' },
            filename_pattern: {
              type: 'string',
              description: 'OPZIONALE — regex case-insensitive: estrae SOLO gli allegati il cui filename matcha.',
            },
          },
          required: ['account', 'uid'],
        },
      },
      auto_send_if_internal: {
        type: 'boolean',
        description: 'Se true e tutti i destinatari sono @restruktura.it, invia subito senza pending.',
      },
    },
    required: ['from_account', 'to', 'subject', 'body_text'],
  },
}

export async function executeSendEmailWithAttachments(
  input: SendEmailWithAttachmentsInput,
): Promise<string> {
  try {
    return JSON.stringify({ ok: true, ...(await sendEmailWithAttachments(input)) })
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

export const MAIL_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  READ_EMAIL_TOOL,
  GET_EMAIL_BODY_TOOL,
  SEND_EMAIL_TOOL,
  FORWARD_EMAIL_TOOL,
  MARK_EMAIL_TOOL,
  PACK_EMAILS_AND_SEND_TOOL,
  SAVE_EMAIL_ATTACHMENTS_TOOL,
  SEND_EMAIL_WITH_ATTACHMENTS_TOOL,
  READ_SCAN_DRIVE_TOOL,
]

export const MAIL_TOOL_EXECUTORS: Record<string, (input: unknown) => Promise<string>> = {
  read_email: (i) => executeReadEmail(i as Parameters<typeof executeReadEmail>[0]),
  get_email_body: (i) => executeGetEmailBody(i as Parameters<typeof executeGetEmailBody>[0]),
  send_email: (i) => executeSendEmail(i as Parameters<typeof executeSendEmail>[0]),
  forward_email: (i) => executeForwardEmail(i as Parameters<typeof executeForwardEmail>[0]),
  mark_email: (i) => executeMarkEmail(i as Parameters<typeof executeMarkEmail>[0]),
  pack_emails_and_send: (i) =>
    executePackEmailsAndSend(i as Parameters<typeof executePackEmailsAndSend>[0]),
  save_email_attachments_to_drive: (i) =>
    executeSaveEmailAttachmentsToDrive(i as SaveEmailAttachmentsInput),
  send_email_with_attachments: (i) =>
    executeSendEmailWithAttachments(i as SendEmailWithAttachmentsInput),
  leggi_scansione_drive: (i) =>
    executeReadScanFromDrive(i as { file_id: string; prompt?: string }),
}

/** Sub-agent allow-list (mail-router): solo read/get/mark.
 *  send_email + forward_email sono SOLO del parent orchestrator
 *  (policy conferma utente vive nel parent). */
export const MAIL_ROUTER_ALLOWED_TOOLS = ['read_email', 'get_email_body', 'mark_email'] as const
