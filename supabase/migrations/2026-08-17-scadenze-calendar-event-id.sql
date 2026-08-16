-- cervellone_scadenze: dedup degli eventi Google Calendar + guardia contro le
-- righe attive duplicate.
--
-- PERCHÉ (audit 17/08/2026 sul cablaggio scadenza→Calendar, commit 6634b10):
--
-- 1. Senza `calendar_event_id` non c'è modo di ritrovare l'evento creato per una
--    scadenza, quindi alla sostituzione il vecchio evento resta in agenda CON I
--    SUOI REMINDER: non è rumore visivo, è una notifica futura per una scadenza
--    che non esiste più. E la sostituzione è il flusso NOMINALE, non un caso
--    limite: il bot riepiloga e chiede conferma proprio perché la lettura di date
--    può sbagliare (prompts.ts), quindi ogni correzione di data produce un
--    fantasma. Dopo tre anni di rinnovi (DURC ogni 120 giorni, visita medica
--    ogni anno) un solo dipendente accumula ~9 eventi omonimi, tutti attivi.
--
-- 2. `marcaSostituite` è un read-modify-write non atomico su due round-trip
--    PostgREST. Due `registra_scadenza` concorrenti con la stessa chiave possono
--    marcare `sostituito` a vicenda la riga dell'altra e lasciare ZERO righe
--    attive — l'invariante che il fix di atomicità voleva rendere impossibile.
--    Il mutex per-chat del webhook Telegram serializza il caso normale, ma cede
--    dopo 150s di stale-lock, nel ramo degradato, e sugli entry point non-Telegram.
--
-- IDEMPOTENTE: si può rieseguire senza danno.

alter table public.cervellone_scadenze
  add column if not exists calendar_event_id text;

comment on column public.cervellone_scadenze.calendar_event_id is
  'ID evento Google Calendar creato da registra_scadenza. Serve a cancellare/aggiornare il vecchio evento quando la scadenza viene sostituita, invece di lasciarlo in agenda con i suoi reminder.';

-- La chiave di identità di una scadenza è soggetto + tipo_documento + categoria,
-- tutti normalizzati (lower+trim), e vale solo fra le righe ATTIVE: le storiche
-- 'sostituito'/'archiviato' devono poter coesistere quante sono.
--
-- ATTENZIONE PRIMA DI APPLICARLA: se in tabella ci sono GIÀ duplicati attivi
-- (probabile, visto che fino a oggi il match su tipo_documento era
-- case-sensitive e 'DURC' vs 'Durc' non si sostituivano), la create index
-- fallisce. Trovarli con:
--
--   select lower(trim(soggetto))               as sogg,
--          lower(trim(coalesce(tipo_documento,''))) as tipo,
--          lower(trim(coalesce(categoria,'')))      as cat,
--          count(*), array_agg(id order by created_at)
--   from public.cervellone_scadenze
--   where stato = 'attivo'
--   group by 1,2,3
--   having count(*) > 1;
--
-- e chiudere le più vecchie di ogni gruppo (stato='sostituito'), tenendo la più
-- recente, PRIMA di creare l'indice.

create unique index if not exists uq_scadenze_attive_chiave
  on public.cervellone_scadenze (
    lower(trim(soggetto)),
    lower(trim(coalesce(tipo_documento, ''))),
    lower(trim(coalesce(categoria, '')))
  )
  where stato = 'attivo';
