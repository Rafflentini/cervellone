-- cervellone_doc_proposte: proposte della sentinella documenti personale.
-- La sentinella rileva un documento (idoneità/attestato/...) in arrivo via mail, estrae la
-- scadenza e crea una proposta "in_attesa" da confermare. Supporta escalation (attempts) e
-- auto-memorizzazione al 3° silenzio. RLS deny-all (accesso service_role server-side).

create table if not exists public.cervellone_doc_proposte (
  id uuid primary key default gen_random_uuid(),
  account text not null,                 -- 'info' | 'raffaele'
  uid bigint not null,                   -- UID IMAP della mail
  folder text not null default 'INBOX',
  message_subject text,
  attachment_filename text,
  drive_url text,
  tipo_documento text,
  soggetto text,
  data_scadenza date,
  emittente text,
  confidenza real,
  stato text not null default 'in_attesa'
    check (stato in ('in_attesa','confermata','ignorata','auto_memorizzata')),
  attempts int not null default 0,       -- quante volte è stata proposta
  last_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account, uid, attachment_filename)
);

create index if not exists idx_proposte_stato on public.cervellone_doc_proposte (stato, created_at);

alter table public.cervellone_doc_proposte enable row level security;

create policy "deny_all_anon_auth" on public.cervellone_doc_proposte
  for all to anon, authenticated using (false) with check (false);

comment on table public.cervellone_doc_proposte is
  'Proposte sentinella documenti personale (mail → scadenza). RLS deny-all anon/auth.';
