-- Auto-debrief Fase 2 (apprendimento implicito): colonne per preferenze output, dedup, provenienza.
-- Additiva e idempotente. Il flag auto_debrief_enabled resta OFF fino a collaudo.

ALTER TABLE procedures    ADD COLUMN IF NOT EXISTS output_preferences text[] NOT NULL DEFAULT '{}';
ALTER TABLE procedures    ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE project_state ADD COLUMN IF NOT EXISTS last_debrief_at timestamptz;
ALTER TABLE project_state ADD COLUMN IF NOT EXISTS updated_by text;

-- Flag (default OFF). Seed solo se assente.
INSERT INTO cervellone_config (key, value)
VALUES ('auto_debrief_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
