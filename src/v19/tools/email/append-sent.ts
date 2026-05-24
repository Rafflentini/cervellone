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

function extractErrDetails(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const parts: string[] = []
    if (e.code) parts.push(`code=${e.code}`)
    if (e.response) parts.push(`response=${String(e.response).slice(0, 200)}`)
    if (e.responseText) parts.push(`responseText=${String(e.responseText).slice(0, 200)}`)
    if (e.responseStatus) parts.push(`status=${e.responseStatus}`)
    if (e.serverResponseCode) parts.push(`serverCode=${e.serverResponseCode}`)
    if (e.message) parts.push(`msg=${e.message}`)
    return parts.length ? parts.join(' | ') : String(err)
  }
  return String(err)
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

    // DIAG: stampa SEMPRE elenco completo folder con attributes per analisi
    const folderDump = list.map((f) => {
      const flags = f.flags
        ? (f.flags instanceof Set ? [...f.flags] : f.flags)
        : []
      return `${f.path}[su=${f.specialUse ?? '-'},flags=${flags.join(',') || '-'}]`
    }).join('; ')
    console.info(`[append-sent] folders(${account}): ${folderDump}`)

    if (!target) {
      console.warn(`[append-sent] no Sent folder for ${account}`)
      throw new Error(
        `Sent folder non trovata su ${account}. Disponibili: ${[...paths].join(', ')}`,
      )
    }

    console.info(
      `[append-sent] target=${target} (byAttr=${byAttr ?? 'none'}, byName=${byName ?? 'none'}, account=${account}, rawLen=${raw.length})`,
    )

    // SUBSCRIBE preventivo: alcuni server Dovecot richiedono mailbox subscribed prima APPEND
    try {
      await (client as unknown as { mailboxSubscribe(path: string): Promise<void> }).mailboxSubscribe(target)
      console.info(`[append-sent] subscribed ${target} ok`)
    } catch (subErr) {
      console.info(`[append-sent] subscribe ${target} skipped: ${extractErrDetails(subErr)}`)
    }

    // Try 1: append con flag \\Seen
    try {
      const r = (await client.append(target, raw, ['\\Seen'])) as { uid?: number } | undefined
      console.info(`[append-sent] try1 (with \\Seen) OK on ${target} uid=${r?.uid ?? 'null'}`)
      return { path: target, uid: r?.uid ?? null }
    } catch (err1) {
      const d1 = extractErrDetails(err1)
      console.warn(`[append-sent] try1 (with \\Seen) failed on ${target}: ${d1}`)

      // Try 2: append senza flag
      try {
        const r2 = (await client.append(target, raw)) as { uid?: number } | undefined
        console.info(`[append-sent] try2 (no flags) OK on ${target} uid=${r2?.uid ?? 'null'}`)
        return { path: target, uid: r2?.uid ?? null }
      } catch (err2) {
        const d2 = extractErrDetails(err2)
        console.warn(`[append-sent] try2 (no flags) failed on ${target}: ${d2}`)

        // Try 3: forza SELECT+APPEND (alcuni server richiedono SELECT prima)
        try {
          const lock = await (client as unknown as { getMailboxLock(path: string): Promise<{ release(): void }> }).getMailboxLock(target)
          try {
            const r3 = (await client.append(target, raw)) as { uid?: number } | undefined
            console.info(`[append-sent] try3 (after SELECT lock) OK on ${target} uid=${r3?.uid ?? 'null'}`)
            return { path: target, uid: r3?.uid ?? null }
          } finally {
            lock.release()
          }
        } catch (err3) {
          const d3 = extractErrDetails(err3)
          console.error(
            `[append-sent] ALL 3 attempts failed on ${target}. try1=${d1} | try2=${d2} | try3=${d3}`,
          )
          throw new Error(`IMAP APPEND failed on ${target} after 3 tries: ${d3}`)
        }
      }
    }
  } finally {
    await closeImap(client)
  }
}
