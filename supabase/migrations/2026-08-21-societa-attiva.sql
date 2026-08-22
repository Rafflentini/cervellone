-- 2026-08-21 — la società attiva per conversazione
--
-- PERCHE'. Cervellone tiene la contabilità di due società. Ogni operazione deve
-- sapere per quale sta lavorando, e la scelta deve essere esplicita: dedurla dal
-- discorso significa, prima o poi, registrare un movimento nella società
-- sbagliata o emettere una fattura dalla partita IVA sbagliata. Nessuno dei due
-- errori da segnale: si scoprono dal commercialista, mesi dopo.
--
-- Ricalca il pattern gia collaudato del "progetto attivo" (project_state).
--
-- Il CHECK e deliberato: un codice societa non previsto deve essere RIFIUTATO
-- dal database, non scritto e scoperto dopo. Se un domani si aggiunge una terza
-- societa, il vincolo va esteso qui e nel registro in src/lib/societa.ts —
-- fallire alla scrittura e meglio che accorgersene a fatture emesse.

create table if not exists public.cervellone_societa_attiva (
  conversation_id uuid primary key,
  societa text not null check (societa in ('restruktura', 'larealestate')),
  updated_at timestamptz not null default now()
);

-- RLS come su tutte le altre tabelle applicative (verificato: movimenti,
-- riconciliazioni, fic_pending e google_oauth_credentials ce l'hanno).
--
-- Non è una formalità: il repository è PUBBLICO, quindi la chiave anon è nota.
-- Senza RLS un estraneo potrebbe leggere e soprattutto RISCRIVERE quale società
-- è attiva in una conversazione — cioè dirottare le operazioni contabili su
-- un'altra azienda. Il servizio usa la service key e non è toccato dalla policy.
alter table public.cervellone_societa_attiva enable row level security;

drop policy if exists "deny_anon_societa_attiva" on public.cervellone_societa_attiva;
create policy "deny_anon_societa_attiva"
  on public.cervellone_societa_attiva
  for all
  to anon, authenticated
  using (false)
  with check (false);
