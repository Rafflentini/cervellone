-- Bug 1 (mutex per chat): tabella per evitare bgProcess paralleli sulla stessa chat.
-- Quando l'utente manda un messaggio mentre il bot sta elaborando il precedente,
-- la nuova richiesta deve droppare invece di partire in parallelo (causa hallucination
-- "Trovato!" senza tool, streaming sovrapposti, contesto inconsistente).

CREATE TABLE IF NOT EXISTS telegram_active_jobs (
  chat_id BIGINT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_id TEXT
);

-- Indice per pulizia stale lock (>5 min = function Vercel timeout)
CREATE INDEX IF NOT EXISTS idx_telegram_active_jobs_started_at
  ON telegram_active_jobs (started_at);

-- RLS off: tabella interna usata solo dal backend con service role
ALTER TABLE telegram_active_jobs DISABLE ROW LEVEL SECURITY;
