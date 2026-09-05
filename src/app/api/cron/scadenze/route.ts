import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { sendEmailInternal, type SendEmailInput } from '@/v19/tools/email/send-email'
import { sendTelegramMessageChecked, chatAdmin } from '@/lib/telegram-helpers'
import {
  soglieDa,
  soglieGiaMandate,
  promemoriaDiOggi,
  marcatore,
  quantoManca,
  type PromemoriaDaMandare,
} from '@/lib/scadenze-promemoria'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

type ScadenzaRow = {
  id: string
  soggetto: string
  categoria: string | null
  tipo_documento: string | null
  data_scadenza: string
  reminder_days: number | null
  recipients: string[] | null
  drive_url: string | null
  reminders_sent: unknown
}

type ReminderResult = {
  id: string
  soggetto: string
  data_scadenza: string
  days_until: number
  /** Quale dei tre promemoria e' questo: la soglia che lo ha fatto scattare. */
  soglia: number
  /** L'avviso su Telegram: se non e' partito, il motivo sta scritto. */
  telegram: { inviato: boolean; motivo?: string }
  /** Almeno un canale ha consegnato. Se falso, la scadenza resta da avvisare. */
  consegnato: boolean
  recipients: Array<{
    to: string
    status: 'sent' | 'pending'
    message_id?: string
    uuid?: string
    warning?: string
  }>
}

const DEFAULT_RECIPIENTS = ['info@restruktura.it', 'raffaele.lentini@restruktura.it']
const DAY_MS = 24 * 60 * 60 * 1000

function todayISO(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
}

function isoDateToUtcMs(value: string): number {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function daysUntil(dateISO: string, today: string): number {
  return Math.ceil((isoDateToUtcMs(dateISO) - isoDateToUtcMs(today)) / DAY_MS)
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map(item => typeof item === 'string' ? item.trim() : '')
      .filter(Boolean)
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      try {
        return parseStringArray(JSON.parse(trimmed))
      } catch {
        return []
      }
    }
    return trimmed.split(',').map(item => item.trim()).filter(Boolean)
  }

  return []
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildSubject(row: ScadenzaRow, days: number): string {
  const when = days === 0 ? 'oggi' : `tra ${days} giorni`
  const type = row.tipo_documento ? `${row.tipo_documento} ` : ''
  return `Scadenza ${when}: ${type}${row.soggetto}`
}

function buildBodyText(row: ScadenzaRow, days: number): string {
  const lines = [
    days === 0
      ? 'Promemoria: questa scadenza e prevista per oggi.'
      : `Promemoria: questa scadenza e prevista tra ${days} giorni.`,
    '',
    `Soggetto: ${row.soggetto}`,
    row.tipo_documento ? `Tipo documento: ${row.tipo_documento}` : '',
    row.categoria ? `Categoria: ${row.categoria}` : '',
    `Data scadenza: ${row.data_scadenza}`,
    row.drive_url ? `Documento Drive: ${row.drive_url}` : '',
  ].filter(Boolean)

  return lines.join('\n')
}

function buildBodyHtml(bodyText: string): string {
  return `<p>${bodyText.split('\n').map(escapeHtml).join('<br>')}</p>`
}

/**
 * Il promemoria su Telegram.
 *
 * Sta ACCANTO alla mail, non al posto: la posta di `info@` riceve centinaia di
 * messaggi al mese e un avviso li' dentro si perde. Telegram e' il canale che
 * l'Ingegnere legge davvero.
 *
 * Restituisce il motivo del mancato invio invece di tacere: un avviso che non
 * parte e' esattamente il guasto che questo lavoro sta chiudendo.
 */
