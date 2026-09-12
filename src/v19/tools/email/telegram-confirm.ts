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
import type { EsitoLetturaPending } from './pending'
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
import { confermaFicSenzaSocieta } from '@/lib/conferma-fic'

/**
 * Il messaggio per una lettura di pending che non ha dato una riga.
 *
 * Tiene separate le tre assenze vere dal guasto: fino al 12 set 2026 erano un
 * `null` solo, e «Pending non trovato (scaduto o già processato)» veniva detto
 * anche quando il database non rispondeva — mandando l'Ingegnere a cercare una
 * bozza scaduta che invece era lì.
 */
function messaggioLetturaFallita(
  lettura: Extract<EsitoLetturaPending, { ok: false }>,
  uuid: string,
): string {
  if (lettura.motivo === 'errore') {
    console.error('[pending] lettura pending fallita', { uuid, error: lettura.error })
    return [
      '⚠️ NON ho fatto niente: non riesco a leggere questo invio',
      `(errore nel database: ${lettura.error}).`,
      'Non e\' detto che sia scaduto o gia\' processato — e\' il controllo che non funziona.',
      'Riprovi fra poco col comando che le ho mandato.',
    ].join('\n')
  }
  if (lettura.motivo === 'scaduto') {
    return '⌛ Questo invio e\' scaduto (le bozze valgono 30 minuti). Mi ridica cosa mandare e la ripreparo.'
  }
  if (lettura.motivo === 'non_piu_pending') {
    return '⚠️ Questo invio e\' gia\' stato processato (inviato o annullato) — controlli se la mail e\' partita.'
  }
  return '📭 Non trovo questo invio: il codice non corrisponde a nessuna bozza.'
}

