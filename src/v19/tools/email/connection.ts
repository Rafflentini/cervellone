// src/v19/tools/email/connection.ts
/**
 * Cervellone V19 — Factory IMAP/SMTP per account TopHost.
 * Apertura/chiusura per-call (no pool persistente: Vercel functions sono
 * stateless e short-lived, pool diventerebbe stale tra invocations).
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
    // connectionTimeout copre la fase TCP dial (socketTimeout copre solo dopo handshake).
    // Senza questo, dial a host irraggiungibile può appendere la function fino al maxDuration.
    connectionTimeout: 15_000,
  }
  const client = new ImapFlow(opts)
  await client.connect()
  return client
}

export async function closeImap(client: ImapFlow): Promise<void> {
  try {
    await client.logout()
  } catch {
    // ignore: connection may already be torn down
  }
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
