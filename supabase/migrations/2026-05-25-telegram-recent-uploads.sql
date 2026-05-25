-- telegram_recent_uploads: registra ogni file caricato via Telegram (foto/doc), anche se il
-- turno LLM viene scartato dal mutex per-chat. Permette di allegare gli upload recenti non
-- processati al turno successivo (fix multi-foto / album, Approccio 2).
-- RLS pattern Cervellone: deny-all anon/auth, accesso solo service_role server-side.

create table if not exists public.telegram_recent_uploads (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  telegram_file_id text not null,
  drive_url text,
  drive_file_id text,
  filename text,
  caption text,
  mime_type text,
  processed boolean not null default false,
  inserted_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_recent_uploads_chat_unprocessed
  on public.telegram_recent_uploads (chat_id, inserted_at desc) where processed = false;

alter table public.telegram_recent_uploads enable row level security;

create policy "deny_all_anon_auth" on public.telegram_recent_uploads
  for all to anon, authenticated using (false) with check (false);

comment on table public.telegram_recent_uploads is
  'Upload Telegram recenti (foto/doc) per allegarli al turno successivo (fix multi-foto). RLS deny-all anon/auth.';
