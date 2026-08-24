import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export default async function proxy(request: NextRequest) {
  const authCookie = request.cookies.get('cervellone_auth')
  const { pathname } = request.nextUrl

  const isLoginPage = pathname === '/login'
  const isPublic = pathname.startsWith('/api/auth')
    || pathname.startsWith('/api/telegram')
    || pathname.startsWith('/api/doc/')
    || pathname.startsWith('/doc/')
    || pathname.startsWith('/api/cron/')
    // Il check-in lo compila l ospite o chi consegna le chiavi: non c e un
    // login da chiedere a un turista. La difesa e il token nel collegamento,
    // verificato dalle route stesse (vedi api/checkin/registra).
    || pathname === '/checkin'
    || pathname.startsWith('/api/checkin/registra')
    || pathname.startsWith('/api/checkin/dati')
    || pathname.startsWith('/api/checkin/comuni')
    || pathname.startsWith('/api/checkin/pratica')
    || pathname.startsWith('/api/checkin/logo')
    || pathname === '/checkin/nuova'
    || pathname.startsWith('/api/checkin/prenotazione')

  if (isPublic) return NextResponse.next()

  if (!authCookie && !isLoginPage) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (authCookie && isLoginPage) {
    return NextResponse.redirect(new URL('/chat', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|\\.well-known/workflow/).*)'],
}
