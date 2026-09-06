/**
 * src/lib/checkin/numero-ospiti.ts
 *
 * Quante persone sono prenotate, leggendo una cella scritta da una persona.
 *
 * ── Perche' esiste (6 settembre 2026) ────────────────────────────────────────
 * `N. ospiti` e' il metro di tutto il check-in: decide se e' completo, quanti
 * collegamenti generare, e quanta imposta di soggiorno si versa al Comune. Ma
 * e' una cella di un foglio di calcolo, e la puo' scrivere una persona: "2
 * adulti", "due", "3,5" capitano.
 *
 * `Number('2 adulti')` e' NaN, e con NaN ogni confronto e' falso senza che
 * niente si lamenti. Il 6 settembre questo azzerava i collegamenti degli
 * ospiti: si apriva la prenotazione e non c'era un solo link da mandare,
 * senza spiegazione.
 */

/**
 * Il numero di ospiti, o `ripiego` se la cella non e' un numero utilizzabile.
 *
 * Non prova a indovinare: "2 adulti" non diventa 2. Indovinare su un numero
 * che finisce in un versamento a un Comune sarebbe peggio che ripiegare su un
 * valore prudente e dichiarato.
 */
export function numeroOspiti(cella: unknown, ripiego = 0): number {
  const testo = String(cella ?? '').trim()
  if (!testo) return ripiego
  const n = Number(testo)
  if (!Number.isFinite(n) || n < 0) return ripiego
  return Math.floor(n)
}
