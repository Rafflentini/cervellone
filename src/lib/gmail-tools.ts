/**
 * lib/gmail-tools.ts — Integrazione Gmail R+W per Cervellone.
 *
 * Riusa OAuth Google già autenticato (refresh_token in google_oauth_credentials).
 * Scope richiesti: gmail.modify + gmail.send (devono essere autorizzati nel
 * consent flow utente).
 *
 * Spec: docs/superpowers/specs/2026-05-05-cervellone-gmail-rw-design.md
 */

import { google } from 'googleapis'
import { supabase } from './supabase'

// ── Types ──

export interface GmailMessageMeta {
  id: string
  threadId: string
  from: string
  to: string
  subject: string
  snippet: string
  date: string
  labelIds: string[]
  hasAttachments: boolean
}

export interface GmailMessage extends GmailMessageMeta {
  bodyText: string
  bodyHtml: string
  headers: Record<string, string>
  attachments: GmailAttachmentMeta[]
}

export interface GmailAttachmentMeta {
  attachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface GmailDraftMeta {
  draftId: string
  messageId: string
  to: string
  subject: string
  snippet: string
  threadId?: string
}

export interface SendDraftResult {
  messageId: string
  threadId: string
}

// ── Auth (riusa pattern di drive.ts) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getGmailAuth(): Promise<any> {
  const { getAuthorizedClient } = await import('./google-oauth')
  const oauthClient = await getAuthorizedClient()
  if (!oauthClient) {
    throw new Error('OAuth Gmail non autenticato. L\'Ingegnere deve completare il consent flow su /api/auth/google con scope gmail.modify + gmail.send.')
  }
  return oauthClient
}

async function getGmailClient() {
  return google.gmail({ version: 'v1', auth: await getGmailAuth() })
}

// ── Anti-loop helpers ──

export async function isThreadInBotLoop(threadId: string): Promise<boolean> {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('gmail_processed_messages')
    .select('message_id')
    .eq('thread_id', threadId)
    .eq('bot_action', 'sent_reply')
    .gte('ts', since)
    .limit(1)
  return Array.isArray(data) && data.length > 0
}

export async function recordBotAction(
  messageId: string,
  threadId: string,
  action: string,
  fromAddress?: string,
  subject?: string,
): Promise<void> {
  await supabase
    .from('gmail_processed_messages')
    .upsert({
      message_id: messageId,
      thread_id: threadId,
      from_address: fromAddress || null,
      subject: subject?.slice(0, 500) || null,
      bot_action: action,
    })
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) console.error('[GMAIL] recordBotAction failed:', error.message)
    })
}
