-- Cron self-audit settimanale Cervellone (Sub-progetto G)
-- Pattern uniforme con cervellone_memoria_extraction_runs

CREATE TABLE IF NOT EXISTS cervellone_audit_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iso_week TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'ok', 'error')),
  anomalies_count INT NOT NULL DEFAULT 0,
  dimensions_json JSONB,
  anomalies_json JSONB,
  report_text TEXT,
  llm_tokens_used INT,
  llm_cost_estimate_usd DECIMAL(8,4),
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_runs_week
  ON cervellone_audit_runs (iso_week DESC);

CREATE INDEX IF NOT EXISTS idx_audit_runs_started
  ON cervellone_audit_runs (started_at DESC);

ALTER TABLE cervellone_audit_runs DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_audit_runs IS
  'Audit trail dei report self-audit settimanali. 1 row per lunedì cron run.';

INSERT INTO cervellone_config (key, value) VALUES
  ('audit_silent_until', 'null'),
  ('audit_last_run_week', 'null'),
  ('audit_model', '"claude-sonnet-4-6"')
ON CONFLICT (key) DO NOTHING;
