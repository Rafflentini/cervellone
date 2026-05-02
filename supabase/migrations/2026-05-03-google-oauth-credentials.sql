-- Migration W1.3.5: Google OAuth credentials storage
-- Scopo: salvare refresh_token + access_token per accedere a Drive con quota utente
-- (Service Account ha quota 0 su Drive personali — bypass via OAuth flow)

CREATE TABLE IF NOT EXISTS google_oauth_credentials (
  id BIGSERIAL PRIMARY KEY,
  account_email TEXT NOT NULL UNIQUE,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_google_oauth_email ON google_oauth_credentials(account_email);

-- RLS: solo service_role può accedere (refresh_token è secret)
ALTER TABLE google_oauth_credentials ENABLE ROW LEVEL SECURITY;

-- No policy = solo service_role bypass RLS via Supabase service key.
-- Anon/authenticated NON possono leggere o scrivere.

COMMENT ON TABLE google_oauth_credentials IS 'OAuth refresh_token per accesso Drive utente. Bypass quota Service Account.';
COMMENT ON COLUMN google_oauth_credentials.refresh_token IS 'SENSITIVE — long-lived token per generare access_token';
COMMENT ON COLUMN google_oauth_credentials.access_token IS 'Short-lived (1h), auto-refreshed da googleapis library';
