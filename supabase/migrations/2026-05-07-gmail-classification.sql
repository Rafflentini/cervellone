-- Cervellone — Gmail classification automatica (Sub-progetto C)

CREATE TABLE IF NOT EXISTS cervellone_gmail_categorie (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  seed_examples TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_gmail_categorie_enabled
  ON cervellone_gmail_categorie (enabled);

ALTER TABLE cervellone_gmail_categorie DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_gmail_categorie IS
  'Categorie classifier Gmail. description usata nel prompt LLM. seed_examples come hint.';

INSERT INTO cervellone_gmail_categorie (name, description, seed_examples) VALUES
  ('Cliente',
   'Mail da committenti privati o aziende che richiedono lavori, sopralluoghi, preventivi, perizie',
   ARRAY['richiesta preventivo', 'sopralluogo', 'incarico', 'commissione', 'lavoro']),
  ('Fornitore',
   'Mail da fornitori di materiali edili o servizi: preventivi ricevuti, fatture passive, listini',
   ARRAY['listino', 'preventivo allegato', 'fattura n', 'ordine confermato', 'consegna']),
  ('DURC',
   'Mail relative al DURC: richieste, scadenze, comunicazioni Cassa Edile, INPS, INAIL',
   ARRAY['DURC', 'regolarità contributiva', 'cassa edile', 'INPS', 'INAIL']),
  ('Bandi',
   'Mail su bandi pubblici, gare d''appalto, MEPA, opportunità di partecipazione',
   ARRAY['bando', 'gara appalto', 'MEPA', 'CIG', 'CUP', 'avviso pubblico']),
  ('Spam tecnico',
   'Newsletter tecniche, marketing prodotti edili, eventi, fiere, comunicati commerciali non personalizzati',
   ARRAY['newsletter', 'webinar', 'fiera', 'sconto', 'novità prodotto', 'unsubscribe'])
ON CONFLICT (name) DO NOTHING;

ALTER TABLE gmail_processed_messages DROP CONSTRAINT IF EXISTS gmail_processed_messages_bot_action_check;
ALTER TABLE gmail_processed_messages ADD CONSTRAINT gmail_processed_messages_bot_action_check
  CHECK (bot_action IN (
    'notified_critical','in_summary','draft_created','sent_reply',
    'labeled','archived','trashed','marked_read',
    'classified','classified_skip'
  ));

INSERT INTO cervellone_config (key, value) VALUES
  ('gmail_classify_last_run', 'null')
ON CONFLICT (key) DO NOTHING;
