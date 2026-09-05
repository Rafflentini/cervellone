// src/v19/routines/monthly-foreign-invoices.ts
/**
 * Cervellone V19 — Routine mensile fatture estere.
 *
 * Scandaglia TUTTE E TRE le caselle — info@ (IMAP), raffaele.lentini@ (IMAP) e
 * la Gmail del bot — cerca le fatture dei fornitori esteri del mese precedente
 * e le inoltra a raffaele.lentini@ con oggetto
 * "Fatture estere Restruktura <mese> <anno>".
 *
 * ── Perche' questo file e' stato riscritto il 5 settembre 2026 ────────────────
 * Il cron girava puntuale dal 1° giugno e non aveva MAI inoltrato una fattura:
 * `cervellone_email_invoices_log` era vuota dopo quattro esecuzioni. Misurando
 * le caselle vere sono emerse tre cause, tutte silenziose:
 *
 *  1. CASELLA SBAGLIATA — leggeva solo `info@`, dove da giugno c'erano ZERO
 *     messaggi dei fornitori esteri. Le fatture arrivano su `raffaele.lentini@`
 *     (73 messaggi nello stesso periodo).
 *  2. MITTENTI SBAGLIATI — la whitelist conteneva indirizzi plausibili ma
 *     inesistenti (`billing@anthropic.com`), mentre i mittenti veri usano il
 *     plus-addressing:
 *       invoice+statements@mail.anthropic.com          (Anthropic PBC, USA)
 *       invoice+statements@vercel.com                  (Vercel Inc., USA)
 *       invoice+statements+acct_<id>@stripe.com        (Anthropic Ireland, UE)
 *     Il confronto era per uguaglianza esatta: non poteva riuscire.
 *  3. LETTURA TROPPO CORTA — leggeva 100 messaggi, ma quelle caselle ne
 *     ricevono 230-290 al mese: l'inizio del mese, cioe' quando arrivano le
 *     fatture, cadeva fuori.
 *
 * Nessuna delle tre si e' fatta sentire, perche' "zero fatture inoltrate"
 * somiglia a "questo mese non ce n'erano". Da qui la regola che governa questo
 * file: OGNI scarto va contato e dichiarato nel risultato. Lo zero deve fare
 * rumore. [[feedback_misura_non_e_dato]] [[feedback_controllo_positivo]]
 *
 * ── Forma del codice ─────────────────────────────────────────────────────────
 * Un motore solo, tre ADATTATORI (uno per casella). Il motore non sa da dove
 * arrivano i messaggi. Ma un motore condiviso non rende equipollenti le caselle
 * da solo: per questo esiste un test che verifica che tutte e tre siano davvero
 * collegate, e non due su tre. [[feedback_testare_gli_adattatori_non_il_motore]]
 */
import { readEmail } from '../tools/email/read-email'
import { forwardEmail } from '../tools/email/forward-email'
import { markEmail } from '../tools/email/mark-email'
import { sendEmailInternal } from '../tools/email/send-email'
import { searchGmail, readMessage, scaricaAllegato } from '@/lib/gmail-tools'
import { getSupabaseServer } from '@/lib/supabase-server'
import type { AccountKey } from '../tools/email/config'

const KEYWORDS = ['invoice', 'fattura', 'receipt', 'ricevuta', 'billing']
const TARGET = 'raffaele.lentini@restruktura.it'
/**
 * Gli inoltri partono verso una casella che noi stessi leggiamo: senza questa
 * esclusione il mese dopo li ritroveremmo (allegato PDF + "Fatture estere"
 * nell'oggetto) e li segnaleremmo come mittente sconosciuto, ogni mese, per
 * sempre.
 */
