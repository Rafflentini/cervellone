/**
 * Cron mensile fatture estere.
 *
 * Auth: Bearer ${CRON_SECRET} (pattern condiviso con altri cron Cervellone).
 * Idempotency: lock per (month_ref) via cervellone_config key
 *   monthly_foreign_invoices_last_run::YYYY-MM.
 *
 * Query string:
 *   ?month=YYYY-MM  override del mese (default = mese precedente UTC)
 *   ?dry=1          dry-run, NON inoltra, NON setta lock
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { runMonthlyForeignInvoices } from '@/v19/routines/monthly-foreign-invoices'
import { sendTelegramMessage } from '@/lib/telegram-helpers'

export const maxDuration = 300

const RAFFAELE_CHAT_ID = process.env.TELEGRAM_RAFFAELE_CHAT_ID

function previousMonthRef(now = new Date()): string {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() // 0..11 (current month)
  const prev = new Date(Date.UTC(y, m - 1, 1))
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const monthRef = req.nextUrl.searchParams.get('month') ?? previousMonthRef()
  const dry = req.nextUrl.searchParams.get('dry') === '1'

  const idemKey = `monthly_foreign_invoices_last_run::${monthRef}`
  const { data: lastRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', idemKey)
    .maybeSingle()
  if (lastRow?.value && !dry) {
    return NextResponse.json({ ok: true, skipped: 'already_run', last: lastRow.value })
  }

  try {
    const result = await runMonthlyForeignInvoices({ month_ref: monthRef, dry_run: dry })
    if (!dry) {
      await supabase
        .from('cervellone_config')
        .upsert({ key: idemKey, value: new Date().toISOString() })
    }
    if (RAFFAELE_CHAT_ID) {
      const senders = [...new Set(result.forwarded.map((f) => f.from))]
      const lines = [
        `✉️ Fatture estere mese ${monthRef}${dry ? ' (DRY-RUN)' : ''}: ${result.forwarded.length} inoltrate.`,
        result.forwarded.length > 0 ? `Mittenti: ${senders.join(', ')}` : '',
        result.fallback_warnings.length > 0
          ? `⚠️ ${result.fallback_warnings.length} mail con PDF e keyword fattura ma mittente NON in whitelist (UID: ${result.fallback_warnings.map((f) => f.uid).join(', ')}). Aggiungili a cervellone_email_senders se è il caso.`
          : '',
        result.skipped_already_done.length > 0
          ? `Skip già fatte (dedup): ${result.skipped_already_done.join(', ')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
      await sendTelegramMessage(Number(RAFFAELE_CHAT_ID), lines)
    }
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (RAFFAELE_CHAT_ID) {
      await sendTelegramMessage(
        Number(RAFFAELE_CHAT_ID),
        `❌ Routine fatture estere ${monthRef} fallita: ${message}`,
      )
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
