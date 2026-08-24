/**
 * src/lib/checkin/accesso.ts
 *
 * Chi sta bussando: dal collegamento al livello di accesso.
 *
 * Sta in un file suo, e non dentro una route, perche' e' la stessa decisione
 * per tutte: lettura, salvataggio, caricamento delle foto. Duplicarla vorrebbe
 * dire che prima o poi due copie divergono, e la piu' permissiva vince senza
 * che nessuno l'abbia deciso.
 */

import crypto from 'crypto'
import { verificaToken } from './token-prenotazione'
import type { Livello } from './merge-pratica'

export type EsitoAccesso =
  | { ok: true; livello: Livello; id: string | null }
  | { ok: false; motivo: string }

/** Il token generale: l'Ingegnere e chi consegna le chiavi. */
function tokenGenerale(ricevuto: string | null): boolean {
  const atteso = process.env.CHECKIN_TOKEN
  if (!atteso || !ricevuto) return false
  if (ricevuto.length !== atteso.length) return false
  return crypto.timingSafeEqual(Buffer.from(ricevuto), Buffer.from(atteso))
}

/**
 * @param k  token generale, dal parametro `k`
 * @param p  id della prenotazione, dal parametro `p`
 * @param t  token della prenotazione o dell'ospite, dal parametro `t`
 * @param o  progressivo dell'ospite, dal parametro `o`
 */
export function risolviAccesso(
  k: string | null,
  p: string | null,
  t: string | null,
  o: string | null,
): EsitoAccesso {
  // Il token generale vince: e' quello di chi gestisce, e deve poter aprire
  // qualunque pratica anche senza avere il link dell'ospite sottomano.
  if (tokenGenerale(k)) return { ok: true, livello: { tipo: 'gestore' }, id: p ?? null }

  if (!p || !t) return { ok: false, motivo: 'Collegamento non valido.' }

  if (o !== null && o !== '') {
    const progressivo = Number(o)
    if (!Number.isInteger(progressivo) || progressivo < 1) {
      return { ok: false, motivo: 'Collegamento non valido.' }
    }
    if (verificaToken({ tipo: 'ospite', id: p, progressivo }, t)) {
      return { ok: true, livello: { tipo: 'ospite', progressivo }, id: p }
    }
    return { ok: false, motivo: 'Collegamento non valido.' }
  }

  if (verificaToken({ tipo: 'prenotazione', id: p }, t)) {
    return { ok: true, livello: { tipo: 'prenotazione' }, id: p }
  }

  return { ok: false, motivo: 'Collegamento non valido.' }
}
