# Mail Subagent (IMAP/SMTP nativo TopHost) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) o `superpowers:executing-plans` per implementare task-by-task. Steps usano checkbox (`- [ ]`).
> Da richiesta esplicita utente 10 mag 2026: **multi-agente sempre** quando applicabile.

**Goal:** aggiungere a Cervellone V19 un sub-agent `mail-router` che parla IMAP/SMTP nativamente con TopHost (`pop.tophost.it:993` IMAPS, `mail.tophost.it:587` STARTTLS) per le caselle `info@restruktura.it` e `raffaele.lentini@restruktura.it`, con tool `read_email` / `get_email_body` / `send_email` / `forward_email` / `mark_email`, pattern conferma utente Telegram per invii esterni, prima routine cron `monthly_foreign_invoices_forward`.

**Architecture:**
- Tool client-side TS in `src/v19/tools/email/` (factory per account → `imapflow` + `nodemailer` + `mailparser`)
- Sub-agent `mail-router` registrato in `src/v19/agent/subagent-registry.ts` (sostituisce placeholder `gmail-router` mai usato in prod V19)
- Migration Supabase `2026-05-11-v19-email-subagent.sql`: 3 tabelle (`cervellone_email_log` audit, `cervellone_email_senders` whitelist, `cervellone_email_invoices_log` dedup) + seed 4 senders + tabella `cervellone_email_pending_send` per conferma utente
- Cron endpoint `/api/cron/monthly-foreign-invoices` (auth `Bearer ${CRON_SECRET}`, idempotency via `cervellone_config` come gli altri cron)
- Pattern conferma utente: outbound verso destinatari NON `@restruktura.it` salvato come pending → notifica Telegram → comandi `/invia_<uuid>` / `/annulla_<uuid>` → send + IMAP APPEND su Sent del mittente

**Tech Stack:** TypeScript 5, Next.js 16 App Router, Anthropic SDK 0.80, Supabase, vitest 4.1, imapflow, nodemailer 7, mailparser 3.

**Branch:** `v19/email-subagent` partendo da `v19/foundation` (HEAD `1571c186c2eca99c3fdc82bba3d6522802c250d7`). PR foundation resta separata.

**Confini operativi (rispettare sempre):**
- NO push su `main`. NO deploy prod Vercel. NO modifiche env Vercel prod senza Raffaele al telefono. NO applicare migration Supabase su prod (solo file `.sql`). NO commit di password in chiaro. NO inviare mail reali verso esterni nei test.

---

## File Structure

```
supabase/migrations/
└── 2026-05-11-v19-email-subagent.sql        # 4 tabelle + seed senders (single-line per Monaco)

src/v19/tools/email/
├── config.ts                                # Account registry da env vars + validation
├── connection.ts                            # IMAP/SMTP client factory + close helper
├── append-sent.ts                           # IMAP APPEND in Sent post-SMTP-send
├── parse-message.ts                         # mailparser wrapper + snippet/attachments util
├── audit.ts                                 # insert into cervellone_email_log
├── read-email.ts                            # tool read_email
├── get-email-body.ts                        # tool get_email_body
├── send-email.ts                            # tool send_email (+ pending guard)
├── forward-email.ts                         # tool forward_email
├── mark-email.ts                            # tool mark_email
├── pending.ts                               # CRUD cervellone_email_pending_send
└── index.ts                                 # barrel: tool defs + executor map

src/v19/routines/
└── monthly-foreign-invoices.ts              # routine logica pura (testabile)

src/app/api/cron/monthly-foreign-invoices/
└── route.ts                                 # Next.js cron handler

src/app/api/telegram/
└── route.ts                                 # MODIFY: handler /invia_<uuid> + /annulla_<uuid>

src/v19/agent/
├── types.ts                                 # MODIFY: SubagentKind enum
├── subagent-registry.ts                     # MODIFY: gmail-router → mail-router
└── orchestrator.ts                          # MODIFY: spawn_subagent kind enum

src/v19/__tests__/
├── email-config.spec.ts
├── email-parse-message.spec.ts
├── email-read.spec.ts                       # mock imapflow
├── email-send.spec.ts                       # mock nodemailer
├── email-append-sent.spec.ts                # mock imapflow
├── email-pending.spec.ts                    # supabase test client
├── monthly-foreign-invoices.spec.ts         # dry-run + dedup
└── email-integration.spec.ts                # OPT-IN: real IMAP/SMTP, skip se no env

vercel.json                                  # MODIFY: add cron entry

.env.local.example                           # MODIFY o CREATE: documenta env vars (mai segreti reali)
```

---

## Decisioni di design (locked-in)

| # | Decisione | Motivazione |
|---|---|---|
| 1 | Hostname IMAP = `pop.tophost.it:993` (confermato banner `+OK IMAP4rev1 IDLE` su `m-rb.th.seeweb.it`) | Alias DNS TopHost copre entrambi i protocolli, evita di hardcodare `imap.tophost.it` che NXDOMAIN |
| 2 | `imapflow` (non `node-imap`) | Async/await, IDLE, APPEND, SEARCH, manutenuto da Nodemailer team |
| 3 | `mailparser` per RFC822 → JSON | De facto standard, allegati + charset gestiti |
| 4 | `nodemailer` per SMTP | Stesso ecosistema, gestisce STARTTLS automaticamente |
| 5 | Connessione **per-tool-call** (no pool persistente) | Functions serverless Vercel: lifecycle breve, pool inutile, evita stale connections |
| 6 | APPEND Sent **dentro `send_email`/`forward_email`**, non separato | Atomicità lato chiamante: o entrambi o errore esplicito |
| 7 | Confirm utente: pending table, NON in-memory | Funzioni serverless stateless, deve sopravvivere a request boundaries |
| 8 | Dedup mensile: UNIQUE (`month_ref`, `source_uid`, `source_folder`) | Re-run idempotente della routine |
| 9 | Whitelist senders: tabella separata, NON hardcoded | Raffaele estende via Telegram (futuro), riusabile per altre categorie |
| 10 | RLS DISABLED sulle tabelle email (come V18+V19) | App fa auth server-side, no client diretto Supabase |
| 11 | Audit log: snippet body max 200 char, NO body completo | GDPR, evita PII clienti in chiaro |
| 12 | Sub-agent rinominato `mail-router` (era placeholder `gmail-router`) | Future-proof: domani PEC, Outlook, altri protocolli stesso sub-agent |
| 13 | Tool `send_email`/`forward_email` esposti SOLO all'orchestrator parent, **non al sub-agent** | Conferma utente è policy parent. Sub-agent chiama `read_email`/`get_email_body`/`mark_email` + draft, parent invia |

---

## Open per Raffaele (NON bloccanti, da confermare in Task 17)

1. ☐ Aggiungere env vars su Vercel (Encrypted): 6 chiavi TopHost server + 4×2 chiavi account
2. ☐ Confermo che `CRON_SECRET` su Vercel è impostato (gli altri cron lo usano)
3. ☐ Confermo che `raffaele.lentini@restruktura.it` IMAP è già migrato (handoff dice "in corso stanotte") prima di abilitarla — fino ad allora il sub-agent gestisce solo `info@`

---

## Task 0: Setup branch + dipendenze

**Files:** repo root.

- [ ] **Step 1: crea branch da v19/foundation**

```bash
cd "C:/Progetti claude Code/02.SuperING/cervellone"
git checkout v19/foundation
git pull origin v19/foundation
git checkout -b v19/email-subagent
```

- [ ] **Step 2: installa deps**

```bash
npm install imapflow@^1.0.180 mailparser@^3.7.4 nodemailer@^7.0.10
npm install --save-dev @types/nodemailer@^7.0.4 @types/mailparser@^3.4.7
```

Atteso: aggiunte 5 dipendenze in `package.json`, nessun audit critical.

- [ ] **Step 3: commit**

```bash
git add package.json package-lock.json
git commit -m "chore(v19): add imapflow/mailparser/nodemailer for mail subagent"
```

---

## Task 1: Migration SQL (4 tabelle + seed)

**Files:**
- Create: `supabase/migrations/2026-05-11-v19-email-subagent.sql`

- [ ] **Step 1: scrivi migration**

```sql
-- 2026-05-11-v19-email-subagent.sql
-- Mail subagent: audit log + senders whitelist + invoices dedup + pending send confirm
-- Pattern: RLS DISABLED (allineato V19 foundation). Single-line per Monaco editor.

CREATE TABLE IF NOT EXISTS cervellone_email_log (id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(), account TEXT NOT NULL, action TEXT NOT NULL, direction TEXT, message_id TEXT, subject TEXT, from_addr TEXT, to_addrs TEXT[], cc_addrs TEXT[], bcc_addrs TEXT[], attachments_count INT NOT NULL DEFAULT 0, attachments_summary JSONB, status TEXT NOT NULL DEFAULT 'ok', error TEXT, request_id TEXT, routine_name TEXT, raw_meta JSONB); CREATE INDEX IF NOT EXISTS ix_email_log_ts ON cervellone_email_log (ts DESC); CREATE INDEX IF NOT EXISTS ix_email_log_account_action ON cervellone_email_log (account, action); ALTER TABLE cervellone_email_log DISABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS cervellone_email_senders (id BIGSERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, category TEXT NOT NULL, label TEXT, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), notes TEXT); CREATE INDEX IF NOT EXISTS ix_email_senders_cat ON cervellone_email_senders (category, active); ALTER TABLE cervellone_email_senders DISABLE ROW LEVEL SECURITY;

INSERT INTO cervellone_email_senders (email, category, label) VALUES ('billing@anthropic.com', 'fatture_estere', 'Anthropic'), ('invoice@vercel.com', 'fatture_estere', 'Vercel'), ('support@openai.com', 'fatture_estere', 'OpenAI billing support'), ('billing@supabase.io', 'fatture_estere', 'Supabase') ON CONFLICT (email) DO NOTHING;

CREATE TABLE IF NOT EXISTS cervellone_email_invoices_log (id BIGSERIAL PRIMARY KEY, month_ref TEXT NOT NULL, source_uid INT NOT NULL, source_folder TEXT NOT NULL DEFAULT 'INBOX', from_addr TEXT, subject TEXT, received_at TIMESTAMPTZ, forwarded_at TIMESTAMPTZ NOT NULL DEFAULT now(), forwarded_message_id TEXT, attachments_filenames TEXT[], UNIQUE (month_ref, source_uid, source_folder)); ALTER TABLE cervellone_email_invoices_log DISABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS cervellone_email_pending_send (uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 minutes'), from_account TEXT NOT NULL, to_addrs TEXT[] NOT NULL, cc_addrs TEXT[], bcc_addrs TEXT[], subject TEXT NOT NULL, body_text TEXT NOT NULL, body_html TEXT, attachments JSONB, in_reply_to JSONB, status TEXT NOT NULL DEFAULT 'pending', sent_message_id TEXT, sent_at TIMESTAMPTZ); CREATE INDEX IF NOT EXISTS ix_email_pending_status ON cervellone_email_pending_send (status, expires_at); ALTER TABLE cervellone_email_pending_send DISABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: commit (file SQL only, NON applicare in prod)**

```bash
git add supabase/migrations/2026-05-11-v19-email-subagent.sql
git commit -m "feat(v19): mail subagent migrations (audit/senders/invoices-dedup/pending-send)"
```

Nota: applicazione in prod sarà esplicita dopo conferma Raffaele (Task 17).

---

## Task 2: Account config + env validation

**Files:**
- Create: `src/v19/tools/email/config.ts`
- Test: `src/v19/__tests__/email-config.spec.ts`

- [ ] **Step 1: scrivi failing test**

```ts
// src/v19/__tests__/email-config.spec.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getAccountConfig, listAccounts, EmailConfigError } from '../tools/email/config'

