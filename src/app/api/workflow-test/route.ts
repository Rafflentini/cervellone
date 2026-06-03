import { NextResponse } from 'next/server'
import { start } from 'workflow/api'

import { helloWorkflow } from '@/workflows/hello'

export const maxDuration = 800

export async function GET() {
  const run = await start(helloWorkflow, ['Raffaele'])
  return NextResponse.json({ ok: true, runId: run.runId })
}
