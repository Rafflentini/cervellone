/**
 * app/api/health/route.ts — MNT-002 fix
 */
import { NextResponse } from 'next/server'
import { getHealthStatus } from '@/lib/resilience'

export async function GET() {
  const status = await getHealthStatus()
  const httpStatus = status.status === 'critical' ? 503 : 200
  return NextResponse.json(status, { status: httpStatus })
}
