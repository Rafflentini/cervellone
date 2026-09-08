/**
 * src/lib/chat-save-limits.ts
 *
 * Il tetto di dimensione che governa il salvataggio del messaggio UTENTE dal
 * browser. Dall'8 set 2026 la risposta la scrive il server, quindi il beacon
 * d'emergenza non esiste piu' e con esso se ne sono andati `TETTO_BEACON_BYTE`
 * e `tagliaAiByte`, che servivano solo a lui.
 *
 * Vive qui, e non dentro il componente, per un motivo preciso: e' logica in cui
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

