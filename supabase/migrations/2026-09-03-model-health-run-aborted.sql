-- Un esito in piu' per model_health: `run_aborted`.
--
-- Serve alle run troncate dal guard rail di costo (isRunOverBudget). Prima
-- venivano registrate come 'success': un runaway da 200K token spariva dalla
-- telemetria dietro un turno "riuscito".
--
-- Perche' NON sono un fallimento. Il circuit breaker fa rollback dopo 3 esiti
-- non-success su 5. Contare qui una run troncata significherebbe far cadere un
-- modello SANO dopo tre richieste pesanti di fila: la richiesta era grossa, il
-- modello non c'entra. E' lo stesso falso segnale — misura sbagliata che diventa
-- rollback immotivato — chiuso oggi su web_search e sulle promesse mantenute.
-- Lato codice l'esclusione sta in ESITI_NON_IMPUTABILI (lib/circuit-breaker.ts).
--
-- ATTENZIONE, il motivo per cui questa migrazione esiste: il CHECK constraint
-- avrebbe RIFIUTATO il valore nuovo, e l'insert dell'esito e' fire-and-forget
-- (l'errore finisce in console.error, non risale). Ogni run troncata sarebbe
-- sparita in silenzio, lasciando il breaker con una finestra campione bucata.
-- I test non potevano vederlo: mockano Supabase, e il vincolo vive solo nel DB.
--
-- Additiva e retrocompatibile: allarga l'insieme dei valori ammessi, nessuna
-- riga esistente ne e' toccata.

ALTER TABLE public.model_health
  DROP CONSTRAINT IF EXISTS model_health_outcome_check;

ALTER TABLE public.model_health
  ADD CONSTRAINT model_health_outcome_check
  CHECK (outcome = ANY (ARRAY[
    'success'::text,
    'empty'::text,
    'force_text'::text,
    'hallucination'::text,
    'api_error'::text,
    'timeout'::text,
    'run_aborted'::text
  ]));
