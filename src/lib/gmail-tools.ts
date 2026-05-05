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

// ── Parser helpers ──

interface RawMessage {
  id?: string | null
  threadId?: string | null
  snippet?: string | null
  labelIds?: string[] | null
  internalDate?: string | null
  payload?: RawPayload | null
}

interface RawPayload {
  headers?: { name?: string | null; value?: string | null }[] | null
  parts?: RawPayload[] | null
  body?: { data?: string | null; size?: number | null; attachmentId?: string | null } | null
  filename?: string | null
  mimeType?: string | null
}

function getHeader(headers: RawPayload['headers'], name: string): string {
  if (!headers) return ''
  const h = headers.find(x => x.name?.toLowerCase() === name.toLowerCase())
  return h?.value || ''
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

function extractBody(payload: RawPayload | null | undefined): { text: string; html: string } {
  if (!payload) return { text: '', html: '' }
  let text = ''
  let html = ''
  function walk(p: RawPayload) {
    if (p.mimeType === 'text/plain' && p.body?.data) text += decodeBase64Url(p.body.data) + '\n'
    if (p.mimeType === 'text/html' && p.body?.data) html += decodeBase64Url(p.body.data) + '\n'
    if (p.parts) for (const part of p.parts) walk(part)
  }
  walk(payload)
  return { text: text.trim(), html: html.trim() }
}

function extractAttachments(payload: RawPayload | null | undefined): GmailAttachmentMeta[] {
  const result: GmailAttachmentMeta[] = []
  if (!payload) return result
  function walk(p: RawPayload) {
    if (p.body?.attachmentId && p.filename) {
      result.push({
        attachmentId: p.body.attachmentId,
        filename: p.filename,
        mimeType: p.mimeType || 'application/octet-stream',
        sizeBytes: p.body.size || 0,
      })
    }
    if (p.parts) for (const part of p.parts) walk(part)
  }
  walk(payload)
  return result
}

function rawToMeta(raw: RawMessage): GmailMessageMeta {
  const headers = raw.payload?.headers
  const labels = raw.labelIds || []
  return {
    id: raw.id || '',
    threadId: raw.threadId || '',
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    subject: getHeader(headers, 'Subject'),
    snippet: raw.snippet || '',
    date: getHeader(headers, 'Date') || (raw.internalDate ? new Date(parseInt(raw.internalDate, 10)).toISOString() : ''),
    labelIds: labels,
    hasAttachments: extractAttachments(raw.payload).length > 0,
  }
}

function rawToFull(raw: RawMessage): GmailMessage {
  const meta = rawToMeta(raw)
  const body = extractBody(raw.payload)
  const headers: Record<string, string> = {}
  if (raw.payload?.headers) {
    for (const h of raw.payload.headers) {
      if (h.name) headers[h.name] = h.value || ''
    }
  }
  return {
    ...meta,
    bodyText: body.text,
    bodyHtml: body.html,
    headers,
    attachments: extractAttachments(raw.payload),
  }
}

// ── Read tools ──

export async function listInbox(opts?: {
  maxResults?: number
  onlyUnread?: boolean
  sinceDays?: number
}): Promise<GmailMessageMeta[]> {
  const gmail = await getGmailClient()
  const max = Math.min(opts?.maxResults || 20, 100)
  const queryParts: string[] = ['in:inbox']
  if (opts?.onlyUnread) queryParts.push('is:unread')
  if (opts?.sinceDays && opts.sinceDays > 0) queryParts.push(`newer_than:${opts.sinceDays}d`)
  const q = queryParts.join(' ')

  console.log(`[GMAIL] listInbox q="${q}" max=${max}`)
  const list = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: max,
  })
  const ids = list.data.messages || []
  if (ids.length === 0) return []

  const results: GmailMessageMeta[] = []
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10)
    const fetched = await Promise.all(
      batch.map(m =>
        gmail.users.messages.get({
          userId: 'me',
          id: m.id || '',
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        }).then(r => rawToMeta(r.data as RawMessage)).catch(err => {
          console.error(`[GMAIL] fetch meta ${m.id} failed:`, err.message)
          return null
        })
      )
    )
    results.push(...fetched.filter((x): x is GmailMessageMeta => x !== null))
  }
  return results
}

export async function searchGmail(query: string, maxResults = 20): Promise<GmailMessageMeta[]> {
  const gmail = await getGmailClient()
  const max = Math.min(maxResults, 100)
  console.log(`[GMAIL] search q="${query}" max=${max}`)
  const list = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: max,
  })
  const ids = list.data.messages || []
  if (ids.length === 0) return []

  const results: GmailMessageMeta[] = []
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10)
    const fetched = await Promise.all(
      batch.map(m =>
        gmail.users.messages.get({
          userId: 'me',
          id: m.id || '',
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date'],
        }).then(r => rawToMeta(r.data as RawMessage)).catch(() => null)
      )
    )
    results.push(...fetched.filter((x): x is GmailMessageMeta => x !== null))
  }
  return results
}

export async function readMessage(messageId: string): Promise<GmailMessage> {
  const gmail = await getGmailClient()
  console.log(`[GMAIL] readMessage id=${messageId}`)
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  })
  return rawToFull(res.data as RawMessage)
}

export async function readThread(threadId: string): Promise<GmailMessage[]> {
  const gmail = await getGmailClient()
  console.log(`[GMAIL] readThread id=${threadId}`)
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'full',
  })
  const msgs = res.data.messages || []
  return msgs.map(m => rawToFull(m as RawMessage))
}