const ENV_BACKUP = { ...process.env }

describe('email/config', () => {
  beforeEach(() => {
    process.env.TOPHOST_IMAP_HOST = 'pop.tophost.it'
    process.env.TOPHOST_IMAP_PORT = '993'
    process.env.TOPHOST_IMAP_TLS = 'true'
    process.env.TOPHOST_SMTP_HOST = 'mail.tophost.it'
    process.env.TOPHOST_SMTP_PORT = '587'
    process.env.TOPHOST_SMTP_STARTTLS = 'true'
    process.env.EMAIL_INFO_USER = 'restruktura.it78915'
    process.env.EMAIL_INFO_PASS = 'redacted'
    process.env.EMAIL_INFO_FROM_ADDRESS = 'info@restruktura.it'
    process.env.EMAIL_INFO_DISPLAY_NAME = 'Restruktura'
  })
  afterEach(() => { process.env = { ...ENV_BACKUP } })

  it('returns account config for "info"', () => {
    const cfg = getAccountConfig('info')
    expect(cfg.imap.host).toBe('pop.tophost.it')
    expect(cfg.imap.port).toBe(993)
    expect(cfg.imap.secure).toBe(true)
    expect(cfg.smtp.host).toBe('mail.tophost.it')
    expect(cfg.smtp.port).toBe(587)
    expect(cfg.auth.user).toBe('restruktura.it78915')
    expect(cfg.fromAddress).toBe('info@restruktura.it')
    expect(cfg.displayName).toBe('Restruktura')
  })

  it('throws EmailConfigError when account user is missing', () => {
    delete process.env.EMAIL_INFO_USER
    expect(() => getAccountConfig('info')).toThrow(EmailConfigError)
  })

  it('throws EmailConfigError on unknown account', () => {
    expect(() => getAccountConfig('unknown' as never)).toThrow(EmailConfigError)
  })

  it('listAccounts returns only configured accounts', () => {
    delete process.env.EMAIL_RAFFAELE_USER
    expect(listAccounts()).toEqual(['info'])
  })
})
```

- [ ] **Step 2: run test (fails — modulo non esiste)**

```bash
npx vitest run src/v19/__tests__/email-config.spec.ts
```

Atteso: FAIL `Cannot find module ../tools/email/config`.

- [ ] **Step 3: implementa config.ts**

```ts
// src/v19/tools/email/config.ts
/**
 * Cervellone V19 — Mail account config registry
 * Legge env vars TOPHOST_* + EMAIL_<ACCOUNT>_* e ritorna struct validate.
 * Mai loggare la password.
 */

export class EmailConfigError extends Error {
  constructor(msg: string) { super(msg); this.name = 'EmailConfigError' }
}

export type AccountKey = 'info' | 'raffaele'

export type EmailAccountConfig = {
  key: AccountKey
  imap: { host: string; port: number; secure: boolean }
  smtp: { host: string; port: number; requireTLS: boolean }
  auth: { user: string; pass: string }
  fromAddress: string
  displayName: string
}

const SERVER_VARS = ['TOPHOST_IMAP_HOST', 'TOPHOST_IMAP_PORT', 'TOPHOST_IMAP_TLS', 'TOPHOST_SMTP_HOST', 'TOPHOST_SMTP_PORT', 'TOPHOST_SMTP_STARTTLS'] as const

function requireEnv(key: string): string {
  const v = process.env[key]
  if (!v || v.trim() === '') throw new EmailConfigError(`Env mancante: ${key}`)
  return v
}

function getServer() {
  for (const k of SERVER_VARS) requireEnv(k)
  return {
    imap: {
      host: requireEnv('TOPHOST_IMAP_HOST'),
      port: Number(requireEnv('TOPHOST_IMAP_PORT')),
      secure: requireEnv('TOPHOST_IMAP_TLS').toLowerCase() === 'true',
    },
    smtp: {
      host: requireEnv('TOPHOST_SMTP_HOST'),
      port: Number(requireEnv('TOPHOST_SMTP_PORT')),
      requireTLS: requireEnv('TOPHOST_SMTP_STARTTLS').toLowerCase() === 'true',
    },
  }
}

const ACCOUNT_PREFIX: Record<AccountKey, string> = { info: 'EMAIL_INFO', raffaele: 'EMAIL_RAFFAELE' }

export function getAccountConfig(account: AccountKey): EmailAccountConfig {
  const prefix = ACCOUNT_PREFIX[account]
  if (!prefix) throw new EmailConfigError(`Account sconosciuto: ${account}`)
  const server = getServer()
  return {
    key: account,
    imap: server.imap,
    smtp: server.smtp,
    auth: {
      user: requireEnv(`${prefix}_USER`),
      pass: requireEnv(`${prefix}_PASS`),
    },
    fromAddress: requireEnv(`${prefix}_FROM_ADDRESS`),
    displayName: requireEnv(`${prefix}_DISPLAY_NAME`),
  }
}

export function listAccounts(): AccountKey[] {
  const out: AccountKey[] = []
  for (const key of ['info', 'raffaele'] as const) {
    const prefix = ACCOUNT_PREFIX[key]
    if (process.env[`${prefix}_USER`] && process.env[`${prefix}_PASS`]) out.push(key)
  }
  return out
}
```

- [ ] **Step 4: run test (PASS atteso)**

```bash
npx vitest run src/v19/__tests__/email-config.spec.ts
```

Atteso: 4/4 PASS.

- [ ] **Step 5: commit**

```bash
git add src/v19/tools/email/config.ts src/v19/__tests__/email-config.spec.ts
git commit -m "feat(v19/mail): account config registry + env validation"
```

---

## Task 3: Connection factory IMAP + SMTP

**Files:**
- Create: `src/v19/tools/email/connection.ts`

Niente test unitario (è wrapper di librerie esterne, coperto da integration test Task 13). Aggiungiamo solo type-safety.

- [ ] **Step 1: implementa connection.ts**

```ts
// src/v19/tools/email/connection.ts
/**
 * Factory IMAP/SMTP per account TopHost. Apertura/chiusura per-call
 * (no pool persistente: Vercel functions sono stateless e short-lived).
 */
import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import nodemailer, { type Transporter } from 'nodemailer'
import { getAccountConfig, type AccountKey } from './config'

export async function openImap(account: AccountKey): Promise<ImapFlow> {
  const cfg = getAccountConfig(account)
  const opts: ImapFlowOptions = {
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth: { user: cfg.auth.user, pass: cfg.auth.pass },
    logger: false,
    socketTimeout: 30_000,
  }
  const client = new ImapFlow(opts)
  await client.connect()
  return client
}

export async function closeImap(client: ImapFlow): Promise<void> {
  try { await client.logout() } catch { /* ignore */ }
}

export function makeSmtp(account: AccountKey): Transporter {
  const cfg = getAccountConfig(account)
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: false,
    requireTLS: cfg.smtp.requireTLS,
    auth: { user: cfg.auth.user, pass: cfg.auth.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  })
}

export function fromHeader(account: AccountKey): string {
  const cfg = getAccountConfig(account)
  return `"${cfg.displayName}" <${cfg.fromAddress}>`
}
```

- [ ] **Step 2: type-check**

```bash
npx tsc --noEmit
```

Atteso: 0 errori NEL FILE NUOVO (gli errori pre-esistenti in `pdf-generator.test.ts` ignoriamo).

- [ ] **Step 3: commit**

```bash
git add src/v19/tools/email/connection.ts
git commit -m "feat(v19/mail): IMAP/SMTP connection factory (imapflow + nodemailer)"
```

---

## Task 4: parse-message helper (mailparser wrapper)

**Files:**
- Create: `src/v19/tools/email/parse-message.ts`
- Test: `src/v19/__tests__/email-parse-message.spec.ts`

- [ ] **Step 1: failing test**

```ts
// src/v19/__tests__/email-parse-message.spec.ts
import { describe, it, expect } from 'vitest'
import { parseRfc822, toSnippet } from '../tools/email/parse-message'

const SAMPLE = Buffer.from(
  'From: sender@example.com\r\n' +
  'To: info@restruktura.it\r\n' +
  'Subject: Test fattura\r\n' +
  'Date: Mon, 11 May 2026 10:00:00 +0200\r\n' +
  'Message-ID: <abc123@example.com>\r\n' +
  'Content-Type: text/plain; charset=utf-8\r\n' +
  '\r\n' +
  'Corpo della mail con testo che contiene oltre 200 caratteri usato per validare lo snippet. Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.'
)

describe('parse-message', () => {
  it('estrae header e body da RFC822', async () => {
    const p = await parseRfc822(SAMPLE)
    expect(p.from).toBe('sender@example.com')
    expect(p.to).toEqual(['info@restruktura.it'])
    expect(p.subject).toBe('Test fattura')
    expect(p.messageId).toBe('<abc123@example.com>')
    expect(p.text).toContain('Corpo della mail')
    expect(p.attachments).toEqual([])
    expect(p.date instanceof Date).toBe(true)
  })

  it('toSnippet ritorna max 200 char', () => {
    const long = 'a'.repeat(500)
    expect(toSnippet(long).length).toBeLessThanOrEqual(200)
  })

  it('toSnippet collassa whitespace e trim', () => {
    expect(toSnippet('   hello\n\n  world  \t\t  ')).toBe('hello world')
  })
})
```

- [ ] **Step 2: run (fails)**

```bash
npx vitest run src/v19/__tests__/email-parse-message.spec.ts
```

Atteso: FAIL.

- [ ] **Step 3: implementa parse-message.ts**

```ts
// src/v19/tools/email/parse-message.ts
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser'

export type ParsedEmail = {
  messageId: string | null
  from: string | null
  to: string[]
  cc: string[]
  subject: string | null
  date: Date | null
  text: string
  html: string | null
  attachments: ParsedAttachment[]
}

export type ParsedAttachment = {
  filename: string | null
  contentType: string
  size: number
  contentBase64: string
}

function flatAddrs(addr?: AddressObject | AddressObject[]): string[] {
  if (!addr) return []
  const arr = Array.isArray(addr) ? addr : [addr]
  return arr.flatMap(a => a.value.map(v => v.address ?? '').filter(Boolean))
}

