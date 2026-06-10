import crypto from 'crypto'
import { validateAuth } from './auth'

const SESSION_PAYLOAD = 'cervellone_v2'

/** Token di sessione (identico a api/auth). httpOnly cookie `cervellone_auth`. */
export function getAuthToken(): string {
  const secret = process.env.AUTH_SECRET || 'cervellone'
  return crypto.createHmac('sha256', secret).update(SESSION_PAYLOAD).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

// Audit r2 (P2): unificato sul MEDESIMO check dei 9 endpoint hardened (validateAuth in ./auth):
// constant-time, accetta SOLO il token canonico (niente varianti case dell'hex). Un'unica fonte
// di verità per il cookie di sessione su tutta l'app.
export function isAuthedCookie(cookieToken: string | undefined): boolean {
  return validateAuth(cookieToken)
}

/** Segreto share separato dalla sessione (un token share non vale come cookie e viceversa). */
function shareSecret(): string {
  return (process.env.AUTH_SECRET || 'cervellone') + ':doc_share'
}

export function signShareToken(docId: string, expSec: number): string {
  // Audit r2 (P3): payload non ambiguo. Col vecchio `${docId}.${expSec}` un docId che contiene
  // un punto poteva collidere con un altro (docId,exp) — neutralizzato dal guard exp<=now, ma qui
  // lo chiudiamo alla radice. JSON.stringify length-prefissa di fatto le stringhe → nessuna collisione.
  return crypto.createHmac('sha256', shareSecret()).update(JSON.stringify([docId, expSec])).digest('hex')
}

export function verifyShareToken(docId: string, token: string | undefined, expSec: number): boolean {
  if (!token || !Number.isFinite(expSec)) return false
  if (expSec <= Math.floor(Date.now() / 1000)) return false // scaduto
  return safeEqualHex(token, signShareToken(docId, expSec))
}

export function isDocAccessAllowed(p: {
  id: string
  cookieToken?: string
  shareToken?: string
  exp?: number
}): boolean {
  if (isAuthedCookie(p.cookieToken)) return true
  if (p.shareToken && typeof p.exp === 'number') return verifyShareToken(p.id, p.shareToken, p.exp)
  return false
}
