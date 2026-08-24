/**
 * src/lib/checkin/token-prenotazione.ts
 *
 * I collegamenti che girano fra le persone.
 *
 * Un solo token per tutti non regge il flusso vero: il link passa dall'ospite
 * intestatario agli altri ospiti via WhatsApp, e persone che non si conoscono
 * fra loro non devono vedersi i documenti a vicenda.
 *
 * I token NON si conservano, si DERIVANO. Scriverli nel foglio significherebbe
 * mettere un segreto dentro un documento che gira, e tenerli allineati fra
 * foglio e link. Derivandoli da un segreto di ambiente non c'e' niente da
 * custodire e la verifica non richiede nemmeno di leggere il foglio.
 *
 * Prezzo di questa scelta, dichiarato: **non si revoca un singolo link**, si
 * ruota il segreto e cadono tutti. E' accettabile perche' i link sono di durata
 * breve per costruzione (scadono dopo il check-out) e perche' l'alternativa —
 * una colonna di segreti nel foglio — e' peggio.
 */

import crypto from 'crypto'

/** Lunghezza del token nel link. 24 caratteri esadecimali = 96 bit. */
const LUNGHEZZA = 24

export type Ambito =
  | { tipo: 'prenotazione'; id: string }
  | { tipo: 'ospite'; id: string; progressivo: number }

function materiale(a: Ambito): string {
  return a.tipo === 'prenotazione' ? `p:${a.id}` : `o:${a.id}:${a.progressivo}`
}

/**
 * Null se il segreto non e' configurato: fail-closed. Senza, `generaToken`
 * produrrebbe comunque una stringa e ogni link sarebbe indovinabile da chiunque
 * conosca l'algoritmo.
 */
export function generaToken(ambito: Ambito): string | null {
  const segreto = process.env.CHECKIN_SECRET
  if (!segreto) return null
  return crypto
    .createHmac('sha256', segreto)
    .update(materiale(ambito))
    .digest('hex')
    .slice(0, LUNGHEZZA)
}

export function verificaToken(ambito: Ambito, ricevuto: string | null | undefined): boolean {
  const atteso = generaToken(ambito)
  if (!atteso || !ricevuto) return false
  if (ricevuto.length !== atteso.length) return false
  return crypto.timingSafeEqual(Buffer.from(ricevuto), Buffer.from(atteso))
}

/**
 * Una pratica chiusa da un pezzo non ha motivo di restare apribile. Non e' una
 * difesa forte: e' riduzione di superficie, perche' un link dimenticato in una
 * chat non deve restare buono per sempre.
 */
export function linkScaduto(checkout: string, oggi: Date, giorniValidita = 7): boolean {
  const co = Date.parse(String(checkout || '').trim())
  if (!Number.isFinite(co)) return false // senza data non si puo' dire: non si blocca
  return oggi.getTime() > co + giorniValidita * 86_400_000
}

/** Il link da girare all'ospite intestatario. */
export function linkPrenotazione(base: string, id: string): string | null {
  const t = generaToken({ tipo: 'prenotazione', id })
  return t ? `${base}/checkin?p=${encodeURIComponent(id)}&t=${t}` : null
}

/** Il link per un singolo ospite: apre soltanto la sua scheda. */
export function linkOspite(base: string, id: string, progressivo: number): string | null {
  const t = generaToken({ tipo: 'ospite', id, progressivo })
  return t ? `${base}/checkin?p=${encodeURIComponent(id)}&o=${progressivo}&t=${t}` : null
}
