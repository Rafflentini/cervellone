-- =============================================================================
-- Cervellone V19 — RLS Hardening — FASE 1.2 (consumer migrati)
-- Progetto: cervellone (prod: cervellone-five.vercel.app)
-- Generato: 2026-05-23
-- Autore: Code (Claude)
--
-- ⚠️  PREREQUISITO BLOCCANTE — VERIFICARE PRIMA DI ESEGUIRE
--     Lanciare questo script SOLO DOPO che il commit di migrazione consumer
--     (5 file: pending.ts, audit.ts, monthly-foreign-invoices.ts,
--     telegram/route.ts blocchi memoria, memoria-tools.ts) è deployato in prod
--     e ha passato lo smoke test (canary 200 + telegram /ricorda 200 + cron
--     expire-pending 200).
--
--     Se anche solo UN consumer su queste 4 tabelle gira ancora con anon/auth
--     key, abilitare RLS qui = accesso negato = OUTAGE del bot per:
--     - /invia_<uuid> /annulla_<uuid> (pending_send)
--     - /ricorda /dimentica (memoria_esplicita)
--     - audit log mail
--     - cron monthly-foreign-invoices
--
-- 📌  Semantica RLS applicata (identica a Fase 1.1)
--     • service_role bypassa RLS (BYPASSRLS) — codice prod via getSupabaseServer() ok
--     • anon + authenticated DENIED via policy RESTRICTIVE deny_all_anon_auth
--     • Single transaction: rollback automatico se anche solo un ALTER fallisce
--
-- 🔁  Rollback rapido per singola tabella (se serve):
--       ALTER TABLE public.<tabella> DISABLE ROW LEVEL SECURITY;
--
-- ⚠️  Lock conflict: se ALTER TABLE va in timeout, controllare leak Supavisor:
--       SELECT pid, application_name, state, (now()-query_start)::text AS dur
--       FROM pg_stat_activity
--       WHERE state = 'idle in transaction'
--         AND (now() - query_start) > interval '1 hour';
--     Terminare con pg_terminate_backend(pid). Vedi memoria
--     [[cervellone-rls-fase1.1-applied]] per dettagli.
-- =============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- 1) cervellone_email_pending_send
--    Consumer: src/v19/tools/email/pending.ts (6 funzioni)
-- ----------------------------------------------------------------------------
ALTER TABLE public.cervellone_email_pending_send ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_email_pending_send;
CREATE POLICY deny_all_anon_auth
  ON public.cervellone_email_pending_send
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ----------------------------------------------------------------------------
-- 2) cervellone_email_log
--    Consumer: src/v19/tools/email/audit.ts (logEmail)
-- ----------------------------------------------------------------------------
ALTER TABLE public.cervellone_email_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_email_log;
CREATE POLICY deny_all_anon_auth
  ON public.cervellone_email_log
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ----------------------------------------------------------------------------
-- 3) cervellone_email_invoices_log
--    Consumer: src/v19/routines/monthly-foreign-invoices.ts
--             (isAlreadyForwarded, recordForwarded)
-- ----------------------------------------------------------------------------
ALTER TABLE public.cervellone_email_invoices_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_email_invoices_log;
CREATE POLICY deny_all_anon_auth
  ON public.cervellone_email_invoices_log
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ----------------------------------------------------------------------------
-- 4) cervellone_memoria_esplicita
--    Consumer:
--    - src/app/api/telegram/route.ts (blocchi /ricorda + /dimentica)
--    - src/lib/memoria-tools.ts (ricorda, richiama_memoria)
-- ----------------------------------------------------------------------------
ALTER TABLE public.cervellone_memoria_esplicita ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_memoria_esplicita;
CREATE POLICY deny_all_anon_auth
  ON public.cervellone_memoria_esplicita
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

COMMIT;

-- =============================================================================
-- VERIFICA — eseguire SEPARATAMENTE dopo il COMMIT
-- =============================================================================

-- A) RLS attivo sulle 4 tabelle Fase 1.2 (relrowsecurity = true atteso)
-- SELECT relname, relrowsecurity
-- FROM pg_class
-- WHERE relnamespace = 'public'::regnamespace
--   AND relname IN (
--     'cervellone_email_pending_send','cervellone_email_log',
--     'cervellone_email_invoices_log','cervellone_memoria_esplicita'
--   )
-- ORDER BY relname;

-- B) Policy deny presenti (permissive = 'RESTRICTIVE' atteso)
-- SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN (
--     'cervellone_email_pending_send','cervellone_email_log',
--     'cervellone_email_invoices_log','cervellone_memoria_esplicita'
--   )
-- ORDER BY tablename;