const INDIRIZZI_PROPRI = [
  'raffaele.lentini@restruktura.it',
  'info@restruktura.it',
  // La Gmail del bot: senza, ogni PDF che Cervellone stesso ha spedito da li'
  // con "fattura" nell'oggetto tornerebbe come mittente sconosciuto, ogni mese.
  'restruktura.drive@gmail.com',
]
/**
 * Le caselle ricevono 230-290 messaggi al mese. Con il vecchio limite di 100 la
 * lettura teneva solo gli ultimi 100 uid del mese e buttava via l'inizio del
 * mese — proprio quando arrivano le fatture. 500 e' il massimo che read-email
 * accetta; se anche quello non bastasse, `troncato` lo dice invece di lasciarlo
 * indovinare.
 */
const LIMITE_LETTURA = 500
const LIMITE_GMAIL = 100
const SLEEP_MS = 2000
/**
 * Tetto di tempo del giro. La rotta ha maxDuration 300s. Uno sforo non e' una
 * riga rossa: e' un 504 che non lascia NIENTE — nessun conteggio, nessun
 * avviso — e assomiglia a "non e' partita". A 240s si chiude in anticipo e lo
 * si dichiara.
 */
const BUDGET_MS = 240_000

const MESI = [
  'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
]

// ── Il contratto di una casella ──────────────────────────────────────────────

export type MessaggioCasella = {
  /** Identificativo nella sua casella: uid IMAP (numerico) o id Gmail (esadecimale). */
  chiave: string
  from: string
  subject: string
  /** ISO, oppure null se la casella non lo sa dire. */
  date: string | null
  has_attachments: boolean
}

export type LetturaCasella = {
  messaggi: MessaggioCasella[]
  /** Quanti ne aveva in tutto, se la casella sa dirlo. */
  totale: number
  /** La lettura non ha coperto tutto il periodo: il risultato e' parziale. */
  troncato: boolean
}

export type EsitoInoltro = {
  stato: string
  message_id?: string
  /** I nomi dei file allegati, dove la casella li conosce. */
  filenames?: string[]
}

export type Casella = {
  nome: string
  leggi(since: string, before: string): Promise<LetturaCasella>
  inoltra(m: MessaggioCasella, oggetto: string, testo: string): Promise<EsitoInoltro>
  /** Segna il messaggio come lavorato, dove la casella lo permette. */
  marca?(m: MessaggioCasella): Promise<void>
}

export type RunOptions = {
  /** YYYY-MM */
  month_ref: string
  dry_run?: boolean
  /** Override whitelist (per test). */
  senders?: string[]
  /** Override caselle (per test). Di default: info, raffaele, gmail. */
  caselle?: Casella[]
  /** Pausa fra un inoltro e l'altro, per non martellare l'SMTP. 0 nei test. */
  pausa_ms?: number
  /**
   * Tempo massimo del giro. La rotta ha maxDuration 300s: se si sfora, Vercel
   * tronca la funzione e non arriva NIENTE — ne' il conteggio ne' l'avviso, e
   * un 504 e' indistinguibile da "non e' partita". Meglio chiudere prima
   * dichiarando `tempo_scaduto`.
   */
  budget_ms?: number
}

export type RigaEsito = { casella: string; chiave: string; from: string }

