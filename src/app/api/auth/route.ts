import { NextRequest, NextResponse } from 'next/server'
import { getAuthToken } from '@/lib/doc-access'

export async function POST(request: NextRequest) {
  const { password } = await request.json()

  if (password !== process.env.APP_PASSWORD) {
    return NextResponse.json({ error: 'Password errata' }, { status: 401 })
  }

  // Se AUTH_SECRET manca, `getAuthToken` alza: NON si emette un cookie
  // calcolabile da chiunque legga il repository. Il login smette di funzionare,
  // ed e' voluto — un accesso che finge di proteggere e' peggio di un accesso
  // che non c'e'. Anche `validateAuth` nega nello stesso caso: i due lati
  // restano d'accordo, cosi' non torna il 401 perpetuo di maggio.
  let token: string
  try {
    token = getAuthToken()
  } catch {
    console.error('[auth] AUTH_SECRET non configurato: login disabilitato.')
    return NextResponse.json(
      { error: 'Configurazione incompleta sul server: accesso disabilitato.' },
      { status: 503 },
    )
  }
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
