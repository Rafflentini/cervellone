import { NextResponse } from 'next/server'

/**
 * GET /api/auth/google/debug
 * Diagnostic — verifica env vars OAuth in runtime serverless.
 * NON espone i valori, solo presence + length.
 * Da rimuovere dopo verifica.
 */
export async function GET() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
  const idTail = id ? id.slice(-8) : null
  return NextResponse.json({
    has_client_id: !!id,
    client_id_length: id?.length || 0,
    client_id_tail: idTail,
    has_client_secret: !!secret,
    client_secret_length: secret?.length || 0,
    has_base_url: !!baseUrl,
    base_url: baseUrl || '(default fallback https://cervellone-5poc.vercel.app)',
    redirect_uri_used: `${baseUrl || 'https://cervellone-5poc.vercel.app'}/api/auth/google/callback`,
  })
}
