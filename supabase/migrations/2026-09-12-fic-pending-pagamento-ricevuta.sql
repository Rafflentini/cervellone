-- 2026-09-12 — il pending FIC puo' essere anche un PAGAMENTO su fatture ricevute
--
-- PERCHE'. Il tool `segna_fatture_ricevute_pagate` riusa la doppia conferma che
-- gia' esiste: la stessa tabella, la stessa riga, gli stessi comandi
-- /fic_ok_<id> e /fic_ok2_<id> — cosi' funziona identico su Telegram e sulla
-- chat web senza toccare i due dispatch, e le difese stanno in un posto solo.
--
-- Ma `tipo` ha un vincolo CHECK che ammette soltanto 'fattura_emessa' e
-- 'rapporto_intervento' (verificato su pg_constraint il 12 set 2026:
-- cervellone_fic_pending_tipo_check). Senza questa migrazione l'insert del
-- nuovo tipo viene RIFIUTATO dal database, e il tool risponde con l'errore di
-- Postgres: onesto, ma inutilizzabile.
--
-- SICUREZZA: additiva e reversibile. Il vincolo si allarga di un valore, non si
-- toglie: un `tipo` non previsto continua a essere rifiutato invece di essere
-- scritto. Nessuna riga esistente viene toccata.
--
-- Per tornare indietro (solo se nessuna riga usa il nuovo tipo):
--   alter table public.cervellone_fic_pending
--     drop constraint cervellone_fic_pending_tipo_check;
--   alter table public.cervellone_fic_pending
--     add constraint cervellone_fic_pending_tipo_check
--     check (tipo in ('fattura_emessa', 'rapporto_intervento'));

alter table public.cervellone_fic_pending
  drop constraint if exists cervellone_fic_pending_tipo_check;

alter table public.cervellone_fic_pending
  add constraint cervellone_fic_pending_tipo_check
  check (tipo in ('fattura_emessa', 'rapporto_intervento', 'pagamento_ricevuta'));
