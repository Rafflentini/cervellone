-- Durable P0 fix (6 giu 2026): contatore tentativi per run workflow.
-- Anti crash-restart loop WDK (incidente $118 del 4 giu): lo step core incrementa
-- attempts a ogni esecuzione; oltre MAX_RUN_ATTEMPTS (run-budget.ts) abortisce
-- senza chiamare Claude. Applicata in prod via Supabase MCP il 6 giu 2026 (notte).
-- Idempotente: rieseguibile senza effetti.

ALTER TABLE public.agent_workflow_runs
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.increment_workflow_run_attempts(p_run_id text)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.agent_workflow_runs
  SET attempts = attempts + 1, updated_at = now()
  WHERE id = p_run_id
  RETURNING attempts;
$$;

REVOKE ALL ON FUNCTION public.increment_workflow_run_attempts(text) FROM anon, authenticated;
