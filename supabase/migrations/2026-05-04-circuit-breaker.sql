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

-- RLS disabled — coerente con telegram_active_jobs (entrambe usate solo dal
-- backend via service key). ENABLE senza policies blocca recordOutcome del
-- Circuit Breaker (test prod 2026-05-05 13:22 ha confermato la regression).
ALTER TABLE model_health DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE model_health IS 'Outcome storico per ogni request modello — usato dal Circuit Breaker per detection di regressioni e canary recovery.';

-- 2. Init valori config breaker
-- IMPORTANTE: model_default usa claude-opus-4-7 (versione concreta attualmente
-- supportata). NON usare alias *-latest perché Anthropic non li supporta per
-- famiglia 4.x — test prod 2026-05-05 ha confermato che claude-opus-latest
-- ritorna 404 not_found_error. Per upgrade a nuove versioni usare il tool admin
-- promuovi_modello con model id concreto (es. claude-opus-4-8 quando esce).
INSERT INTO cervellone_config (key, value) VALUES
  ('model_stable', '"claude-opus-4-7"'),
  ('model_active', '"claude-opus-4-7"'),
  ('circuit_state', '{"state":"NORMAL","tripped_at":null,"reason":null,"canary_consecutive_ok":0}')
ON CONFLICT (key) DO NOTHING;
