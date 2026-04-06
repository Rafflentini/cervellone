import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'

function getAuthToken(): string {
  const secret = process.env.AUTH_SECRET || 'cervellone'
  return crypto.createHmac('sha256', secret).update('cervellone_v2').digest('hex')
}

export async function POST(request: NextRequest) {
  const { password } = await request.json()

  if (password !== process.env.APP_PASSWORD) {
    return NextResponse.json({ error: 'Password errata' }, { status: 401 })
  }

  const token = getAuthToken()
  const response = NextResponse.json({ ok: true })
  response.cookies.set('cervellone_auth', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30, // 30 giorni
  })

  return response
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete('cervellone_auth')
  return response
}
