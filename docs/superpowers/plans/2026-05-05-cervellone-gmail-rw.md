# Cervellone Gmail R+W — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrare Gmail (`restruktura.drive@gmail.com`) bidirezionalmente: lettura inbox + ricerca + bozze + invio con human-in-loop, gestione label/archive/mark-read, daily morning summary + critical alerts via Telegram. Hard-block delete/forward/modify-filters/signature/bulk.

**Architecture:** Riusa OAuth Google Drive già attivo, aggiunge scope `gmail.modify` + `gmail.send`. 20 tool registrati nel registry esistente. 2 nuove tabelle Supabase (`gmail_alert_rules` con seed iniziale + `gmail_processed_messages` per anti-loop). 2 cron Vercel (morning summary + alerts ogni 30 min orario lavorativo). Pattern: Cervellone propone bozze, l'Ingegnere conferma esplicitamente con `/conferma` prima di ogni invio.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase, Anthropic SDK 0.80, googleapis SDK (Gmail v1), Vercel cron, vitest per unit test.

**Spec di riferimento:** `docs/superpowers/specs/2026-05-05-cervellone-gmail-rw-design.md`

---

## File Structure

| File | Tipo | Responsabilità |
|---|---|---|
| `supabase/migrations/2026-05-05-gmail-rw.sql` | Create | Schema gmail_alert_rules + gmail_processed_messages + config keys |
| `src/lib/gmail-tools.ts` | Create | Wrapper Gmail API: 20 funzioni read/draft/send/manage + anti-loop |
| `src/lib/gmail-summary.ts` | Create | Logica digest mattutino + critical alert detection |
| `src/lib/gmail-tools.test.ts` | Create | Unit test vitest (parser headers, anti-loop logic, classifier) |
| `src/app/api/cron/gmail-morning/route.ts` | Create | Vercel cron 8:00 lun-ven — daily summary |
| `src/app/api/cron/gmail-alerts/route.ts` | Create | Vercel cron ogni 30 min 9-18 lun-ven — critical alerts |
| `src/lib/google-oauth.ts` | Modify | Aggiungere scope `gmail.modify` + `gmail.send` |
| `src/lib/tools.ts` | Modify | Register GMAIL_TOOLS (~20) |
| `src/lib/prompts.ts` | Modify | Aggiungere REGOLA TOOL GMAIL |
| `vercel.json` | Modify | Aggiungere 2 cron schedules |

---

## Task 1: Migration SQL

**Files:**
- Create: `supabase/migrations/2026-05-05-gmail-rw.sql`

- [ ] **Step 1: Creare il file migration**

Contenuto esatto:

```sql
-- Gmail R+W (Fase 2 sostituzione personale) — schema alert_rules + processed_messages

-- 1. Regole per critical alert push immediato (keyword o mittente VIP)
CREATE TABLE IF NOT EXISTS gmail_alert_rules (
  id BIGSERIAL PRIMARY KEY,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('keyword', 'sender_vip')),
  pattern TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'high' CHECK (severity IN ('high', 'medium', 'low')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_gmail_alert_rules_enabled
  ON gmail_alert_rules (enabled, rule_type);
ALTER TABLE gmail_alert_rules DISABLE ROW LEVEL SECURITY;
COMMENT ON TABLE gmail_alert_rules IS 'Regole keyword + sender VIP per critical alert push immediato.';

-- Seed iniziale 7 keyword + 2 pattern VIP (rivedere dopo deploy)
INSERT INTO gmail_alert_rules (rule_type, pattern, severity, notes) VALUES
  ('keyword', 'urgente', 'high', 'Parola chiave esplicita di urgenza'),
  ('keyword', 'scadenza', 'high', 'Scadenze fiscali o burocratiche'),
  ('keyword', 'pignoramento', 'high', 'Atti giudiziari'),
  ('keyword', 'DURC', 'medium', 'Documenti regolarità contributiva'),
  ('keyword', 'INPS', 'medium', 'Comunicazioni INPS'),
  ('keyword', 'INAIL', 'medium', 'Comunicazioni INAIL'),
  ('keyword', 'fattura', 'low', 'Fatture in arrivo'),
  ('sender_vip', 'noreply@pec.', 'high', 'PEC sempre rilevante'),
  ('sender_vip', 'cassaedile', 'high', 'Cassa Edile')
ON CONFLICT DO NOTHING;

-- 2. Track mail già processate dal bot (anti-loop + idempotenza summary/alert)
CREATE TABLE IF NOT EXISTS gmail_processed_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_address TEXT,
  subject TEXT,
  bot_action TEXT NOT NULL CHECK (bot_action IN (
    'notified_critical','in_summary','draft_created','sent_reply',
    'labeled','archived','trashed','marked_read'
  )),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gmail_processed_thread
  ON gmail_processed_messages (thread_id, ts DESC);
ALTER TABLE gmail_processed_messages DISABLE ROW LEVEL SECURITY;
COMMENT ON TABLE gmail_processed_messages IS 'Track mail viste/processate per anti-loop e idempotenza.';

-- 3. Config keys (cron timestamp + silent mode)
INSERT INTO cervellone_config (key, value) VALUES
  ('gmail_summary_last_run', 'null'),
  ('gmail_alert_check_last_run', 'null'),
  ('gmail_silent_until', 'null')
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: User action — applicare migration manualmente**

L'utente deve aprire https://supabase.com/dashboard/project/vpmcqzaqiozpanaekxgj/sql ed eseguire il blocco SQL del file appena creato.

- [ ] **Step 3: Verifica via SQL**

```sql
SELECT count(*) FROM gmail_alert_rules; -- atteso: 9
SELECT count(*) FROM gmail_processed_messages; -- atteso: 0
SELECT key FROM cervellone_config WHERE key LIKE 'gmail_%'; -- atteso: 3
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-05-gmail-rw.sql
git commit -m "feat(gmail): migration alert_rules + processed_messages + config keys"
```

---

## Task 2: Aggiungere scope Gmail in OAuth

**Files:**
- Modify: `src/lib/google-oauth.ts` (aggiungi 2 scope all'array)

- [ ] **Step 1: Leggere il file corrente**

Identificare la costante che definisce gli scope OAuth (probabilmente un array `GOOGLE_OAUTH_SCOPES` o passato a `buildConsentUrl`).

- [ ] **Step 2: Aggiungere i 2 nuovi scope**

Trovare l'array degli scope (es. `['drive', 'spreadsheets', 'openid', 'email', 'profile']` con prefisso `https://www.googleapis.com/auth/`) e aggiungere:

