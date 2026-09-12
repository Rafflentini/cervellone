// src/v19/tools/email/pending.ts
/**
 * Cervellone V19 — Pending send store.
 * Tabella cervellone_email_pending_send: salva draft outbound verso destinatari
 * esterni in attesa di conferma utente via Telegram (/invia_<uuid> | /annulla_<uuid>).
 * TTL 30 minuti (default DB).
 */
import { getSupabaseServer } from '@/lib/supabase-server'
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
  conversation_id: string | null
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

/**
 * Due elenchi di destinatari sono lo stesso destinatario? Confronto per
 * INSIEME, non per ordine: `[a, b]` e `[b, a]` sono la stessa mail, e il
 * modello non garantisce l'ordine fra un tentativo e l'altro.
 */
function stessiDestinatari(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const norm = (x: string[]) => [...x].map((s) => s.trim().toLowerCase()).sort()
  const na = norm(a)
  const nb = norm(b)
  return na.every((v, i) => v === nb[i])
}

/**
 * Crea il pending, oppure RIUSA quello identico che è già in attesa.
 *
 * 🚨 Perché la deduplica sta QUI e non nei tool: `createPendingSend` è
 * l'imbuto unico. `send_email` e `send_email_with_attachments` (e anche
 * `forward_email` e `pack_emails_and_send`) passano tutti da
 * `sendEmailInternal`, che chiama questa funzione in un punto solo. Metterla
 * nei tool vorrebbe dire scriverla quattro volte e dimenticarsene in uno —
 * che è come sono nate quasi tutte le divergenze di questo repo.
 *
 * Il difetto che chiude, misurato il 12 set 2026: il bot chiedeva «mi dica
 * "invia"», l'Ingegnere scriveva «Invia», la regola non lo riconosceva e il
 * modello leggeva la parola come una RICHIESTA NUOVA, preparando un'altra
 * bozza. In `cervellone_email_pending_send` sono finite CINQUE bozze identiche
 * in attesa. Cinque bozze non sono solo disordine: fanno scattare la guardia
 * anti-ambiguità, che a quel punto rifiuta la conferma a parole e chiede il
 * codice — cioè la cosa che dal telefono lui non riusciva a usare.
 *
 * La regola della conferma è stata allargata, ma questa difesa serve comunque:
 * un doppione può nascere da qualunque ripetizione, non solo da quella.
 */
export async function createPendingSend(
  input: SendEmailInput,
): Promise<{ uuid: string; expires_at: string; riusato: boolean }> {
  const supabase = getSupabaseServer()

  // Cerco un pending valido con STESSO oggetto e STESSI destinatari.
  const { data: esistenti, error: erroreRicerca } = await supabase
    .from('cervellone_email_pending_send')
    .select('uuid, expires_at, to_addrs')
    .eq('status', 'pending')
    .eq('subject', input.subject)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
  if (erroreRicerca) {
    // Qui il guasto NON diventa un'assenza silenziosa: viene detto a log, e si
    // procede a creare. È l'unica direzione sicura — al peggio nasce un
    // doppione, che è disordine; il contrario (non creare) perderebbe una mail
    // che l'Ingegnere ha chiesto di preparare. Nessuna mail viene inviata in
    // nessuno dei due casi: qui si prepara soltanto.
    console.error('[pending] ricerca doppioni fallita, procedo a creare', {
      error: erroreRicerca.message,
      subject: input.subject,
    })
  } else if (esistenti) {
    const gemello = (esistenti as Array<{ uuid: string; expires_at: string; to_addrs: string[] }>)
      .find((r) => stessiDestinatari(r.to_addrs ?? [], input.to))
    if (gemello) {
      console.warn('[pending] bozza identica già in attesa: riuso, non ne creo un\'altra', {
        uuid: gemello.uuid,
        subject: input.subject,
      })
      return { uuid: gemello.uuid, expires_at: gemello.expires_at, riusato: true }
    }
  }

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
  return { uuid: data.uuid, expires_at: data.expires_at, riusato: false }
}

/**
 * Esito della lettura di UN pending per uuid.
 *
 * Le tre assenze VERE (`assente` / `non_piu_pending` / `scaduto`) sono separate
 * dal GUASTO (`errore`) perché vogliono risposte diverse all'Ingegnere: le
 * prime sono un fatto da riferire, il secondo è una cosa nostra che non
 * funziona, e dirgli «non trovato» quando il database non risponde lo manda a
 * cercare un problema che non ha.
 */
export type EsitoLetturaPending =
  | { ok: true; pending: PendingRow }
  | { ok: false; motivo: 'assente' | 'non_piu_pending' | 'scaduto' }
  | { ok: false; motivo: 'errore'; error: string }

export async function fetchPending(uuid: string): Promise<EsitoLetturaPending> {
  const supabase = getSupabaseServer()
  const { data, error } = await supabase
    .from('cervellone_email_pending_send')
    .select('*')
    .eq('uuid', uuid)
    .maybeSingle()
  // 🚨 `if (error || !data) return null` metteva il guasto del database e la
  // riga inesistente nello stesso cassetto. Sono cose diverse e vanno dette
  // diverse: un errore non diventa mai un'assenza.
  if (error) return { ok: false, motivo: 'errore', error: error.message }
  if (!data) return { ok: false, motivo: 'assente' }
  if (data.status !== 'pending') return { ok: false, motivo: 'non_piu_pending' }
  if (new Date(data.expires_at).getTime() < Date.now()) return { ok: false, motivo: 'scaduto' }
  return { ok: true, pending: data as PendingRow }
}

