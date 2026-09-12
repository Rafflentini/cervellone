-- Task 12 — la via d'uscita dal blocco sui dati societari.
--
-- `messaggioBlocco` (src/lib/guardia-societa.ts) prometteva "se e' voluto,
-- dimmelo e lo genero comunque" senza avere un modo per mantenerla: se
-- l'Ingegnere rispondeva a voce, il modello ritentava, la guardia bloccava di
-- nuovo, e si otteneva un giro a vuoto — la stessa frustrazione di cui si e'
-- lamentato il 12 set 2026 («mi ha chiesto conferma 4 volte senza inviarla
-- davvero»). Questa tabella e' la via d'uscita VERA: un codice tappabile,
-- che l'Ingegnere concede lui stesso, legato a UN documento preciso.
--
-- Le cinque scelte che la rendono sicura (vedi task-12-brief.md):
--  1. legata all'IMPRONTA del contenuto (md5), non alla conversazione: non
--     spegne la guardia per il resto della giornata;
--  2. scade in 30 minuti (`scadenza`): il tempo di leggere e tappare;
--  3. la concede l'Ingegnere tappando /doc_ok_<codice> — un comando nella
--     ROUTE del canale, dove il modello non arriva. Nessun tool puo'
--     valorizzare `concessa_at`;
--  4. il messaggio col codice nomina le partite IVA accettate
--     (`pive_accettate`): si autorizza una cosa che si e' letta;
--  5. si usa una volta (`usata_at`): consumata alla prima generazione
--     riuscita.
--
-- ⚠️ Chiave primaria `uuid` (testo), NON `id`: e' il difetto A2 della lista
-- di controllo (un nome di colonna scritto a mano che non esiste), vissuto
-- in produzione per tre mesi sulle mail in sospeso.

create table if not exists public.cervellone_guardia_autorizzazioni (
  uuid             text primary key,
  conversation_id  text not null,
  impronta         text not null,               -- md5 del contenuto autorizzato: lega l'autorizzazione a QUEL documento
  pive_accettate   text[] not null default '{}',-- le P.IVA che l'Ingegnere ha accettato di vedere nel documento
  scadenza         timestamptz not null,
  concessa_at      timestamptz,                  -- quando l'Ingegnere ha tappato /doc_ok_<codice>
  usata_at         timestamptz,                  -- quando ha davvero sbloccato una generazione (una volta sola)
  created_at       timestamptz not null default now()
);

-- La ricerca di un'autorizzazione valida per QUESTO contenuto avviene per
-- conversazione + impronta, fra quelle non ancora consumate.
create index if not exists idx_cervellone_guardia_autorizzazioni_ricerca
  on public.cervellone_guardia_autorizzazioni (conversation_id, impronta)
  where usata_at is null;

alter table public.cervellone_guardia_autorizzazioni enable row level security;

-- Stesso profilo di tutte le altre tabelle cervellone_*: solo il service role.
-- 57 tabelle su 57 ce l'hanno: una tabella nuova senza RLS e' il difetto che
-- l'11 set 2026 e' passato inosservato dentro un piano.
drop policy if exists "service_role_all_cervellone_guardia_autorizzazioni" on public.cervellone_guardia_autorizzazioni;
create policy "service_role_all_cervellone_guardia_autorizzazioni"
  on public.cervellone_guardia_autorizzazioni
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.cervellone_guardia_autorizzazioni is
  'Autorizzazioni una tantum che sciolgono il blocco della guardia sui dati societari (src/lib/guardia-societa.ts) per UN documento preciso (impronta md5), concesse dall''Ingegnere tappando /doc_ok_<codice>. Chiave uuid (testo), non id. Vedi Task 12, 2026-09-12-guardia-autorizzazioni.sql.';
