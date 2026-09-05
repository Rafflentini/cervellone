-- Fatture estere: il registro deve reggere TRE caselle, non una.
--
-- Contesto: il cron mensile girava puntuale dal 1° giugno 2026 e non aveva mai
-- inoltrato una fattura. Misurando le caselle vere: leggeva solo info@, dove i
-- fornitori esteri non scrivono; le fatture arrivavano su raffaele.lentini@.
-- Ora le caselle scandagliate sono tre (info, raffaele, gmail).
--
-- Gli identificativi Gmail sono stringhe esadecimali, quindi source_uid
-- (integer) non li puo' contenere: serve una chiave testuale.
-- La tabella era VUOTA quando questa migrazione e' stata applicata, quindi
-- nessun dato esistente e' stato toccato.

alter table cervellone_email_invoices_log
  add column if not exists source_account text,
  add column if not exists source_key text;

alter table cervellone_email_invoices_log
  alter column source_uid drop not null;

update cervellone_email_invoices_log
  set source_account = coalesce(source_account, 'raffaele'),
      source_key = coalesce(source_key, source_uid::text)
  where source_account is null or source_key is null;

alter table cervellone_email_invoices_log
  alter column source_account set not null,
  alter column source_key set not null;

-- Il divieto di doppione sta QUI e non solo nel codice: il controllo
-- applicativo (leggo, poi scrivo) non e' atomico, e un cron lanciato due volte
-- di fila inoltrerebbe la stessa fattura due volte. Con l'indice unico la
-- seconda scrittura fallisce, e la routine lo dichiara in `errori_registro`.
create unique index if not exists cervellone_email_invoices_log_unico
  on cervellone_email_invoices_log (month_ref, source_account, source_key);

comment on column cervellone_email_invoices_log.source_account is
  'Casella di provenienza: info | raffaele | gmail';
comment on column cervellone_email_invoices_log.source_key is
  'Identificativo del messaggio nella sua casella: uid IMAP (numerico) o id Gmail (esadecimale).';

-- ── Seconda parte, dopo l'audit ──────────────────────────────────────────────
-- Il vincolo VECCHIO era rimasto in piedi accanto a quello nuovo:
--   UNIQUE (month_ref, source_uid, source_folder)   con source_folder = 'INBOX'
-- Gli uid IMAP sono numerati PER CASELLA: info@ e raffaele@ possono avere lo
-- stesso uid nello stesso mese (~250 messaggi al mese l'una: succede). La
-- seconda fattura sarebbe stata spedita davvero e l'insert rifiutato, quindi
-- nessuna traccia nel registro e reinvio il mese dopo. Un doppione nato da un
-- vincolo che era giusto quando le caselle erano una.
alter table cervellone_email_invoices_log
  drop constraint if exists cervellone_email_invoices_log_month_ref_source_uid_source_f_key;
