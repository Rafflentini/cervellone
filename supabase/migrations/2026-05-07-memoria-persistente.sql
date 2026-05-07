-- Memoria persistente cross-sessione (Sub-progetto B)
-- Approach HYBRID: cron giornaliero + /ricorda manuale
-- Granularità conservativa: solo fatti verificabili

-- ─────────────────────────────────────────────────────────────
-- 1. cervellone_memoria_esplicita
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cervellone_memoria_esplicita (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contenuto TEXT NOT NULL,
  conversation_id UUID,
  tag TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'telegram'
    CHECK (source IN ('telegram', 'web', 'tool', 'cron'))
);

CREATE INDEX IF NOT EXISTS idx_memoria_esplicita_conv
  ON cervellone_memoria_esplicita (conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memoria_esplicita_created
  ON cervellone_memoria_esplicita (created_at DESC);

ALTER TABLE cervellone_memoria_esplicita DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_memoria_esplicita IS
  'Decisioni e contesti salvati esplicitamente via /ricorda o tool. Priorità L1. TTL FOREVER.';

-- ─────────────────────────────────────────────────────────────
-- 2. cervellone_summary_giornaliero
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cervellone_summary_giornaliero (
  data DATE PRIMARY KEY,
  summary_text TEXT NOT NULL,
  message_count INT NOT NULL DEFAULT 0,
  conversations_json JSONB,
  llm_tokens_used INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_summary_giornaliero_data
  ON cervellone_summary_giornaliero (data DESC);

ALTER TABLE cervellone_summary_giornaliero DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_summary_giornaliero IS
  '1 riga per giorno. Prodotta da cron 23:30 Rome. TTL 2 anni (cleanup OUT-OF-SCOPE MVP).';

-- ─────────────────────────────────────────────────────────────
-- 3. cervellone_entita_menzionate
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cervellone_entita_menzionate (
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cliente', 'cantiere', 'fornitore')),
  last_seen_at DATE NOT NULL DEFAULT CURRENT_DATE,
  mention_count INT NOT NULL DEFAULT 1,
  contexts_json JSONB,
  PRIMARY KEY (name, type)
);

CREATE INDEX IF NOT EXISTS idx_entita_lastseen
  ON cervellone_entita_menzionate (last_seen_at DESC);

ALTER TABLE cervellone_entita_menzionate DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_entita_menzionate IS
  'Registro aggregato entità named estratte dal cron. UPSERT su (name, type). TTL FOREVER.';

-- ─────────────────────────────────────────────────────────────
-- 4. cervellone_memoria_extraction_runs
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cervellone_memoria_extraction_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date_processed DATE NOT NULL,
  conversations_count INT NOT NULL DEFAULT 0,
  entities_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'ok', 'error')),
  llm_cost_estimate_usd DECIMAL(8,4),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_date
  ON cervellone_memoria_extraction_runs (date_processed DESC);

ALTER TABLE cervellone_memoria_extraction_runs DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_memoria_extraction_runs IS
  'Log ogni run cron memoria-extract. Status started→ok|error. Per debug e stima costi LLM.';

-- ─────────────────────────────────────────────────────────────
-- 5. Config keys
-- ─────────────────────────────────────────────────────────────
INSERT INTO cervellone_config (key, value) VALUES
  ('memoria_extract_last_run', 'null'),
  ('memoria_silent_until', 'null'),
  ('memoria_extract_model', '"claude-sonnet-4-6"')
ON CONFLICT (key) DO NOTHING;
