-- Chiave d'invio per la chat web — l'equipollente di `telegram_dedup`.
--
-- Telegram deduplica gli invii su (chat_id, message_id), con una PRIMARY KEY,
-- quindi atomica: in sei mesi, zero domande duplicate. Il web non aveva
-- niente, e nel dato si vedeva — 85 domande dell'Ingegnere scritte due volte
-- fra aprile e il 20 agosto 2026, tutte a meno di 10 secondi di distanza, cioe'
-- la durata di `searchMemory` fra le due scritture.
--
-- Il difetto che le ha prodotte e' chiuso (`48d1d08`), ma la chiusura poggiava
-- su una sola `if` applicativa: a livello di database non c'era NIENTE. Questo
-- indice e' la rete che mancava, e vale anche per una scheda che gira col
-- bundle vecchio.
--
-- Perche' non una dedup sul CONTENUTO: scarterebbe un "ok" o un "procedi"
-- scritti due volte in cinque minuti, cioe' una perdita muta di dati legittimi
-- dentro il lavoro che elimina le perdite mute. La chiave d'invio distingue le
-- due cose per costruzione: due invii veri hanno due chiavi.
--
-- L'indice e' PARZIALE (`WHERE client_msg_id IS NOT NULL`) perche' nessuna
-- modifica al client raggiunge una scheda gia' aperta: chi non manda la chiave
-- deve continuare a scrivere come prima, senza vincolo.
--
-- Lato applicazione l'INSERT e' tollerante alla unique violation (Postgres
-- 23505): un doppione respinto e' un successo, non un errore, e chi lo manda
-- riceve 200 — altrimenti il browser mostrerebbe un guasto che non c'e'.
--
-- La migrazione NON viene applicata al DB automaticamente: la applica
-- l'orchestratore.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS client_msg_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_client_msg_id
  ON public.messages (conversation_id, client_msg_id)
  WHERE client_msg_id IS NOT NULL;
