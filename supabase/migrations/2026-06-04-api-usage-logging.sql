-- API usage logging — traccia consumo token/costo per componente (Step 1 cost-control 4 giu 2026).
-- Best-effort: il bot scrive una riga dopo ogni chiamata Claude. Permette report costo-per-componente.
-- RLS: solo service_role (coerente con hardening RLS — nessuna policy permissiva).

create table if not exists api_usage (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  entry_point text not null,            -- 'telegram' | 'chat' | 'cron:audit' | 'cron:memoria' | 'cron:gmail-morning' | 'mail-subagent' | 'self-heal' | ...
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_creation_tokens integer not null default 0,
  estimated_cost_usd numeric(12,6) not null default 0,
  meta jsonb
);

create index if not exists api_usage_ts_idx on api_usage (ts desc);
create index if not exists api_usage_entry_ts_idx on api_usage (entry_point, ts desc);

alter table api_usage enable row level security;
-- Nessuna policy permissiva: accesso solo via service_role (server-side).
