// src/v19/tools/email/mark-email.ts
/**
 * Cervellone V19 — Tool mark_email.
 * Flag/unflag, seen/unseen, o move di un messaggio per UID.
 * "move" crea la target_folder se non esiste.
 */
import type Anthropic from '@anthropic-ai/sdk'
import { openImap, closeImap } from './connection'
import { logEmail } from './audit'
import type { AccountKey } from './config'

export type MarkEmailAction = 'flag' | 'unflag' | 'seen' | 'unseen' | 'move'

export type MarkEmailInput = {
  account: AccountKey
  uid: number
  folder?: string
  action: MarkEmailAction
  target_folder?: string
}

export async function markEmail(input: MarkEmailInput): Promise<{ ok: true }> {
  const folder = input.folder ?? 'INBOX'
  if (input.action === 'move' && !input.target_folder) {
    throw new Error('move richiede target_folder')
  }
  const client = await openImap(input.account)
  try {
    await client.mailboxOpen(folder, { readOnly: false })
    const uidStr = String(input.uid)
    switch (input.action) {
      case 'flag':
        await client.messageFlagsAdd(uidStr, ['\\Flagged'], { uid: true })
        break
      case 'unflag':
        await client.messageFlagsRemove(uidStr, ['\\Flagged'], { uid: true })
        break
      case 'seen':
        await client.messageFlagsAdd(uidStr, ['\\Seen'], { uid: true })
        break
      case 'unseen':
        await client.messageFlagsRemove(uidStr, ['\\Seen'], { uid: true })
        break
      case 'move':
        try {
          await client.mailboxCreate(input.target_folder as string)
        } catch {
          // folder già esiste — ignore
        }
        await client.messageMove(uidStr, input.target_folder as string, { uid: true })
        break
    }
    await logEmail({
      account: input.account,
      action: 'mark',
      raw_meta: {
        uid: input.uid,
        folder,
        op: input.action,
        target: input.target_folder ?? null,
      },
    })
    return { ok: true }
  } finally {
    await closeImap(client)
  }
}

export const MARK_EMAIL_TOOL: Anthropic.Tool = {
  name: 'mark_email',
  description:
    'Flag/unflag, seen/unseen, o move di un messaggio per UID. Move crea la target_folder se non esiste.',
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
  try {
    const result = await markEmail(input)
    return JSON.stringify({ ...result, ok: true })
  } catch (e) {
    return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}
