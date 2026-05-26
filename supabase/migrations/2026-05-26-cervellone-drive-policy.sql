-- Governance accessi Drive: cartelle radice in cui Cervellone può SCRIVERE.
-- Una scrittura è permessa se la destinazione è una radice consentita o una sua discendente
-- (enforcement in src/lib/drive.ts -> assertWriteAllowed). Gestione con doppia conferma.

create table if not exists public.cervellone_drive_policy (
  id uuid primary key default gen_random_uuid(),
  folder_id text not null unique,
  folder_name text not null,
  can_write boolean not null default true,
  added_at timestamptz not null default now()
);
alter table public.cervellone_drive_policy enable row level security;
create policy "deny_all_anon_auth" on public.cervellone_drive_policy
  for all to anon, authenticated using (false) with check (false);

create table if not exists public.cervellone_drive_policy_pending (
  id uuid primary key default gen_random_uuid(),
  folder_query text not null,
  folder_id text,
  folder_name text,
  azione text not null check (azione in ('consenti','revoca')),
  conferme int not null default 0,
  stato text not null default 'pending' check (stato in ('pending','applicata','annullata')),
  created_at timestamptz not null default now()
);
alter table public.cervellone_drive_policy_pending enable row level security;
create policy "deny_all_anon_auth" on public.cervellone_drive_policy_pending
  for all to anon, authenticated using (false) with check (false);

-- Seed iniziale (scelta utente 2026-05-26): Studio Tecnico + Impresa Edile.
-- POS/DURC/DVR vivono sotto Doc. Impresa Edile -> coperti dalla regola discendenza.
-- Real Estate SRLS verrà aggiunta dall'utente via chat (doppia conferma).
insert into public.cervellone_drive_policy (folder_id, folder_name) values
  ('1fPrUX_GTZVYITQVk-CW0VuXSGs1Db3If','Studio Tecnico ATTIVI'),
  ('1-pExmiifvV9v8sfSzEkR0XNYi8tdXAkj','Studio Tecnico ARCHIVIO'),
  ('1PAXIQwW4opTJtJPZA0JCApZKYVJr63eq','Doc. Impresa Edile')
on conflict (folder_id) do nothing;
