-- Migration C correttiva — DISABLE RLS su model_health
--
-- Migration B (2026-05-04-circuit-breaker.sql) aveva ENABLE ROW LEVEL SECURITY
-- senza policies. Risultato: il backend (service key) NON poteva fare INSERT su
-- model_health, nonostante service_role bypassasse RLS in teoria. In pratica
-- senza policy esplicita "FOR ALL TO service_role USING (true)" il PostgREST
-- ritornava "new row violates row-level security policy for table model_health".
--
-- Risultato: recordOutcome del Circuit Breaker falliva silently → tripBreaker
-- non scattava mai → il sistema di auto-cura non funzionava.
--
-- Fix consistente con telegram_active_jobs (anch'esso DISABLE RLS): le tabelle
-- interne usate solo dal backend via service key non hanno bisogno di RLS.
--
-- Validato in produzione 2026-05-05 13:22: dopo il fix manuale applicato da
-- Cowork, il Circuit Breaker ha rilevato 5 api_error consecutivi e ruotato
-- automaticamente da claude-opus-latest (404) a claude-opus-4-7. Self-heal
-- end-to-end funziona.

ALTER TABLE model_health DISABLE ROW LEVEL SECURITY;
