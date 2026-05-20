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

function requireEnv(key: string): string {
  const v = process.env[key]
  if (!v || v.trim() === '') throw new EmailConfigError(`Env mancante: ${key}`)
  return v
}

function parsePort(key: string, raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new EmailConfigError(`${key} non è una porta valida (1-65535): "${raw}"`)
  }
  return n
}

function parseBool(key: string, raw: string): boolean {
  const v = raw.toLowerCase().trim()
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  throw new EmailConfigError(`${key} deve essere true|false|1|0|yes|no, ricevuto: "${raw}"`)
}

function getServer() {
  return {
    imap: {
      host: requireEnv('TOPHOST_IMAP_HOST'),
      port: parsePort('TOPHOST_IMAP_PORT', requireEnv('TOPHOST_IMAP_PORT')),
      secure: parseBool('TOPHOST_IMAP_TLS', requireEnv('TOPHOST_IMAP_TLS')),
    },
    smtp: {
      host: requireEnv('TOPHOST_SMTP_HOST'),
      port: parsePort('TOPHOST_SMTP_PORT', requireEnv('TOPHOST_SMTP_PORT')),
      requireTLS: parseBool('TOPHOST_SMTP_STARTTLS', requireEnv('TOPHOST_SMTP_STARTTLS')),
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
