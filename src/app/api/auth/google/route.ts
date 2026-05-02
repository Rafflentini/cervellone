import { NextResponse } from 'next/server'
import { buildConsentUrl } from '@/lib/google-oauth'

/**
 * GET /api/auth/google
 * Reindirizza l'utente alla pagina di consent Google OAuth.
 * Una sola autorizzazione per ottenere il refresh_token persistente.
 */
export async function GET() {
  try {
    const url = buildConsentUrl()
    return NextResponse.redirect(url, { status: 302 })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return new NextResponse(
      `<html><body style="font-family:system-ui;padding:40px;max-width:600px">
        <h1>❌ Errore setup OAuth</h1>
        <pre style="background:#f5f5f5;padding:12px;overflow:auto">${msg}</pre>
        <p>Verifica che GOOGLE_OAUTH_CLIENT_ID e GOOGLE_OAUTH_CLIENT_SECRET siano settati su Vercel.</p>
      </body></html>`,
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    )
  }
}
