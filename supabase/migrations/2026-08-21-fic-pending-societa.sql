-- 2026-08-21 — la bozza di fattura ricorda a quale società appartiene
--
-- PERCHE'. La creazione di un documento su Fatture in Cloud avviene in due
-- passaggi separati nel tempo: prima `compilaDocumento` salva la bozza qui, poi
-- `confirmFicStep2` la crea davvero, dopo la doppia conferma dell'Ingegnere.
--
-- Con due società, se la bozza non porta con sé l'azienda a cui appartiene, al
-- momento della conferma il codice dovrebbe indovinarla — e indovinare male
-- significa emettere una fattura da una partita IVA sbagliata. Una fattura
-- elettronica trasmessa non si cancella: si corregge con nota di credito.
--
-- SICUREZZA: additiva. La tabella e vuota (0 righe, verificato), il default
-- serve solo a non rompere eventuali scritture che non passano ancora la
-- societa. Il vincolo CHECK rifiuta un codice non previsto invece di scriverlo.

alter table public.cervellone_fic_pending
  add column if not exists societa text not null default 'restruktura'
  check (societa in ('restruktura', 'larealestate'));
