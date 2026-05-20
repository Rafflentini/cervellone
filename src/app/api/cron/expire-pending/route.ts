/**
 * Cron: pulizia pending email scaduti.
 *
 * Marca come 'expired' le righe di cervellone_email_pending_send che hanno
 * superato il TTL (default 30 min). `fetchPending()` già le ignora a runtime,
 * ma senza questo cron le righe restavano indefinitamente in DB.
 *
 * Auth: Bearer ${CRON_SECRET} (pattern condiviso con altri cron Cervellone,
 * vedi `api/cron/monthly-foreign-invoices/route.ts`).
 *
 * Schedule (vercel.json): `0 * /6 * * *` — ogni 6 ore.
 *
 * NOTA: Vercel UI "Run now" NON inietta il Bearer CRON_SECRET, quindi smoke
 * affidabili solo via curl con secret esplicito OPPURE attendendo lo scheduler
 * reale. Vedi `feedback_vercel_cron_run_now.md` (lezione 7 mag).
 */
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { expirePendingOlderThan } from '@/v19/tools/email/pending'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // DIAGNOSTIC PROBE: 2 step per isolare il fail mode esatto.
  // STEP 1: SELECT su tabella V18 LIVE (cervellone_config) -> baseline supabase OK
  // STEP 2: SELECT su cervellone_email_pending_send (V19) -> se fail = problema specifico
  const probeStart = Date.now()
  const { data: probe1Data, error: probe1Error } = await supabase
    .from('cervellone_config')
    .select('key')
    .limit(1)
  if (probe1Error) {
    console.error('[expire-pending] PROBE1 baseline fail', { message: probe1Error.message, code: probe1Error.code })
    return NextResponse.json({ ok: false, stage: 'probe1_baseline', error: probe1Error.message, code: probe1Error.code }, { status: 500 })
  }
  console.log('[expire-pending] PROBE1 OK (cervellone_config)', { rows: probe1Data?.length })

  const { data: probeData, error: probeError } = await supabase
    .from('cervellone_email_pending_send')
    .select('status')
    .limit(1)
  const probeMs = Date.now() - probeStart
  if (probeError) {
    console.error('[expire-pending] PROBE select fail', {
      ms: probeMs,
      message: probeError.message,
      code: probeError.code,
      details: probeError.details,
      hint: probeError.hint,
    })
    return NextResponse.json({
      ok: false,
      stage: 'probe',
      error: probeError.message,
      code: probeError.code,
    }, { status: 500 })
  }
  console.log('[expire-pending] PROBE OK', { ms: probeMs, count: probeData })

  try {
    const { expired } = await expirePendingOlderThan(30)
    return NextResponse.json({ ok: true, expired, probe_ms: probeMs })
  } catch (err) {
    const e = err as Error & { cause?: unknown; code?: string }
    console.error('[expire-pending] UPDATE fail', {
      name: e.name,
      message: e.message,
      stack: e.stack?.split('\n').slice(0, 5).join('\n'),
      cause: e.cause ? String(e.cause) : undefined,
      code: e.code,
    })
    return NextResponse.json({
      ok: false,
      stage: 'update',
      error: e.message,
      cause: e.cause ? String(e.cause) : undefined,
    }, { status: 500 })
  }
}
