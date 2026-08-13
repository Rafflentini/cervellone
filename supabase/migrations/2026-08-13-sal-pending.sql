-- 2026-08-13 SAL pending (doppia conferma, modello cervellone_fic_pending)
create table if not exists public.cervellone_sal_pending (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null,
  descrizione text not null,
  stato text not null default 'in_attesa',   -- in_attesa | creato | annullato
  conferme int not null default 0,            -- 0 -> 1 (step1) -> 2 (step2)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.cervellone_sal_pending enable row level security;
-- Nessuna policy pubblica: accesso solo via service role (come cervellone_fic_pending).