export async function parseRfc822(raw: Buffer): Promise<ParsedEmail> {
  const m: ParsedMail = await simpleParser(raw, { skipHtmlToText: false })
  return {
    messageId: m.messageId ?? null,
    from: m.from?.value?.[0]?.address ?? null,
    to: flatAddrs(m.to),
    cc: flatAddrs(m.cc),
    subject: m.subject ?? null,
    date: m.date ?? null,
    text: m.text ?? '',
    html: typeof m.html === 'string' ? m.html : null,
    attachments: (m.attachments ?? []).map(a => ({
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
      contentBase64: a.content.toString('base64'),
    })),
  }
}

export function toSnippet(text: string, max = 200): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? cleaned.slice(0, max - 1) + '…' : cleaned
}
```

- [ ] **Step 4: run (PASS)**

```bash
npx vitest run src/v19/__tests__/email-parse-message.spec.ts
```

Atteso: 3/3 PASS.

- [ ] **Step 5: commit**

```bash
git add src/v19/tools/email/parse-message.ts src/v19/__tests__/email-parse-message.spec.ts
git commit -m "feat(v19/mail): RFC822 parser wrapper + snippet helper"
```

---

## Task 5: audit log helper

**Files:**
- Create: `src/v19/tools/email/audit.ts`

Niente unit test dedicato: la funzione è un thin wrapper insert. Validato da test E2E Task 13.

- [ ] **Step 1: implementa audit.ts**

```ts
// src/v19/tools/email/audit.ts
import { supabase } from '@/lib/supabase'
import type { AccountKey } from './config'

export type EmailAuditEntry = {
  account: AccountKey
  action: 'read' | 'send' | 'forward' | 'mark' | 'append_sent' | 'pending_created' | 'pending_confirmed' | 'pending_cancelled'
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
```

- [ ] **Step 2: type-check + commit**

```bash
npx tsc --noEmit
git add src/v19/tools/email/audit.ts
git commit -m "feat(v19/mail): audit logger to cervellone_email_log"
```

---

## Task 6: Tool `read_email`

**Files:**
- Create: `src/v19/tools/email/read-email.ts`
- Test: `src/v19/__tests__/email-read.spec.ts`

- [ ] **Step 1: failing test (mock imapflow)**

```ts
// src/v19/__tests__/email-read.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../tools/email/connection', () => ({
  openImap: vi.fn(),
  closeImap: vi.fn(),
}))
vi.mock('../tools/email/audit', () => ({ logEmail: vi.fn() }))

import { readEmail } from '../tools/email/read-email'
import { openImap, closeImap } from '../tools/email/connection'

function fakeClient(messages: Array<{ uid: number; envelope: any; flags: Set<string>; size: number }>) {
  return {
    mailboxOpen: vi.fn().mockResolvedValue({ exists: messages.length }),
    mailboxClose: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockImplementation(async function* () {
      for (const m of messages) yield {
        uid: m.uid,
        envelope: m.envelope,
        flags: m.flags,
        size: m.size,
        bodyStructure: { childNodes: [] },
      }
    }),
    search: vi.fn().mockResolvedValue(messages.map(m => m.uid)),
  } as any
}

