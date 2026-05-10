// src/v19/tools/email/pending.ts
/**
 * Cervellone V19 — Pending send store.
 * Tabella cervellone_email_pending_send: salva draft outbound verso destinatari
 * esterni in attesa di conferma utente via Telegram (/invia_<uuid> | /annulla_<uuid>).
 * TTL 30 minuti (default DB).
 */
import { supabase } from '@/lib/supabase'
import type { SendEmailInput, AttachmentInput } from './types'

export type PendingRow = {
  uuid: string
  created_at: string
  expires_at: string
  from_account: string
  to_addrs: string[]
  cc_addrs: string[] | null
  bcc_addrs: string[] | null
  subject: string
  body_text: string
  body_html: string | null
  attachments: AttachmentInput[] | null
  in_reply_to: SendEmailInput['in_reply_to'] | null
  status: 'pending' | 'sent' | 'cancelled' | 'expired'
  sent_message_id: string | null
  sent_at: string | null
}

export async function createPendingSend(
  input: SendEmailInput,
): Promise<{ uuid: string; expires_at: string }> {
  const row = {
    from_account: input.from_account,
    to_addrs: input.to,
    cc_addrs: input.cc ?? null,
    bcc_addrs: input.bcc ?? null,
    subject: input.subject,
    body_text: input.body_text,
    body_html: input.body_html ?? null,
    attachments: input.attachments ?? null,
    in_reply_to: input.in_reply_to ?? null,
    status: 'pending',
  }
  const { data, error } = await supabase
    .from('cervellone_email_pending_send')
    .insert(row)
    .select('uuid, expires_at')
    .single()
  if (error || !data) throw new Error(`pending insert: ${error?.message ?? 'no data'}`)
  return { uuid: data.uuid, expires_at: data.expires_at }
}

export async function fetchPending(uuid: string): Promise<PendingRow | null> {
  const { data, error } = await supabase
    .from('cervellone_email_pending_send')
    .select('*')
    .eq('uuid', uuid)
    .maybeSingle()
  if (error || !data) return null
  if (data.status !== 'pending') return null
  if (new Date(data.expires_at).getTime() < Date.now()) return null
  return data as PendingRow
}

export async function markPendingSent(uuid: string, messageId: string): Promise<void> {
  await supabase
    .from('cervellone_email_pending_send')
    .update({ status: 'sent', sent_message_id: messageId, sent_at: new Date().toISOString() })
    .eq('uuid', uuid)
}

export async function markPendingCancelled(uuid: string): Promise<void> {
  await supabase.from('cervellone_email_pending_send').update({ status: 'cancelled' }).eq('uuid', uuid)
}

export async function expirePending(): Promise<number> {
  const { data } = await supabase
    .from('cervellone_email_pending_send')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lt('expires_at', new Date().toISOString())
    .select('uuid')
  return (data ?? []).length
}