export type RunResult = {
  month_ref: string
  candidates: Array<{ casella: string; chiave: string; from: string; subject: string; date: string | null }>
  forwarded: Array<RigaEsito & { forwarded_message_id: string }>
  skipped_already_done: RigaEsito[]
  skipped_not_whitelisted: RigaEsito[]
  fallback_warnings: Array<RigaEsito & { subject: string }>
  /** Quanti messaggi del mese sono stati esaminati: il denominatore dello zero. */
  esaminati: number
  /** Messaggi trovati nelle caselle nel mese (prima del taglio di lettura). */
  totale_in_casella: number
  /** La lettura non ha coperto tutto il mese in almeno una casella. */
  troncato: boolean
  /** Caselle non vuote ma nessun candidato: sospetto, va detto. */
  nessun_risultato: boolean
  /** Candidati per cui l'inoltro non e' partito (prima erano scartati in silenzio). */
  non_inoltrate: Array<RigaEsito & { stato: string }>
  /** Inoltri riusciti ma NON registrati: rischio doppione il mese dopo. */
  errori_registro: Array<RigaEsito & { errore: string }>
  /** Caselle che non si sono aperte: un guasto non e' un "zero fatture". */
  caselle_fallite: Array<{ casella: string; errore: string }>
  /**
   * Mittente riconosciuto ma senza allegato: prima spariva senza contatore.
   * Un PDF messo "inline" invece che come allegato finisce qui, e va visto.
   */
  scartate_senza_allegato: RigaEsito[]
  /** Un singolo messaggio e' esploso: non deve fermare gli altri, ne' sparire. */
  errori_messaggio: Array<RigaEsito & { errore: string }>
  /** Il tempo a disposizione e' finito prima di aver guardato tutto. */
  tempo_scaduto: boolean
  /** Nessun mittente configurato: il filtro non poteva far passare nulla. */
  whitelist_vuota: boolean
  /** Il dettaglio per casella: senza questo, "3 inoltrate" non dice DA DOVE. */
  per_casella: Array<{ casella: string; esaminati: number; riconosciute: number; inoltrate: number }>
}

// ── Funzioni pure ────────────────────────────────────────────────────────────

function monthBounds(monthRef: string): { since: string; before: string } {
  const [y, m] = monthRef.split('-').map(Number)
  const since = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10)
  const before = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
  return { since, before }
}

/** "2026-08" → "agosto 2026". Il mese e' quello DI RIFERIMENTO, non quello odierno. */
export function meseInLettere(monthRef: string): string {
  const [anno, mese] = monthRef.split('-').map(Number)
  return `${MESI[mese - 1] ?? monthRef} ${anno}`
}

/**
 * Toglie il tag dopo il '+' dalla parte locale.
 * `invoice+statements+acct_1re...@stripe.com` → `invoice@stripe.com`.
 * Serve perche' Stripe emette per conto di ogni cliente con un tag diverso:
 * senza questa normalizzazione nessuna voce di whitelist potrebbe mai coprirlo.
 */
export function normalizzaIndirizzo(indirizzo: string): string {
  const [locale, dominio] = indirizzo.toLowerCase().split('@')
  if (!dominio) return indirizzo.toLowerCase()
  return `${locale.split('+')[0]}@${dominio}`
}

/**
 * Converte una data in ISO senza mai lanciare: un'intestazione `Date` storta in
 * un singolo messaggio non deve poter far risultare "non raggiungibile" tutta
 * la casella.
 */
