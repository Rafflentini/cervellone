/**
 * lib/google-token-health.ts — salute del refresh token Google.
 *
 * PROBLEMA CHE RISOLVE
 * Il refresh token Google sta in DB e `getAuthorizedClient()` è il choke point
 * unico di tutti i client Google del repo (drive.ts, document-saver.ts,
 * gmail-tools.ts, calendar-tools.ts). Prima faceva solo `setCredentials()`:
 * un token revocato non produceva NESSUN segnale lì, esplodeva pigramente
 * dentro la prima chiamata API e arrivava all'utente come errore generico
 * ("Errore lettura PDF: ...") — indistinguibile da un file mancante.
 *
 * Qui stanno le due cose che servivano:
 *  1. `classifyGoogleError` — distinguere "token morto" da "rete ballerina",
 *     perché un alert su ogni 503 sarebbe rumore e un silenzio su invalid_grant
 *     è il bug.
 *  2. `GoogleAuthDeadError` — un errore che si PORTA DIETRO la spiegazione.
 *     I ~20 catch di drive.ts fanno già `return \`Errore ...: ${err}\``, quindi
 *     tutti e venti dicono la causa vera senza toccarne nemmeno uno.
 *
 * NON è un circuit breaker: non blocca nulla, il flag è solo-alert.
 */

import { getSupabaseServer } from './supabase-server'
import { sendTelegramMessage } from './telegram-helpers'

export type GoogleErrorKind = 'dead' | 'scope' | 'config' | 'transient' | 'other'

const GOOGLE_TOKEN_DEAD_KEY = 'google_token_dead'

/**
 * Testo unico dell'errore. Deve contenere: cosa è successo, cosa NON è
 * successo (i file ci sono ancora) e il gesto esatto per rimediare.
 */
export const GOOGLE_TOKEN_DEAD_MESSAGE =
  '⚠️ Token Google scaduto o revocato — non posso accedere a Drive, Gmail e Calendar. ' +
  'Non è un problema di file mancanti. Riautorizza aprendo in incognito: ' +
  'https://cervellone-five.vercel.app/api/auth/google (login restruktura.drive@gmail.com → Consenti).'

const KIND_NOTE: Partial<Record<GoogleErrorKind, string>> = {
  scope: ' (Nota: mancano scope OAuth — il re-consent li concede.)',
  config: ' (Nota: client_id/client_secret OAuth errati o non autorizzati — il re-consent NON risolve: ' +
    'vanno corretti GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.)',
}

function buildDeadMessage(kind: GoogleErrorKind, detail?: string): string {
  const note = KIND_NOTE[kind] ?? ''
  return `${GOOGLE_TOKEN_DEAD_MESSAGE}${note}${detail ? ` [${detail}]` : ''}`
}

export class GoogleAuthDeadError extends Error {
  readonly kind: GoogleErrorKind

  constructor(kind: GoogleErrorKind = 'dead', detail?: string) {
    super(buildDeadMessage(kind, detail))
    this.name = 'GoogleAuthDeadError'
    this.kind = kind
    // preserva instanceof anche se il target di compilazione è ES5
    Object.setPrototypeOf(this, GoogleAuthDeadError.prototype)
  }
}

// ── Classificazione ──

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null ? (value as UnknownRecord) : null
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  const rec = asRecord(err)
  return typeof rec?.message === 'string' ? rec.message : ''
}

function httpStatus(err: unknown): number | undefined {
  const rec = asRecord(err)
  if (!rec) return undefined
  if (typeof rec.status === 'number') return rec.status
  const response = asRecord(rec.response)
  if (response && typeof response.status === 'number') return response.status
  // gaxios: `code` è numerico solo per errori API-level (AIP-193)
  if (typeof rec.code === 'number') return rec.code
  return undefined
}

function systemCode(err: unknown): string | undefined {
  const rec = asRecord(err)
  if (rec && typeof rec.code === 'string') return rec.code
  const cause = asRecord(rec?.cause)
  if (cause && typeof cause.code === 'string') return cause.code
  return undefined
}

