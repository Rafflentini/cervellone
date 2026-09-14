/**
 * Cost-control 5 giu 2026: hard cap token per singola run dell'agente.
 * Impedisce che un runaway (loop tool infinito, tool result giganti) bruci
 * il credito API. Al superamento il loop si ferma e logga `run_aborted_budget`.
 *
 * Metrica: input non-cached + cache_creation + output. I cache_read sono
 * esclusi (costano ~10% dell'input: non sono il driver del runaway).
 */
import type { UsageTokens } from './api-usage'

/**
 * Il tetto di token di un turno del coordinatore.
 *
 * ⚠️ Era 200.000 fino al 14 settembre 2026, e li sfondava LAVORANDO.
 * Quel giorno l'Ingegnere ha chiesto di registrare l'incasso di UNA fattura:
 * il bot ha letto le fatture su Fatture in Cloud, ha incontrato un errore, e
 * mentre ne cercava la causa nel proprio codice si e' visto rispondere «la
 * richiesta ha superato il budget di elaborazione». Su una richiesta semplice.
 *
 * Questo file conteneva gia' il principio, scritto per lo specialista:
 * «un tetto che una richiesta NORMALE supera non e' un tetto anti-runaway,
 * e' una guardia che blocca il caso normale». Valeva anche qui, e nessuno
 * l'aveva applicato al coordinatore.
 *
 * E dal 14 settembre esiste una guardia MIGLIORE: quella sul TEMPO
 * (`SOGLIA_TEMPO_MS` in `claude.ts`), che misura direttamente la cosa che fa
 * male — essere uccisi da Vercel a 800 secondi senza consegnare niente —
 * invece di un sostituto. I token erano un modo indiretto di dire «si e'
 * impantanato»; i secondi lo dicono e basta.
 *
 * 500k: il coordinatore puo' portare a termine un lavoro vero con due o tre
 * deleghe, e il runaway lo ferma il tempo. Nel caso peggiore un turno costa di
 * piu' — ma un turno che si ferma a meta' e' costato tutto e non ha consegnato
 * niente, che e' la spesa peggiore di tutte.
 *
 * ⚠️ Cosa cambia nel rapporto con gli specialisti: prima «due deleghe stanno
 * sotto un budget di coordinatore». Ora ce ne stanno cinque. Non e' un
 * invito a delegare di piu': e' che il tetto non e' piu' lui a decidere
 * quando fermarsi.
 */
export const MAX_RUN_TOKENS = 500_000

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
 * Era 60k, perché «tre deleghe stanno sotto un solo budget di coordinatore».
 * ⚠️ MISURATO la notte del 13 set 2026, prima delega vera in produzione: la
 * contabile ha letto 2 elenchi + 15 dettagli FIC per rispondere «quali
 * fatture Vallina non sono pagate» e ha consumato **71.5k** (di cui 63k di
 * scrittura in cache dei risultati). Non è stata troncata solo perché aveva
 * già finito. Un tetto che una richiesta NORMALE supera non è un tetto
 * anti-runaway, è una guardia che blocca il caso normale.
 *
 * 100k: **due deleghe stanno sotto un budget di coordinatore** (200k), e la
 * richiesta di stanotte ci sta con margine. Se ne serve di più, è il compito
 * a essere sbagliato — ed è meglio che torni `troncato: true` (che il
 * coordinatore legge) piuttosto che macinare.
 *
 * ⚠️ **Quello che questo NON fa, dichiarato:** non è un tetto sulla SOMMA. Se
 * il coordinatore delegasse dieci volte, sarebbero dieci budget da 60k. Un
 * tetto vero richiederebbe di far passare il residuo dal coordinatore fino
 * dentro l'esecuzione del tool, che oggi non ha un canale per riceverlo.
 */
export const MAX_SPECIALISTA_RUN_TOKENS = 100_000
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
