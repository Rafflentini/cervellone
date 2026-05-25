-- cervellone_scadenze: scadenzario generico (documenti + reminder)
-- Toolkit segretaria Fase 1. Soggetto/categoria/tipo liberi (no anagrafica hardcoded).
-- RLS pattern Cervellone: deny-all anon+authenticated; accesso solo via service_role server-side.

create table if not exists public.cervellone_scadenze (
  id uuid primary key default gen_random_uuid(),
  soggetto text not null,
  categoria text,
  tipo_documento text,
  data_scadenza date not null,
  reminder_days int not null default 5,
  recipients text[] not null default array['info@restruktura.it','raffaele.lentini@restruktura.it'],
  drive_file_id text,
  drive_url text,
  note text,
  reminders_sent jsonb not null default '[]'::jsonb,
  stato text not null default 'attivo' check (stato in ('attivo','sostituito','archiviato')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_scadenze_data_attive
  on public.cervellone_scadenze (data_scadenza) where stato = 'attivo';
create index if not exists idx_scadenze_soggetto
  on public.cervellone_scadenze (soggetto);

alter table public.cervellone_scadenze enable row level security;

create policy "deny_all_anon_auth" on public.cervellone_scadenze
  for all to anon, authenticated using (false) with check (false);

comment on table public.cervellone_scadenze is
  'Scadenzario generico Cervellone (documenti + reminder). RLS deny-all anon/auth; accesso service_role server-side.';