/** Body della risposta: `{error:'invalid_grant'}` (OAuth) o `{error:{...}}` (API). */
function responseData(err: unknown): UnknownRecord | null {
  const rec = asRecord(err)
  const response = asRecord(rec?.response)
  return asRecord(response?.data)
}

/** Codice OAuth testuale: presente solo nella forma `{"error":"invalid_grant"}`. */
function oauthErrorCode(err: unknown): string | undefined {
  const data = responseData(err)
  return typeof data?.error === 'string' ? data.error : undefined
}

/**
 * Tutte le `reason` disponibili: `error.errors[].reason` (forma classica) e
 * `error.details[].reason` (forma ErrorInfo, dove vive ACCESS_TOKEN_SCOPE_INSUFFICIENT).
 */
function errorReasons(err: unknown): string[] {
  const apiError = asRecord(responseData(err)?.error)
  if (!apiError) return []
  const out: string[] = []
  for (const key of ['errors', 'details']) {
    const list = apiError[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const rec = asRecord(entry)
      if (rec && typeof rec.reason === 'string') out.push(rec.reason)
    }
  }
  return out
}

const NO_CREDENTIALS_MESSAGES = [
  'No refresh token is set.',
  'No refresh token or refresh handler callback is set.',
]

const DEAD_JSON_RE = /"error"\s*:\s*"invalid_grant"/
const CONFIG_JSON_RE = /"error"\s*:\s*"(unauthorized_client|invalid_client)"/
const CONFIG_CODES = new Set(['unauthorized_client', 'invalid_client'])
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'])
const TRANSIENT_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'backendError',
  'internalError',
])
const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE'])

/**
 * ATTENZIONE: Google usa 403 sia per "scope insufficiente" sia per
 * "rate limited". Si discrimina sulla `reason`, MAI sullo status secco —
 * un 403 rateLimitExceeded letto come `scope` manderebbe alert falsi.
 */
export function classifyGoogleError(err: unknown): GoogleErrorKind {
  const message = errorMessage(err)
  const trimmed = message.trim()

  // Credenziali semplicemente assenti: NON è un token morto, non deve latchare.
  if (NO_CREDENTIALS_MESSAGES.includes(trimmed)) return 'other'

  const oauthCode = oauthErrorCode(err)

  // Token revocato/scaduto. Tre forme reali (google-auth-library oauth2client.js:261-269):
  // message secco, message riscritto in JSON (caso ReAuth), body della risposta.
  if (trimmed === 'invalid_grant' || oauthCode === 'invalid_grant' || DEAD_JSON_RE.test(message)) {
    return 'dead'
  }

  // Client OAuth sbagliato: il re-consent non risolve, è configurazione.
  if ((oauthCode && CONFIG_CODES.has(oauthCode)) || CONFIG_CODES.has(trimmed) || CONFIG_JSON_RE.test(message)) {
    return 'config'
  }

  const reasons = errorReasons(err)
  if (reasons.some((r) => SCOPE_REASONS.has(r))) return 'scope'
  if (reasons.some((r) => TRANSIENT_REASONS.has(r))) return 'transient'

  const code = systemCode(err)
  if (code && NETWORK_CODES.has(code)) return 'transient'
  if (/fetch failed|socket hang up|network timeout/i.test(message)) return 'transient'

  const status = httpStatus(err)
  if (status === 408 || status === 429 || (typeof status === 'number' && status >= 500 && status < 600)) {
    return 'transient'
  }

  return 'other'
}

export type FatalGoogleAuthKind = Extract<GoogleErrorKind, 'dead' | 'scope' | 'config'>

/** Solo questi tre meritano un alert: gli altri sono rumore o assenza di credenziali. */
export function isFatalGoogleAuthKind(kind: GoogleErrorKind): kind is FatalGoogleAuthKind {
  return kind === 'dead' || kind === 'scope' || kind === 'config'
}

