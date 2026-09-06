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
/**
 * Il segreto di sessione. NESSUN ripiego.
 *
 * Fino al 6 settembre 2026 qui c'era `process.env.AUTH_SECRET || 'cervellone'`,
 * in due file di un repository PUBBLICO: bastava che la variabile mancasse su
 * Vercel — un deploy nuovo, un ambiente di prova, una svista — perche' il
 * cookie di sessione diventasse calcolabile da chiunque avesse letto il
 * codice. Un ripiego comodo che degrada la sicurezza in silenzio: l'app
 * continuava a funzionare, e nessuno poteva accorgersene.
 *
 * Ora, se manca, non si autentica NESSUNO. Chiudersi fuori e' un guasto che si
 * vede; una porta aperta no.
 *
 * ATTENZIONE al motivo per cui il ripiego era stato messo (bug pre-24 mag):
 * `validateAuth` rifiutava mentre il login accettava, e il cookie non
 * combaciava mai — 401 perpetuo dopo un login riuscito. Per questo la regola
 * dev'essere la STESSA sui due lati: qui si nega, e `getAuthToken` alza un
 * errore invece di emettere un cookie indovinabile. Nessuno dei due finge.
 */
export function segretoSessione(): string | null {
  const s = process.env.AUTH_SECRET
  return s && s.trim() ? s : null
}

export function validateAuth(cookieValue: string | undefined): boolean {
  if (!cookieValue) return false

  const secret = segretoSessione()
  if (!secret) {
    console.error('[auth] AUTH_SECRET non configurato: nessun accesso viene autenticato.')
    return false
  }

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
