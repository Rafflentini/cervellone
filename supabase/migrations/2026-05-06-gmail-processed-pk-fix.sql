-- Migration correttiva: gmail_processed_messages PK composita
--
-- Bug identificato da Cowork 2026-05-06: PK su solo message_id impedisce
-- di tracciare lo stesso messaggio attraverso più bot_action. Con upsert,
-- l'ultima action overwrites la precedente. Conseguenza: cron alerts
-- non riesce a verificare correttamente "questa mail è già stata
-- notified_critical?" se nel frattempo è stata labelata/archiviata.
--
-- Fix: PK composita (message_id, bot_action). Permette N rows per stessa
-- mail, una per ogni action distinta. Upsert con onConflict esplicito.

ALTER TABLE gmail_processed_messages DROP CONSTRAINT IF EXISTS gmail_processed_messages_pkey;
ALTER TABLE gmail_processed_messages ADD PRIMARY KEY (message_id, bot_action);

COMMENT ON TABLE gmail_processed_messages IS 'Track mail viste/processate per anti-loop e idempotenza. PK composita (message_id, bot_action) — una mail può passare per più stati distinti.';
