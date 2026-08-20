-- 2026-08-20 — lo stato 'partial' per i run di memoria-extract
--
-- PERCHE'. L'estrattore notturno ora distingue tre esiti: riuscito, fallito, e
-- "riuscito ma ho scartato del contenuto illeggibile" (partial). Quest'ultimo e'
-- il segnale che serviva: per tre mesi le giornate di lavoro intenso sono state
-- perse mentre il run si dichiarava 'ok', e nessuno se ne e' accorto.
--
-- Il vincolo attuale ammette solo ('started','ok','error'): senza questa
-- migration la UPDATE con status='partial' viene RIFIUTATA dal database, la riga
-- resta 'started' per sempre e l'audit settimanale non vede nulla. Cioe' lo
-- stesso fallimento muto, un piano piu' in basso.
--
-- SICUREZZA: additiva. Allarga l'insieme dei valori ammessi, non ne toglie
-- nessuno, e non tocca le righe esistenti. Va applicata PRIMA del deploy del
-- codice che scrive 'partial'.

alter table public.cervellone_memoria_extraction_runs
  drop constraint if exists cervellone_memoria_extraction_runs_status_check;

alter table public.cervellone_memoria_extraction_runs
  add constraint cervellone_memoria_extraction_runs_status_check
  check (status in ('started', 'ok', 'partial', 'error'));