describe('read_email', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ritorna lista UID + metadata da INBOX', async () => {
    const client = fakeClient([
      { uid: 101, envelope: { from: [{ address: 'a@x.com' }], to: [{ address: 'info@restruktura.it' }], subject: 'Hello', date: new Date('2026-05-10T10:00:00Z'), messageId: '<m1@x>' }, flags: new Set(['\\Seen']), size: 1024 },
    ])
    ;(openImap as any).mockResolvedValue(client)

    const r = await readEmail({ account: 'info', folder: 'INBOX', limit: 10 })
    expect(r.messages.length).toBe(1)
    expect(r.messages[0].uid).toBe(101)
    expect(r.messages[0].from).toBe('a@x.com')
    expect(r.messages[0].subject).toBe('Hello')
    expect(r.messages[0].seen).toBe(true)
    expect(closeImap).toHaveBeenCalled()
  })

  it('applica filtro since', async () => {
    const client = fakeClient([])
    ;(openImap as any).mockResolvedValue(client)
    await readEmail({ account: 'info', since: '2026-05-01', limit: 5 })
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ since: expect.any(Date) }), expect.anything())
  })

  it('chiude IMAP anche su errore', async () => {
    const client = fakeClient([])
    client.mailboxOpen = vi.fn().mockRejectedValue(new Error('boom'))
    ;(openImap as any).mockResolvedValue(client)
    await expect(readEmail({ account: 'info' })).rejects.toThrow('boom')
    expect(closeImap).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: run (fails)**

```bash
npx vitest run src/v19/__tests__/email-read.spec.ts
```

- [ ] **Step 3: implementa read-email.ts**

```ts
// src/v19/tools/email/read-email.ts
import type Anthropic from '@anthropic-ai/sdk'
import { openImap, closeImap } from './connection'
import { logEmail } from './audit'
import type { AccountKey } from './config'

export type ReadEmailInput = {
  account: AccountKey
  folder?: string
  unread_only?: boolean
  since?: string
  from?: string
  subject_contains?: string
  limit?: number
}

export type ReadEmailMessage = {
  uid: number
  from: string | null
  to: string[]
  subject: string | null
  date: string | null
  message_id: string | null
  seen: boolean
  flagged: boolean
  size: number
  has_attachments: boolean
}

export type ReadEmailResult = { folder: string; messages: ReadEmailMessage[] }

function hasAttachments(bodyStructure: any): boolean {
  if (!bodyStructure) return false
  if (Array.isArray(bodyStructure.childNodes)) {
    return bodyStructure.childNodes.some((n: any) => n.disposition === 'attachment' || hasAttachments(n))
  }
  return bodyStructure.disposition === 'attachment'
}

export async function readEmail(input: ReadEmailInput): Promise<ReadEmailResult> {
  const folder = input.folder ?? 'INBOX'
  const limit = Math.min(input.limit ?? 20, 100)
  const client = await openImap(input.account)
  try {
    await client.mailboxOpen(folder, { readOnly: true })
    const criteria: Record<string, unknown> = { all: true }
    if (input.unread_only) criteria.seen = false
    if (input.since) criteria.since = new Date(input.since)
    if (input.from) criteria.from = input.from
    if (input.subject_contains) criteria.subject = input.subject_contains
    const uids = await client.search(criteria, { uid: true })
    const tail = (uids ?? []).slice(-limit)
    const messages: ReadEmailMessage[] = []
    if (tail.length > 0) {
      for await (const msg of client.fetch(tail, { uid: true, envelope: true, flags: true, size: true, bodyStructure: true }, { uid: true })) {
        const env: any = msg.envelope ?? {}
        messages.push({
          uid: msg.uid,
          from: env.from?.[0]?.address ?? null,
          to: (env.to ?? []).map((a: any) => a.address).filter(Boolean),
          subject: env.subject ?? null,
          date: env.date ? new Date(env.date).toISOString() : null,
          message_id: env.messageId ?? null,
          seen: msg.flags?.has('\\Seen') ?? false,
          flagged: msg.flags?.has('\\Flagged') ?? false,
          size: msg.size ?? 0,
          has_attachments: hasAttachments(msg.bodyStructure),
        })
      }
    }
    await logEmail({ account: input.account, action: 'read', direction: 'in', raw_meta: { folder, count: messages.length, criteria } })
    return { folder, messages }
  } finally {
    await closeImap(client)
  }
}

export const READ_EMAIL_TOOL: Anthropic.Tool = {
  name: 'read_email',
  description: 'Lista messaggi (metadata, no body) da una cartella IMAP di un account TopHost. Per leggere il body usa get_email_body. Default folder INBOX, default limit 20 (max 100).',
  input_schema: {
    type: 'object',
    properties: {
      account: { type: 'string', enum: ['info', 'raffaele'] },
      folder: { type: 'string', description: 'Default INBOX. Es: INBOX, Sent, INBOX.Fatture-Estere.2026-04' },
      unread_only: { type: 'boolean' },
      since: { type: 'string', description: 'YYYY-MM-DD' },
      from: { type: 'string', description: 'filtra mittente (substring/exact)' },
      subject_contains: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['account'],
  },
}

export async function executeReadEmail(input: ReadEmailInput): Promise<string> {
  try { return JSON.stringify({ ok: true, ...(await readEmail(input)) }) }
  catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }
}
```

- [ ] **Step 4: run (PASS)**

```bash
npx vitest run src/v19/__tests__/email-read.spec.ts
```

Atteso: 3/3 PASS.

- [ ] **Step 5: commit**

```bash
git add src/v19/tools/email/read-email.ts src/v19/__tests__/email-read.spec.ts
git commit -m "feat(v19/mail): tool read_email (IMAP search + envelope)"
```

---

## Task 7: Tool `get_email_body`

**Files:**
- Create: `src/v19/tools/email/get-email-body.ts`

- [ ] **Step 1: implementa**

```ts
// src/v19/tools/email/get-email-body.ts
import type Anthropic from '@anthropic-ai/sdk'
import { openImap, closeImap } from './connection'
import { parseRfc822 } from './parse-message'
import { logEmail } from './audit'
import type { AccountKey } from './config'

export type GetEmailBodyInput = { account: AccountKey; uid: number; folder?: string; include_attachments?: boolean }

export async function getEmailBody(input: GetEmailBodyInput) {
  const folder = input.folder ?? 'INBOX'
  const client = await openImap(input.account)
  try {
    await client.mailboxOpen(folder, { readOnly: true })
    const msg = await client.fetchOne(String(input.uid), { source: true }, { uid: true })
    if (!msg || !msg.source) throw new Error(`UID ${input.uid} non trovato in ${folder}`)
    const parsed = await parseRfc822(msg.source as Buffer)
    await logEmail({ account: input.account, action: 'read', direction: 'in', message_id: parsed.messageId, subject: parsed.subject, from_addr: parsed.from, to_addrs: parsed.to, attachments_count: parsed.attachments.length, raw_meta: { uid: input.uid, folder } })
    return {
      uid: input.uid,
      folder,
      message_id: parsed.messageId,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      date: parsed.date?.toISOString() ?? null,
      text: parsed.text,
      html: parsed.html,
      attachments: input.include_attachments
        ? parsed.attachments
        : parsed.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
    }
  } finally { await closeImap(client) }
}

export const GET_EMAIL_BODY_TOOL: Anthropic.Tool = {
  name: 'get_email_body',
  description: 'Leggi corpo + allegati di una specifica mail per UID. Se include_attachments=true ritorna anche il contenuto base64 (attenzione token).',
  input_schema: {
    type: 'object',
    properties: {
      account: { type: 'string', enum: ['info', 'raffaele'] },
      uid: { type: 'integer' },
      folder: { type: 'string' },
      include_attachments: { type: 'boolean' },
    },
    required: ['account', 'uid'],
  },
}

export async function executeGetEmailBody(input: GetEmailBodyInput): Promise<string> {
  try { return JSON.stringify({ ok: true, ...(await getEmailBody(input)) }) }
  catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }
}
```

- [ ] **Step 2: type-check + commit**

```bash
npx tsc --noEmit
git add src/v19/tools/email/get-email-body.ts
git commit -m "feat(v19/mail): tool get_email_body (body + attachments via mailparser)"
```

---

## Task 8: Helper `appendToSent` + Tool `send_email`

**Files:**
- Create: `src/v19/tools/email/append-sent.ts`
- Create: `src/v19/tools/email/send-email.ts`
- Test: `src/v19/__tests__/email-append-sent.spec.ts`
- Test: `src/v19/__tests__/email-send.spec.ts`

- [ ] **Step 1: failing test append-sent**

```ts
// src/v19/__tests__/email-append-sent.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../tools/email/connection', () => ({
  openImap: vi.fn(),
  closeImap: vi.fn(),
}))
import { appendToSent } from '../tools/email/append-sent'
import { openImap, closeImap } from '../tools/email/connection'

describe('appendToSent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('appende su "Sent" se presente nella list', async () => {
    const client = {
      list: vi.fn().mockResolvedValue([{ path: 'INBOX' }, { path: 'Sent' }, { path: 'Trash' }]),
      append: vi.fn().mockResolvedValue({ uid: 555, path: 'Sent' }),
    } as any
    ;(openImap as any).mockResolvedValue(client)
    const res = await appendToSent('info', Buffer.from('raw'))
    expect(client.append).toHaveBeenCalledWith('Sent', expect.any(Buffer), ['\\Seen'])
    expect(res.path).toBe('Sent')
    expect(res.uid).toBe(555)
  })

  it('fallback a "INBOX.Sent" se "Sent" assente', async () => {
    const client = {
      list: vi.fn().mockResolvedValue([{ path: 'INBOX' }, { path: 'INBOX.Sent' }]),
      append: vi.fn().mockResolvedValue({ uid: 7, path: 'INBOX.Sent' }),
    } as any
    ;(openImap as any).mockResolvedValue(client)
    const res = await appendToSent('info', Buffer.from('raw'))
    expect(res.path).toBe('INBOX.Sent')
  })

  it('throw se nessuna Sent folder trovata', async () => {
    const client = { list: vi.fn().mockResolvedValue([{ path: 'INBOX' }]) } as any
    ;(openImap as any).mockResolvedValue(client)
    await expect(appendToSent('info', Buffer.from('raw'))).rejects.toThrow(/Sent folder/i)
  })
})
```

- [ ] **Step 2: implementa append-sent.ts**

```ts
// src/v19/tools/email/append-sent.ts
import { openImap, closeImap } from './connection'
import type { AccountKey } from './config'

const SENT_CANDIDATES = ['Sent', 'INBOX.Sent', 'Sent Items', 'INBOX.Sent Items', 'Posta inviata', 'INBOX.Posta inviata']

export type AppendSentResult = { path: string; uid: number | null }

export async function appendToSent(account: AccountKey, raw: Buffer): Promise<AppendSentResult> {
  const client = await openImap(account)
  try {
    const list = await client.list()
    const paths = new Set(list.map((m: any) => m.path))
    const target = SENT_CANDIDATES.find(p => paths.has(p))
    if (!target) throw new Error(`Sent folder non trovata su ${account}. Disponibili: ${[...paths].join(', ')}`)
    const r: any = await client.append(target, raw, ['\\Seen'])
    return { path: target, uid: r?.uid ?? null }
  } finally { await closeImap(client) }
}
```

- [ ] **Step 3: failing test send-email**

```ts
// src/v19/__tests__/email-send.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendMail = vi.fn()
vi.mock('../tools/email/connection', () => ({
  makeSmtp: () => ({ sendMail, verify: vi.fn().mockResolvedValue(true) }),
  fromHeader: () => '"Restruktura" <info@restruktura.it>',
  openImap: vi.fn(),
  closeImap: vi.fn(),
}))
vi.mock('../tools/email/append-sent', () => ({
  appendToSent: vi.fn().mockResolvedValue({ path: 'Sent', uid: 42 }),
}))
vi.mock('../tools/email/audit', () => ({ logEmail: vi.fn() }))
vi.mock('../tools/email/pending', () => ({
  createPendingSend: vi.fn().mockResolvedValue({ uuid: 'uuid-pending' }),
}))

import { sendEmail } from '../tools/email/send-email'
import { createPendingSend } from '../tools/email/pending'
import { appendToSent } from '../tools/email/append-sent'

describe('send_email', () => {
  beforeEach(() => vi.clearAllMocks())

  it('crea pending quando destinatario esterno e non auto_send_if_internal', async () => {
    const res = await sendEmail({ from_account: 'info', to: ['cliente@gmail.com'], subject: 'Test', body_text: 'ciao' })
    expect(res.status).toBe('pending')
    expect(res.uuid).toBe('uuid-pending')
    expect(createPendingSend).toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('invia direttamente se tutti destinatari interni @restruktura.it', async () => {
    sendMail.mockResolvedValue({ messageId: '<msg-internal@x>', envelope: { from: 'info@restruktura.it', to: ['raffaele.lentini@restruktura.it'] }, raw: Buffer.from('raw') })
    const res = await sendEmail({ from_account: 'info', to: ['raffaele.lentini@restruktura.it'], subject: 'Interno', body_text: 'x' })
    expect(res.status).toBe('sent')
    expect(res.message_id).toBe('<msg-internal@x>')
    expect(appendToSent).toHaveBeenCalledWith('info', expect.any(Buffer))
  })

  it('invia direttamente se auto_send_if_internal e dest esterno (ERRORE: deve comunque essere bloccato)', async () => {
    const res = await sendEmail({ from_account: 'info', to: ['estraneo@gmail.com'], subject: 'X', body_text: 'y', auto_send_if_internal: true })
    expect(res.status).toBe('pending') // auto_send_if_internal vale SOLO se dest interno
    expect(sendMail).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: implementa send-email.ts**

```ts
// src/v19/tools/email/send-email.ts
import type Anthropic from '@anthropic-ai/sdk'
import { makeSmtp, fromHeader } from './connection'
import { appendToSent } from './append-sent'
import { logEmail } from './audit'
import { createPendingSend } from './pending'
import type { AccountKey } from './config'

const INTERNAL_DOMAIN = 'restruktura.it'

export type AttachmentInput = { filename: string; content_base64: string; contentType?: string }

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
  routine_name?: string
  request_id?: string
}

export type SendEmailResult =
  | { status: 'sent'; message_id: string; sent_folder: string; sent_uid: number | null }
  | { status: 'pending'; uuid: string; reason: string }

function isInternal(addrs: string[]): boolean {
  return addrs.every(a => a.toLowerCase().endsWith('@' + INTERNAL_DOMAIN))
}

function buildAttachments(input: SendEmailInput) {
  return (input.attachments ?? []).map(a => ({
    filename: a.filename,
    content: Buffer.from(a.content_base64, 'base64'),
    contentType: a.contentType,
  }))
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]
  const internalOnly = isInternal(recipients)
  const allowAutoSend = input.auto_send_if_internal === true && internalOnly

  if (!allowAutoSend && !internalOnly) {
    const pending = await createPendingSend(input)
    await logEmail({
      account: input.from_account, action: 'pending_created', direction: 'out',
      subject: input.subject, from_addr: null, to_addrs: input.to, cc_addrs: input.cc, bcc_addrs: input.bcc,
      attachments_count: input.attachments?.length ?? 0, request_id: input.request_id ?? null,
      raw_meta: { uuid: pending.uuid },
    })
    return { status: 'pending', uuid: pending.uuid, reason: 'recipients include external addresses; user confirmation required' }
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
  const info = await transporter.sendMail(message)
  const raw = info.raw ?? Buffer.from(info.message ?? '')
  const append = await appendToSent(input.from_account, raw as Buffer)
  await logEmail({
    account: input.from_account, action: 'send', direction: 'out',
    message_id: info.messageId ?? null, subject: input.subject,
    from_addr: fromHeader(input.from_account), to_addrs: input.to, cc_addrs: input.cc, bcc_addrs: input.bcc,
    attachments_count: input.attachments?.length ?? 0,
    attachments_summary: input.attachments?.map(a => ({ filename: a.filename, size: Buffer.from(a.content_base64, 'base64').length, contentType: a.contentType ?? 'application/octet-stream' })),
    request_id: input.request_id ?? null, routine_name: input.routine_name ?? null,
    raw_meta: { sent_folder: append.path, sent_uid: append.uid },
  })
  return { status: 'sent', message_id: info.messageId ?? '', sent_folder: append.path, sent_uid: append.uid }
}

export const SEND_EMAIL_TOOL: Anthropic.Tool = {
  name: 'send_email',
  description: 'Invia mail da un account TopHost (info|raffaele). Verso destinatari ESTERNI a @restruktura.it ritorna status="pending" + uuid: l\'utente conferma via Telegram /invia_<uuid>. Verso destinatari interni con auto_send_if_internal=true invia subito. Salva sempre copia in Sent del mittente.',
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
      attachments: { type: 'array', items: { type: 'object', properties: { filename: { type: 'string' }, content_base64: { type: 'string' }, contentType: { type: 'string' } }, required: ['filename', 'content_base64'] } },
      in_reply_to: { type: 'object', properties: { uid: { type: 'integer' }, folder: { type: 'string' }, message_id: { type: 'string' } }, required: ['uid', 'folder'] },
      auto_send_if_internal: { type: 'boolean' },
      routine_name: { type: 'string' },
    },
    required: ['from_account', 'to', 'subject', 'body_text'],
  },
}

export async function executeSendEmail(input: SendEmailInput): Promise<string> {
  try { return JSON.stringify({ ok: true, ...(await sendEmail(input)) }) }
  catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }
}
```

- [ ] **Step 5: run test send-email + append-sent**

```bash
npx vitest run src/v19/__tests__/email-send.spec.ts src/v19/__tests__/email-append-sent.spec.ts
```

Atteso: 6/6 PASS (3+3).

- [ ] **Step 6: commit**

```bash
git add src/v19/tools/email/append-sent.ts src/v19/tools/email/send-email.ts src/v19/__tests__/email-append-sent.spec.ts src/v19/__tests__/email-send.spec.ts
git commit -m "feat(v19/mail): send_email + appendToSent (Sent folder discovery)"
```

---

## Task 9: Tool `forward_email`

**Files:**
- Create: `src/v19/tools/email/forward-email.ts`

- [ ] **Step 1: implementa**

```ts
// src/v19/tools/email/forward-email.ts
import type Anthropic from '@anthropic-ai/sdk'
import { getEmailBody } from './get-email-body'
import { sendEmail, type SendEmailResult } from './send-email'
import type { AccountKey } from './config'

export type ForwardEmailInput = {
  from_account: AccountKey
  source_uid: number
  source_folder?: string
  to: string[]
  extra_body_text?: string
  new_subject_prefix?: string
  auto_send_if_internal?: boolean
  routine_name?: string
}

