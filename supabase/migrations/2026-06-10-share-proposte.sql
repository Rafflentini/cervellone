-- supabase/migrations/2026-06-10-share-proposte.sql
create table if not exists cervellone_share_proposte (
  id uuid primary key default gen_random_uuid(),
  document_id text not null,
  giorni int not null default 7,
  stato text not null default 'in_attesa', -- in_attesa | confermata | annullata
  created_at timestamptz not null default now()
);
alter table cervellone_share_proposte enable row level security;
