// src/v19/tools/email/telegram-confirm.ts
/**
 * Cervellone V19 — Telegram confirm flow per send esterni.
 *
 * Quando send_email crea un pending (destinatario esterno), il parent
 * orchestrator notifica Raffaele con buildPendingTelegramMessage().
 * Quando Raffaele digita /invia_<uuid> il bot Telegram chiama
 * confirmPendingSend() che bypassa la policy e invia. /annulla_<uuid>
 * chiama cancelPendingSend().
 */
import { fetchPending, markPendingSent, markPendingCancelled } from './pending'
import { sendEmail } from './send-email'
import type { SendEmailResult } from './types'
import { logEmail } from './audit'
import type { AccountKey } from './config'

export async function buildPendingTelegramMessage(uuid: string): Promise<string | null> {
  const p = await fetchPending(uuid)
  if (!p) return null
  const attachmentsLine =
    p.attachments && p.attachments.length > 0
      ? `\n📎 Allegati: ${p.attachments.map((a) => a.filename).join(', ')}`
      : ''
  const ccLine = p.cc_addrs && p.cc_addrs.length > 0 ? `Cc: ${p.cc_addrs.join(', ')}` : ''
  return [
    '📧 Vuoi che invii questa mail?',
    '',
    `Da: ${p.from_account}`,
    `A: ${p.to_addrs.join(', ')}`,
    ccLine,
    `Oggetto: ${p.subject}`,
    '─────────────────',
    p.body_text,
    '─────────────────',
    attachmentsLine,
    '',
    `Conferma con /invia_${uuid}  oppure  /annulla_${uuid}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export async function confirmPendingSend(
  uuid: string,
): Promise<{ ok: boolean; result?: SendEmailResult; message: string }> {
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
    bypass_user_confirmation: true, // utente ha confermato via Telegram
  })
  if (result.status === 'sent') {
    await markPendingSent(uuid, result.message_id)
    await logEmail({
      account: p.from_account as AccountKey,
      action: 'pending_confirmed',
      direction: 'out',
      message_id: result.message_id,
      raw_meta: { uuid },
    })
    return {
      ok: true,
      result,
      message: `✅ Inviata. Message-ID: ${result.message_id}\nCopia salvata in ${result.sent_folder} (UID ${result.sent_uid ?? '?'}).`,
    }
  }
  return { ok: false, message: `Errore: status inatteso ${result.status}` }
}

export async function cancelPendingSend(uuid: string): Promise<{ ok: boolean; message: string }> {
  const p = await fetchPending(uuid)
  if (!p) return { ok: false, message: 'Pending non trovato (scaduto o già processato)' }
  await markPendingCancelled(uuid)
  await logEmail({
    account: p.from_account as AccountKey,
    action: 'pending_cancelled',
    direction: 'out',
    raw_meta: { uuid },
  })
  return { ok: true, message: '❎ Invio annullato.' }
}
