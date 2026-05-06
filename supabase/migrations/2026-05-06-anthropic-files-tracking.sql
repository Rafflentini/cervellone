-- Migration: cervellone_anthropic_files — tracking file uploadati ad Anthropic Files API
-- Spec: docs/superpowers/specs/2026-05-06-cervellone-file-pipeline-design.md
-- Sub-progetto A — File Pipeline universale

CREATE TABLE IF NOT EXISTS cervellone_anthropic_files (
  file_id TEXT PRIMARY KEY,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  original_filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  conversation_id UUID,
  -- TTL per cleanup futuro (iter #5)
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS idx_anthropic_files_expires ON cervellone_anthropic_files(expires_at);
CREATE INDEX IF NOT EXISTS idx_anthropic_files_conv ON cervellone_anthropic_files(conversation_id);

-- RLS DISABLED come per altre tabelle Cervellone (server-only access via service_role)
ALTER TABLE cervellone_anthropic_files DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_anthropic_files IS 'Tracking file uploadati su Anthropic Files API. Cleanup cron pending (iter #5).';