```typescript
'https://www.googleapis.com/auth/gmail.modify',
'https://www.googleapis.com/auth/gmail.send',
```

- [ ] **Step 3: User action — re-autorizzare consent flow**

L'utente apre https://cervellone-5poc.vercel.app/api/auth/google da browser autenticato e conferma il consent screen Google con i nuovi scope.

- [ ] **Step 4: Commit**

```bash
git add src/lib/google-oauth.ts
git commit -m "feat(gmail): aggiunti scope OAuth gmail.modify + gmail.send"
```

---

## Task 3: Skeleton gmail-tools.ts con types

**Files:**
- Create: `src/lib/gmail-tools.ts`

- [ ] **Step 1: Creare file con types e helper auth**

```typescript
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
    .then(({ error }) => {
      if (error) console.error('[GMAIL] recordBotAction failed:', error.message)
    })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/gmail-tools.ts
git commit -m "feat(gmail): skeleton types + auth + anti-loop helpers"
```

---

## Task 4: Read tools (listInbox, searchGmail, readMessage, readThread)

**Files:**
- Modify: `src/lib/gmail-tools.ts`

- [ ] **Step 1: Aggiungere helper di parsing message**

Append a gmail-tools.ts:

```typescript
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
```

- [ ] **Step 2: Implementare listInbox**

```typescript
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

  // Fetch metadata for ognuno (parallel, max 10 simultanei)
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
```

- [ ] **Step 3: Implementare searchGmail**

```typescript
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
```

- [ ] **Step 4: Implementare readMessage e readThread**

```typescript
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
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/gmail-tools.ts
git commit -m "feat(gmail): read tools — listInbox, searchGmail, readMessage, readThread"
```

---

## Task 5: Draft tools (createDraft, listDrafts, showDraft, deleteDraft)

**Files:**
- Modify: `src/lib/gmail-tools.ts`

- [ ] **Step 1: Implementare createDraft**

Append:

```typescript
// ── Draft tools ──

function buildRfc822(opts: {
  to: string
  subject: string
  body: string
  fromName?: string
  fromEmail?: string
  inReplyTo?: string
  references?: string
}): string {
  const lines: string[] = []
  if (opts.fromName && opts.fromEmail) lines.push(`From: "${opts.fromName}" <${opts.fromEmail}>`)
  lines.push(`To: ${opts.to}`)
  lines.push(`Subject: ${opts.subject}`)
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${opts.inReplyTo}`)
  if (opts.references) lines.push(`References: ${opts.references}`)
  lines.push('Content-Type: text/plain; charset="UTF-8"')
  lines.push('MIME-Version: 1.0')
  lines.push('')
  lines.push(opts.body)
  return lines.join('\r\n')
}

function rfc822ToBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf-8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export async function createDraft(opts: {
  to: string
  subject: string
  body: string
  inReplyTo?: string
  threadId?: string
}): Promise<{ draftId: string; messageId: string }> {
  if (!opts.to.includes('@')) throw new Error(`Indirizzo destinatario non valido: ${opts.to}`)
  const gmail = await getGmailClient()
  const rfc822 = buildRfc822({
    to: opts.to,
    subject: opts.subject,
    body: opts.body,
    inReplyTo: opts.inReplyTo,
  })
  const raw = rfc822ToBase64Url(rfc822)
  console.log(`[GMAIL] createDraft to=${opts.to.slice(0, 40)} subj=${opts.subject.slice(0, 40)}`)

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: {
        raw,
        threadId: opts.threadId,
      },
    },
  })
  const draftId = res.data.id || ''
  const messageId = res.data.message?.id || ''
  if (!draftId) throw new Error('Gmail draft creation failed: nessun draftId restituito')
  return { draftId, messageId }
}
```

- [ ] **Step 2: Implementare listDrafts e showDraft**

```typescript
export async function listDrafts(maxResults = 10): Promise<GmailDraftMeta[]> {
  const gmail = await getGmailClient()
  const list = await gmail.users.drafts.list({
    userId: 'me',
    maxResults: Math.min(maxResults, 50),
  })
  const drafts = list.data.drafts || []
  if (drafts.length === 0) return []

  const results: GmailDraftMeta[] = []
  for (const d of drafts) {
    if (!d.id || !d.message?.id) continue
    try {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: d.message.id,
        format: 'metadata',
        metadataHeaders: ['To', 'Subject'],
      })
      const meta = rawToMeta(msg.data as RawMessage)
      results.push({
        draftId: d.id,
        messageId: d.message.id,
        to: meta.to,
        subject: meta.subject,
        snippet: meta.snippet,
        threadId: meta.threadId,
      })
    } catch (err) {
      console.error(`[GMAIL] listDrafts fetch ${d.id} failed:`, err)
    }
  }
  return results
}

