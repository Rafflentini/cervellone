// src/v19/tools/email/types.ts
/**
 * Cervellone V19 — Shared types per il modulo mail.
 * Esposti qui per evitare cicli send-email <-> pending.
 */
import type { AccountKey } from './config'

export type AttachmentInput = {
  filename: string
  content_base64: string
  contentType?: string
}

export type SendEmailInput = {
  from_account: AccountKey
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body_text: string
  body_html?: string
  attachments?: AttachmentInput[]
  in_reply_to?: { uid: number; folder: string; message_id?: string }
  /** Se tutti i destinatari sono @restruktura.it, salta la conferma utente. */
  auto_send_if_internal?: boolean
  /** Interno (non esposto al modello): bypassa la policy di conferma utente.
   *  Usato dal flow di conferma Telegram dopo che l'utente ha digitato /invia_<uuid>. */
  bypass_user_confirmation?: boolean
  routine_name?: string
  request_id?: string
}

export type SendEmailResult =
  | {
      status: 'sent'
      message_id: string
      sent_folder: string
      sent_uid: number | null
      append_failed?: boolean
      warning?: string
    }
  | { status: 'pending'; uuid: string; reason: string }