async function avvisaSuTelegram(row: ScadenzaRow, days: number): Promise<{ inviato: boolean; motivo?: string }> {
  const chat = chatAdmin()
  if (!chat) {
    // Non e' un dettaglio: il cron delle fatture estere leggeva una variabile
    // inesistente e per quattro mesi non ha mandato NIENTE, senza che nessuno
    // potesse accorgersene. L'assenza di un messaggio non fa rumore da sola.
    return { inviato: false, motivo: 'chat Telegram non configurata (ADMIN_CHAT_ID / TELEGRAM_ALLOWED_IDS)' }
  }
  const righe = [
    `⏰ Scadenza ${quantoManca(days)}: ${row.tipo_documento ? `${row.tipo_documento} — ` : ''}${row.soggetto}`,
    `Data: ${row.data_scadenza}`,
    row.categoria ? `Categoria: ${row.categoria}` : '',
    row.drive_url ? `Documento: ${row.drive_url}` : '',
  ].filter(Boolean)
  // `sendTelegramMessageChecked` e NON `sendTelegramMessage`: la seconda e'
  // "fire and forget" e non rigetta MAI — senza token esce muta, e su 4xx/429
  // la fetch risolve lo stesso. Un try/catch attorno ad essa e' codice morto, e
  // il danno non sarebbe teorico: dando per consegnato un messaggio mai
  // arrivato si marca la scadenza come avvisata e quel promemoria e' perso per
  // sempre. Il file dei mittenti Telegram mette in guardia proprio da questo
  // errore, e alla prima stesura ci sono cascato lo stesso.
  const consegnato = await sendTelegramMessageChecked(chat, righe.join('\n'))
  return consegnato
    ? { inviato: true }
    : { inviato: false, motivo: 'Telegram non ha confermato la consegna (token mancante o invio rifiutato)' }
}

