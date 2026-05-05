-- Circuit Breaker (Fase 1 punto 1) — schema model_health + init config

-- 1. Tabella outcome storico per ogni request modello
CREATE TABLE IF NOT EXISTS model_health (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model TEXT NOT NULL,
  request_id TEXT,
  is_canary BOOLEAN NOT NULL DEFAULT FALSE,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'success','empty','force_text','hallucination','api_error','timeout'
  )),
  full_len INTEGER,
  consecutive_no_text INTEGER,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_health_model_canary_ts
  ON model_health (model, is_canary, ts DESC);

-- Solo service_role scrive (backend). Niente policy = deny-by-default per anon/auth.
ALTER TABLE model_health ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE model_health IS 'Outcome storico per ogni request modello — usato dal Circuit Breaker per detection di regressioni e canary recovery.';

-- 2. Init valori config breaker
INSERT INTO cervellone_config (key, value) VALUES
  ('model_stable', '"claude-opus-4-7"'),
  ('model_active', '"claude-opus-latest"'),
  ('circuit_state', '{"state":"NORMAL","tripped_at":null,"reason":null,"canary_consecutive_ok":0}')
ON CONFLICT (key) DO NOTHING;

-- 3. Aggiorna model_default a alias latest (era hardcoded a claude-opus-4-7)
UPDATE cervellone_config SET value = '"claude-opus-latest"'
  WHERE key = 'model_default' AND value = '"claude-opus-4-7"';
