// src/v19/tools/email/append-sent.ts
/**
 * Cervellone V19 — IMAP APPEND helper: salva la copia di una mail inviata via
 * SMTP nella folder "Sent" del mittente, così Outlook desktop/mobile la vede.
 * Discovery delle folder candidate per coprire variazioni di server config.
 */
import { openImap, closeImap } from './connection'
import type { AccountKey } from './config'

const SENT_CANDIDATES = [
  'Sent',
  'INBOX.Sent',
  'Sent Items',
  'INBOX.Sent Items',
  'Posta inviata',
  'INBOX.Posta inviata',
]

export type AppendSentResult = { path: string; uid: number | null }

export async function appendToSent(account: AccountKey, raw: Buffer): Promise<AppendSentResult> {
  const client = await openImap(account)
  try {
    const list = await client.list()
    const paths = new Set(list.map((m: { path: string }) => m.path))
    const target = SENT_CANDIDATES.find((p) => paths.has(p))
    if (!target) {
      throw new Error(
        `Sent folder non trovata su ${account}. Disponibili: ${[...paths].join(', ')}`,
      )
    }
    const r = (await client.append(target, raw, ['\\Seen'])) as { uid?: number } | undefined
    return { path: target, uid: r?.uid ?? null }
  } finally {
    await closeImap(client)
  }
}