async function sendReminder(
  row: ScadenzaRow,
  days: number,
  today: string,
  promemoria: PromemoriaDaMandare,
): Promise<ReminderResult> {
  const recipients = parseStringArray(row.recipients)
  const to = recipients.length > 0 ? recipients : DEFAULT_RECIPIENTS
  const subject = buildSubject(row, days)
  const bodyText = buildBodyText(row, days)
  const sent: ReminderResult['recipients'] = []

  for (const recipient of to) {
    const input: SendEmailInput = {
      from_account: 'info',
      to: [recipient],
      subject,
      body_text: bodyText,
      body_html: buildBodyHtml(bodyText),
      auto_send_if_internal: true,
      routine_name: 'cron_scadenze',
      request_id: `scadenza:${row.id}:${today}:${recipient}`,
    }
    const result = await sendEmailInternal(input, { bypassUserConfirmation: false })
    sent.push({
      to: recipient,
      status: result.status,
      message_id: result.status === 'sent' ? result.message_id : undefined,
      uuid: result.status === 'pending' ? result.uuid : undefined,
      warning: result.status === 'sent' ? result.warning : undefined,
    })
  }

  const telegram = await avvisaSuTelegram(row, days)

  // Basta UN canale arrivato per considerare dato l'avviso: se la mail parte e
  // Telegram no, rimandare tutto domani vorrebbe dire una seconda mail uguale.
  const consegnato = sent.some((recipient) => recipient.status === 'sent') || telegram.inviato
  if (consegnato) {
    const previous = parseStringArray(row.reminders_sent)
    // Si segnano anche le soglie ASSORBITE: sono piu' larghe di quella appena
    // usata, quindi ormai passate. Senza, domani partirebbe un "mancano 30
    // giorni" quando ne mancano quattro.
    const nuovi = [promemoria.soglia, ...promemoria.assorbite].map((s) => marcatore(s, today))
    const nextReminders = [...new Set([...previous, ...nuovi])]
    const { error } = await supabase
      .from('cervellone_scadenze')
      .update({ reminders_sent: nextReminders, updated_at: new Date().toISOString() })
      .eq('id', row.id)

    if (error) {
      throw new Error(`Errore aggiornamento reminders_sent per ${row.id}: ${error.message}`)
    }
  } else {
    console.warn(`[CRON scadenze] reminder non marcato per ${row.id}: nessun canale ha consegnato`)
  }

  return {
    id: row.id,
    soggetto: row.soggetto,
    data_scadenza: row.data_scadenza,
    days_until: days,
    soglia: promemoria.soglia,
    recipients: sent,
    telegram,
    consegnato,
  }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const today = todayISO()

  try {
    // PostgREST tronca al suo row-cap senza dirlo: senza paginare, oltre il cap
    // le scadenze piu lontane non riceverebbero MAI il promemoria e il JSON di
    // risposta riporterebbe il conteggio della pagina troncata come se fosse
    // il totale. Nessun umano legge l'output del cron: qui non basta segnalare
    // il troncamento, vanno processate tutte.
    // Tetto di sicurezza: 40 pagine x 500 = 20.000 scadenze attive future.
    // Serve perche un `for(;;)` che interroga il DB sta dentro una route con
    // maxDuration 120: se il server continuasse a rispondere con pagine piene
    // (o se un range non avanzasse) il cron ciclerebbe fino al timeout, e un
    // cron che va in timeout e un cron che non manda promemoria.
    // Il tetto e a sua volta un troncamento: si dichiara in risposta.
    const PAGINA = 500
    const MAX_PAGINE = 40
    const rows: ScadenzaRow[] = []
    let troncato = false
    for (let pagina = 0; ; pagina++) {
      if (pagina >= MAX_PAGINE) {
        troncato = true
        console.error(`[cron/scadenze] tetto di ${MAX_PAGINE} pagine raggiunto: lette ${rows.length} scadenze, potrebbero essercene altre`)
        break
      }
      const offset = pagina * PAGINA
      const { data, error } = await supabase
        .from('cervellone_scadenze')
        .select('id, soggetto, categoria, tipo_documento, data_scadenza, reminder_days, recipients, drive_url, reminders_sent')
        .eq('stato', 'attivo')
        .gte('data_scadenza', today)
        .order('data_scadenza', { ascending: true })
        // Tiebreaker OBBLIGATORIO: `data_scadenza` non e unica (un rinnovo di
        // squadra ne mette dieci sullo stesso giorno) e `.range()` non ha
        // isolamento fra una pagina e l'altra. Con un ordinamento non
        // deterministico, due pari-merito a cavallo dell'offset possono
        // arrivare due volte (doppia mail) o zero volte (nessuna mail: la
        // stessa perdita silenziosa che la paginazione doveva chiudere).
        .order('id', { ascending: true })
        .range(offset, offset + PAGINA - 1)

      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
      }

      const page = (data ?? []) as ScadenzaRow[]
      rows.push(...page)
      if (page.length < PAGINA) break
    }

    const reminded: ReminderResult[] = []
    // Scadenze su cui il giro e' inciampato: se restassero fuori dalla risposta
    // sparirebbero, ed e' esattamente la forma di guasto che stiamo chiudendo.
    const falliti: Array<{ id: string; soggetto: string; errore: string }> = []

    for (const row of rows) {
      // TRE promemoria, non uno: alla soglia dichiarata, a una settimana e il
      // giorno stesso. Prima ne partiva uno solo e poi silenzio — per una
      // scadenza annuale voleva dire una mail sola, dodici mesi dopo, in una
      // casella da centinaia di messaggi al mese.
      // Uno per soglia, pero': non uno al mattino, o diventa rumore e viene
      // ignorato proprio quando conta. La logica sta in scadenze-promemoria.ts,
      // dove si puo' provare senza mandare una mail.
      const reminderDays = row.reminder_days ?? 5
      const days = daysUntil(row.data_scadenza, today)
      const promemoria = promemoriaDiOggi(
        days,
        soglieDa(reminderDays),
        soglieGiaMandate(parseStringArray(row.reminders_sent), reminderDays),
      )
      if (!promemoria) continue

      // Rete per riga. Prima un errore su UNA scadenza (tipicamente la
      // scrittura del segno) risaliva in cima e faceva fallire l'intero giro:
      // le scadenze successive restavano senza avviso, e quella andata storta
      // aveva GIA' mandato mail e Telegram — domani li avrebbe rimandati.
      // Adesso l'errore resta suo, viene dichiarato, e il giro prosegue.
      try {
        reminded.push(await sendReminder(row, days, today, promemoria))
      } catch (err) {
        falliti.push({
          id: row.id,
          soggetto: row.soggetto,
          errore: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Un promemoria che non ha raggiunto nessun canale e' la cosa piu'
    // importante di tutta la risposta: la scadenza resta scoperta e nessuno lo
    // sa. Va in cima, non annegato dentro `details`.
    const nonConsegnati = reminded.filter((r) => !r.consegnato)
    const telegramMuto = reminded.filter((r) => !r.telegram.inviato)

    return NextResponse.json({
      ok: true,
      today,
      checked: rows.length,
      troncato,
      reminded: reminded.length,
      falliti,
      non_consegnati: nonConsegnati.map((r) => ({ id: r.id, soggetto: r.soggetto })),
      telegram_non_partito: telegramMuto.map((r) => ({ id: r.id, motivo: r.telegram.motivo })),
      details: reminded,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
