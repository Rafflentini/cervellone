// src/v19/tools/email/pending.ts
/**
 * Cervellone V19 — Pending send store.
 * Tabella cervellone_email_pending_send: salva draft outbound verso destinatari
 * esterni in attesa di conferma utente via Telegram (/invia_<uuid> | /annulla_<uuid>).
 * TTL 30 minuti (default DB).
 */
import { supabase } from '@/lib/supabase'
import type { SendEmailInput, AttachmentInput } from './types'

export type PendingRow = {
  uuid: string
  created_at: string
  expires_at: string
  from_account: string
  to_addrs: string[]
  cc_addrs: string[] | null
  bcc_addrs: string[] | null
  subject: string
  body_text: string
  body_html: string | null
  attachments: AttachmentInput[] | null
  in_reply_to: SendEmailInput['in_reply_to'] | null
  status: 'pending' | 'sent' | 'cancelled' | 'expired' | 'sent_failed'
  sent_message_id: string | null
  sent_at: string | null
}

/**
 * Esito di una transizione di stato su pending.
 * - ok:true → riga aggiornata atomicamente (UPDATE...WHERE status='pending' RETURNING)
 * - ok:false, reason:'already_processed' → la riga c'era ma lo status non era 'pending'
 *   (race condition: un altro webhook ha già processato), oppure non esiste
 * - ok:false, reason:'not_found' → uuid sconosciuto (riservato per usi futuri)
 * - ok:false, reason:'expired' → riservato per usi futuri (oggi `fetchPending` filtra
 *   prima a livello applicativo)
 * - ok:false, reason:'db_error' → errore Supabase
 */
export type PendingTransitionResult =
  | { ok: true }
  | { ok: false; reason: 'already_processed' | 'not_found' | 'expired' | 'db_error'; error?: string }

export async function createPendingSend(
  input: SendEmailInput,
): Promise<{ uuid: string; expires_at: string }> {
  const row = {
    from_account: input.from_account,
    to_addrs: input.to,
    cc_addrs: input.cc ?? null,
    bcc_addrs: input.bcc ?? null,
    subject: input.subject,
    body_text: input.body_text,
    body_html: input.body_html ?? null,
    attachments: input.attachments ?? null,
    in_reply_to: input.in_reply_to ?? null,
    status: 'pending',
  }
  const { data, error } = await supabase
    .from('cervellone_email_pending_send')
    .insert(row)
    .select('uuid, expires_at')
    .single()
  if (error || !data) throw new Error(`pending insert: ${error?.message ?? 'no data'}`)
  return { uuid: data.uuid, expires_at: data.expires_at }
}

export async function fetchPending(uuid: string): Promise<PendingRow | null> {
  const { data, error } = await supabase
    .from('cervellone_email_pending_send')
    .select('*')
    .eq('uuid', uuid)
    .maybeSingle()
  if (error || !data) return null
  if (data.status !== 'pending') return null
  if (new Date(data.expires_at).getTime() < Date.now()) return null
  return data as PendingRow
}

/**
 * Transizione atomica pending → sent.
 *
 * **Race condition fix (P0):** se due webhook Telegram arrivano simultanei per lo
 * stesso `/invia_<uuid>`, entrambi possono superare il check `fetchPending()` e
 * tentare l'UPDATE. La guardia `WHERE status='pending'` garantisce che solo UNO
 * dei due effettivamente aggiorni la riga; l'altro riceve `data.length === 0` e
 * ritorna `{ ok:false, reason:'already_processed' }` SENZA inviare la mail.
 *
 * @returns
 *   - `{ ok: true }` se la riga era pending ed è stata marcata sent
 *   - `{ ok: false, reason: 'already_processed' }` se status già diverso da 'pending'
 *   - `{ ok: false, reason: 'db_error' }` su errore Supabase
 */
