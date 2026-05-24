/**
 * lib/auth.ts — SEC-001, SEC-002 fix
 * 
 * Validazione autenticazione per web app e webhook Telegram.
 */

import crypto from 'crypto'

/**
 * Valida il cookie cervellone_auth.
 * Il valore valido è un HMAC-SHA256 di 'cervellone_v2' con AUTH_SECRET.
 * 
 * Per generare il cookie valido (una volta):
 *   node -e "console.log(require('crypto').createHmac('sha256','YOUR_SECRET').update('cervellone_v2').digest('hex'))"
 * Poi impostalo come cookie nel browser.
 */
export function validateAuth(cookieValue: string | undefined): boolean {
  if (!cookieValue) return false

  // Allinea fallback con /api/auth/route.ts:5 (entrambi usano 'cervellone' se env mancante).
  // Bug pre-24mag: validateAuth early-returns false su AUTH_SECRET missing, mentre login
  // accetta password e setta cookie con HMAC default → mismatch → 401 perpetuo su /api/chat
  // anche dopo login OK su /api/auth. Vedi memoria feedback_auth_secret_fallback_mismatch.
  const secret = process.env.AUTH_SECRET || 'cervellone'

  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update('cervellone_v2')
      .digest('hex')

    // timingSafeEqual previene timing attacks
    if (cookieValue.length !== expected.length) return false
    return crypto.timingSafeEqual(
      Buffer.from(cookieValue),
      Buffer.from(expected)
    )
  } catch {
    return false
  }
}

/**
 * Valida il secret token del webhook Telegram.
 * Telegram invia l'header X-Telegram-Bot-Api-Secret-Token ad ogni webhook call.
 * 
 * Setup:
 *   POST https://api.telegram.org/bot{TOKEN}/setWebhook
 *   Body: { "url": "https://...", "secret_token": "RANDOM_64_CHARS" }
 *   Salva lo stesso valore in TELEGRAM_WEBHOOK_SECRET env var.
 */
export function validateWebhookSecret(headerValue: string | null): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET
  if (!expected || !headerValue) return false

  if (headerValue.length !== expected.length) return false
  return crypto.timingSafeEqual(
    Buffer.from(headerValue),
    Buffer.from(expected)
  )
}
