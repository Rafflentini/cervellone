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
import {
  fetchPending,
  getLatestPendingSend,
  countValidPendingSends,
  listValidPendingSends,
  markPendingSent,
  markPendingCancelled,
  updatePendingMessageId,
} from './pending'
import { sendEmailInternal } from './send-email'
import type { SendEmailResult } from './types'
import { logEmail } from './audit'
import type { AccountKey } from './config'
import { recordSentMail } from '@/lib/sent-mail'

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
    `✅ Per inviare: scrivi o di’ "invia pure mail"  (oppure /invia_${uuid})`,
    `❌ Per annullare: /annulla_${uuid}`,
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export async function confirmPendingSend(
  uuid: string,
): Promise<{ ok: boolean; result?: SendEmailResult; message: string }> {
  const p = await fetchPending(uuid)
  if (!p) return { ok: false, message: 'Pending non trovato (scaduto o già processato)' }

  // CLAIM ATOMICO: marca 'sent' con placeholder PRIMA del send per chiudere la race SMTP.
  // Se 2 webhook /invia_<uuid> arrivano simultanei, solo uno passa qui.
  const claimMessageId = `claim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const claim = await markPendingSent(uuid, claimMessageId)
  if (!claim.ok) {
    return { ok: false, message: `Pending già processato (${claim.reason ?? 'unknown'})` }
  }

  // SEND vero. Da qui in poi NON possiamo rollbackare la mail.
  let result: SendEmailResult
  try {
    result = await sendEmailInternal(
      {
        from_account: p.from_account as AccountKey,
        to: p.to_addrs,
        cc: p.cc_addrs ?? undefined,
        bcc: p.bcc_addrs ?? undefined,
        subject: p.subject,
        body_text: p.body_text,
        body_html: p.body_html ?? undefined,
        attachments: p.attachments ?? undefined,
        in_reply_to: p.in_reply_to ?? undefined,
      },
      { bypassUserConfirmation: true }, // utente ha confermato via Telegram
    )
  } catch (e) {
    // SMTP failure: DB resta 'sent' con claim placeholder.
    // Logghiamo errore + ritorniamo messaggio esplicito a Raffaele.
    const errMsg = e instanceof Error ? e.message : String(e)
    await logEmail({
      account: p.from_account as AccountKey,
      action: 'pending_confirmed',
      direction: 'out',
      message_id: claimMessageId,
      raw_meta: { uuid, send_error: errMsg, claim_placeholder: true },
    })
    return {
      ok: false,
      message: `❌ Errore SMTP: ${errMsg}\n⚠️ Stato pending è 'sent' con placeholder. Verifica Outlook prima di reinviare manualmente.`,
    }
  }

  if (result.status === 'sent') {
    // Aggiorna messageId reale (best effort, non blocca utente)
    await updatePendingMessageId(uuid, result.message_id)
    await logEmail({
      account: p.from_account as AccountKey,
      action: 'pending_confirmed',
      direction: 'out',
      message_id: result.message_id,
      raw_meta: { uuid },
    })
    // Consapevolezza mail inviate: l'invio ESTERNO avviene qui (non in executeMailWrapper).
    // Se la riga pending ha conversation_id, registra la mail come "già inviata" nella
    // conversazione di origine. Best-effort: non blocca, non lancia.
    if (p.conversation_id) {
      void recordSentMail(p.conversation_id, {
        to: p.to_addrs.join(', '),
        subject: p.subject,
      }).catch(() => {})
    }
    const baseMsg = `✅ Inviata. Message-ID: ${result.message_id}`
    const sentMsg = result.append_failed
      ? `${baseMsg}\n⚠️ ${result.warning ?? 'Copia NON salvata in Sent IMAP'}`
      : `${baseMsg}\nCopia salvata in ${result.sent_folder} (UID ${result.sent_uid ?? '?'}).`
    return {
      ok: true,
      result,
      message: sentMsg,
    }
  }

  return { ok: false, message: `Errore: status inatteso ${result.status}` }
}

/**
 * Conferma l'ULTIMO pending non scaduto senza uuid — per la conferma a
 * linguaggio naturale ("invia pure mail"). Single-user. Mantiene il passo
 * prepara→rivedi→conferma: invia solo un pending già preparato da send_email.
 */
export async function confirmLatestPendingSend(): Promise<{ ok: boolean; message: string }> {
  // STOPGAP anti-ambiguità: la conferma a linguaggio naturale ("invia pure mail")
  // non porta un uuid, quindi è sicura SOLO se esiste un singolo pending valido.
  // Con 2+ pending invierebbe in silenzio il più recente (rischio invio sbagliato):
  // in quel caso NON inviamo e chiediamo il codice esplicito /invia_<uuid>.
  const count = await countValidPendingSends()
  if (count === 0) {
    return { ok: false, message: '📭 Non ho una mail pronta da inviare in questo momento.' }
  }
  if (count > 1) {
    const pendings = await listValidPendingSends()
    const lines = pendings.map(
      (p) => `• A: ${p.to_addrs.join(', ')} — Oggetto: ${p.subject}\n  /invia_${p.uuid}`,
    )
    return {
      ok: false,
      message: [
        `⚠️ Ho ${count} mail pronte da inviare. Per evitare di mandare quella sbagliata,`,
        'usa il codice esplicito della bozza che vuoi inviare:',
        '',
        ...lines,
      ].join('\n'),
    }
  }
  const latest = await getLatestPendingSend()
  if (!latest) {
    return { ok: false, message: '📭 Non ho una mail pronta da inviare in questo momento.' }
  }
  const r = await confirmPendingSend(latest.uuid)
  return { ok: r.ok, message: r.message }
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
