// src/v19/tools/email/audit.ts
/**
 * Cervellone V19 — Audit logger per operazioni mail.
 * Insert-only su cervellone_email_log. Failure non blocca il flow utente
 * (audit best-effort).
 *
 * Mai loggare body completo o password — solo metadata + snippet redatti.
 */
import { supabase } from '@/lib/supabase'
import type { AccountKey } from './config'

export type EmailAuditAction =
  | 'read'
  | 'send'
  | 'forward'
  | 'mark'
  | 'append_sent'
  | 'pending_created'
  | 'pending_confirmed'
  | 'pending_cancelled'

export type EmailAuditEntry = {
  account: AccountKey
  action: EmailAuditAction
  direction?: 'in' | 'out'
  message_id?: string | null
  subject?: string | null
  from_addr?: string | null
  to_addrs?: string[] | null
  cc_addrs?: string[] | null
  bcc_addrs?: string[] | null
  attachments_count?: number
  attachments_summary?: Array<{ filename: string | null; size: number; contentType: string }>
  status?: 'ok' | 'error'
  error?: string | null
  request_id?: string | null
  routine_name?: string | null
  raw_meta?: Record<string, unknown> | null
  /** SMTP send ok ma IMAP append-to-Sent fallito. La mail è inviata ma non visibile in Sent. */
  append_failed?: boolean
}

export async function logEmail(entry: EmailAuditEntry): Promise<void> {
  const { error } = await supabase.from('cervellone_email_log').insert({
    account: entry.account,
    action: entry.action,
    direction: entry.direction ?? null,
    message_id: entry.message_id ?? null,
    subject: entry.subject ?? null,
    from_addr: entry.from_addr ?? null,
    to_addrs: entry.to_addrs ?? null,
    cc_addrs: entry.cc_addrs ?? null,
    bcc_addrs: entry.bcc_addrs ?? null,
    attachments_count: entry.attachments_count ?? 0,
    attachments_summary: entry.attachments_summary ?? null,
    status: entry.status ?? 'ok',
    error: entry.error ?? null,
    request_id: entry.request_id ?? null,
    routine_name: entry.routine_name ?? null,
    raw_meta: entry.raw_meta ?? null,
  })
  if (error) console.error('[email/audit] insert failed:', error.message)
  // NON throw: audit failure non deve rompere il flow utente
}