export async function showDraft(draftId: string): Promise<GmailMessage> {
  const gmail = await getGmailClient()
  const res = await gmail.users.drafts.get({
    userId: 'me',
    id: draftId,
    format: 'full',
  })
  if (!res.data.message) throw new Error(`Draft ${draftId} non trovato`)
  return rawToFull(res.data.message as RawMessage)
}

export async function deleteDraft(draftId: string): Promise<void> {
  const gmail = await getGmailClient()
  await gmail.users.drafts.delete({ userId: 'me', id: draftId })
  console.log(`[GMAIL] deleteDraft id=${draftId}`)
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/gmail-tools.ts
git commit -m "feat(gmail): draft tools — create, list, show, delete"
```

---

## Task 6: Send tool con anti-loop protection

**Files:**
- Modify: `src/lib/gmail-tools.ts`

- [ ] **Step 1: Implementare sendDraft con check anti-loop**

```typescript
// ── Send tool ──

const NOREPLY_REGEX = /(?:^|<)(?:noreply|no-reply|donotreply|do-not-reply|notification|notifications)@/i

export async function sendDraft(draftId: string): Promise<SendDraftResult> {
  const gmail = await getGmailClient()
  // 1. Read draft to get target thread + recipient
  const draft = await showDraft(draftId)

  // 2. Anti-loop: thread cooldown
  if (draft.threadId) {
    if (await isThreadInBotLoop(draft.threadId)) {
      throw new Error('Anti-loop: bot ha già inviato 1+ risposta in questo thread negli ultimi 30 min. Verifica manualmente prima di re-inviare.')
    }
  }

  // 3. Anti-loop: skip noreply / auto-reply
  // Read most recent message in thread (last incoming)
  if (draft.threadId) {
    const thread = await readThread(draft.threadId).catch(() => [])
    const incoming = thread.filter(m => m.from && !/me$/i.test(m.from))
    const last = incoming[incoming.length - 1]
    if (last) {
      if (NOREPLY_REGEX.test(last.from)) {
        throw new Error(`Anti-loop: thread contiene messaggio da noreply (${last.from.slice(0, 50)}). Bot non risponde.`)
      }
      if ((last.headers['Auto-Submitted'] || '').toLowerCase().startsWith('auto-')) {
        throw new Error('Anti-loop: thread contiene Auto-Submitted reply. Bot non risponde.')
      }
    }
  }

  // 4. Effettiva send
  console.log(`[GMAIL] sendDraft id=${draftId}`)
  const res = await gmail.users.drafts.send({
    userId: 'me',
    requestBody: { id: draftId },
  })
  const messageId = res.data.id || ''
  const threadId = res.data.threadId || ''

  // 5. Record bot action per anti-loop futuro
  await recordBotAction(messageId, threadId, 'sent_reply', undefined, draft.subject)

  return { messageId, threadId }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/gmail-tools.ts
git commit -m "feat(gmail): sendDraft con anti-loop protection (thread cooldown + noreply skip)"
```

---

## Task 7: Management tools (labels, archive, mark read, trash)

**Files:**
- Modify: `src/lib/gmail-tools.ts`

- [ ] **Step 1: Implementare label tools**

```typescript
// ── Management tools ──

interface LabelInfo {
  id: string
  name: string
}

export async function listLabels(): Promise<LabelInfo[]> {
  const gmail = await getGmailClient()
  const res = await gmail.users.labels.list({ userId: 'me' })
  return (res.data.labels || []).map(l => ({
    id: l.id || '',
    name: l.name || '',
  })).filter(l => l.id && l.name)
}

async function ensureLabelId(labelName: string): Promise<string> {
  const labels = await listLabels()
  const existing = labels.find(l => l.name === labelName)
  if (existing) return existing.id
  const gmail = await getGmailClient()
  const res = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  })
  return res.data.id || ''
}

export async function applyLabel(messageId: string, labelName: string): Promise<void> {
  const labelId = await ensureLabelId(labelName)
  if (!labelId) throw new Error(`Label "${labelName}" non creabile`)
  const gmail = await getGmailClient()
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  })
  await recordBotAction(messageId, '', 'labeled')
  console.log(`[GMAIL] applyLabel msg=${messageId} label=${labelName}`)
}

export async function removeLabel(messageId: string, labelName: string): Promise<void> {
  const labels = await listLabels()
  const label = labels.find(l => l.name === labelName)
  if (!label) return  // niente da rimuovere
  const gmail = await getGmailClient()
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: [label.id] },
  })
  console.log(`[GMAIL] removeLabel msg=${messageId} label=${labelName}`)
}
```

- [ ] **Step 2: Implementare markRead/Unread, archive, trash**

```typescript
export async function markAsRead(messageId: string): Promise<void> {
  const gmail = await getGmailClient()
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  })
  await recordBotAction(messageId, '', 'marked_read')
}

export async function markAsUnread(messageId: string): Promise<void> {
  const gmail = await getGmailClient()
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: ['UNREAD'] },
  })
}

export async function archive(messageId: string): Promise<void> {
  const gmail = await getGmailClient()
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['INBOX'] },
  })
  await recordBotAction(messageId, '', 'archived')
  console.log(`[GMAIL] archive msg=${messageId}`)
}

