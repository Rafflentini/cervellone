-- =============================================================================
-- Cervellone V19 — RLS Hardening — FASE 1 (tabelle critiche)
-- Progetto: cervellone (prod: cervellone-five.vercel.app)
-- Generato: 2026-05-21
-- Autore: Cowork (Claude) — validato da Code (Claude)
-- Eseguire in: Supabase SQL Editor
--
-- Fonte autoritativa: bridge/2026-05-21-smoke-post-redeploy.md sezione [Cowork] 19:31
--
-- ⚠️  PREREQUISITO BLOCCANTE — LEGGERE PRIMA DI ESEGUIRE
--     Lanciare questo script SOLO DOPO che la FASE 0 (migrazione dei consumer a
--     SUPABASE_SERVICE_ROLE_KEY) è deployata in prod e ha passato lo smoke test.
--     In particolare src/lib/google-oauth.ts (tabella google_oauth_credentials)
--     DEVE già usare il client service_role.
--     Se un qualunque consumer di queste 6 tabelle gira ancora con anon/authenticated
--     key, abilitare RLS qui = accesso negato = OUTAGE del bot.
--
-- 📌  Semantica RLS applicata
--     • service_role (Supabase) ha l'attributo BYPASSRLS → continua ad accedere
--       a tutto, nessuna policy necessaria per lui.
--     • anon + authenticated → con RLS ON e ZERO policy PERMISSIVE sono già negati
--       di default. In più aggiungiamo una policy RESTRICTIVE deny-by-default
--       esplicita (USING false / WITH CHECK false): documenta l'intento e protegge
--       anche se in futuro qualcuno aggiungesse per errore una PERMISSIVE.
--     • Tutto in un'unica transazione: se qualcosa fallisce, rollback automatico.
--       NB: ENABLE RLS prende un lock ACCESS EXCLUSIVE breve per tabella (ok su
--       carico basso come questo bot).
--
-- 🔁  Rollback rapido per singola tabella (se serve):
--       ALTER TABLE public.<tabella> DISABLE ROW LEVEL SECURITY;
-- =============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1) google_oauth_credentials   ← PIÙ CRITICA (contiene refresh token Google)
-- ----------------------------------------------------------------------------
ALTER TABLE public.google_oauth_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.google_oauth_credentials;
CREATE POLICY deny_all_anon_auth
  ON public.google_oauth_credentials
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ----------------------------------------------------------------------------
-- 2) cervellone_email_pending_send
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
-- 3) cervellone_email_log
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
-- 4) cervellone_email_invoices_log
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
-- 5) cervellone_memoria_esplicita
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

-- ----------------------------------------------------------------------------
-- 6) memory
-- ----------------------------------------------------------------------------
ALTER TABLE public.memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.memory;
CREATE POLICY deny_all_anon_auth
  ON public.memory
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- ----------------------------------------------------------------------------
-- Advisor fix: function_search_path_mutable  (zero-impact runtime)
-- 5 funzioni: search_memory, update_config_timestamp, update_skill_timestamp,
--             search_prezziario, get_distinct_regioni
--
-- NB: ALTER FUNCTION richiede la FIRMA ESATTA (tipi argomenti) se la funzione è
--     overloaded; con il nome nudo darebbe "function name is not unique".
--     Il blocco DO qui sotto risolve la firma da pg_proc e applica l'ALTER su
--     OGNI overload trovato → robusto, niente firme hardcoded.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'search_memory',
        'update_config_timestamp',
        'update_skill_timestamp',
        'search_prezziario',
        'get_distinct_regioni'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp;', r.sig);
    RAISE NOTICE 'search_path fissato su %', r.sig;
  END LOOP;
END $$;

COMMIT;

-- =============================================================================
-- VERIFICA — eseguire SEPARATAMENTE dopo il COMMIT
-- =============================================================================

-- A) RLS attivo sulle 6 tabelle (relrowsecurity = true atteso)
-- SELECT relname, relrowsecurity
-- FROM pg_class
-- WHERE relnamespace = 'public'::regnamespace
--   AND relname IN (
--     'google_oauth_credentials','cervellone_email_pending_send',
--     'cervellone_email_log','cervellone_email_invoices_log',
--     'cervellone_memoria_esplicita','memory'
--   )
-- ORDER BY relname;

-- B) Policy deny presenti (permissive = 'RESTRICTIVE' atteso)
-- SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND tablename IN (
--     'google_oauth_credentials','cervellone_email_pending_send',
--     'cervellone_email_log','cervellone_email_invoices_log',
--     'cervellone_memoria_esplicita','memory'
--   )
-- ORDER BY tablename;

-- C) search_path fissato sulle 5 funzioni (proconfig deve contenere search_path)
-- SELECT p.oid::regprocedure AS funzione, p.proconfig
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'public'
--   AND p.proname IN (
--     'search_memory','update_config_timestamp','update_skill_timestamp',
--     'search_prezziario','get_distinct_regioni'
--   )
-- ORDER BY funzione;
