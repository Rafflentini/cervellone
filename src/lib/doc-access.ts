import crypto from 'crypto'
import { validateAuth, segretoSessione } from './auth'
import { confrontoCostante } from './confronto-costante'

const SESSION_PAYLOAD = 'cervellone_v2'

/**
 * Token di sessione (identico a api/auth). httpOnly cookie `cervellone_auth`.
 *
 * ALZA un errore se `AUTH_SECRET` manca, invece di emettere un cookie
 * calcolabile da chiunque legga il repository (che e' pubblico). Il chiamante
 * lo trasforma in un errore visibile: meglio non poter entrare che entrare
 * tutti. Vedi `segretoSessione` in auth.ts.
 */
export function getAuthToken(): string {
  const secret = segretoSessione()
  if (!secret) {
    throw new Error('AUTH_SECRET non configurato: non emetto un token di sessione indovinabile.')
  }
  return crypto.createHmac('sha256', secret).update(SESSION_PAYLOAD).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  // In esadecimale il rischio e' un altro ma la forma e' la stessa: Buffer.from
  // SCARTA i caratteri non validi, quindi due stringhe della stessa lunghezza
  // possono produrre byte di lunghezza diversa. Il try/catch lo copriva; ora
  // la guardia e' sui byte, e il catch non serve piu' a nascondere niente.
  return confrontoCostante(a, b, 'hex')
}

// Audit r2 (P2): unificato sul MEDESIMO check dei 9 endpoint hardened (validateAuth in ./auth):
// constant-time, accetta SOLO il token canonico (niente varianti case dell'hex). Un'unica fonte
// di verità per il cookie di sessione su tutta l'app.
export function isAuthedCookie(cookieToken: string | undefined): boolean {
  return validateAuth(cookieToken)
}

/**
 * Segreto share, separato dalla sessione (un token share non vale come cookie
 * e viceversa). NESSUN ripiego.
 *
 * ⚠️ Qui, fino al 14 settembre 2026, c'era
 *
 *     (process.env.AUTH_SECRET || 'cervellone') + ':doc_share'
 *
 * ed e' il TERZO ripiego della stessa famiglia: la bonifica del 6 settembre ne
 * tolse due (v. il commento di `segretoSessione` in auth.ts) e si lascio'
 * dietro questo. Era il peggiore dei tre, perche' non degrada a `undefined` ma
 * a una costante SCRITTA NEL SORGENTE di un repository PUBBLICO: mancando
 * `AUTH_SECRET`, chiunque avesse letto il codice poteva firmarsi da solo il
 * collegamento per qualunque documento di cui conoscesse l'id — e gli id
 * girano nelle chat, non sono un segreto.
 *
 * Peggio ancora, l'incoerenza stava DENTRO QUESTO FILE: `getAuthToken()` qui
 * sopra si rifiuta di firmare un token di sessione senza segreto, e venti
 * righe piu' giu' si firmava un collegamento di condivisione lo stesso.
 *
 * Ora si comporta come `getAuthToken`: se il segreto manca, non si firma
 * niente. Chi verifica (`verifyShareToken`) nega invece di sollevare, cosi' un
 * ospite con un collegamento vede «non valido» e non un 500.
 */
function shareSecret(): string {
  const s = segretoSessione()
  if (!s) {
    throw new Error('AUTH_SECRET non configurato: non firmo un collegamento di condivisione indovinabile.')
  }
  return s + ':doc_share'
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
  // Senza segreto non si verifica NIENTE: si nega. Il controllo sta qui e non
  // dentro un try/catch perche' `shareSecret()` ora ALZA, e un'eccezione che
  // risale fin qui diventerebbe un 500 in faccia all'ospite invece di un
  // «collegamento non valido». Negare e' anche la risposta giusta nel merito:
  // se il server non ha il segreto, nessun token puo' essere legittimo.
  if (!segretoSessione()) return false
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