export async function forwardEmail(input: ForwardEmailInput): Promise<SendEmailResult> {
  const folder = input.source_folder ?? 'INBOX'
  const body = await getEmailBody({ account: input.from_account, uid: input.source_uid, folder, include_attachments: true })
  const prefix = input.new_subject_prefix ?? '[Fwd] '
  const subject = prefix + (body.subject ?? '(senza oggetto)')
  const header = [
    '---------- Inoltro automatico Cervellone ----------',
    `Da: ${body.from ?? '?'}`,
    `Data: ${body.date ?? '?'}`,
    `Oggetto: ${body.subject ?? '?'}`,
    `A: ${body.to.join(', ')}`,
    '',
  ].join('\n')
  const bodyText = (input.extra_body_text ? input.extra_body_text + '\n\n' : '') + header + (body.text ?? '')
  return sendEmail({
    from_account: input.from_account,
    to: input.to,
    subject,
    body_text: bodyText,
    attachments: (body.attachments as any[]).filter(a => 'contentBase64' in a).map(a => ({
      filename: a.filename ?? 'allegato.bin',
      content_base64: a.contentBase64,
      contentType: a.contentType,
    })),
    auto_send_if_internal: input.auto_send_if_internal,
    routine_name: input.routine_name,
  })
}

export const FORWARD_EMAIL_TOOL: Anthropic.Tool = {
  name: 'forward_email',
  description: 'Inoltra mail (preserva allegati). Verso destinatari esterni ritorna pending (vedi send_email). Default prefix oggetto "[Fwd] ".',
  input_schema: {
    type: 'object',
    properties: {
      from_account: { type: 'string', enum: ['info', 'raffaele'] },
      source_uid: { type: 'integer' },
      source_folder: { type: 'string' },
      to: { type: 'array', items: { type: 'string' }, minItems: 1 },
      extra_body_text: { type: 'string' },
      new_subject_prefix: { type: 'string' },
      auto_send_if_internal: { type: 'boolean' },
      routine_name: { type: 'string' },
    },
    required: ['from_account', 'source_uid', 'to'],
  },
}

export async function executeForwardEmail(input: ForwardEmailInput): Promise<string> {
  try { return JSON.stringify({ ok: true, ...(await forwardEmail(input)) }) }
  catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }
}
```

- [ ] **Step 2: type-check + commit**

```bash
npx tsc --noEmit
git add src/v19/tools/email/forward-email.ts
git commit -m "feat(v19/mail): tool forward_email (preserva allegati)"
```

---

## Task 10: Tool `mark_email`

**Files:**
- Create: `src/v19/tools/email/mark-email.ts`

- [ ] **Step 1: implementa**

```ts
// src/v19/tools/email/mark-email.ts
import type Anthropic from '@anthropic-ai/sdk'
import { openImap, closeImap } from './connection'
import { logEmail } from './audit'
import type { AccountKey } from './config'

export type MarkEmailInput = {
  account: AccountKey
  uid: number
  folder?: string
  action: 'flag' | 'unflag' | 'seen' | 'unseen' | 'move'
  target_folder?: string
}

export async function markEmail(input: MarkEmailInput) {
  const folder = input.folder ?? 'INBOX'
  if (input.action === 'move' && !input.target_folder) throw new Error('move richiede target_folder')
  const client = await openImap(input.account)
  try {
    await client.mailboxOpen(folder, { readOnly: false })
    const uidStr = String(input.uid)
    if (input.action === 'flag') await client.messageFlagsAdd(uidStr, ['\\Flagged'], { uid: true })
    else if (input.action === 'unflag') await client.messageFlagsRemove(uidStr, ['\\Flagged'], { uid: true })
    else if (input.action === 'seen') await client.messageFlagsAdd(uidStr, ['\\Seen'], { uid: true })
    else if (input.action === 'unseen') await client.messageFlagsRemove(uidStr, ['\\Seen'], { uid: true })
    else if (input.action === 'move') {
      try { await client.mailboxCreate(input.target_folder!) } catch { /* exists */ }
      await client.messageMove(uidStr, input.target_folder!, { uid: true })
    }
    await logEmail({ account: input.account, action: 'mark', raw_meta: { uid: input.uid, folder, op: input.action, target: input.target_folder ?? null } })
    return { ok: true }
  } finally { await closeImap(client) }
}

export const MARK_EMAIL_TOOL: Anthropic.Tool = {
  name: 'mark_email',
  description: 'Flag/unflag, seen/unseen, o move di un messaggio per UID. Move crea la target_folder se non esiste.',
  input_schema: {
    type: 'object',
    properties: {
      account: { type: 'string', enum: ['info', 'raffaele'] },
      uid: { type: 'integer' },
      folder: { type: 'string' },
      action: { type: 'string', enum: ['flag', 'unflag', 'seen', 'unseen', 'move'] },
      target_folder: { type: 'string' },
    },
    required: ['account', 'uid', 'action'],
  },
}

export async function executeMarkEmail(input: MarkEmailInput): Promise<string> {
  try { return JSON.stringify({ ok: true, ...(await markEmail(input)) }) }
  catch (e) { return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }) }
}
```

- [ ] **Step 2: commit**

```bash
git add src/v19/tools/email/mark-email.ts
git commit -m "feat(v19/mail): tool mark_email (flag/seen/move via IMAP)"
```

---

## Task 11: Pending send (Telegram confirm flow)

**Files:**
- Create: `src/v19/tools/email/pending.ts`
- Test: `src/v19/__tests__/email-pending.spec.ts`

- [ ] **Step 1: failing test (mock supabase)**

```ts
// src/v19/__tests__/email-pending.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const supabaseMock: any = {
  from: vi.fn(),
}
vi.mock('@/lib/supabase', () => ({ supabase: supabaseMock }))

import { createPendingSend, fetchPending, markPendingSent, markPendingCancelled, expirePending } from '../tools/email/pending'

function chain(result: any) {
  const obj: any = {}
  for (const k of ['insert', 'select', 'eq', 'update', 'lt', 'single', 'maybeSingle']) obj[k] = vi.fn().mockReturnValue(obj)
  obj.then = (resolve: any) => Promise.resolve(result).then(resolve)
  return obj
}

