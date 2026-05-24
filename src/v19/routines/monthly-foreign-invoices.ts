// src/v19/routines/monthly-foreign-invoices.ts
/**
 * Cervellone V19 — Routine mensile fatture estere.
 *
 * Legge INBOX di info@ del mese precedente, filtra mail con allegato PDF +
 * mittente in whitelist (categoria 'fatture_estere'), inoltra a
 * raffaele.lentini@ (destinatario INTERNO → auto_send_if_internal=true salta
 * la conferma utente). Flag IMAP \Flagged sul messaggio originale + insert in
 * cervellone_email_invoices_log per dedup re-run.
 *
 * Mittenti con PDF + keyword fattura ma NON in whitelist → fallback_warnings
 * (notifica Raffaele via cron handler, non inoltro automatico).
 */
import { readEmail } from '../tools/email/read-email'
import { forwardEmail } from '../tools/email/forward-email'
import { markEmail } from '../tools/email/mark-email'
import { getSupabaseServer } from '@/lib/supabase-server'

const KEYWORDS = ['invoice', 'fattura', 'receipt', 'ricevuta', 'billing']
const TARGET = 'raffaele.lentini@restruktura.it'
const SLEEP_MS = 2000

export type RunOptions = {
  /** YYYY-MM */
  month_ref: string
  dry_run?: boolean
  /** Override whitelist (per test). */
  senders?: string[]
}

export type RunResult = {
  month_ref: string
  candidates: Array<{ uid: number; from: string; subject: string; date: string | null }>
  forwarded: Array<{ uid: number; from: string; forwarded_message_id: string }>
  skipped_already_done: number[]
  skipped_not_whitelisted: number[]
  fallback_warnings: Array<{ uid: number; from: string; subject: string }>
}

function monthBounds(monthRef: string): { since: string; before: string } {
  const [y, m] = monthRef.split('-').map(Number)
  const since = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10)
  const before = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)
  return { since, before }
}

async function loadSenders(): Promise<string[]> {
  const supabase = getSupabaseServer()
  const { data } = await supabase
    .from('cervellone_email_senders')
    .select('email')
    .eq('category', 'fatture_estere')
    .eq('active', true)
  return ((data ?? []) as Array<{ email: string }>).map((r) => r.email.toLowerCase())
}

async function isAlreadyForwarded(monthRef: string, uid: number): Promise<boolean> {
  const supabase = getSupabaseServer()
  const { data } = await supabase
    .from('cervellone_email_invoices_log')
    .select('id')
    .eq('month_ref', monthRef)
    .eq('source_uid', uid)
    .eq('source_folder', 'INBOX')
    .maybeSingle()
  return !!data
}

async function recordForwarded(args: {
  monthRef: string
  uid: number
  from: string
  subject: string
  receivedAt: string | null
  forwardedMessageId: string
  filenames: string[]
}): Promise<void> {
  const supabase = getSupabaseServer()
  await supabase.from('cervellone_email_invoices_log').insert({
    month_ref: args.monthRef,
    source_uid: args.uid,
    source_folder: 'INBOX',
    from_addr: args.from,
    subject: args.subject,
    received_at: args.receivedAt,
    forwarded_message_id: args.forwardedMessageId,
    attachments_filenames: args.filenames,
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runMonthlyForeignInvoices(opts: RunOptions): Promise<RunResult> {
  const monthRef = opts.month_ref
  const { since, before } = monthBounds(monthRef)
  const whitelist = new Set((opts.senders ?? (await loadSenders())).map((s) => s.toLowerCase()))
  const list = await readEmail({ account: 'info', folder: 'INBOX', since, limit: 100 })
  const inMonth = list.messages.filter((m) => m.date && m.date >= since && m.date < before)

  const candidates: RunResult['candidates'] = []
  const forwarded: RunResult['forwarded'] = []
  const skippedAlreadyDone: number[] = []
  const skippedNotWhitelisted: number[] = []
  const fallbackWarnings: RunResult['fallback_warnings'] = []

  for (const m of inMonth) {
    const from = (m.from ?? '').toLowerCase()
    const subj = (m.subject ?? '').toLowerCase()
    const inWhitelist = !!from && whitelist.has(from)
    const isKeyword = m.has_attachments && KEYWORDS.some((k) => subj.includes(k))
    if (!inWhitelist && !isKeyword) continue
    if (!m.has_attachments) continue
    if (!inWhitelist && isKeyword) {
      fallbackWarnings.push({ uid: m.uid, from: m.from ?? '?', subject: m.subject ?? '' })
      skippedNotWhitelisted.push(m.uid)
      continue
    }
    candidates.push({ uid: m.uid, from: m.from ?? '?', subject: m.subject ?? '', date: m.date })
    if (opts.dry_run) continue
    if (await isAlreadyForwarded(monthRef, m.uid)) {
      skippedAlreadyDone.push(m.uid)
      continue
    }
    const result = await forwardEmail({
      from_account: 'info',
      source_uid: m.uid,
      source_folder: 'INBOX',
      to: [TARGET],
      new_subject_prefix: '[Fattura mensile] ',
      extra_body_text: `Inoltro automatico Cervellone — fattura ricevuta il ${m.date ?? '?'} da ${m.from ?? '?'}. Mese di riferimento: ${monthRef}.`,
      auto_send_if_internal: true,
      routine_name: 'monthly_foreign_invoices_forward',
    })
    if (result.status !== 'sent') continue
    await recordForwarded({
      monthRef,
      uid: m.uid,
      from: m.from ?? '?',
      subject: m.subject ?? '',
      receivedAt: m.date,
      forwardedMessageId: result.message_id,
      filenames: [],
    })
    await markEmail({ account: 'info', uid: m.uid, folder: 'INBOX', action: 'flag' })
    forwarded.push({ uid: m.uid, from: m.from ?? '?', forwarded_message_id: result.message_id })
    await sleep(SLEEP_MS)
  }
  return {
    month_ref: monthRef,
    candidates,
    forwarded,
    skipped_already_done: skippedAlreadyDone,
    skipped_not_whitelisted: skippedNotWhitelisted,
    fallback_warnings: fallbackWarnings,
  }
}