export async function markPendingSent(
  uuid: string,
  messageId: string,
): Promise<PendingTransitionResult> {
  const { data, error } = await supabase
    .from('cervellone_email_pending_send')
    .update({ status: 'sent', sent_message_id: messageId, sent_at: new Date().toISOString() })
    .eq('uuid', uuid)
    .eq('status', 'pending')
    .select('uuid')
  if (error) return { ok: false, reason: 'db_error', error: error.message }
  if (!data || data.length === 0) return { ok: false, reason: 'already_processed' }
  return { ok: true }
}

/**
 * Aggiorna SOLO il sent_message_id di un pending già marcato 'sent'.
 * Usato dopo claim atomico in telegram-confirm: prima si marca 'sent' con
 * placeholder per chiudere la race SMTP, poi si scrive il messageId reale.
 * Best effort: errori loggati, non thrown.
 */
export async function updatePendingMessageId(
  uuid: string,
  messageId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('cervellone_email_pending_send')
    .update({ sent_message_id: messageId })
    .eq('uuid', uuid)
    .eq('status', 'sent')
  if (error) {
    console.warn('[pending] updatePendingMessageId failed', { uuid, error: error.message })
    return { ok: false, error: error.message }
  }
  return { ok: true }
}

/**
 * Transizione atomica pending → cancelled.
 *
 * **Race condition fix (P0):** stesso pattern di `markPendingSent`. Accetta come
 * stato di partenza SOLO 'pending' — se l'utente ha già cliccato /invia (status='sent')
 * o /annulla (status='cancelled'), la seconda call ritorna `already_processed`.
 *
 * @returns
 *   - `{ ok: true }` se la riga era pending ed è stata marcata cancelled
 *   - `{ ok: false, reason: 'already_processed' }` se status già diverso da 'pending'
 *   - `{ ok: false, reason: 'db_error' }` su errore Supabase
 */
export async function markPendingCancelled(uuid: string): Promise<PendingTransitionResult> {
  const { data, error } = await supabase
    .from('cervellone_email_pending_send')
    .update({ status: 'cancelled' })
    .eq('uuid', uuid)
    .eq('status', 'pending')
    .select('uuid')
  if (error) return { ok: false, reason: 'db_error', error: error.message }
  if (!data || data.length === 0) return { ok: false, reason: 'already_processed' }
  return { ok: true }
}

/**
 * Marca come 'expired' tutti i pending oltre la soglia.
 *
 * Storicamente: la colonna DB `expires_at` ha default `now() + 30 min` e
 * `fetchPending()` rigetta a runtime i pending scaduti — ma le righe restavano
 * indefinitamente in DB. Questa funzione è chiamata dal cron
 * `/api/cron/expire-pending` (vercel.json) per pulire periodicamente.
 *
 * @param thresholdMin minuti di vita massima oltre i quali un pending è scaduto.
 *   Default 30 (allineato al default DB). Implementato come `expires_at < now()`
 *   se thresholdMin === 30; altrimenti come `created_at < now() - thresholdMin`.
 *
 * @returns `{ expired: number }` quante righe sono state marcate.
 */
export async function expirePendingOlderThan(
  thresholdMin = 30,
): Promise<{ expired: number }> {
  // Se il chiamante usa il default 30 min, ci fidiamo della colonna `expires_at`
  // (popolata dal DB con `now() + 30 min`). Altrimenti calcoliamo un cutoff
  // basato su `created_at` per onorare la soglia custom.
  const query = supabase
    .from('cervellone_email_pending_send')
    .update({ status: 'expired' })
    .eq('status', 'pending')

  const filtered =
    thresholdMin === 30
      ? query.lt('expires_at', new Date().toISOString())
      : query.lt('created_at', new Date(Date.now() - thresholdMin * 60_000).toISOString())

  const { data, error } = await filtered.select('uuid')
  if (error) throw new Error(`expirePendingOlderThan: ${error.message}`)
  return { expired: (data ?? []).length }
}

/**
 * @deprecated Usa `expirePendingOlderThan()`. Mantenuto per compat. con eventuali
 * caller esistenti finché non viene rimosso.
 */
export async function expirePending(): Promise<number> {
  const { expired } = await expirePendingOlderThan(30)
  return expired
}