export async function buildPendingTelegramMessage(uuid: string): Promise<string | null> {
  const lettura = await fetchPending(uuid)
  // Qui il `null` resta: il chiamante è il notificatore della bozza appena
  // creata, e se non c'è niente da mostrare non c'è messaggio. Ma il guasto
  // va almeno LOGGATO, perché «non ho notificato la bozza» e «il database non
  // risponde» sono due fatti diversi e finora erano lo stesso silenzio.
  if (!lettura.ok) {
    if (lettura.motivo === 'errore') {
      console.error('[pending] buildPendingTelegramMessage: lettura fallita', {
        uuid,
        error: lettura.error,
      })
    }
    return null
  }
  const p = lettura.pending
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
  const lettura = await fetchPending(uuid)
  if (!lettura.ok) return { ok: false, message: messaggioLetturaFallita(lettura, uuid) }
  const p = lettura.pending

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
  const conteggio = await countValidPendingSends()

  // 🚨 «Non lo so» NON è «zero». Finché il conteggio restituiva un numero, un
  // errore del database diventava uno zero e questo ramo diceva «non ho una
  // mail pronta»: per tre mesi la risposta era una BUGIA, e l'Ingegnere non
  // aveva modo di capire che il guasto era nostro. Qui dichiariamo il guasto e
  // diamo la via d'uscita che non dipende dal conteggio (il comando esplicito
  // arrivato insieme alla bozza).
  if (!conteggio.ok) {
    console.error('[pending] conteggio pending non disponibile', { error: conteggio.error })
    return {
      ok: false,
      message: [
        '⚠️ NON ho inviato niente: non riesco a controllare quali mail sono in attesa',
        `(errore nel database: ${conteggio.error}).`,
        '',
        'Per inviare comunque, usi il comando esplicito che le ho mandato insieme alla',
        'bozza: /invia_<codice> — così l\'invio non dipende da questo controllo.',
      ].join('\n'),
    }
  }

  const count = conteggio.count
  if (count === 0) {
    // Nessuna mail da inviare: la stessa frase-conferma puo' riguardare una
    // BOZZA FIC in attesa. Questo ramo sta a monte di quello FIC nel dispatch
    // Telegram, quindi senza questa delega «confermo» moriva qui con «non ho
    // una mail pronta» e la fattura non nasceva mai — accaduto il 10 set 2026
    // sul saldo SAL n.1 del Condominio Fermi, tre volte di fila.
    const fic = await confermaFicSenzaSocieta()
    if (fic.intercettato) return { ok: true, message: fic.message }
    return { ok: false, message: '📭 Non ho una mail pronta da inviare in questo momento.' }
  }
  if (count > 1) {
    const elenco = await listValidPendingSends()
    // L'elenco è l'unica cosa che gli dà i CODICI per scegliere. Se non riesco
    // a leggerlo, un elenco vuoto lo lascerebbe bloccato senza sapere perché:
    // meglio dire che il controllo è rotto e come uscirne.
    if (!elenco.ok) {
      console.error('[pending] elenco disambiguazione non disponibile', { error: elenco.error })
      return {
        ok: false,
        message: [
          `⚠️ NON ho inviato niente: ci sono ${count} mail in attesa e non riesco a`,
          `elencarle per farle scegliere (errore nel database: ${elenco.error}).`,
          '',
          'Usi il comando esplicito che le ho mandato insieme alla bozza che vuole inviare.',
        ].join('\n'),
      }
    }
    if (elenco.pendings.length === 0) {
      // Lettura riuscita ma vuota, mentre il conteggio dice 2+: discordanza,
      // non assenza. Non si tace e non si inventa.
      return {
        ok: false,
        message: [
          `⚠️ NON ho inviato niente: risultano ${count} mail in attesa ma l'elenco torna vuoto.`,
          'Usi il comando esplicito che le ho mandato insieme alla bozza.',
        ].join('\n'),
      }
    }
    const lines = elenco.pendings.map(
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
  const ultimo = await getLatestPendingSend()
  if (!ultimo.ok) {
    console.error('[pending] rilettura ultimo pending fallita', { error: ultimo.error })
    return {
      ok: false,
      message: [
        '⚠️ NON ho inviato niente: non riesco a rileggere la mail in attesa',
        `(errore nel database: ${ultimo.error}).`,
        'Usi il comando esplicito che le ho mandato insieme alla bozza.',
      ].join('\n'),
    }
  }
  const latest = ultimo.pending
  if (!latest) {
    // Il conteggio ha detto «una», la lettura non la trova: è una discordanza,
    // non un'assenza. Dirla «non ho una mail pronta» ripeterebbe lo stesso
    // errore di classe appena chiuso poche righe sopra.
    return {
      ok: false,
      message: [
        '⚠️ NON ho inviato niente: risulta una mail in attesa ma non riesco a rileggerla.',
        'Usi il comando esplicito /invia_<codice> che le ho mandato con la bozza.',
      ].join('\n'),
    }
  }
  const r = await confirmPendingSend(latest.uuid)
  return { ok: r.ok, message: r.message }
}

export async function cancelPendingSend(uuid: string): Promise<{ ok: boolean; message: string }> {
  const lettura = await fetchPending(uuid)
  if (!lettura.ok) return { ok: false, message: messaggioLetturaFallita(lettura, uuid) }
  const p = lettura.pending
  // L'esito si guarda, come fa il gemello `markPendingSent` poche righe sopra.
  // Buttarlo qui significava dire «annullato» anche quando la riga era rimasta
  // `pending` per un errore del database: quella riga resta il latest pending
  // valido, e la successiva conferma a voce «invia pure la mail» avrebbe
  // spedito a un destinatario ESTERNO la mail appena annullata. Oppure la mail
  // era gia' partita, e l'Ingegnere credeva di averla fermata.
  const annullato = await markPendingCancelled(uuid)
  if (!annullato.ok) {
    if (annullato.reason === 'already_processed') {
      return {
        ok: false,
        message: '⚠️ NON annullato: questo invio era gia\' stato processato — controlli se la mail e\' partita.',
      }
    }
    return {
      ok: false,
      message: '⚠️ NON sono riuscito ad annullare: l\'invio resta in attesa. Riprovi fra poco.',
    }
  }

  await logEmail({
    account: p.from_account as AccountKey,
    action: 'pending_cancelled',
    direction: 'out',
    raw_meta: { uuid },
  })
  return { ok: true, message: '❎ Invio annullato.' }
}
