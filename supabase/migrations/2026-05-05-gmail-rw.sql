-- Gmail R+W (Fase 2 sostituzione personale) — schema alert_rules + processed_messages

-- 1. Regole per critical alert push immediato (keyword o mittente VIP)
CREATE TABLE IF NOT EXISTS gmail_alert_rules (
  id BIGSERIAL PRIMARY KEY,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('keyword', 'sender_vip')),
  pattern TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'high' CHECK (severity IN ('high', 'medium', 'low')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_gmail_alert_rules_enabled
  ON gmail_alert_rules (enabled, rule_type);
ALTER TABLE gmail_alert_rules DISABLE ROW LEVEL SECURITY;
COMMENT ON TABLE gmail_alert_rules IS 'Regole keyword + sender VIP per critical alert push immediato.';

-- Seed iniziale 7 keyword + 2 pattern VIP (rivedere dopo deploy)
INSERT INTO gmail_alert_rules (rule_type, pattern, severity, notes) VALUES
  ('keyword', 'urgente', 'high', 'Parola chiave esplicita di urgenza'),
  ('keyword', 'scadenza', 'high', 'Scadenze fiscali o burocratiche'),
  ('keyword', 'pignoramento', 'high', 'Atti giudiziari'),
  ('keyword', 'DURC', 'medium', 'Documenti regolarità contributiva'),
  ('keyword', 'INPS', 'medium', 'Comunicazioni INPS'),
  ('keyword', 'INAIL', 'medium', 'Comunicazioni INAIL'),
  ('keyword', 'fattura', 'low', 'Fatture in arrivo'),
  ('sender_vip', 'noreply@pec.', 'high', 'PEC sempre rilevante'),
  ('sender_vip', 'cassaedile', 'high', 'Cassa Edile')
ON CONFLICT DO NOTHING;

-- 2. Track mail già processate dal bot (anti-loop + idempotenza summary/alert)
CREATE TABLE IF NOT EXISTS gmail_processed_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  from_address TEXT,
  subject TEXT,
  bot_action TEXT NOT NULL CHECK (bot_action IN (
    'notified_critical','in_summary','draft_created','sent_reply',
    'labeled','archived','trashed','marked_read'
  )),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gmail_processed_thread
  ON gmail_processed_messages (thread_id, ts DESC);
ALTER TABLE gmail_processed_messages DISABLE ROW LEVEL SECURITY;
COMMENT ON TABLE gmail_processed_messages IS 'Track mail viste/processate per anti-loop e idempotenza.';

-- 3. Config keys (cron timestamp + silent mode)
INSERT INTO cervellone_config (key, value) VALUES
  ('gmail_summary_last_run', 'null'),
  ('gmail_alert_check_last_run', 'null'),
  ('gmail_silent_until', 'null')
ON CONFLICT (key) DO NOTHING;