/**
 * Esito della lettura dell'ULTIMO pending valido.
 * `pending: null` con `ok:true` è l'assenza vera: non c'è nessuna bozza.
 */
export type EsitoUltimoPending =
  | { ok: true; pending: PendingRow | null }
  | { ok: false; error: string }

/**
 * Ultimo pending non scaduto (status='pending'). Per la conferma a linguaggio
 * naturale "invia pure mail" senza uuid. Single-user → l'ultimo è quello giusto.
 */
export async function getLatestPendingSend(): Promise<EsitoUltimoPending> {
  const supabase = getSupabaseServer()
  const { data, error } = await supabase
    .from('cervellone_email_pending_send')
    .select('*')
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  return { ok: true, pending: (data as PendingRow | null) ?? null }
}

/**
 * Esito del conteggio dei pending.
 *
 * È un tipo esito e non un `number | null` di proposito: `null` si legge bene
 * con `=== 0` ma si sbaglia con `!count` o con `count > 1`, e il compilatore
 * non obbliga nessuno ad accorgersene. Con due varianti, `tsc` costringe ogni
 * chiamante a dire cosa fa del «non lo so» — che NON è «zero».
 */
export type ConteggioPending =
  | { ok: true; count: number }
  | { ok: false; error: string }

/**
 * Conta i pending validi (status='pending', non scaduti). Stessi filtri di
 * `getLatestPendingSend`. Usato dalla conferma a linguaggio naturale per
 * rilevare l'ambiguità multi-pending (più bozze pronte contemporaneamente).
 *
 * 🚨 Due difetti vissuti qui dal 4 giugno 2026 (commit dd20348, «P0 conferma
 * NL sicura»), per tre mesi, in silenzio:
 *
 * 1. il conteggio chiedeva `count` sulla colonna **`id`**, che in
 *    `cervellone_email_pending_send` NON ESISTE — la chiave è `uuid`. Postgres
 *    rispondeva `42703: column "id" does not exist` a OGNI chiamata.
 * 2. `if (error) return 0` trasformava quell'errore in «non ci sono mail».
 *
 * Insieme: `confirmLatestPendingSend` cadeva SEMPRE nel ramo `count === 0` e
 * rispondeva «non ho una mail pronta da inviare» anche con sei bozze valide in
 * attesa. La guardia anti-ambiguità ha disattivato in silenzio esattamente la
 * funzione che doveva proteggere. Il primo difetto era una riga; il secondo è
 * il motivo per cui nessuno l'ha visto. **Un guasto non deve mai poter passare
 * per un'assenza.**
 */
export async function countValidPendingSends(): Promise<ConteggioPending> {
  const supabase = getSupabaseServer()
  const { count, error } = await supabase
    .from('cervellone_email_pending_send')
    // `uuid`: la tabella non ha una colonna `id`. Chiederla qui rendeva ogni
    // conteggio un errore, e l'errore diventava «zero mail in attesa».
    .select('uuid', { count: 'exact', head: true })
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
  if (error) return { ok: false, error: error.message }
  // `count` nullo = la risposta non porta il conteggio: anche questo è un «non
  // lo so», non uno zero.
  if (count === null || count === undefined) {
    return { ok: false, error: 'conteggio assente nella risposta Supabase' }
  }
  return { ok: true, count }
}

/**
 * Elenco dei pending validi (status='pending', non scaduti), ordinati per
 * created_at desc. Restituisce i campi minimi per costruire un messaggio di
 * disambiguazione (uuid + destinatario + oggetto). Stessi filtri di
 * `getLatestPendingSend`.
 */
export type RigaDisambiguazione = { uuid: string; to_addrs: string[]; subject: string }

/**
 * Esito dell'elenco dei pending validi.
 *
 * 🚨 `if (error || !data) return []` qui era un gradino più in basso dello
 * stesso guasto del conteggio, ma pesa quanto quello: l'elenco serve a dare
 * all'Ingegnere i CODICI con cui scegliere la bozza. Un elenco vuoto per
 * errore lo lascia senza nessun codice da usare — bloccato, e senza sapere
 * perché. Un errore non diventa mai un'assenza.
 */
export type EsitoElencoPending =
  | { ok: true; pendings: RigaDisambiguazione[] }
  | { ok: false; error: string }

export async function listValidPendingSends(): Promise<EsitoElencoPending> {
  const supabase = getSupabaseServer()
  const { data, error } = await supabase
    .from('cervellone_email_pending_send')
    .select('uuid, to_addrs, subject')
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
  if (error) return { ok: false, error: error.message }
  return { ok: true, pendings: (data as RigaDisambiguazione[] | null) ?? [] }
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
  const supabase = getSupabaseServer()
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
  const supabase = getSupabaseServer()
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
  const supabase = getSupabaseServer()
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
  const supabase = getSupabaseServer()
  // Se il chiamante usa il default 30 min, ci fidiamo della colonna `expires_at`
  // (popolata dal DB con `now() + 30 min`). Altrimenti calcoliamo un cutoff
  // basato su `created_at` per onorare la soglia custom.
  //
  // NB: chain unica (no variabile intermedia + ternary su builder Supabase) —
  // pattern precedente causava "TypeError: fetch failed" runtime su Supabase JS v2.
  const cutoffColumn = thresholdMin === 30 ? 'expires_at' : 'created_at'
  const cutoffIso =
    thresholdMin === 30
      ? new Date().toISOString()
      : new Date(Date.now() - thresholdMin * 60_000).toISOString()

  const { data, error } = await supabase
    .from('cervellone_email_pending_send')
    .update({ status: 'expired' })
    .eq('status', 'pending')
    .lt(cutoffColumn, cutoffIso)
    .select('uuid')
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
