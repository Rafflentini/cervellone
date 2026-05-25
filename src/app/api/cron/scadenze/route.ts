import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { sendEmailInternal, type SendEmailInput } from '@/v19/tools/email/send-email'

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

async function sendReminder(row: ScadenzaRow, days: number, today: string): Promise<ReminderResult> {
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

  const previous = parseStringArray(row.reminders_sent)
  const nextReminders = [...new Set([...previous, today])]
  const { error } = await supabase
    .from('cervellone_scadenze')
    .update({ reminders_sent: nextReminders, updated_at: new Date().toISOString() })
    .eq('id', row.id)

  if (error) {
    throw new Error(`Errore aggiornamento reminders_sent per ${row.id}: ${error.message}`)
  }

  return {
    id: row.id,
    soggetto: row.soggetto,
    data_scadenza: row.data_scadenza,
    days_until: days,
    recipients: sent,
  }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const today = todayISO()

  try {
    const { data, error } = await supabase
      .from('cervellone_scadenze')
      .select('id, soggetto, categoria, tipo_documento, data_scadenza, reminder_days, recipients, drive_url, reminders_sent')
      .eq('stato', 'attivo')
      .gte('data_scadenza', today)
      .order('data_scadenza', { ascending: true })

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }

    const rows = (data ?? []) as ScadenzaRow[]
    const reminded: ReminderResult[] = []

    for (const row of rows) {
      const remindersSent = parseStringArray(row.reminders_sent)
      // One-shot: una sola notifica per scadenza, al primo giorno entro la finestra reminder_days.
      // (Niente mail ogni giorno.) Per riattivare il reminder basta svuotare reminders_sent.
      if (remindersSent.length > 0) continue

      const days = daysUntil(row.data_scadenza, today)
      const reminderDays = row.reminder_days ?? 5
      if (days < 0 || days > reminderDays) continue

      reminded.push(await sendReminder(row, days, today))
    }

    return NextResponse.json({
      ok: true,
      today,
      checked: rows.length,
      reminded: reminded.length,
      details: reminded,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
