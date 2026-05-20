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
import { expirePendingOlderThan } from '@/v19/tools/email/pending'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  try {
    const { expired } = await expirePendingOlderThan(30)
    return NextResponse.json({ ok: true, expired })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
