import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { runMemoriaExtract } from '@/lib/memoria-extract'

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
    .eq('key', 'memoria_silent_until')
    .maybeSingle()
  const silentValue = silentRow?.value
  if (silentValue && silentValue !== 'null' && silentValue !== null) {
    const silentUntil = new Date(typeof silentValue === 'string' ? silentValue.replace(/"/g, '') : silentValue)
    if (Date.now() < silentUntil.getTime()) {
      console.log(`[CRON memoria-extract] silent until ${silentUntil.toISOString()}, skip`)
      return NextResponse.json({ ok: true, skipped: 'silent' })
    }
  }

  // date_target = ieri (cron gira 23:30 Rome, processiamo giornata chiusa)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const dateTarget = yesterday.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })

  // Idempotency: skip se già processato
  const { data: lastRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'memoria_extract_last_run')
    .maybeSingle()
  const lastValue = lastRow?.value
  if (lastValue && lastValue !== 'null' && lastValue !== null) {
    const lastRun = typeof lastValue === 'string' ? lastValue.replace(/"/g, '') : String(lastValue)
    if (lastRun === dateTarget) {
      console.log(`[CRON memoria-extract] already ran for ${dateTarget}, skip`)
      return NextResponse.json({ ok: true, skipped: 'already_ran', date: dateTarget })
    }
  }

  let result
  try {
    result = await runMemoriaExtract(dateTarget)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[CRON memoria-extract] runMemoriaExtract failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 })
  }

  // Aggiorna last_run
  await supabase
    .from('cervellone_config')
    .update({ value: dateTarget })
    .eq('key', 'memoria_extract_last_run')

  console.log(`[CRON memoria-extract] done: ${dateTarget} | conv=${result.conversations} ent=${result.entities} tok=${result.tokens} cost=$${result.cost_usd}`)

  return NextResponse.json({
    ok: true,
    date: dateTarget,
    conversations: result.conversations,
    entities: result.entities,
    tokens: result.tokens,
    cost_usd: result.cost_usd,
  })
}
