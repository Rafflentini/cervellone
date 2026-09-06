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
    // L'informativa privacy e' pubblica per definizione: dev'essere leggibile
    // PRIMA di consegnare un documento d'identita', e da chiunque — anche da
    // chi non ha il collegamento della propria prenotazione. Un'informativa
    // dietro un login non e' un'informativa. (Il 6 set 2026 la pagina e' andata
    // in produzione e rispondeva 307 verso /login: la prova in produzione ha
    // trovato in trenta secondi cio' che il build non poteva vedere.)
    || pathname === '/checkin/privacy'
    || pathname.startsWith('/api/checkin/registra')
    || pathname.startsWith('/api/checkin/dati')
    || pathname.startsWith('/api/checkin/comuni')
    || pathname.startsWith('/api/checkin/pratica')
    || pathname.startsWith('/api/checkin/logo')
    || pathname.startsWith('/api/checkin/documento')
    || pathname.startsWith('/api/checkin/alloggiati')
    || pathname.startsWith('/api/checkin/pratiche')
    || pathname === '/checkin/nuova'
    || pathname === '/checkin/gestione'
    || pathname.startsWith('/api/checkin/prenotazione')
    // Difesa col token generale nella route, come le altre: la pagina di
    // gestione la apre chi ha il collegamento, non chi ha la password dell app.
    || pathname.startsWith('/api/checkin/segna')

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
