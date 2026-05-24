// src/v19/tools/email/append-sent.ts
/**
 * Cervellone V19 — IMAP APPEND helper: salva la copia di una mail inviata via
 * SMTP nella folder "Sent" del mittente, così Outlook desktop/mobile la vede.
 * Discovery delle folder candidate per coprire variazioni di server config.
 */
import { openImap, closeImap } from './connection'
import type { AccountKey } from './config'

// Folder candidate names + IMAP attribute fallback (\\Sent special-use flag, RFC 6154).
// Ordine: nome esatto comune prima, poi varianti italiane, poi discovery via attribute.
const SENT_CANDIDATES = [
  'Sent',
  'INBOX.Sent',
  'Sent Items',
  'INBOX.Sent Items',
  'Posta inviata',
  'INBOX.Posta inviata',
  'INBOX.Sent Messages',
  'Sent Messages',
  'INBOX.Inviata',
  'Inviata',
  'INBOX.Inviati',
  'Inviati',
]

export type AppendSentResult = { path: string; uid: number | null }

type ImapFolder = {
  path: string
  specialUse?: string
  flags?: Set<string> | string[]
}

function discoverSentByAttribute(list: ImapFolder[]): string | null {
  for (const f of list) {
    if (f.specialUse === '\\Sent') return f.path
    const flags = f.flags
    if (flags && typeof flags !== 'string') {
      const flagArr = flags instanceof Set ? [...flags] : flags
      if (flagArr.some((x) => x === '\\Sent')) return f.path
    }
  }
  return null
}

export async function appendToSent(account: AccountKey, raw: Buffer): Promise<AppendSentResult> {
  const client = await openImap(account)
  try {
    const list = (await client.list()) as ImapFolder[]
    const paths = new Set(list.map((m) => m.path))

    // 1) Discovery via IMAP \\Sent special-use attribute (più affidabile)
    const byAttr = discoverSentByAttribute(list)
    // 2) Fallback su SENT_CANDIDATES nomi noti
    const byName = SENT_CANDIDATES.find((p) => paths.has(p))
    const target = byAttr ?? byName

    if (!target) {
      const available = [...paths].join(', ')
      console.warn(`[append-sent] no Sent folder for ${account}. Available: ${available}`)
      throw new Error(
        `Sent folder non trovata su ${account}. Disponibili: ${available}`,
      )
    }

    console.info(
      `[append-sent] target=${target} (byAttr=${byAttr ?? 'none'}, byName=${byName ?? 'none'}, account=${account})`,
    )

    // Try 1: append con flag \\Seen
    try {
      const r = (await client.append(target, raw, ['\\Seen'])) as { uid?: number } | undefined
      return { path: target, uid: r?.uid ?? null }
    } catch (err1) {
      const msg1 = err1 instanceof Error ? err1.message : String(err1)
      console.warn(`[append-sent] try1 (with \\Seen) failed on ${target}: ${msg1}`)

      // Try 2: append senza flag (alcuni server IMAP rifiutano flag argument)
      try {
        const r2 = (await client.append(target, raw)) as { uid?: number } | undefined
        console.info(`[append-sent] try2 (no flags) succeeded on ${target}`)
        return { path: target, uid: r2?.uid ?? null }
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2)
        console.error(
          `[append-sent] BOTH attempts failed on ${target}. try1=${msg1} | try2=${msg2} | available=${[...paths].join(', ')}`,
        )
        throw new Error(`IMAP APPEND failed on ${target}: ${msg2} (try1: ${msg1})`)
      }
    }
  } finally {
    await closeImap(client)
  }
}
