/**
 * Aspetta un lavoro, ma non oltre un tetto.
 *
 * Serve dove un'attesa di rete sta davanti a qualcosa che l'utente vede: in
 * `api/chat/route.ts` il salvataggio della risposta precede `controller.close()`,
 * e senza tetto un Supabase lento terrebbe lo stream aperto — testo gia' a
 * schermo, spinner acceso, pulsante invio bloccato e messaggi dirottati in coda —
 * fino a `maxDuration`, cioe' 800 secondi.
 *
 * Il lavoro NON viene annullato: continua per conto suo (chi chiama puo'
 * affidarlo a `waitUntil`). Qui si decide solo quanto lo si aspetta.
 */
export function conTetto<T, S>(lavoro: Promise<T>, ms: number, seScade: S): Promise<T | S> {
  return Promise.race([
    // Un rigetto non deve propagarsi al chiamante: per lui "fallito" e "non
    // finito in tempo" portano alla stessa decisione, cioe' andare avanti.
    lavoro.catch(() => seScade),
    new Promise<S>((res) => setTimeout(() => res(seScade), ms)),
  ])
}