// ── Alert (latch DB + guardia in-memory) ──

const ALERT_TEXT: Record<FatalGoogleAuthKind, string> = {
  dead:
    '⚠️ *Token Google scaduto o revocato* — non posso accedere a Drive, Gmail e Calendar. ' +
    'Non è un problema di file mancanti. Riautorizza aprendo in incognito: ' +
    'https://cervellone-five.vercel.app/api/auth/google (login restruktura.drive@gmail.com → Consenti).',
  scope:
    '⚠️ *Autorizzazione Google incompleta* — mancano scope OAuth, alcune API rispondono 403. ' +
    'Riautorizza aprendo in incognito: https://cervellone-five.vercel.app/api/auth/google ' +
    '(login restruktura.drive@gmail.com → Consenti).',
  config:
    '⚠️ *Configurazione OAuth Google errata* — client_id/client_secret rifiutati. ' +
    'Il re-consent NON risolve: vanno corretti GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET su Vercel. ' +
    'Poi riautorizza: https://cervellone-five.vercel.app/api/auth/google',
}

// Copia locale (deliberata) di resolveAdminChatId: la funzione è duplicata in 6
// punti del repo; unificarla è un refactor a sé, fuori dallo scopo di questo fix.
function resolveAdminChatId(): number {
  let adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
  if (!adminChat) {
    const firstAllowed = (process.env.TELEGRAM_ALLOWED_IDS || '').split(',')[0]?.trim()
    adminChat = parseInt(firstAllowed || '0', 10)
  }
  return adminChat
}

const NOTIFY_THROTTLE_MS = 60 * 60 * 1000

// Il latch DB sopravvive ai cold start; questa guardia copre la concorrenza
// DENTRO la stessa istanza lambda (due chiamate partite prima che il flag sia
// scritto vedrebbero entrambe il flag a false).
let lastNotifyAt = 0

/**
 * Alert una-tantum "token Google morto".
 *
 * Ordine deliberato (copiato da gmail-alerts/route.ts:36-49): prima il send,
 * il flag SOLO dopo un send riuscito — un Telegram giù non deve bruciare il
 * latch lasciando l'utente senza mai sapere che deve riautorizzare.
 */
export async function markGoogleTokenDead(kind: GoogleErrorKind): Promise<void> {
  if (!isFatalGoogleAuthKind(kind)) return

  const now = Date.now()
  if (now - lastNotifyAt < NOTIFY_THROTTLE_MS) {
    console.log('[GOOGLE-HEALTH] alert throttled (in-memory guard)')
    return
  }
  lastNotifyAt = now

  try {
    const supabase = getSupabaseServer()

    const { data } = await supabase
      .from('cervellone_config')
      .select('value')
      .eq('key', GOOGLE_TOKEN_DEAD_KEY)
      .maybeSingle()

    if (String(data?.value ?? '').replace(/"/g, '') === 'true') return

    const adminChat = resolveAdminChatId()
    if (!adminChat) {
      console.warn('[GOOGLE-HEALTH] alert skipped: no admin chat configured')
      return
    }

    try {
      await sendTelegramMessage(adminChat, ALERT_TEXT[kind])
    } catch (err) {
      console.error('[GOOGLE-HEALTH] alert send failed:', err instanceof Error ? err.message : String(err))
      lastNotifyAt = 0 // send fallito: il prossimo tentativo deve poter riprovare
      return
    }

    const { error } = await supabase.from('cervellone_config').upsert(
      { key: GOOGLE_TOKEN_DEAD_KEY, value: 'true' },
      { onConflict: 'key' },
    )
    if (error) console.error('[GOOGLE-HEALTH] flag upsert failed:', error.message)
  } catch (err) {
    console.error('[GOOGLE-HEALTH] markGoogleTokenDead failed:', err instanceof Error ? err.message : String(err))
  }
}
