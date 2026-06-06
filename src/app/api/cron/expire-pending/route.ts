/**
 * Cron: pulizia pending email scaduti + run durable zombie.
 *
 * 1) Marca come 'expired' le righe di cervellone_email_pending_send che hanno
 *    superato il TTL (default 30 min). `fetchPending()` già le ignora a runtime,
 *    ma senza questo cron le righe restavano indefinitamente in DB.
 *
 * 2) Audit 6 giu (P0-B zombie cleanup): marca 'error' le agent_workflow_runs con
 *    status='running' e created_at < now()-2h. Queste sono run durable morte
 *    (crash senza catch) che altrimenti bloccherebbero la chat per 30 min
 *    (ACTIVE_RUN_WINDOW_MS). Ogni 6h è sufficiente per il clean.
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
import { expirePendingOlderThan } from '@/v19/tools/email/pending'
import { getSupabaseServer } from '@/lib/supabase-server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Zombie threshold: 2 hours. Una run legittima non supera mai 800s (Fluid max). */
const ZOMBIE_THRESHOLD_HOURS = 2

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  try {
    const { expired } = await expirePendingOlderThan(30)

    // Zombie workflow run cleanup (P0-B audit 6 giu)
    const cutoff = new Date(Date.now() - ZOMBIE_THRESHOLD_HOURS * 60 * 60 * 1000).toISOString()
    const { count: zombieCount, error: zombieError } = await getSupabaseServer()
      .from('agent_workflow_runs')
      .update({ status: 'error', updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('status', 'running')
      .lt('created_at', cutoff)

    if (zombieError) {
      console.error('[expire-pending] zombie workflow cleanup error:', zombieError.message)
    } else if ((zombieCount ?? 0) > 0) {
      console.log(`[expire-pending] zombie workflow runs closed: ${zombieCount}`)
    }

    return NextResponse.json({ ok: true, expired })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
