// src/v19/tools/email/index.ts
/**
 * Cervellone V19 — Barrel del modulo mail.
 * Esporta tool definitions + executor map per la registrazione nell'orchestrator.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { READ_EMAIL_TOOL, executeReadEmail } from './read-email'
import { GET_EMAIL_BODY_TOOL, executeGetEmailBody } from './get-email-body'
import { SEND_EMAIL_TOOL, executeSendEmail } from './send-email'
import { FORWARD_EMAIL_TOOL, executeForwardEmail } from './forward-email'
import { MARK_EMAIL_TOOL, executeMarkEmail } from './mark-email'
import { PACK_EMAILS_AND_SEND_TOOL, executePackEmailsAndSend } from './pack-emails-and-send'

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

export const MAIL_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  READ_EMAIL_TOOL,
  GET_EMAIL_BODY_TOOL,
  SEND_EMAIL_TOOL,
  FORWARD_EMAIL_TOOL,
  MARK_EMAIL_TOOL,
  PACK_EMAILS_AND_SEND_TOOL,
]

export const MAIL_TOOL_EXECUTORS: Record<string, (input: unknown) => Promise<string>> = {
  read_email: (i) => executeReadEmail(i as Parameters<typeof executeReadEmail>[0]),
  get_email_body: (i) => executeGetEmailBody(i as Parameters<typeof executeGetEmailBody>[0]),
  send_email: (i) => executeSendEmail(i as Parameters<typeof executeSendEmail>[0]),
  forward_email: (i) => executeForwardEmail(i as Parameters<typeof executeForwardEmail>[0]),
  mark_email: (i) => executeMarkEmail(i as Parameters<typeof executeMarkEmail>[0]),
  pack_emails_and_send: (i) =>
    executePackEmailsAndSend(i as Parameters<typeof executePackEmailsAndSend>[0]),
}

/** Sub-agent allow-list (mail-router): solo read/get/mark.
 *  send_email + forward_email sono SOLO del parent orchestrator
 *  (policy conferma utente vive nel parent). */
export const MAIL_ROUTER_ALLOWED_TOOLS = ['read_email', 'get_email_body', 'mark_email'] as const