export function dataSicura(valore: string | null | undefined): string | null {
  if (!valore) return null
  const d = new Date(valore)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Vero se la data (AAAA-MM-GG) e' successiva a oggi. */
export function dataNelFuturo(giorno: string, adesso = new Date()): boolean {
  return new Date(`${giorno}T00:00:00Z`).getTime() > adesso.getTime()
}

/**
 * Estrae l'indirizzo da un'intestazione tipo `"Anthropic, PBC" <invoice@x.com>`.
 * IMAP consegna gia' l'indirizzo nudo, Gmail consegna l'intestazione intera:
 * senza questa normalizzazione la stessa fattura verrebbe riconosciuta su una
 * casella e non sull'altra. [[feedback_due_canali_equipollenti]]
 */
export function estraiIndirizzo(intestazione: string): string {
  const conParentesi = intestazione.match(/<([^>]+)>/)
  return (conParentesi ? conParentesi[1] : intestazione).trim().toLowerCase()
}

/**
 * Riconosce un mittente in tre modi, dal piu' stretto al piu' largo:
 *   1. indirizzo identico            → invoice+statements@vercel.com
 *   2. indirizzo senza il tag '+'    → invoice@vercel.com
 *   3. dominio intero                → @mail.anthropic.com
 * L'uguaglianza esatta da sola e' cio' che ha tenuto ferma la routine per
 * quattro mesi: i fornitori cambiano il tag, non il dominio.
 */
export function mittenteRiconosciuto(from: string, voci: Set<string>): boolean {
  if (!from) return false
  const f = estraiIndirizzo(from)
  if (voci.has(f)) return true
  if (voci.has(normalizzaIndirizzo(f))) return true
  const dominio = f.split('@')[1]
  return !!dominio && voci.has(`@${dominio}`)
}

function eIndirizzoNostro(from: string): boolean {
  const f = normalizzaIndirizzo(estraiIndirizzo(from))
  return INDIRIZZI_PROPRI.some((proprio) => normalizzaIndirizzo(proprio) === f)
}

// ── Gli adattatori: uno per casella ──────────────────────────────────────────

/** Casella IMAP TopHost (info@ oppure raffaele.lentini@). */
export function casellaImap(account: AccountKey): Casella {
  return {
    nome: account,
    async leggi(since, before) {
      // `before` limita la ricerca IMAP al mese: senza, la ricerca prende tutto
      // da inizio mese a oggi e il taglio finisce per premiare i giorni recenti.
      //
      // Ma una data di fine NEL FUTURO fa fallire la ricerca sul server TopHost
      // (misurato il 5 set: risponde `undefined`). Succede ogni volta che si
      // chiede il mese in corso — cioe' proprio quando l'Ingegnere lo chiede a
      // voce. Per il mese in corso si lascia cadere `before`: il filtro sulle
      // date, subito sotto, tiene comunque il mese.
      const lista = await readEmail({
        account,
        folder: 'INBOX',
        since,
        before: dataNelFuturo(before) ? undefined : before,
        limit: LIMITE_LETTURA,
      })
      const messaggi = lista.messages
        .filter((m) => m.date && m.date >= since && m.date < before)
        .map((m) => ({
          chiave: String(m.uid),
          from: m.from ?? '',
          subject: m.subject ?? '',
          date: m.date,
          has_attachments: m.has_attachments,
        }))
      return { messaggi, totale: lista.total_matched ?? messaggi.length, troncato: !!lista.truncated }
    },
    async inoltra(m, oggetto, testo) {
      const esito = await forwardEmail({
        from_account: account,
        source_uid: Number(m.chiave),
        source_folder: 'INBOX',
        to: [TARGET],
        new_subject_prefix: oggetto,
        extra_body_text: testo,
        auto_send_if_internal: true,
        routine_name: 'monthly_foreign_invoices_forward',
      })
      return esito.status === 'sent'
        ? { stato: 'sent', message_id: esito.message_id }
        : { stato: esito.status }
    },
    async marca(m) {
      await markEmail({ account, uid: Number(m.chiave), folder: 'INBOX', action: 'flag' })
    },
  }
}

/**
 * Casella Gmail del bot (restruktura.drive@gmail.com).
 *
 * Gmail non ha un "inoltra": i tool esistenti sanno cercare e leggere. Qui la
 * fattura viene ricomposta — allegati scaricati e rispediti via SMTP — perche'
 * limitarsi a segnalarla lascerebbe il lavoro all'Ingegnere, e un'automazione
 * che lascia lavoro non e' un'automazione. [[feedback_apprendimento_implicito]]
 */
export function casellaGmail(): Casella {
  return {
    nome: 'gmail',
    async leggi(since, before) {
      // Gmail vuole le date come YYYY/MM/DD. `has:attachment` restringe subito
      // al solo insieme che ci interessa. `-in:sent -in:trash` tiene fuori la
      // posta che il bot ha spedito lui stesso e il cestino.
      const q = `after:${since.replace(/-/g, '/')} before:${before.replace(/-/g, '/')} has:attachment -in:sent -in:trash`
      const trovati = await searchGmail(q, LIMITE_GMAIL)
      const messaggi = trovati.map((g) => ({
        chiave: g.id,
        from: g.from ?? '',
        subject: g.subject ?? '',
        // Un'intestazione Date malformata farebbe lanciare toISOString() QUI
        // dentro, e l'intera casella Gmail risulterebbe "non raggiungibile"
        // per colpa di un solo messaggio storto.
        date: dataSicura(g.date),
        // NON si usa `g.hasAttachments`: e' SEMPRE false. searchGmail chiede a
        // Gmail il formato 'metadata', che non restituisce le parti MIME, e
        // hasAttachments si calcola proprio da quelle. Copiarlo avrebbe fatto
        // morire ogni messaggio Gmail al controllo allegati, senza finire in
        // nessun contatore: lo stesso zero silenzioso che questa riscrittura
        // doveva chiudere, rifatto sulla terza casella.
        // Qui vale true PER COSTRUZIONE: la query contiene `has:attachment`.
        has_attachments: true,
      }))
      return { messaggi, totale: messaggi.length, troncato: trovati.length >= LIMITE_GMAIL }
    },
    async inoltra(m, oggetto, testo) {
      const completo = await readMessage(m.chiave)
      const allegati = []
      for (const a of completo.attachments ?? []) {
        allegati.push({
          filename: a.filename,
          content_base64: await scaricaAllegato(m.chiave, a.attachmentId),
          contentType: a.mimeType,
        })
      }
      const esito = await sendEmailInternal(
        {
          from_account: 'info',
          to: [TARGET],
          subject: `${oggetto}${m.subject}`,
          body_text: testo,
          attachments: allegati,
          auto_send_if_internal: true,
          routine_name: 'monthly_foreign_invoices_forward',
          request_id: `fattura-estera:gmail:${m.chiave}`,
        },
        { bypassUserConfirmation: false },
      )
      return esito.status === 'sent'
        ? { stato: 'sent', message_id: esito.message_id, filenames: allegati.map((a) => a.filename) }
        : { stato: esito.status }
    },
  }
}

/**
 * Le tre caselle da scandagliare. L'elenco sta in una funzione e non in
 * linea nel motore perche' e' esattamente cio' che un test deve poter
 * guardare: la causa numero uno del guasto era una casella sola.
 */
export function caselleStandard(): Casella[] {
  return [casellaImap('info'), casellaImap('raffaele'), casellaGmail()]
}

// ── Banca dati ───────────────────────────────────────────────────────────────

async function loadSenders(): Promise<string[]> {
  const supabase = getSupabaseServer()
  const { data } = await supabase
    .from('cervellone_email_senders')
    .select('email')
    .eq('category', 'fatture_estere')
    .eq('active', true)
  return ((data ?? []) as Array<{ email: string }>).map((r) => r.email.toLowerCase())
}

async function giaInoltrata(monthRef: string, casella: string, chiave: string): Promise<boolean> {
  const supabase = getSupabaseServer()
  const { data, error } = await supabase
    .from('cervellone_email_invoices_log')
    .select('id')
    .eq('month_ref', monthRef)
    .eq('source_account', casella)
    .eq('source_key', chiave)
    .maybeSingle()
  // Se la domanda "l'ho gia' mandata?" non riceve risposta, la risposta NON e'
  // "no". Ignorando l'errore si andrebbe a sbattere dalla parte sbagliata:
  // reinviare tutto. Meglio fermarsi su questo messaggio, dichiararlo, e
  // ritentare dopo — il mese resta aperto proprio per questo.
  if (error) throw new Error(`registro non interrogabile: ${error.message}`)
  return !!data
}

/** Ritorna il messaggio d'errore se la registrazione non e' riuscita, altrimenti null. */
async function registraInoltro(args: {
  monthRef: string
  casella: string
  chiave: string
  from: string
  subject: string
  receivedAt: string | null
  forwardedMessageId: string
  filenames: string[]
}): Promise<string | null> {
  const supabase = getSupabaseServer()
  const { error } = await supabase.from('cervellone_email_invoices_log').insert({
    month_ref: args.monthRef,
    source_account: args.casella,
    source_key: args.chiave,
    source_uid: /^\d+$/.test(args.chiave) ? Number(args.chiave) : null,
    source_folder: 'INBOX',
    from_addr: args.from,
    subject: args.subject,
    received_at: args.receivedAt,
    forwarded_message_id: args.forwardedMessageId,
    attachments_filenames: args.filenames,
  })
  // La mail e' gia' partita: se il registro non la accoglie NON possiamo
  // fingere che sia tutto a posto, perche' il mese prossimo la reinvieremmo.
  return error ? error.message : null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── Il motore ────────────────────────────────────────────────────────────────

export async function runMonthlyForeignInvoices(opts: RunOptions): Promise<RunResult> {
  const monthRef = opts.month_ref
  const { since, before } = monthBounds(monthRef)
  const whitelist = new Set((opts.senders ?? (await loadSenders())).map((s) => s.toLowerCase()))
  const caselle = opts.caselle ?? caselleStandard()

  const candidates: RunResult['candidates'] = []
  const forwarded: RunResult['forwarded'] = []
  const skippedAlreadyDone: RigaEsito[] = []
  const skippedNotWhitelisted: RigaEsito[] = []
  const fallbackWarnings: RunResult['fallback_warnings'] = []
  const nonInoltrate: RunResult['non_inoltrate'] = []
  const erroriRegistro: RunResult['errori_registro'] = []
  const caselleFallite: RunResult['caselle_fallite'] = []
  const scartateSenzaAllegato: RigaEsito[] = []
  const erroriMessaggio: RunResult['errori_messaggio'] = []
  const perCasella: RunResult['per_casella'] = []

  const oggetto = `Fatture estere Restruktura ${meseInLettere(monthRef)} — `
  const scadenza = Date.now() + (opts.budget_ms ?? BUDGET_MS)
  let esaminatiTotali = 0
  let totaleInCasella = 0
  let troncatoOvunque = false
  let tempoScaduto = false
  let tentativi = 0

  for (const casella of caselle) {
    if (tempoScaduto) {
      perCasella.push({ casella: casella.nome, esaminati: 0, riconosciute: 0, inoltrate: 0 })
      continue
    }
    let lettura: LetturaCasella
    try {
      lettura = await casella.leggi(since, before)
    } catch (err) {
      // Una casella che non si apre NON e' "zero fatture": e' un guasto, e va
      // detto. Le altre due vanno comunque scandagliate: un fornitore giu' non
      // puo' fermare l'intero giro.
      caselleFallite.push({ casella: casella.nome, errore: err instanceof Error ? err.message : String(err) })
      perCasella.push({ casella: casella.nome, esaminati: 0, riconosciute: 0, inoltrate: 0 })
      continue
    }

    esaminatiTotali += lettura.messaggi.length
    totaleInCasella += lettura.totale
    if (lettura.troncato) troncatoOvunque = true
    let riconosciute = 0
    let inoltrate = 0

    for (const m of lettura.messaggi) {
      if (Date.now() > scadenza) {
        tempoScaduto = true
        break
      }
      const from = m.from.toLowerCase()
      const subj = m.subject.toLowerCase()
      const riga: RigaEsito = { casella: casella.nome, chiave: m.chiave, from: m.from }

      // Prima di ogni altra cosa: i nostri stessi inoltri non rientrano nel giro.
      if (from && eIndirizzoNostro(from)) continue

      const inWhitelist = mittenteRiconosciuto(from, whitelist)
      const isKeyword = m.has_attachments && KEYWORDS.some((k) => subj.includes(k))
      if (!inWhitelist && !isKeyword) continue
      if (!m.has_attachments) {
        // Un mittente RICONOSCIUTO che arriva senza allegato non puo' sparire in
        // silenzio: o il fornitore ha cambiato modo di mandare la fattura (un
        // link invece del PDF), o il rilevamento allegati non la vede. In
        // entrambi i casi e' una fattura persa, e va detto.
        if (inWhitelist) scartateSenzaAllegato.push(riga)
        continue
      }
      if (!inWhitelist && isKeyword) {
        fallbackWarnings.push({ ...riga, subject: m.subject })
        skippedNotWhitelisted.push(riga)
        continue
      }

      riconosciute++
      candidates.push({ ...riga, subject: m.subject, date: m.date })
      if (opts.dry_run) continue

      // Ogni messaggio sta dentro la propria rete: un allegato che non si
      // scarica, un SMTP che cade, una cartella in sola lettura non devono
      // buttare a terra l'intero giro — che significherebbe nessun conteggio,
      // nessun avviso, e un 500 indistinguibile da "non e' partita".
      try {
        if (await giaInoltrata(monthRef, casella.nome, m.chiave)) {
          skippedAlreadyDone.push(riga)
          continue
        }

        // La pausa conta i TENTATIVI, non i successi: se gli invii falliscono
        // per troppa fretta, contare i successi stringerebbe il ritmo proprio
        // quando andrebbe allargato.
        if (tentativi > 0) await sleep(opts.pausa_ms ?? SLEEP_MS)
        tentativi++
        const esito = await casella.inoltra(
          m,
          oggetto,
          `Inoltro automatico Cervellone — fattura ricevuta il ${m.date ?? '?'} da ${m.from} sulla casella ${casella.nome}. Mese di riferimento: ${monthRef}.`,
        )
        if (esito.stato !== 'sent' || !esito.message_id) {
          // Prima questo era `continue` secco: un inoltro non partito spariva
          // senza traccia, e il conteggio finale diceva comunque "tutto a posto".
          nonInoltrate.push({ ...riga, stato: esito.stato })
          continue
        }
        inoltrate++

        const erroreRegistro = await registraInoltro({
          monthRef,
          casella: casella.nome,
          chiave: m.chiave,
          from: m.from,
          subject: m.subject,
          receivedAt: m.date,
          forwardedMessageId: esito.message_id,
          filenames: esito.filenames ?? [],
        })
        if (erroreRegistro) erroriRegistro.push({ ...riga, errore: erroreRegistro })
        if (casella.marca) await casella.marca(m)
        forwarded.push({ ...riga, forwarded_message_id: esito.message_id })
      } catch (err) {
        erroriMessaggio.push({ ...riga, errore: err instanceof Error ? err.message : String(err) })
      }
    }

    perCasella.push({ casella: casella.nome, esaminati: lettura.messaggi.length, riconosciute, inoltrate })
  }

  return {
    month_ref: monthRef,
    candidates,
    forwarded,
    skipped_already_done: skippedAlreadyDone,
    skipped_not_whitelisted: skippedNotWhitelisted,
    fallback_warnings: fallbackWarnings,
    esaminati: esaminatiTotali,
    totale_in_casella: totaleInCasella,
    troncato: troncatoOvunque,
    // Il segnale che mancava: messaggi ce n'erano, candidati nessuno.
    // A caselle vuote NON e' un allarme, altrimenti diventa rumore e viene
    // ignorato proprio quando conta. [[feedback_controllo_positivo]]
    nessun_risultato: esaminatiTotali > 0 && candidates.length === 0,
    non_inoltrate: nonInoltrate,
    errori_registro: erroriRegistro,
    caselle_fallite: caselleFallite,
    scartate_senza_allegato: scartateSenzaAllegato,
    errori_messaggio: erroriMessaggio,
    tempo_scaduto: tempoScaduto,
    whitelist_vuota: whitelist.size === 0,
    per_casella: perCasella,
  }
}
