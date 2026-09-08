/**
 * src/lib/confronto-costante.ts — confronto di segreti a tempo costante.
 *
 * Esisteva in OTTO copie identiche, e tutte e otto avevano lo stesso difetto:
 *
 *   if (ricevuto.length !== atteso.length) return false
 *   return crypto.timingSafeEqual(Buffer.from(ricevuto), Buffer.from(atteso))
 *
 * La guardia conta i CARATTERI, `Buffer.from` conta i BYTE. Una stringa di 8
 * caratteri con un accento ne occupa 9: supera la guardia e fa lanciare
 * `timingSafeEqual`. L'ospite che apre un collegamento storpiato riceve un
 * **500** invece di «Collegamento non valido», e nei log resta un'eccezione
 * al posto di un tentativo respinto.
 *
 * Il confronto resta a tempo costante dove conta: la lunghezza di un segreto
 * non e' un'informazione che si protegge con questo strumento — `timingSafeEqual`
 * stesso pretende due Buffer della stessa lunghezza.
 */
import crypto from 'crypto'

export function confrontoCostante(
  ricevuto: string | null | undefined,
  atteso: string | null | undefined,
  codifica: BufferEncoding = 'utf8',
): boolean {
  if (!ricevuto || !atteso) return false
  const a = Buffer.from(ricevuto, codifica)
  const b = Buffer.from(atteso, codifica)
  if (a.length !== b.length || a.length === 0) return false
  return crypto.timingSafeEqual(a, b)
}
