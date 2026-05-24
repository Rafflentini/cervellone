-- =============================================================================
-- Cervellone V19 — RLS Hardening — FASE 2/3 (full sweep)
-- Progetto: cervellone (prod: cervellone-five.vercel.app)
-- Generato: 2026-05-24
-- Autore: Code (Claude)
--
-- Applica RLS deny-by-default su tutte le 20 tabelle restanti del backlog.
-- Prerequisito: commit ce9927a (magic-fix src/lib/supabase.ts ritorna service_role
-- server-side) deve essere deployato in prod. Senza quello commit, abilitare
-- RLS qui = outage Telegram bot + 7 cron.
--
-- 📌  Semantica (identica a Fase 1.1 + 1.2):
--     • service_role bypassa RLS (BYPASSRLS) — codice prod via getSupabaseServer()
--       o src/lib/supabase.ts post-magic-fix → ok
--     • anon + authenticated DENIED via policy RESTRICTIVE deny_all_anon_auth
--     • Single transaction: rollback automatico se anche solo un ALTER fallisce
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─── V12 RAG (6 tabelle) ──────────────────────────────────────────────────────
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.projects;
CREATE POLICY deny_all_anon_auth ON public.projects AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.conversations;
CREATE POLICY deny_all_anon_auth ON public.conversations AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.messages;
CREATE POLICY deny_all_anon_auth ON public.messages AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.documents;
CREATE POLICY deny_all_anon_auth ON public.documents AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.embeddings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.embeddings;
CREATE POLICY deny_all_anon_auth ON public.embeddings AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.memory;
CREATE POLICY deny_all_anon_auth ON public.memory AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- ─── V18 ops (4 tabelle) ─────────────────────────────────────────────────────
ALTER TABLE public.cervellone_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_config;
CREATE POLICY deny_all_anon_auth ON public.cervellone_config AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.cervellone_skills ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_skills;
CREATE POLICY deny_all_anon_auth ON public.cervellone_skills AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.cervellone_anthropic_files ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_anthropic_files;
CREATE POLICY deny_all_anon_auth ON public.cervellone_anthropic_files AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.cervellone_audit_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_audit_runs;
CREATE POLICY deny_all_anon_auth ON public.cervellone_audit_runs AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- ─── V18-19 mail (3 tabelle) ─────────────────────────────────────────────────
ALTER TABLE public.cervellone_email_senders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_email_senders;
CREATE POLICY deny_all_anon_auth ON public.cervellone_email_senders AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.gmail_alert_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.gmail_alert_rules;
CREATE POLICY deny_all_anon_auth ON public.gmail_alert_rules AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.gmail_processed_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.gmail_processed_messages;
CREATE POLICY deny_all_anon_auth ON public.gmail_processed_messages AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- ─── V19 memoria/automation (4 tabelle) ──────────────────────────────────────
ALTER TABLE public.cervellone_summary_giornaliero ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_summary_giornaliero;
CREATE POLICY deny_all_anon_auth ON public.cervellone_summary_giornaliero AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.cervellone_entita_menzionate ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_entita_menzionate;
CREATE POLICY deny_all_anon_auth ON public.cervellone_entita_menzionate AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.cervellone_memoria_extraction_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.cervellone_memoria_extraction_runs;
CREATE POLICY deny_all_anon_auth ON public.cervellone_memoria_extraction_runs AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.model_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.model_health;
CREATE POLICY deny_all_anon_auth ON public.model_health AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- ─── Infra (3 tabelle) ───────────────────────────────────────────────────────
ALTER TABLE public.telegram_active_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.telegram_active_jobs;
CREATE POLICY deny_all_anon_auth ON public.telegram_active_jobs AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.telegram_dedup ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.telegram_dedup;
CREATE POLICY deny_all_anon_auth ON public.telegram_dedup AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

ALTER TABLE public.prezziario ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon_auth ON public.prezziario;
CREATE POLICY deny_all_anon_auth ON public.prezziario AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

COMMIT;

-- Risultato atteso: 25 tabelle public con relrowsecurity=true (1 Fase 1.1 + 4 Fase 1.2 + 20 Fase 2/3).
-- 25 policy deny_all_anon_auth presenti.
-- Get_advisors security: 0 ERROR rls_disabled_in_public.
