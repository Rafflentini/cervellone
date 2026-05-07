import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { runAudit, getISOWeek } from '@/lib/audit-runner'

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
    .eq('key', 'audit_silent_until')
    .maybeSingle()
  const silentValue = silentRow?.value
  if (silentValue && silentValue !== 'null' && silentValue !== null) {
    const silentUntil = new Date(typeof silentValue === 'string' ? silentValue.replace(/"/g, '') : silentValue)
    if (Date.now() < silentUntil.getTime()) {
      console.log(`[CRON self-audit] silent until ${silentUntil.toISOString()}, skip`)
      return NextResponse.json({ ok: true, skipped: 'silent' })
    }
  }

  // Idempotency week-aware: skip se già run questa settimana ISO
  const currentWeek = getISOWeek(new Date())
  const { data: lastRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'audit_last_run_week')
    .maybeSingle()
  const lastValue = lastRow?.value
  if (lastValue && lastValue !== 'null' && lastValue !== null) {
    const lastWeek = typeof lastValue === 'string' ? lastValue.replace(/"/g, '') : String(lastValue)
    if (lastWeek === currentWeek) {
      console.log(`[CRON self-audit] already ran for ${currentWeek}, skip`)
      return NextResponse.json({ ok: true, skipped: 'already_ran_this_week', week: currentWeek })
    }
  }

  let result
  try {
    result = await runAudit()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[CRON self-audit] runAudit failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 })
  }

  // Aggiorna last_run_week
  await supabase
    .from('cervellone_config')
    .update({ value: currentWeek })
    .eq('key', 'audit_last_run_week')

  console.log(`[CRON self-audit] done week=${currentWeek} run_id=${result.run_id} anomalies=${result.anomalies_count}`)

  return NextResponse.json({
    ok: true,
    week: currentWeek,
    run_id: result.run_id,
    anomalies_count: result.anomalies_count,
  })
}
