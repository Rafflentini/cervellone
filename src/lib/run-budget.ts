/**
 * Cost-control 5 giu 2026: hard cap token per singola run dell'agente.
 * Impedisce che un runaway (loop tool infinito, tool result giganti) bruci
 * il credito API. Al superamento il loop si ferma e logga `run_aborted_budget`.
 *
 * Metrica: input non-cached + cache_creation + output. I cache_read sono
 * esclusi (costano ~10% dell'input: non sono il driver del runaway).
 */
import type { UsageTokens } from './api-usage'

export const MAX_RUN_TOKENS = 200_000

/** Path durable: task lunghe legittime (30-60 min) → budget dedicato. ~$3-4 max su Sonnet. */
export const MAX_DURABLE_RUN_TOKENS = 1_000_000

/**
 * Budget di UNO specialista del Decollo (`src/lib/delega.ts`).
 *
 * ⚠️ **Perché non è `MAX_RUN_TOKENS`.** Un turno delegato gira DENTRO quello
 * del coordinatore ma con il proprio `accUsage`: i suoi token **non** entrano
 * nel budget del coordinatore. Lasciandogli i 200k pieni, un turno
 * dell'Ingegnere poteva costarne 400 — e con due deleghe 600 — senza che
 * nessun tetto se ne accorgesse. Rilevato dall'audit del 13 set 2026.
 *
 * 60k è scelto perché **tre deleghe stanno sotto un solo budget di
 * coordinatore** (180k < 200k): anche il caso peggiore che si riesce a
 * immaginare non raddoppia la spesa di un turno. E uno specialista ha un
 * compito solo e pochi attrezzi: se ne serve di più, è il compito a essere
 * sbagliato — ed è meglio che torni `troncato: true` (che il coordinatore
 * legge) piuttosto che macinare.
 *
 * ⚠️ **Quello che questo NON fa, dichiarato:** non è un tetto sulla SOMMA. Se
 * il coordinatore delegasse dieci volte, sarebbero dieci budget da 60k. Un
 * tetto vero richiederebbe di far passare il residuo dal coordinatore fino
 * dentro l'esecuzione del tool, che oggi non ha un canale per riceverlo.
 */
export const MAX_SPECIALISTA_RUN_TOKENS = 60_000
/** 1 = al secondo ingresso dello step la run viene abortita: paga al massimo UNA esecuzione completa. Scelta post-audit 6 giu (P1-C). */
export const MAX_RUN_ATTEMPTS = 1

export function runTokens(u: UsageTokens): number {
  return (
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0)
  )
}

export function isRunOverBudget(u: UsageTokens, max: number = MAX_RUN_TOKENS): boolean {
  return runTokens(u) > max
}