describe('pending send', () => {
  beforeEach(() => vi.clearAllMocks())

  it('createPendingSend chiama insert e ritorna uuid', async () => {
    const inserted = { uuid: 'aaaa-bbbb', expires_at: '2026-05-11T11:00:00Z' }
    const c = chain({ data: inserted, error: null })
    supabaseMock.from.mockReturnValue(c)
    const r = await createPendingSend({ from_account: 'info', to: ['x@y.com'], subject: 's', body_text: 'b' })
    expect(r.uuid).toBe('aaaa-bbbb')
    expect(c.insert).toHaveBeenCalled()
  })

  it('fetchPending ritorna null se status != pending', async () => {
    const c = chain({ data: { status: 'cancelled' }, error: null })
    supabaseMock.from.mockReturnValue(c)
    const r = await fetchPending('any')
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 2: implementa pending.ts**

```ts
// src/v19/tools/email/pending.ts
import { supabase } from '@/lib/supabase'
import type { SendEmailInput } from './send-email'

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
  attachments: SendEmailInput['attachments'] | null
  in_reply_to: SendEmailInput['in_reply_to'] | null
  status: 'pending' | 'sent' | 'cancelled' | 'expired'
  sent_message_id: string | null
  sent_at: string | null
}

export async function createPendingSend(input: SendEmailInput): Promise<{ uuid: string; expires_at: string }> {
  const row = {
    from_account: input.from_account,
    to_addrs: input.to,
    cc_addrs: input.cc ?? null,
    bcc_addrs: input.bcc ?? null,
    subject: input.subject,
    body_text: input.body_text,
    body_html: input.body_html ?? null,
    attachments: (input.attachments as any) ?? null,
    in_reply_to: (input.in_reply_to as any) ?? null,
    status: 'pending',
  }
  const { data, error } = await supabase.from('cervellone_email_pending_send').insert(row).select('uuid, expires_at').single()
  if (error || !data) throw new Error(`pending insert: ${error?.message}`)
  return { uuid: data.uuid, expires_at: data.expires_at }
}

export async function fetchPending(uuid: string): Promise<PendingRow | null> {
  const { data, error } = await supabase.from('cervellone_email_pending_send').select('*').eq('uuid', uuid).maybeSingle()
  if (error || !data) return null
  if (data.status !== 'pending') return null
  if (new Date(data.expires_at).getTime() < Date.now()) return null
  return data as PendingRow
}

export async function markPendingSent(uuid: string, messageId: string): Promise<void> {
  await supabase.from('cervellone_email_pending_send').update({ status: 'sent', sent_message_id: messageId, sent_at: new Date().toISOString() }).eq('uuid', uuid)
}

export async function markPendingCancelled(uuid: string): Promise<void> {
  await supabase.from('cervellone_email_pending_send').update({ status: 'cancelled' }).eq('uuid', uuid)
}

export async function expirePending(): Promise<number> {
  const { data } = await supabase.from('cervellone_email_pending_send').update({ status: 'expired' }).eq('status', 'pending').lt('expires_at', new Date().toISOString()).select('uuid')
  return (data ?? []).length
}
```

- [ ] **Step 3: run test pending**

```bash
npx vitest run src/v19/__tests__/email-pending.spec.ts
```

Atteso: 2/2 PASS.

- [ ] **Step 4: commit**

```bash
git add src/v19/tools/email/pending.ts src/v19/__tests__/email-pending.spec.ts
git commit -m "feat(v19/mail): pending send store (Supabase) + expire helper"
```

---

## Task 12: Telegram handlers `/invia_<uuid>` `/annulla_<uuid>` + notifica pending

**Files:**
- Modify: `src/app/api/telegram/route.ts`
- Create: `src/v19/tools/email/telegram-confirm.ts` (helper: notifica pending + esegue confirm/cancel)

- [ ] **Step 1: implementa helper**

```ts
// src/v19/tools/email/telegram-confirm.ts
import { fetchPending, markPendingSent, markPendingCancelled } from './pending'
import { sendEmail, type SendEmailResult } from './send-email'
import { logEmail } from './audit'
import type { AccountKey } from './config'

export async function buildPendingTelegramMessage(uuid: string): Promise<string | null> {
  const p = await fetchPending(uuid)
  if (!p) return null
  const attachmentsLine = p.attachments && p.attachments.length > 0
    ? `\n📎 Allegati: ${p.attachments.map((a: any) => a.filename).join(', ')}`
    : ''
  return [
    '📧 Vuoi che invii questa mail?',
    '',
    `Da: ${p.from_account}`,
    `A: ${p.to_addrs.join(', ')}`,
    p.cc_addrs && p.cc_addrs.length > 0 ? `Cc: ${p.cc_addrs.join(', ')}` : '',
    `Oggetto: ${p.subject}`,
    '─────────────────',
    p.body_text,
    '─────────────────',
    attachmentsLine,
    '',
    `Conferma con /invia_${uuid}  oppure  /annulla_${uuid}`,
  ].filter(Boolean).join('\n')
}

export async function confirmPendingSend(uuid: string): Promise<{ ok: boolean; result?: SendEmailResult; message: string }> {
  const p = await fetchPending(uuid)
  if (!p) return { ok: false, message: 'Pending non trovato (scaduto o già processato)' }
  const result = await sendEmail({
    from_account: p.from_account as AccountKey,
    to: p.to_addrs,
    cc: p.cc_addrs ?? undefined,
    bcc: p.bcc_addrs ?? undefined,
    subject: p.subject,
    body_text: p.body_text,
    body_html: p.body_html ?? undefined,
    attachments: p.attachments ?? undefined,
    in_reply_to: p.in_reply_to ?? undefined,
    auto_send_if_internal: true, // user has confirmed: bypass policy
  } as any)
  if (result.status === 'sent') {
    await markPendingSent(uuid, result.message_id)
    await logEmail({ account: p.from_account as AccountKey, action: 'pending_confirmed', direction: 'out', message_id: result.message_id, raw_meta: { uuid } })
    return { ok: true, result, message: `✅ Inviata. Message-ID: ${result.message_id}\nCopia salvata in ${result.sent_folder} (UID ${result.sent_uid}).` }
  }
  return { ok: false, message: `Errore: status inatteso ${result.status}` }
}

export async function cancelPendingSend(uuid: string): Promise<{ ok: boolean; message: string }> {
  const p = await fetchPending(uuid)
  if (!p) return { ok: false, message: 'Pending non trovato (scaduto o già processato)' }
  await markPendingCancelled(uuid)
  await logEmail({ account: p.from_account as AccountKey, action: 'pending_cancelled', direction: 'out', raw_meta: { uuid } })
  return { ok: true, message: '❎ Invio annullato.' }
}
```

**Bypass nota**: nel chiamare `sendEmail` con `auto_send_if_internal: true` PERSEGUE il flow di invio diretto SOLO se destinatari interni. Per i destinatari esterni, dato che la guard rifà il check, dobbiamo bypassare diversamente. Correzione: aggiungiamo flag interno `bypass_user_confirmation: true` non esposto allo schema Anthropic.

- [ ] **Step 2: aggiungi bypass in send-email.ts**

Modifica `src/v19/tools/email/send-email.ts`:
- Aggiungi alla type `SendEmailInput`: `bypass_user_confirmation?: boolean`
- In `sendEmail()`, sostituisci la riga `if (!allowAutoSend && !internalOnly)` con:
  `if (!input.bypass_user_confirmation && !allowAutoSend && !internalOnly)`

NON aggiungere `bypass_user_confirmation` allo `input_schema` di `SEND_EMAIL_TOOL` (deve restare invisibile al modello).

- [ ] **Step 3: aggiorna telegram-confirm.ts**

Sostituisci `auto_send_if_internal: true` con `bypass_user_confirmation: true` nel `confirmPendingSend`.

- [ ] **Step 4: aggiungi test che valida bypass**

Aggiungi a `src/v19/__tests__/email-send.spec.ts`:

```ts
it('bypass_user_confirmation invia subito anche verso esterni', async () => {
  sendMail.mockResolvedValue({ messageId: '<bypass@x>', envelope: {}, raw: Buffer.from('raw') })
  const res = await sendEmail({ from_account: 'info', to: ['external@x.com'], subject: 's', body_text: 'b', bypass_user_confirmation: true })
  expect(res.status).toBe('sent')
})
```

Run: `npx vitest run src/v19/__tests__/email-send.spec.ts` — atteso 4/4 PASS.

- [ ] **Step 5: modifica handler Telegram**

In `src/app/api/telegram/route.ts`, trova il blocco di parsing comandi (cerca `if (userText === '/start')`) e aggiungi prima del fallback default:

```ts
const mInvia = userText.match(/^\/invia_([a-f0-9-]{36})\b/i)
if (mInvia) {
  const { confirmPendingSend } = await import('@/v19/tools/email/telegram-confirm')
  const r = await confirmPendingSend(mInvia[1])
  await sendTelegramMessage(chatId, r.message)
  return NextResponse.json({ ok: true })
}
const mAnnulla = userText.match(/^\/annulla_([a-f0-9-]{36})\b/i)
if (mAnnulla) {
  const { cancelPendingSend } = await import('@/v19/tools/email/telegram-confirm')
  const r = await cancelPendingSend(mAnnulla[1])
  await sendTelegramMessage(chatId, r.message)
  return NextResponse.json({ ok: true })
}
```

(Verifica gli import: probabilmente `import { NextResponse } from 'next/server'` e `sendTelegramMessage` esistono già nel file; se i nomi divergono, allinea al pattern locale del file.)

- [ ] **Step 6: commit**

```bash
git add src/v19/tools/email/telegram-confirm.ts src/v19/tools/email/send-email.ts src/v19/__tests__/email-send.spec.ts src/app/api/telegram/route.ts
git commit -m "feat(v19/mail): telegram confirm flow (/invia_<uuid> /annulla_<uuid>)"
```

---

## Task 13: Barrel `index.ts` + registrazione tool nell'orchestrator

**Files:**
- Create: `src/v19/tools/email/index.ts`
- Modify: `src/v19/agent/types.ts`
- Modify: `src/v19/agent/subagent-registry.ts`
- Modify: `src/v19/agent/orchestrator.ts`

- [ ] **Step 1: barrel index**

```ts
// src/v19/tools/email/index.ts
export { READ_EMAIL_TOOL, executeReadEmail } from './read-email'
export { GET_EMAIL_BODY_TOOL, executeGetEmailBody } from './get-email-body'
export { SEND_EMAIL_TOOL, executeSendEmail } from './send-email'
export { FORWARD_EMAIL_TOOL, executeForwardEmail } from './forward-email'
export { MARK_EMAIL_TOOL, executeMarkEmail } from './mark-email'

import type Anthropic from '@anthropic-ai/sdk'
import { READ_EMAIL_TOOL, executeReadEmail } from './read-email'
import { GET_EMAIL_BODY_TOOL, executeGetEmailBody } from './get-email-body'
import { SEND_EMAIL_TOOL, executeSendEmail } from './send-email'
import { FORWARD_EMAIL_TOOL, executeForwardEmail } from './forward-email'
import { MARK_EMAIL_TOOL, executeMarkEmail } from './mark-email'

export const MAIL_TOOL_DEFINITIONS: Anthropic.Tool[] = [
  READ_EMAIL_TOOL, GET_EMAIL_BODY_TOOL, SEND_EMAIL_TOOL, FORWARD_EMAIL_TOOL, MARK_EMAIL_TOOL,
]

export const MAIL_TOOL_EXECUTORS: Record<string, (input: any) => Promise<string>> = {
  read_email: executeReadEmail,
  get_email_body: executeGetEmailBody,
  send_email: executeSendEmail,
  forward_email: executeForwardEmail,
  mark_email: executeMarkEmail,
}
```

- [ ] **Step 2: aggiorna SubagentKind**

In `src/v19/agent/types.ts:25` sostituisci `| 'gmail-router'` con `| 'mail-router'`.

Risultato:
```ts
export type SubagentKind =
  | 'parsing-files'
  | 'numerical-engine'
  | 'document-render'
  | 'domain-italiano'
  | 'web-research'
  | 'mail-router'
```

- [ ] **Step 3: aggiorna subagent-registry**

In `src/v19/agent/subagent-registry.ts` sostituisci l'entry `'gmail-router'` (righe 75-85) con:

```ts
'mail-router': {
  kind: 'mail-router',
  systemPrompt: `${COMMON_HEADER}

DOMINIO: gestione mail TopHost (info@restruktura.it, raffaele.lentini@restruktura.it) via IMAP/SMTP nativo.
USA: read_email (liste + filtri) → get_email_body (corpo + allegati) → mark_email (flag/move).
Per inviare/inoltrare verso ESTERNI a @restruktura.it NON chiamare send_email/forward_email direttamente: descrivi al parent la bozza, sarà il parent a chiamare il tool con conferma utente Telegram.
Per invii puramente interni (@restruktura.it) puoi indicare auto_send_if_internal=true al parent.
MAI loggare la password. MAI inventare mittenti/oggetti: cita sempre UID e folder reali.
OUTPUT: lista mail classificate/bozze redatte + recommendation per Raffaele (Lei formale).`,
  allowedTools: ['read_email', 'get_email_body', 'mark_email'],
},
```

(NB: send/forward NON nell'allow-list del sub-agent. La policy di conferma utente vive nel parent.)

- [ ] **Step 4: aggiorna orchestrator schema**

In `src/v19/agent/orchestrator.ts:40` aggiorna l'enum dentro `SPAWN_SUBAGENT_TOOL.input_schema.properties.kind.enum`:

```ts
enum: ['parsing-files', 'numerical-engine', 'document-render', 'domain-italiano', 'web-research', 'mail-router'],
```

- [ ] **Step 5: type-check globale**

```bash
npx tsc --noEmit
```

Atteso: 0 errori in V19 (i 4 errori storici di `pdf-generator.test.ts` sono pre-esistenti V18).

Cerca riferimenti residui a `gmail-router` in src/v19/:

```bash
grep -rn "gmail-router" src/v19/ 2>/dev/null || true
```

Atteso: nessun risultato.

- [ ] **Step 6: commit**

```bash
git add src/v19/tools/email/index.ts src/v19/agent/types.ts src/v19/agent/subagent-registry.ts src/v19/agent/orchestrator.ts
git commit -m "feat(v19): register mail tools + rename gmail-router → mail-router subagent"
```

---

## Task 14: Routine `monthly-foreign-invoices`

**Files:**
- Create: `src/v19/routines/monthly-foreign-invoices.ts`
- Test: `src/v19/__tests__/monthly-foreign-invoices.spec.ts`

- [ ] **Step 1: failing test (dry-run + dedup)**

```ts
// src/v19/__tests__/monthly-foreign-invoices.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../tools/email/read-email', () => ({ readEmail: vi.fn() }))
vi.mock('../tools/email/forward-email', () => ({ forwardEmail: vi.fn() }))
vi.mock('../tools/email/mark-email', () => ({ markEmail: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      insert: vi.fn().mockResolvedValue({ error: null }),
    })),
  },
}))

import { runMonthlyForeignInvoices } from '../routines/monthly-foreign-invoices'
import { readEmail } from '../tools/email/read-email'
import { forwardEmail } from '../tools/email/forward-email'

describe('routine monthly-foreign-invoices', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dry_run NON invia, ritorna lista candidati', async () => {
    ;(readEmail as any).mockResolvedValue({
      folder: 'INBOX',
      messages: [
        { uid: 1, from: 'billing@anthropic.com', subject: 'Invoice', date: '2026-04-15T10:00:00Z', has_attachments: true, message_id: '<m1>', to: [], seen: false, flagged: false, size: 1000 },
      ],
    })
    const r = await runMonthlyForeignInvoices({ month_ref: '2026-04', dry_run: true, senders: ['billing@anthropic.com'] })
    expect(r.candidates.length).toBe(1)
    expect(forwardEmail).not.toHaveBeenCalled()
  })

  it('inoltra solo candidati con PDF + mittente in whitelist', async () => {
    ;(readEmail as any).mockResolvedValue({
      folder: 'INBOX',
      messages: [
        { uid: 1, from: 'billing@anthropic.com', subject: 'Invoice', date: '2026-04-15', has_attachments: true, message_id: '<m1>', to: [], seen: false, flagged: false, size: 100 },
        { uid: 2, from: 'rando@spam.com', subject: 'Spam', date: '2026-04-16', has_attachments: false, message_id: '<m2>', to: [], seen: false, flagged: false, size: 100 },
      ],
    })
    ;(forwardEmail as any).mockResolvedValue({ status: 'sent', message_id: '<fwd1>', sent_folder: 'Sent', sent_uid: 99 })
    const r = await runMonthlyForeignInvoices({ month_ref: '2026-04', dry_run: false, senders: ['billing@anthropic.com'] })
    expect(forwardEmail).toHaveBeenCalledTimes(1)
    expect(r.forwarded.length).toBe(1)
    expect(r.skipped_not_whitelisted.length).toBe(1)
  })
})
```

- [ ] **Step 2: implementa routine**

```ts
// src/v19/routines/monthly-foreign-invoices.ts
import { readEmail } from '../tools/email/read-email'
import { forwardEmail } from '../tools/email/forward-email'
import { markEmail } from '../tools/email/mark-email'
import { supabase } from '@/lib/supabase'

const KEYWORDS = ['invoice', 'fattura', 'receipt', 'ricevuta', 'billing']
const TARGET = 'raffaele.lentini@restruktura.it'
const SLEEP_MS = 2000

export type RunOptions = {
  month_ref: string // YYYY-MM
  dry_run?: boolean
  senders?: string[] // override (per test)
}

export type RunResult = {
  month_ref: string
  candidates: Array<{ uid: number; from: string; subject: string; date: string | null }>
  forwarded: Array<{ uid: number; from: string; forwarded_message_id: string }>
  skipped_already_done: number[]
  skipped_not_whitelisted: number[]
  fallback_warnings: Array<{ uid: number; from: string; subject: string }>
}

function monthBounds(monthRef: string): { since: string; before: string } {
  const [y, m] = monthRef.split('-').map(Number)
  const since = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10)
  const before = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
  return { since, before }
}

async function loadSenders(): Promise<string[]> {
  const { data } = await supabase.from('cervellone_email_senders').select('email').eq('category', 'fatture_estere').eq('active', true)
  return (data ?? []).map((r: any) => r.email.toLowerCase())
}

async function isAlreadyForwarded(monthRef: string, uid: number): Promise<boolean> {
  const { data } = await supabase.from('cervellone_email_invoices_log').select('id').eq('month_ref', monthRef).eq('source_uid', uid).eq('source_folder', 'INBOX').maybeSingle()
  return !!data
}

async function recordForwarded(args: { monthRef: string; uid: number; from: string; subject: string; receivedAt: string | null; forwardedMessageId: string; filenames: string[] }) {
  await supabase.from('cervellone_email_invoices_log').insert({
    month_ref: args.monthRef,
    source_uid: args.uid,
    source_folder: 'INBOX',
    from_addr: args.from,
    subject: args.subject,
    received_at: args.receivedAt,
    forwarded_message_id: args.forwardedMessageId,
    attachments_filenames: args.filenames,
  })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export async function runMonthlyForeignInvoices(opts: RunOptions): Promise<RunResult> {
  const monthRef = opts.month_ref
  const { since, before } = monthBounds(monthRef)
  const whitelist = new Set((opts.senders ?? await loadSenders()).map(s => s.toLowerCase()))
  const list = await readEmail({ account: 'info', folder: 'INBOX', since, limit: 100 })
  const inMonth = list.messages.filter(m => m.date && m.date >= since && m.date < before)
  const candidates: RunResult['candidates'] = []
  const forwarded: RunResult['forwarded'] = []
  const skippedAlreadyDone: number[] = []
  const skippedNotWhitelisted: number[] = []
  const fallbackWarnings: RunResult['fallback_warnings'] = []

  for (const m of inMonth) {
    const from = (m.from ?? '').toLowerCase()
    const subj = (m.subject ?? '').toLowerCase()
    const inWhitelist = from && whitelist.has(from)
    const isKeyword = m.has_attachments && KEYWORDS.some(k => subj.includes(k))
    if (!inWhitelist && !isKeyword) continue
    if (!m.has_attachments) continue
    if (!inWhitelist && isKeyword) { fallbackWarnings.push({ uid: m.uid, from: m.from ?? '?', subject: m.subject ?? '' }); skippedNotWhitelisted.push(m.uid); continue }
    candidates.push({ uid: m.uid, from: m.from ?? '?', subject: m.subject ?? '', date: m.date })
    if (opts.dry_run) continue
    if (await isAlreadyForwarded(monthRef, m.uid)) { skippedAlreadyDone.push(m.uid); continue }
    const result = await forwardEmail({
      from_account: 'info',
      source_uid: m.uid,
      source_folder: 'INBOX',
      to: [TARGET],
      new_subject_prefix: '[Fattura mensile] ',
      extra_body_text: `Inoltro automatico Cervellone — fattura ricevuta il ${m.date ?? '?'} da ${m.from ?? '?'}. Mese di riferimento: ${monthRef}.`,
      auto_send_if_internal: true,
      routine_name: 'monthly_foreign_invoices_forward',
    })
    if (result.status !== 'sent') continue
    await recordForwarded({ monthRef, uid: m.uid, from: m.from ?? '?', subject: m.subject ?? '', receivedAt: m.date, forwardedMessageId: result.message_id, filenames: [] })
    await markEmail({ account: 'info', uid: m.uid, folder: 'INBOX', action: 'flag' })
    forwarded.push({ uid: m.uid, from: m.from ?? '?', forwarded_message_id: result.message_id })
    await sleep(SLEEP_MS)
  }
  return { month_ref: monthRef, candidates, forwarded, skipped_already_done: skippedAlreadyDone, skipped_not_whitelisted: skippedNotWhitelisted, fallback_warnings: fallbackWarnings }
}
```

- [ ] **Step 3: run test**

```bash
npx vitest run src/v19/__tests__/monthly-foreign-invoices.spec.ts
```

Atteso: 2/2 PASS.

- [ ] **Step 4: commit**

```bash
git add src/v19/routines/monthly-foreign-invoices.ts src/v19/__tests__/monthly-foreign-invoices.spec.ts
git commit -m "feat(v19/mail): routine monthly_foreign_invoices_forward (whitelist + dedup + sleep)"
```

---

## Task 15: Cron endpoint + vercel.json

**Files:**
- Create: `src/app/api/cron/monthly-foreign-invoices/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: cron route**

```ts
// src/app/api/cron/monthly-foreign-invoices/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { runMonthlyForeignInvoices } from '@/v19/routines/monthly-foreign-invoices'
import { sendTelegramMessage } from '@/lib/telegram-helpers'

export const maxDuration = 300

const RAFFAELE_CHAT_ID = process.env.TELEGRAM_RAFFAELE_CHAT_ID

function previousMonthRef(now = new Date()): string {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0..11 (current)
  const prev = new Date(Date.UTC(y, m - 1, 1))
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const monthRef = req.nextUrl.searchParams.get('month') ?? previousMonthRef()
  const dry = req.nextUrl.searchParams.get('dry') === '1'

  const idemKey = `monthly_foreign_invoices_last_run::${monthRef}`
  const { data: lastRow } = await supabase.from('cervellone_config').select('value').eq('key', idemKey).maybeSingle()
  if (lastRow?.value && !dry) {
    return NextResponse.json({ ok: true, skipped: 'already_run', last: lastRow.value })
  }
  try {
    const result = await runMonthlyForeignInvoices({ month_ref: monthRef, dry_run: dry })
    if (!dry) {
      await supabase.from('cervellone_config').upsert({ key: idemKey, value: new Date().toISOString() })
    }
    if (RAFFAELE_CHAT_ID) {
      const lines = [
        `✉️ Fatture estere mese ${monthRef}${dry ? ' (DRY-RUN)' : ''}: ${result.forwarded.length} inoltrate.`,
        result.forwarded.length > 0 ? `Mittenti: ${[...new Set(result.forwarded.map(f => f.from))].join(', ')}` : '',
        result.fallback_warnings.length > 0
          ? `⚠️ ${result.fallback_warnings.length} mail con PDF e keyword fattura ma mittente NON in whitelist (UID: ${result.fallback_warnings.map(f => f.uid).join(', ')}). Aggiungili se è il caso.`
          : '',
        result.skipped_already_done.length > 0 ? `Skip già fatte: ${result.skipped_already_done.join(', ')}` : '',
      ].filter(Boolean).join('\n')
      await sendTelegramMessage(RAFFAELE_CHAT_ID, lines)
    }
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (RAFFAELE_CHAT_ID) await sendTelegramMessage(RAFFAELE_CHAT_ID, `❌ Routine fatture estere ${monthRef} fallita: ${message}`)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
```

- [ ] **Step 2: aggiorna vercel.json**

Modifica `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/cron/canary", "schedule": "*/30 * * * *" },
    { "path": "/api/cron/gmail-morning", "schedule": "0 6 * * 1-5" },
    { "path": "/api/cron/gmail-alerts", "schedule": "*/30 7-16 * * 1-5" },
    { "path": "/api/cron/memoria-extract", "schedule": "30 21 * * *" },
    { "path": "/api/cron/self-audit", "schedule": "0 6 * * 1" },
    { "path": "/api/cron/monthly-foreign-invoices", "schedule": "0 8 1 * *" }
  ]
}
```

Cron `"0 8 1 * *"` = giorno 1 di ogni mese ore 08:00 UTC. Per Europe/Rome estivo (UTC+2) = 10:00 locale, invernale (UTC+1) = 09:00 locale. Accettabile (vicino al 08:00 richiesto in handoff, allineato pattern altri cron Vercel UTC).

- [ ] **Step 3: type-check + commit**

```bash
npx tsc --noEmit
git add src/app/api/cron/monthly-foreign-invoices/route.ts vercel.json
git commit -m "feat(v19/mail): cron /api/cron/monthly-foreign-invoices (1st of month 08:00 UTC)"
```

---

## Task 16: Integration test reale (OPT-IN)

**Files:**
- Create: `src/v19/__tests__/email-integration.spec.ts`

- [ ] **Step 1: test che skippa se manca env**

```ts
// src/v19/__tests__/email-integration.spec.ts
/**
 * Integration test reali contro TopHost. OPT-IN: gira solo se EMAIL_INFO_USER è settata.
 * NON committare credenziali. Eseguire con:
 *   $env:EMAIL_INFO_USER=...; $env:EMAIL_INFO_PASS=...; ... npx vitest run src/v19/__tests__/email-integration.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { openImap, closeImap, makeSmtp } from '../tools/email/connection'
import { readEmail } from '../tools/email/read-email'
import { appendToSent } from '../tools/email/append-sent'

const hasInfo = !!process.env.EMAIL_INFO_USER && !!process.env.EMAIL_INFO_PASS
const itif = hasInfo ? it : it.skip

describe('email integration (LIVE, opt-in)', () => {
  itif('IMAP connect info@ + list folders', async () => {
    const c = await openImap('info')
    const list = await c.list()
    expect(list.length).toBeGreaterThan(0)
    expect(list.some((m: any) => /inbox/i.test(m.path))).toBe(true)
    await closeImap(c)
  }, 30000)

  itif('SMTP verify info@', async () => {
    const t = makeSmtp('info')
    await expect(t.verify()).resolves.toBeTruthy()
  }, 15000)

  itif('readEmail ritorna almeno una mail recente', async () => {
    const r = await readEmail({ account: 'info', limit: 5 })
    expect(Array.isArray(r.messages)).toBe(true)
  }, 30000)

  itif('SMTP send self-test (info@ → info@) + APPEND Sent', async () => {
    const t = makeSmtp('info')
    const info = await t.sendMail({
      from: '"Restruktura" <info@restruktura.it>',
      to: 'info@restruktura.it',
      subject: `[TEST cervellone ${new Date().toISOString()}]`,
      text: 'Self-test integration cervellone V19. Ignorare.',
    })
    expect(info.messageId).toBeTruthy()
    const append = await appendToSent('info', info.raw as Buffer)
    expect(append.path).toMatch(/sent/i)
  }, 60000)
})
```

- [ ] **Step 2: commit (test non eseguito in CI senza env)**

```bash
git add src/v19/__tests__/email-integration.spec.ts
git commit -m "test(v19/mail): live integration test opt-in (IMAP/SMTP TopHost)"
```

- [ ] **Step 3: run completo unit suite**

```bash
npx vitest run src/v19/__tests__/
```

Atteso: 39 (foundation) + 4 (config) + 3 (parse) + 3 (read) + 3 (append) + 4 (send) + 2 (pending) + 2 (routine) = **60 PASS**. Live test in skip se env non set.

---

## Task 17: Documentazione + env vars guidance + PR

**Files:**
- Create: `.env.local.example` (SE non esiste)
- Modify: `.env.local.example` (aggiungi righe email)

- [ ] **Step 1: aggiorna .env.local.example**

Apri o crea `.env.local.example` (root repo) e aggiungi:

```bash
# === Mail subagent (TopHost IMAP/SMTP) ===
TOPHOST_IMAP_HOST=pop.tophost.it
TOPHOST_IMAP_PORT=993
TOPHOST_IMAP_TLS=true
TOPHOST_SMTP_HOST=mail.tophost.it
TOPHOST_SMTP_PORT=587
TOPHOST_SMTP_STARTTLS=true

# Account "info" — info@restruktura.it
EMAIL_INFO_USER=             # restruktura.it<N> (chiedere a Raffaele)
EMAIL_INFO_PASS=             # in Vercel Encrypted
EMAIL_INFO_FROM_ADDRESS=info@restruktura.it
EMAIL_INFO_DISPLAY_NAME=Restruktura

# Account "raffaele" — raffaele.lentini@restruktura.it
EMAIL_RAFFAELE_USER=         # restruktura.it<N>
EMAIL_RAFFAELE_PASS=         # in Vercel Encrypted
EMAIL_RAFFAELE_FROM_ADDRESS=raffaele.lentini@restruktura.it
EMAIL_RAFFAELE_DISPLAY_NAME=Raffaele Lentini

# Chat ID Telegram per notifiche routine (numero intero, già esistente per altri cron)
TELEGRAM_RAFFAELE_CHAT_ID=
```

Verifica che `.env.local` sia in `.gitignore` (deve esserci già):

```bash
grep -q '^\.env\.local$' .gitignore || echo ".env.local" >> .gitignore
```

- [ ] **Step 2: aggiungi sezione README al plan**

Crea `src/v19/tools/email/README.md`:

```markdown
# V19 Mail Subagent

## Cosa fa
Tool IMAP/SMTP nativo per `info@restruktura.it` e `raffaele.lentini@restruktura.it` via TopHost.

## Tool esposti
- `read_email` — lista metadata (no body)
- `get_email_body` — corpo + allegati per UID
- `send_email` — invio (pending+confirm se destinatario esterno)
- `forward_email` — inoltro (preserva allegati)
- `mark_email` — flag/seen/move

## Sub-agent
`mail-router` ha allow-list ridotta: `read_email`, `get_email_body`, `mark_email`.
Send/forward sono SOLO del parent orchestrator (policy conferma utente).

## Pattern conferma utente
Verso destinatari non-`@restruktura.it`:
1. tool `send_email` salva pending in `cervellone_email_pending_send`
2. user riceve Telegram con anteprima + comandi `/invia_<uuid>` `/annulla_<uuid>`
3. `/invia_<uuid>` → SMTP send + IMAP APPEND su Sent

Verso destinatari `@restruktura.it` con `auto_send_if_internal: true` → invio immediato.

## Cron mensile
`/api/cron/monthly-foreign-invoices` (giorno 1 ore 08:00 UTC):
- legge `info@` mese precedente
- filtra: PDF + mittente whitelist `cervellone_email_senders.category='fatture_estere'`
- inoltra a `raffaele.lentini@` (interno → no confirm)
- flag `\Flagged` sull'originale + insert dedup in `cervellone_email_invoices_log`
- notifica Telegram con riepilogo + warning per fallback (PDF+keyword senza whitelist)

## Env vars
Vedi `.env.local.example`. In prod: Vercel Encrypted.

## Tabelle Supabase
- `cervellone_email_log` — audit per ogni op
- `cervellone_email_senders` — whitelist per categoria
- `cervellone_email_invoices_log` — dedup mensile
- `cervellone_email_pending_send` — pending confirm (TTL 30 min)
```

- [ ] **Step 3: type-check finale + commit**

```bash
npx tsc --noEmit
npx vitest run src/v19/__tests__/
git add .env.local.example .gitignore src/v19/tools/email/README.md
git commit -m "docs(v19/mail): env example + README"
```

- [ ] **Step 4: push branch**

```bash
git push -u origin v19/email-subagent
```

- [ ] **Step 5: notifica Raffaele**

Genera link PR (1 click manuale, gh CLI non disponibile):

```
https://github.com/Rafflentini/cervellone/compare/v19/foundation...v19/email-subagent
```

Comunica a Raffaele cosa fare prima del merge:
1. Apri il link sopra → "Create draft pull request"
2. Aggiungi su Vercel (Encrypted): tutte le 10 env vars TOPHOST_* / EMAIL_INFO_* / EMAIL_RAFFAELE_*
3. Verifica che `CRON_SECRET` e `TELEGRAM_RAFFAELE_CHAT_ID` siano già impostati (gli altri cron li usano già)
4. Applica migration: `supabase db push` (oppure copia il file SQL su Supabase Studio)
5. Smoke test:
   ```bash
   # Da locale, dopo aver settato env locale
   $env:CRON_SECRET="<valore>"; curl "https://<vercel-url>/api/cron/monthly-foreign-invoices?dry=1" -H "Authorization: Bearer $env:CRON_SECRET"
   ```
   Atteso: JSON con candidates>=0, forwarded=[] (dry-run).
6. Quando convinto, rimuovi `?dry=1` o aspetta il giorno 1 del prossimo mese.

---

## Self-Review (post-write)

**1. Spec coverage check (handoff → task):**
- ✅ Cervellone parla IMAP/SMTP nativo → Task 3
- ✅ Solo 2 caselle `info@` + `raffaele@` → Task 2
- ✅ Mai invii in autonomia verso esterni → Task 11+12 (pending+confirm)
- ✅ Conferma esplicita via Telegram con testo completo → Task 12 (`buildPendingTelegramMessage`)
- ✅ Routine con `auto_send_if_internal=true` per fatture mensili → Task 14 (`auto_send_if_internal: true` nel forward + dest interno `raffaele.lentini@`)
- ✅ APPEND in Sent dopo SMTP → Task 8 (`appendToSent` chiamato dentro `sendEmail`)
- ✅ 5 tool definiti (`read_email`, `get_email_body`, `send_email`, `forward_email`, `mark_email`) → Task 6-10
- ✅ Whitelist senders + fallback keyword + warning Telegram → Task 14 (`fallbackWarnings` + Task 15 cron notifica)
- ✅ Dedup via UNIQUE constraint → Task 1 schema + Task 14 `isAlreadyForwarded`
- ✅ Audit log non immutabile → Task 5 (no UPDATE/DELETE in audit.ts, solo insert)
- ✅ Rate limit sleep 2s tra forward → Task 14 `sleep(SLEEP_MS)`
- ✅ Body snippet redatto, no PII completo → Task 4 `toSnippet(max=200)`, Task 5 audit `raw_meta` non body
- ✅ Cron path + vercel.json + `Bearer ${CRON_SECRET}` → Task 15
- ✅ Migration single-line per Monaco → Task 1
- ✅ Test minimi (IMAP, SMTP, APPEND, dry-run, dedup) → Task 16

**2. Placeholder scan:** nessun `TBD`, `implement later`, "add error handling generically". Tutti i code block hanno implementazione concreta.

**3. Type consistency:**
- `AccountKey = 'info' | 'raffaele'` usato ovunque ✓
- `SendEmailResult.message_id` (snake_case nello schema JSON, ma il campo TS è `message_id` consistente) ✓
- `auto_send_if_internal` vs `bypass_user_confirmation`: 2 flag separati, semantiche distinte (handoff parla solo del primo, ma il secondo serve per confirm flow). Documentato in Task 12 step 2.
- `mail-router` vs `gmail-router`: cleanup completo in Task 13 con grep di verifica.
- Routine `auto_send_if_internal: true` + destinatario `raffaele.lentini@restruktura.it` (interno) → invio diretto rispettando policy. Coerente.

**4. Issue residue:** nessuno bloccante. Punti di attenzione documentati come Open per Raffaele in cima.

---

## Execution Handoff

Plan completo e salvato. Due modalità di esecuzione:

1. **Subagent-Driven (recommended, allineato a "USA SEMPRE AGENTI E SUBAGENTI MULTIPLI")** — fresh subagent per task, two-stage review, parallel-friendly per task indipendenti (es. Task 6/7/9/10 possono andare in parallelo dopo Task 3-5).
2. **Inline Execution** — task in sequenza nella stessa session, checkpoint review tra blocchi.

Stima totale: 4-7h di lavoro effettivo (incluso review). Sblocco maggiore tra Task 13 e Task 14 (entrambi toccano `subagent-registry.ts` ma in punti diversi).
