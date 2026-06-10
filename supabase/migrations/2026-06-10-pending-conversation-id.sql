-- 2026-06-10 — Consapevolezza mail inviate per gli invii ESTERNI (pending → confirm).
--
-- Gli invii verso destinatari esterni passano da cervellone_email_pending_send e
-- l'invio REALE avviene alla conferma utente (confirmPendingSend), percorso che NON
-- transita da executeMailWrapper. Aggiungiamo conversation_id alla riga pending così
-- che, al momento della conferma, possiamo registrare la mail come "già inviata"
-- (recordSentMail) nella conversazione di origine.
ALTER TABLE cervellone_email_pending_send
  ADD COLUMN IF NOT EXISTS conversation_id text;
