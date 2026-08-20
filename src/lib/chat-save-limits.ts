/**
 * src/lib/chat-save-limits.ts
 *
 * I tetti di dimensione che governano il salvataggio dei messaggi dal browser.
 *
 * Vivono qui, e non dentro il componente, per un motivo preciso: e' logica in cui
 * si sbaglia facilmente (byte contro caratteri) e le cui rotture sono SILENZIOSE
 * — una richiesta rifiutata dal browser non lancia niente di visibile all'utente.
 * Estratta, e' verificabile con dei test veri.
 */

/**
 * `fetch(..., { keepalive: true })` fa sopravvivere la richiesta alla chiusura
 * della pagina, ma il browser impone un tetto di ~64KB sul corpo, e quel tetto
 * vale SEMPRE, non solo durante la chiusura. Attivarlo indiscriminatamente
 * farebbe fallire il salvataggio di ogni risposta lunga anche a scheda aperta.
 */
export const TETTO_KEEPALIVE_BYTE = 60_000

/** Margine piu prudente per il corpo di sendBeacon, che include l'involucro JSON. */
export const TETTO_BEACON_BYTE = 50_000

/**
 * Peso reale in byte. NON usare `.length`: su testo tecnico italiano — accenti,
 * €, m², simboli — un carattere puo pesare due o tre byte, e una stima in
 * caratteri manda il corpo oltre il tetto proprio sui documenti piu lunghi.
 */
export function byteDi(testo: string): number {
  return new Blob([testo]).size
}

/** Se il corpo sta nel tetto, `keepalive` e' un guadagno netto. Sopra, e' un danno. */
export function staNelTettoKeepalive(corpo: string): boolean {
  return byteDi(corpo) < TETTO_KEEPALIVE_BYTE
}

/**
 * Il piu lungo prefisso di `testo` che sta entro `tetto` byte.
 * Restituisce stringa vuota se anche un solo carattere sforerebbe.
 */
export function tagliaAiByte(testo: string, tetto: number = TETTO_BEACON_BYTE): string {
  if (byteDi(testo) <= tetto) return testo

  let basso = 0
  let alto = testo.length
  while (basso < alto) {
    const meta = Math.ceil((basso + alto) / 2)
    if (byteDi(testo.slice(0, meta)) <= tetto) basso = meta
    else alto = meta - 1
  }
  return testo.slice(0, basso)
}
