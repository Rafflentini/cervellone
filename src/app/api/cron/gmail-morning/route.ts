import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { buildDailySummary } from '@/lib/gmail-summary'
import { sendTelegramMessage } from '@/lib/telegram-helpers'
import { recordBotAction } from '@/lib/gmail-tools'

export const maxDuration = 120

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // Silent mode check
  const { data: silentRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'gmail_silent_until')
    .maybeSingle()
  const silentValue = silentRow?.value
  if (silentValue && silentValue !== 'null' && silentValue !== null) {
    const silentUntil = new Date(typeof silentValue === 'string' ? silentValue.replace(/"/g, '') : silentValue)
    if (Date.now() < silentUntil.getTime()) {
      console.log(`[CRON gmail-morning] silent until ${silentUntil.toISOString()}, skip`)
      return NextResponse.json({ ok: true, skipped: 'silent' })
    }
  }

  // Idempotency: skip if last run < 12h ago
  const { data: lastRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'gmail_summary_last_run')
    .maybeSingle()
  const lastValue = lastRow?.value
  if (lastValue && lastValue !== 'null' && lastValue !== null) {
    const last = new Date(typeof lastValue === 'string' ? lastValue.replace(/"/g, '') : lastValue)
    if (Date.now() - last.getTime() < 12 * 3600 * 1000) {
      console.log(`[CRON gmail-morning] already ran ${last.toISOString()}, skip`)
      return NextResponse.json({ ok: true, skipped: 'already_ran' })
    }
  }

  let summary
  try {
    summary = await buildDailySummary(1)
  } catch (err) {
    console.error('[CRON gmail-morning] buildDailySummary failed:', err)
    return NextResponse.json({ ok: false, error: 'summary_failed' }, { status: 500 })
  }

  if (summary.totalUnread === 0) {
    console.log('[CRON gmail-morning] no new mail, skip notification')
  } else {
    let adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
    if (!adminChat) {
      const firstAllowed = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
      adminChat = parseInt(firstAllowed || '0', 10)
    }
    if (adminChat) {
      await sendTelegramMessage(adminChat, summary.digest).catch(err =>
        console.error('[CRON gmail-morning] telegram send failed:', err)
      )
    }
    for (const m of [...summary.critical, ...summary.routine]) {
      await recordBotAction(m.id, m.threadId, 'in_summary', m.from, m.subject)
    }
  }

  await supabase
    .from('cervellone_config')
    .update({ value: new Date().toISOString() })
    .eq('key', 'gmail_summary_last_run')

  return NextResponse.json({ ok: true, total: summary.totalUnread, critical: summary.critical.length })
}
