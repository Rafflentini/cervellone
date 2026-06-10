import crypto from 'crypto'

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

export function isAuthedCookie(cookieToken: string | undefined): boolean {
  if (!cookieToken) return false
  return safeEqualHex(cookieToken, getAuthToken())
}

/** Segreto share separato dalla sessione (un token share non vale come cookie e viceversa). */
function shareSecret(): string {
  return (process.env.AUTH_SECRET || 'cervellone') + ':doc_share'
}

export function signShareToken(docId: string, expSec: number): string {
  return crypto.createHmac('sha256', shareSecret()).update(`${docId}.${expSec}`).digest('hex')
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
