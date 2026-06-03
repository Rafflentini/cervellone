import { NextRequest, NextResponse } from 'next/server'
import { start } from 'workflow/api'
import { helloWorkflow } from '@/workflows/hello'

export const runtime = 'nodejs'
export const maxDuration = 120

export async function GET(req: NextRequest) {
  const msParam = Number(req.nextUrl.searchParams.get('ms') ?? '90000')
  const ms = Math.min(Math.max(Number.isFinite(msParam) ? msParam : 90000, 0), 110000)
  const t0 = Date.now()
  try {
    const run = await start(helloWorkflow, [ms])
    const result = await run.returnValue
    return NextResponse.json({ ok: true, runId: run.runId, requestedMs: ms, elapsedMs: Date.now() - t0, result })
  } catch (err) {
    return NextResponse.json({ ok: false, requestedMs: ms, elapsedMs: Date.now() - t0, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
