import { NextResponse } from 'next/server'
import { exchangeCodeAndStore } from '@/lib/google-oauth'

/**
 * GET /api/auth/google/callback
 * Riceve il code da Google dopo che l'utente autorizza, lo scambia per
 * access+refresh token e salva su Supabase.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  if (error) {
    return new NextResponse(
      `<html><body style="font-family:system-ui;padding:40px;max-width:600px">
        <h1>❌ Autorizzazione negata</h1>
        <p>Google ha ritornato: <code>${error}</code></p>
        <p><a href="/api/auth/google">Riprova</a></p>
      </body></html>`,
      { status: 400, headers: { 'Content-Type': 'text/html' } },
    )
  }

  if (!code) {
    return new NextResponse(
      `<html><body style="font-family:system-ui;padding:40px;max-width:600px">
        <h1>⚠️ Code OAuth mancante</h1>
        <p><a href="/api/auth/google">Riprova</a></p>
      </body></html>`,
      { status: 400, headers: { 'Content-Type': 'text/html' } },
    )
  }

  try {
    const result = await exchangeCodeAndStore(code)
    return new NextResponse(
      `<html><body style="font-family:system-ui;padding:40px;max-width:600px">
        <h1>✅ Cervellone autorizzato su Drive</h1>
        <p>Account: <strong>${result.email}</strong></p>
        <p>Drive WRITE è ora sbloccato. Puoi chiudere questa pagina e tornare su Telegram/Cervellone.</p>
        <p>Test: chiedi al bot "redigi un POS per cantiere Test" + "salvalo su Drive" — il file apparirà nella cartella POS Restruktura.</p>
        <p style="color:#666;font-size:14px">Per revocare: <a href="https://myaccount.google.com/permissions">Google account permissions</a>.</p>
      </body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return new NextResponse(
      `<html><body style="font-family:system-ui;padding:40px;max-width:600px">
        <h1>❌ Errore scambio token</h1>
        <pre style="background:#f5f5f5;padding:12px;overflow:auto">${msg}</pre>
        <p><a href="/api/auth/google">Riprova</a> — assicurati di selezionare l'account
        restruktura.drive@gmail.com e di concedere TUTTI i permessi richiesti.</p>
      </body></html>`,
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    )
  }
}