export async function trash(messageId: string): Promise<void> {
  const gmail = await getGmailClient()
  await gmail.users.messages.trash({
    userId: 'me',
    id: messageId,
  })
  await recordBotAction(messageId, '', 'trashed')
  console.log(`[GMAIL] trash msg=${messageId}`)
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/gmail-tools.ts
git commit -m "feat(gmail): management tools — labels, archive, mark read, trash"
```

---

## Task 8: gmail-summary.ts — daily digest + critical detect

**Files:**
- Create: `src/lib/gmail-summary.ts`

- [ ] **Step 1: Creare il file**

```typescript
/**
 * lib/gmail-summary.ts — Digest mattutino + detection critical alert.
 */

import { supabase } from './supabase'
import { listInbox, type GmailMessageMeta } from './gmail-tools'

export interface MailSummary {
  totalUnread: number
  byCategory: Record<string, number>
  critical: GmailMessageMeta[]
  routine: GmailMessageMeta[]
  digest: string
}

interface AlertRule {
  rule_type: 'keyword' | 'sender_vip'
  pattern: string
  severity: 'high' | 'medium' | 'low'
}

async function loadAlertRules(): Promise<AlertRule[]> {
  const { data } = await supabase
    .from('gmail_alert_rules')
    .select('rule_type, pattern, severity')
    .eq('enabled', true)
  return (data || []) as AlertRule[]
}

function matchesAlert(msg: GmailMessageMeta, rules: AlertRule[]): { matched: boolean; severity: string; reason: string } {
  for (const r of rules) {
    if (r.rule_type === 'keyword') {
      const haystack = `${msg.subject} ${msg.snippet}`.toLowerCase()
      if (haystack.includes(r.pattern.toLowerCase())) {
        return { matched: true, severity: r.severity, reason: `keyword: ${r.pattern}` }
      }
    } else if (r.rule_type === 'sender_vip') {
      if (msg.from.toLowerCase().includes(r.pattern.toLowerCase())) {
        return { matched: true, severity: r.severity, reason: `VIP sender: ${r.pattern}` }
      }
    }
  }
  return { matched: false, severity: 'low', reason: '' }
}

export async function buildDailySummary(sinceDays = 1): Promise<MailSummary> {
  const messages = await listInbox({ onlyUnread: true, sinceDays, maxResults: 100 })
  const rules = await loadAlertRules()

  const critical: GmailMessageMeta[] = []
  const routine: GmailMessageMeta[] = []
  const byCategory: Record<string, number> = {}

  for (const m of messages) {
    const match = matchesAlert(m, rules)
    if (match.matched && match.severity === 'high') {
      critical.push(m)
    } else {
      routine.push(m)
    }

    // Categorize naively da subject/from
    const cat = naiveCategory(m)
    byCategory[cat] = (byCategory[cat] || 0) + 1
  }

  const digest = formatDigest(messages.length, byCategory, critical, routine)
  return {
    totalUnread: messages.length,
    byCategory,
    critical,
    routine,
    digest,
  }
}

function naiveCategory(m: GmailMessageMeta): string {
  const fromLow = m.from.toLowerCase()
  const subjLow = m.subject.toLowerCase()
  if (/cassaedile|inps|inail|comune|regione|agenzia/i.test(fromLow)) return 'enti'
  if (/fattura|ddt|listino|preventivo/i.test(subjLow)) return 'fornitori'
  if (/cliente|sopralluogo|capitolato/i.test(subjLow)) return 'clienti'
  if (/newsletter|news|update/i.test(fromLow + subjLow)) return 'newsletter'
  return 'altro'
}

function formatDigest(
  total: number,
  byCategory: Record<string, number>,
  critical: GmailMessageMeta[],
  routine: GmailMessageMeta[],
): string {
  const lines: string[] = [`🌅 *Buongiorno Ingegnere* — ${total} mail nuove non lette.`]
  if (critical.length > 0) {
    lines.push('')
    lines.push(`🚨 *Urgenti* (${critical.length}):`)
    for (const m of critical.slice(0, 5)) {
      lines.push(`- ${truncate(m.from, 30)} — '${truncate(m.subject, 60)}'`)
    }
  }
  if (Object.keys(byCategory).length > 0) {
    lines.push('')
    lines.push(`📊 *Per categoria:*`)
    for (const [cat, count] of Object.entries(byCategory)) {
      lines.push(`- ${cat}: ${count}`)
    }
  }
  if (routine.length > 0) {
    lines.push('')
    lines.push(`📋 Routine (${routine.length}): per dettagli chiedi "leggi le mail nuove"`)
  }
  return lines.join('\n')
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export async function checkCriticalAlerts(sinceTs: Date): Promise<GmailMessageMeta[]> {
  const sinceDays = Math.max(1, Math.ceil((Date.now() - sinceTs.getTime()) / (24 * 3600 * 1000)))
  const messages = await listInbox({ onlyUnread: true, sinceDays, maxResults: 50 })
  const rules = await loadAlertRules()
  const critical: GmailMessageMeta[] = []
  for (const m of messages) {
    if (new Date(m.date).getTime() < sinceTs.getTime()) continue
    const match = matchesAlert(m, rules)
    if (match.matched && match.severity !== 'low') {
      critical.push(m)
    }
  }
  return critical
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/gmail-summary.ts
git commit -m "feat(gmail): summary + critical detect (alert rules engine)"
```

---

## Task 9: Cron route morning summary

**Files:**
- Create: `src/app/api/cron/gmail-morning/route.ts`

- [ ] **Step 1: Creare il file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { buildDailySummary } from '@/lib/gmail-summary'
import { sendTelegramMessage } from '@/lib/telegram-helpers'
import { recordBotAction } from '@/lib/gmail-tools'

export const maxDuration = 120

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // Silent mode check
  const { data: silentRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'gmail_silent_until')
    .maybeSingle()
  const silentValue = silentRow?.value
  if (silentValue && silentValue !== 'null' && silentValue !== null) {
    const silentUntil = new Date(typeof silentValue === 'string' ? silentValue.replace(/"/g, '') : silentValue)
    if (Date.now() < silentUntil.getTime()) {
      console.log(`[CRON gmail-morning] silent until ${silentUntil.toISOString()}, skip`)
      return NextResponse.json({ ok: true, skipped: 'silent' })
    }
  }

  // Idempotency: skip if last run < 12h ago
  const { data: lastRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'gmail_summary_last_run')
    .maybeSingle()
  const lastValue = lastRow?.value
  if (lastValue && lastValue !== 'null' && lastValue !== null) {
    const last = new Date(typeof lastValue === 'string' ? lastValue.replace(/"/g, '') : lastValue)
    if (Date.now() - last.getTime() < 12 * 3600 * 1000) {
      console.log(`[CRON gmail-morning] already ran ${last.toISOString()}, skip`)
      return NextResponse.json({ ok: true, skipped: 'already_ran' })
    }
  }

  let summary
  try {
    summary = await buildDailySummary(1)
  } catch (err) {
    console.error('[CRON gmail-morning] buildDailySummary failed:', err)
    return NextResponse.json({ ok: false, error: 'summary_failed' }, { status: 500 })
  }

  if (summary.totalUnread === 0) {
    console.log('[CRON gmail-morning] no new mail, skip notification')
  } else {
    let adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
    if (!adminChat) {
      const firstAllowed = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
      adminChat = parseInt(firstAllowed || '0', 10)
    }
    if (adminChat) {
      await sendTelegramMessage(adminChat, summary.digest).catch(err =>
        console.error('[CRON gmail-morning] telegram send failed:', err)
      )
    }
    // Record che ogni mail è stata inserita nel summary
    for (const m of [...summary.critical, ...summary.routine]) {
      await recordBotAction(m.id, m.threadId, 'in_summary', m.from, m.subject)
    }
  }

  // Update last_run timestamp
  await supabase
    .from('cervellone_config')
    .update({ value: new Date().toISOString() })
    .eq('key', 'gmail_summary_last_run')

  return NextResponse.json({ ok: true, total: summary.totalUnread, critical: summary.critical.length })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/cron/gmail-morning/route.ts
git commit -m "feat(gmail): cron morning summary route"
```

---

## Task 10: Cron route alerts (every 30 min)

**Files:**
- Create: `src/app/api/cron/gmail-alerts/route.ts`

- [ ] **Step 1: Creare il file**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { checkCriticalAlerts } from '@/lib/gmail-summary'
import { sendTelegramMessage } from '@/lib/telegram-helpers'
import { recordBotAction } from '@/lib/gmail-tools'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // Silent mode check
  const { data: silentRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'gmail_silent_until')
    .maybeSingle()
  const silentValue = silentRow?.value
  if (silentValue && silentValue !== 'null' && silentValue !== null) {
    const silentUntil = new Date(typeof silentValue === 'string' ? silentValue.replace(/"/g, '') : silentValue)
    if (Date.now() < silentUntil.getTime()) {
      return NextResponse.json({ ok: true, skipped: 'silent' })
    }
  }

  // Determine "since" timestamp: last_check or 1 hour ago
  const { data: lastRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'gmail_alert_check_last_run')
    .maybeSingle()
  const lastValue = lastRow?.value
  const sinceTs = lastValue && lastValue !== 'null' && lastValue !== null
    ? new Date(typeof lastValue === 'string' ? lastValue.replace(/"/g, '') : lastValue)
    : new Date(Date.now() - 3600 * 1000)

  let critical
  try {
    critical = await checkCriticalAlerts(sinceTs)
  } catch (err) {
    console.error('[CRON gmail-alerts] checkCriticalAlerts failed:', err)
    return NextResponse.json({ ok: false, error: 'check_failed' }, { status: 500 })
  }

  // Filter out già notificate
  const newAlerts = []
  for (const m of critical) {
    const { data: existing } = await supabase
      .from('gmail_processed_messages')
      .select('message_id')
      .eq('message_id', m.id)
      .eq('bot_action', 'notified_critical')
      .maybeSingle()
    if (!existing) newAlerts.push(m)
  }

  if (newAlerts.length > 0) {
    let adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
    if (!adminChat) {
      const firstAllowed = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
      adminChat = parseInt(firstAllowed || '0', 10)
    }
    if (adminChat) {
      for (const m of newAlerts) {
        const text = `🚨 *Mail urgente da ${m.from.slice(0, 50)}*\nOggetto: ${m.subject.slice(0, 100)}\nAnteprima: ${m.snippet.slice(0, 200)}\n\nVuoi leggerla completa o preparo bozza risposta?`
        await sendTelegramMessage(adminChat, text).catch(err =>
          console.error('[CRON gmail-alerts] telegram send failed:', err)
        )
        await recordBotAction(m.id, m.threadId, 'notified_critical', m.from, m.subject)
      }
    }
  }

  // Update last_run
  await supabase
    .from('cervellone_config')
    .update({ value: new Date().toISOString() })
    .eq('key', 'gmail_alert_check_last_run')

  return NextResponse.json({ ok: true, alerts: newAlerts.length })
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/cron/gmail-alerts/route.ts
git commit -m "feat(gmail): cron alerts route every 30min"
```

---

## Task 11: vercel.json schedules

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Aggiungere 2 cron al file esistente**

Leggere `vercel.json` corrente. Aggiungere ai `crons` esistenti (preservando il canary):

```json
{
  "crons": [
    { "path": "/api/cron/canary", "schedule": "*/30 * * * *" },
    { "path": "/api/cron/gmail-morning", "schedule": "0 6 * * 1-5" },
    { "path": "/api/cron/gmail-alerts", "schedule": "*/30 7-16 * * 1-5" }
  ]
}
```

NOTE:
- `0 6 * * 1-5` = 6:00 UTC = 8:00 Europe/Rome (CEST estate, 7:00 d'inverno con CET — tradeoff accettato)
- `*/30 7-16 * * 1-5` = ogni 30 min dalle 9:00 alle 18:30 Europe/Rome lun-ven

- [ ] **Step 2: Commit**

```bash
git add vercel.json
git commit -m "feat(gmail): schedule cron morning + alerts"
```

---

## Task 12: Tool registration in tools.ts

**Files:**
- Modify: `src/lib/tools.ts`

- [ ] **Step 1: Aggiungere import**

In cima al file dopo gli altri import:

```typescript
import {
  listInbox,
  searchGmail,
  readMessage,
  readThread,
  createDraft,
  listDrafts,
  showDraft,
  deleteDraft,
  sendDraft,
  applyLabel,
  removeLabel,
  listLabels,
  markAsRead,
  archive,
  trash,
} from './gmail-tools'
import { buildDailySummary } from './gmail-summary'
```

- [ ] **Step 2: Aggiungere GMAIL_TOOLS array**

Aggiungere dopo `WEATHER_TOOLS`:

```typescript
const GMAIL_TOOLS: ToolDefinition[] = [
  {
    name: 'gmail_list_inbox',
    description: 'Elenca le mail in inbox della casella restruktura.drive@gmail.com. Default 20 mail più recenti, filtri opzionali.',
    input_schema: {
      type: 'object' as const,
      properties: {
        max_results: { type: 'string', description: 'Max risultati (default 20, max 100)' },
        only_unread: { type: 'string', description: '"true" per solo non lette' },
        since_days: { type: 'string', description: 'Solo ultimi N giorni' },
      },
    },
  },
  {
    name: 'gmail_search',
    description: 'Cerca mail con sintassi Gmail nativa (es. "from:rossi after:2026-04-01", "subject:DURC", "has:attachment").',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Query Gmail (sintassi nativa)' },
        max_results: { type: 'string', description: 'Max risultati (default 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'gmail_read_message',
    description: 'Legge il contenuto completo di una singola mail (corpo, headers, lista allegati).',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string', description: 'Gmail message ID' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_read_thread',
    description: 'Legge tutti i messaggi di un thread (conversazione email completa).',
    input_schema: {
      type: 'object' as const,
      properties: {
        thread_id: { type: 'string', description: 'Gmail thread ID' },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'gmail_create_draft',
    description: 'Crea una bozza di mail. Mostrala SEMPRE all\'utente per conferma prima di inviare. Per rispondere a un thread esistente passa in_reply_to e thread_id.',
    input_schema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destinatario (email)' },
        subject: { type: 'string', description: 'Oggetto' },
        body: { type: 'string', description: 'Corpo testo (italiano formale per Restruktura)' },
        in_reply_to: { type: 'string', description: 'Message-ID a cui rispondere (header In-Reply-To)' },
        thread_id: { type: 'string', description: 'Thread ID per risposta in catena' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'gmail_list_drafts',
    description: 'Lista bozze pendenti (max 10).',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'gmail_show_draft',
    description: 'Mostra contenuto completo di una bozza per anteprima.',
    input_schema: {
      type: 'object' as const,
      properties: {
        draft_id: { type: 'string' },
      },
      required: ['draft_id'],
    },
  },
  {
    name: 'gmail_send_draft',
    description: 'INVIA UNA BOZZA. Usa SOLO dopo conferma esplicita dell\'utente (es. "/conferma", "manda", "invia"). Mai senza approvazione esplicita. Anti-loop: rifiuta se thread ha già una recente reply del bot.',
    input_schema: {
      type: 'object' as const,
      properties: {
        draft_id: { type: 'string' },
      },
      required: ['draft_id'],
    },
  },
  {
    name: 'gmail_delete_draft',
    description: 'Cancella una bozza non inviata (utente ha detto /annulla).',
    input_schema: {
      type: 'object' as const,
      properties: {
        draft_id: { type: 'string' },
      },
      required: ['draft_id'],
    },
  },
  {
    name: 'gmail_apply_label',
    description: 'Aggiunge una label a una mail (la crea se non esiste).',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string' },
        label_name: { type: 'string', description: 'Nome label es. "Cliente Rossi" o "Urgente"' },
      },
      required: ['message_id', 'label_name'],
    },
  },
  {
    name: 'gmail_remove_label',
    description: 'Rimuove una label da una mail.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string' },
        label_name: { type: 'string' },
      },
      required: ['message_id', 'label_name'],
    },
  },
  {
    name: 'gmail_list_labels',
    description: 'Elenca tutte le label disponibili nell\'inbox.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'gmail_mark_read',
    description: 'Segna una mail come letta (rimuove label UNREAD).',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_archive',
    description: 'Archivia una mail (rimuove dall\'inbox, recuperabile via search). NIENTE delete permanente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_trash',
    description: 'Sposta una mail nel cestino Gmail (recuperabile 30 giorni). Chiedi conferma esplicita all\'utente prima di chiamare.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: { type: 'string' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'gmail_summary_inbox',
    description: 'Riassunto delle mail non lette degli ultimi N giorni (default 1) — categorizzate, con highlight degli urgenti.',
    input_schema: {
      type: 'object' as const,
      properties: {
        since_days: { type: 'string', description: 'Numero giorni indietro (default 1)' },
      },
    },
  },
]
```

- [ ] **Step 3: Aggiungere wrapper executor**

```typescript
async function executeGmailWrapper(
  name: string,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (!name.startsWith('gmail_')) return null

  const get = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')

  try {
    switch (name) {
      case 'gmail_list_inbox': {
        const res = await listInbox({
          maxResults: parseInt(get('max_results') || '20', 10),
          onlyUnread: get('only_unread') === 'true',
          sinceDays: parseInt(get('since_days') || '0', 10) || undefined,
        })
        return formatGmailList(res)
      }
      case 'gmail_search': {
        const res = await searchGmail(get('query'), parseInt(get('max_results') || '20', 10))
        return formatGmailList(res)
      }
      case 'gmail_read_message': {
        const m = await readMessage(get('message_id'))
        return formatGmailMessage(m)
      }
      case 'gmail_read_thread': {
        const t = await readThread(get('thread_id'))
        return t.map(formatGmailMessage).join('\n\n---\n\n')
      }
      case 'gmail_create_draft': {
        const res = await createDraft({
          to: get('to'),
          subject: get('subject'),
          body: get('body'),
          inReplyTo: get('in_reply_to') || undefined,
          threadId: get('thread_id') || undefined,
        })
        return `✅ Bozza creata. draft_id=${res.draftId}\nUsa gmail_show_draft per anteprima, poi gmail_send_draft DOPO conferma utente.`
      }
      case 'gmail_list_drafts': {
        const drafts = await listDrafts(20)
        if (drafts.length === 0) return 'Nessuna bozza pendente.'
        return drafts.map(d => `📝 ${d.draftId}: A: ${d.to} | Oggetto: ${d.subject}`).join('\n')
      }
      case 'gmail_show_draft': {
        const d = await showDraft(get('draft_id'))
        return formatGmailMessage(d)
      }
      case 'gmail_send_draft': {
        const res = await sendDraft(get('draft_id'))
        return `📤 Inviata. message_id=${res.messageId} thread_id=${res.threadId}`
      }
      case 'gmail_delete_draft': {
        await deleteDraft(get('draft_id'))
        return `🗑 Bozza cancellata.`
      }
      case 'gmail_apply_label': {
        await applyLabel(get('message_id'), get('label_name'))
        return `🏷 Label "${get('label_name')}" applicata.`
      }
      case 'gmail_remove_label': {
        await removeLabel(get('message_id'), get('label_name'))
        return `🏷 Label rimossa.`
      }
      case 'gmail_list_labels': {
        const labels = await listLabels()
        return labels.map(l => `- ${l.name} (id=${l.id})`).join('\n')
      }
      case 'gmail_mark_read': {
        await markAsRead(get('message_id'))
        return `✓ Segnata come letta.`
      }
      case 'gmail_archive': {
        await archive(get('message_id'))
        return `📦 Archiviata.`
      }
      case 'gmail_trash': {
        await trash(get('message_id'))
        return `🗑 Spostata nel cestino (recuperabile 30 giorni).`
      }
      case 'gmail_summary_inbox': {
        const summary = await buildDailySummary(parseInt(get('since_days') || '1', 10))
        return summary.digest
      }
      default:
        return `Tool gmail "${name}" non riconosciuto.`
    }
  } catch (err) {
    return `Errore Gmail: ${err instanceof Error ? err.message : err}`
  }
}

function formatGmailList(messages: { id: string; from: string; subject: string; snippet: string; date: string }[]): string {
  if (messages.length === 0) return 'Nessun messaggio trovato.'
  return messages.map(m =>
    `📧 [${m.id}] ${m.date.slice(0, 16)} | ${m.from.slice(0, 40)} | ${m.subject.slice(0, 60)}\n   ${m.snippet.slice(0, 100)}`
  ).join('\n\n')
}

function formatGmailMessage(m: { from: string; to: string; subject: string; date: string; bodyText: string; attachments: { filename: string; sizeBytes: number }[] }): string {
  const lines = [
    `Da: ${m.from}`,
    `A: ${m.to}`,
    `Data: ${m.date}`,
    `Oggetto: ${m.subject}`,
  ]
  if (m.attachments.length > 0) {
    lines.push(`Allegati: ${m.attachments.map(a => `${a.filename} (${Math.round(a.sizeBytes/1024)}KB)`).join(', ')}`)
  }
  lines.push('', m.bodyText.slice(0, 5000))
  return lines.join('\n')
}
```

- [ ] **Step 4: Aggiungere ai registry ALL_TOOLS + EXECUTORS**

Trovare e modificare:

```typescript
const ALL_TOOLS: ToolDefinition[] = [
  ...STUDIO_TECNICO_TOOLS,
  ...SELF_TOOLS,
  ...DRIVE_TOOLS,
  ...GITHUB_TOOLS,
  ...WEATHER_TOOLS,
  ...GMAIL_TOOLS,  // 2026-05-05: Gmail R+W
]
const EXECUTORS = [executeStudioTecnico, executeSelfTools, executeDriveWrapper, executeGithubWrapper, executeWeatherWrapper, executeGmailWrapper]
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.ts
git commit -m "feat(gmail): registrazione 16 tool Gmail in registry"
```

---

## Task 13: Prompt update — REGOLA TOOL GMAIL

**Files:**
- Modify: `src/lib/prompts.ts`

- [ ] **Step 1: Aggiungere REGOLA TOOL GMAIL**

Trovare la `REGOLA TOOL METEO` e aggiungere SOPRA di essa:

```typescript
REGOLA TOOL GMAIL:
Quando l'utente menziona "mail", "email", "messaggio email", "ho ricevuto", "rispondi a", "scrivi a [persona]", "manda mail a", "cerca nelle mail":
- Per "che mail nuove ho" o "riassunto mail" → gmail_summary_inbox
- Per "leggimi la mail di X" → gmail_search query="from:X" → gmail_read_message
- Per "rispondi a [thread]" → gmail_search → gmail_read_message → gmail_create_draft con in_reply_to → poi MOSTRA anteprima all'utente con TO/oggetto/corpo
- INVIO bozza: SOLO dopo conferma esplicita ("conferma", "/conferma", "manda", "invia"). MAI gmail_send_draft senza esplicito OK utente. Se l'utente non ha confermato, ricorda: "Le mostro la bozza, conferma con 'manda' per inviare."
- Per archiviare → gmail_archive (recuperabile via search)
- Per cestinare (trash) → CHIEDI conferma "vuoi che la cestini?", poi gmail_trash
- Per labelare → gmail_apply_label (auto-crea label se non esiste)
- Hard-blocked: delete permanente, forward a terzi, modify filtri/firma, send a mailing list. Spiegare all'utente che non disponibili.
- Anti-loop: gmail_send_draft rifiuta automaticamente se thread ha bot reply <30min o sender è noreply/auto-reply. Non aggirare.
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/prompts.ts
git commit -m "feat(gmail): REGOLA TOOL GMAIL nel system prompt"
```

---

## Task 14: Push branch + verifica deploy + test smoke

**Files:** nessuno (deploy)

- [ ] **Step 1: Push branch (se in worktree) o main**

```bash
git push origin <branch>
```

- [ ] **Step 2: Verifica preview/prod READY su Vercel**

Attendere ~1-2 min. Se ERROR, leggere log build, identificare TS error, dispatchare fix.

- [ ] **Step 3: Test smoke da Telegram**

Inviare a Cervellone:
- "che mail nuove ho oggi?" — atteso: chiamata gmail_summary_inbox, riassunto categorie
- "cerca mail di google.com" — atteso: gmail_search restituisce risultati
- "leggimi l'ultima mail" — atteso: gmail_list_inbox max 1 + gmail_read_message

- [ ] **Step 4: Test draft + conferma**

- "scrivi a test@example.com con oggetto 'prova' dicendo che è un test" — atteso: gmail_create_draft + bot mostra anteprima
- "/conferma" — atteso: gmail_send_draft chiamato (potrebbe fallire se OAuth scope mancanti, in tal caso punto a re-auth)

- [ ] **Step 5: Test critical alert**

Invia mail di test alla casella `restruktura.drive@gmail.com` con oggetto "test URGENTE Cervellone". Attendere 30 min (o curl manuale al cron alerts) e verificare arrivo notifica Telegram "🚨 Mail urgente da..."

---

## Task 15: User SQL setup + OAuth re-auth

**Files:** nessuno (azioni utente)

- [ ] **Step 1: Migration applicata**

L'utente esegue su Supabase SQL editor il contenuto di `2026-05-05-gmail-rw.sql`.

- [ ] **Step 2: OAuth re-auth con scope Gmail**

L'utente apre browser autenticato su https://cervellone-5poc.vercel.app/api/auth/google e completa il consent screen Google con i nuovi scope (gmail.modify + gmail.send).

- [ ] **Step 3: Verifica refresh_token aggiornato**

Su Supabase SQL:
```sql
SELECT email, scope FROM google_oauth_credentials ORDER BY updated_at DESC LIMIT 1;
```
Atteso: scope contiene `gmail.modify` e `gmail.send`.

---

## Definition of Done

| Item | Task |
|---|---|
| Migration applicata | 1 |
| OAuth scope estesi | 2 + 15 |
| `gmail-tools.ts` con 20 funzioni | 3-7 |
| `gmail-summary.ts` digest + critical | 8 |
| Cron morning summary | 9 |
| Cron alerts every 30min | 10 |
| vercel.json schedules | 11 |
| 16 tool registrati | 12 |
| Prompt REGOLA TOOL GMAIL | 13 |
| Test smoke read+search+digest | 14 |
| Test draft+confirm+send | 14 |
| Test critical alert | 14 |

## Setup utente richiesto

1. Migration `2026-05-05-gmail-rw.sql` su Supabase SQL editor (Task 1)
2. OAuth re-auth via `/api/auth/google` per scope estesi (Task 2/15)
3. Optional post-deploy: aggiungere mittenti VIP via tool `gmail_add_alert_rule` (futuro, non in questo plan)
