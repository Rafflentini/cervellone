import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { checkCriticalAlerts } from '@/lib/gmail-summary'
import { sendTelegramMessage } from '@/lib/telegram-helpers'
import { recordBotAction } from '@/lib/gmail-tools'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const { data: silentRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'gmail_silent_until')
    .maybeSingle()
  const silentValue = silentRow?.value
  if (silentValue && silentValue !== 'null' && silentValue !== null) {
    const silentUntil = new Date(typeof silentValue === 'string' ? silentValue.replace(/"/g, '') : silentValue)
    if (Date.now() < silentUntil.getTime()) {
      return NextResponse.json({ ok: true, skipped: 'silent' })
    }
  }

  const { data: lastRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'gmail_alert_check_last_run')
    .maybeSingle()
  const lastValue = lastRow?.value
  const sinceTs = lastValue && lastValue !== 'null' && lastValue !== null
    ? new Date(typeof lastValue === 'string' ? lastValue.replace(/"/g, '') : lastValue)
    : new Date(Date.now() - 3600 * 1000)

  let critical
  try {
    critical = await checkCriticalAlerts(sinceTs)
  } catch (err) {
    console.error('[CRON gmail-alerts] checkCriticalAlerts failed:', err)
    return NextResponse.json({ ok: false, error: 'check_failed' }, { status: 500 })
  }

  const newAlerts = []
  for (const m of critical) {
    const { data: existing } = await supabase
      .from('gmail_processed_messages')
      .select('message_id')
      .eq('message_id', m.id)
      .eq('bot_action', 'notified_critical')
      .maybeSingle()
    if (!existing) newAlerts.push(m)
  }

  if (newAlerts.length > 0) {
    let adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
    if (!adminChat) {
      const firstAllowed = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
      adminChat = parseInt(firstAllowed || '0', 10)
    }
    if (adminChat) {
      for (const m of newAlerts) {
        const text = `🚨 *Mail urgente da ${m.from.slice(0, 50)}*\nOggetto: ${m.subject.slice(0, 100)}\nAnteprima: ${m.snippet.slice(0, 200)}\n\nVuoi leggerla completa o preparo bozza risposta?`
        await sendTelegramMessage(adminChat, text).catch(err =>
          console.error('[CRON gmail-alerts] telegram send failed:', err)
        )
        await recordBotAction(m.id, m.threadId, 'notified_critical', m.from, m.subject)
      }
    }
  }

  await supabase
    .from('cervellone_config')
    .update({ value: new Date().toISOString() })
    .eq('key', 'gmail_alert_check_last_run')

  return NextResponse.json({ ok: true, alerts: newAlerts.length })
}
