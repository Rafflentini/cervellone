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
