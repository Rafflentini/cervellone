-- Foto cantiere/progetto: record persistente delle foto in attesa di archiviazione.
-- La foto è già su Drive (Telegram Inbox) al caricamento; questo record la lega al
-- cantiere/progetto e sopravvive ad attese/riavvii finché non è spostata (stato 'archiviata').
-- Applicata in prod via apply_migration il 2026-05-26 (file aggiunto per coerenza repo).

create table if not exists public.cervellone_foto_pending (
  id uuid primary key default gen_random_uuid(),
  chat_id text,
  canale text not null check (canale in ('telegram','web')),
  drive_file_id text not null,
  drive_url text,
  filename text,
  ambito text check (ambito in ('cantiere','progetto')),
  soggetto text,
  lavorazione text,
  data_lavorazione date,
  target_folder_id text,
  stato text not null default 'in_attesa' check (stato in ('in_attesa','da_archiviare','archiviata','errore')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.cervellone_foto_pending enable row level security;
create policy "deny_all_anon_auth" on public.cervellone_foto_pending
  for all to anon, authenticated using (false) with check (false);
create index if not exists idx_foto_pending_chat_stato on public.cervellone_foto_pending (chat_id, stato);
