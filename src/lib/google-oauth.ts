import { google } from 'googleapis'
import type { OAuth2Client } from 'google-auth-library'
import { supabase } from './supabase'

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
]

function getBaseUrl(): string {
  return process.env.NEXT_PUBLIC_BASE_URL || 'https://cervellone-5poc.vercel.app'
}

export function getOAuth2Client(): OAuth2Client {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID o GOOGLE_OAUTH_CLIENT_SECRET mancante in env')
  }
  const redirectUri = `${getBaseUrl()}/api/auth/google/callback`
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri)
}

/**
 * URL di consent per autorizzazione iniziale dell'utente.
 * access_type=offline + prompt=consent forzano emissione di refresh_token.
 */
export function buildConsentUrl(): string {
  const oauth2Client = getOAuth2Client()
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    include_granted_scopes: true,
  })
}

/**
 * Scambia il code (dal callback) per access+refresh token e salva su Supabase.
 *
 * FIX W1.3.5: usa fetch manuale invece di googleapis library — il library
 * causava "Request is missing required authentication credential" forse per
 * mismatch di Content-Type o body encoding.
 */
export async function exchangeCodeAndStore(code: string): Promise<{ email: string; refresh_token_present: boolean }> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID o GOOGLE_OAUTH_CLIENT_SECRET mancante in env')
  }
  const redirectUri = `${getBaseUrl()}/api/auth/google/callback`

  console.log(`[OAUTH] exchangeCode: client_id_len=${clientId.length} client_secret_len=${clientSecret.length} redirect_uri="${redirectUri}"`)

  // Token exchange — POST application/x-www-form-urlencoded
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })

  if (!tokenRes.ok) {
    const errBody = await tokenRes.text()
    console.error(`[OAUTH] token exchange failed status=${tokenRes.status} body=${errBody.slice(0, 500)}`)
    throw new Error(`Token exchange HTTP ${tokenRes.status}: ${errBody.slice(0, 300)}`)
  }

  const tokens = await tokenRes.json() as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    id_token?: string
    scope?: string
    token_type?: string
  }

  if (!tokens.refresh_token) {
    throw new Error('Refresh token non ricevuto. Revoca app su https://myaccount.google.com/permissions e riprova (con prompt consent).')
  }

  // Recupera email via userinfo endpoint (standard OAuth)
  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  if (!userInfoRes.ok) {
    throw new Error(`UserInfo HTTP ${userInfoRes.status}`)
  }
  const userInfo = await userInfoRes.json() as { email?: string }
  const email = userInfo.email || 'unknown'

  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null

  const { error } = await supabase.from('google_oauth_credentials').upsert(
    {
      account_email: email,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token || null,
      access_token_expires_at: expiresAt,
      scopes: SCOPES,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'account_email' },
  )
  if (error) throw new Error(`Supabase upsert failed: ${error.message}`)

  console.log(`[OAUTH] credentials saved for ${email}`)
  return { email, refresh_token_present: true }
}

/**
 * Recupera credenziali da Supabase e ritorna OAuth2Client già configurato.
 * googleapis library auto-refresha access_token quando necessario via listener 'tokens'.
 */
export async function getAuthorizedClient(): Promise<OAuth2Client | null> {
  try {
    const { data, error } = await supabase
      .from('google_oauth_credentials')
      .select('refresh_token, access_token, access_token_expires_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    if (error || !data) {
      console.log('[OAUTH] no credentials in DB, fallback to Service Account')
      return null
    }

    const oauth2Client = getOAuth2Client()
    oauth2Client.setCredentials({
      refresh_token: data.refresh_token,
      access_token: data.access_token || undefined,
      expiry_date: data.access_token_expires_at ? new Date(data.access_token_expires_at).getTime() : undefined,
    })

    oauth2Client.on('tokens', async (tokens) => {
      if (tokens.access_token) {
        await supabase
          .from('google_oauth_credentials')
          .update({
            access_token: tokens.access_token,
            access_token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
            updated_at: new Date().toISOString(),
          })
          .eq('refresh_token', data.refresh_token)
        console.log('[OAUTH] access_token rotated')
      }
    })

    return oauth2Client
  } catch (err) {
    console.error('[OAUTH] getAuthorizedClient error:', err)
    return null
  }
}
