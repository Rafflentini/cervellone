import { NextRequest, NextResponse } from 'next/server'
import { getAuthToken } from '@/lib/doc-access'
import { confrontoCostante } from '@/lib/confronto-costante'

export async function POST(request: NextRequest) {
  const { password } = await request.json()

  // ⚠️ Qui, fino al 14 settembre 2026, c'era soltanto
  //
  //     if (password !== process.env.APP_PASSWORD)
  //
  // senza verificare che APP_PASSWORD ESISTESSE. Mancando la variabile vale
  // `undefined`, e un POST col corpo `{}` manda `password` = `undefined`:
  // `undefined !== undefined` e' FALSO, il controllo passa, e chiunque entra
  // SENZA NEMMENO INDOVINARE NIENTE. Bastava un deploy con mezza
  // configurazione — ed e' esattamente la finestra che si apre mentre si
  // RUOTA la password, che e' cosa che dobbiamo fare.
  //
  // La difesa era asimmetrica dentro questo stesso file: le venti righe qui
  // sotto spiegano per esteso perche' AUTH_SECRET mancante deve CHIUDERE, e
  // la riga sopra di loro faceva l'opposto con l'altra variabile.
  const attesa = process.env.APP_PASSWORD
  if (typeof attesa !== 'string' || attesa.trim() === '') {
    console.error('[auth] APP_PASSWORD non configurata: login disabilitato.')
    return NextResponse.json(
      { error: 'Configurazione incompleta sul server: accesso disabilitato.' },
      { status: 503 },
    )
  }

  // A tempo costante come ogni altro confronto di segreti dell'app
  // (`confronto-costante.ts`, gia' usato da check-in, doc-access e webhook):
  // un `!==` su stringa esce al primo carattere diverso.
  if (!confrontoCostante(typeof password === 'string' ? password : null, attesa)) {
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
