-- Registro delle chiamate ai tool. Serve a due cose:
-- 1) scegliere il nucleo dei tool su dati veri invece che a intuito;
-- 2) accorgersi se un tool smette di essere raggiunto dopo il differimento.
-- Senza, un guasto si travestirebbe da colpa dell'utente.
create table if not exists cervellone_tool_calls (
  id bigserial primary key,
  nome text not null,
  conversation_id uuid,
  durata_ms integer,
  riconosciuto boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_tool_calls_created on cervellone_tool_calls (created_at desc);
create index if not exists idx_tool_calls_nome on cervellone_tool_calls (nome, created_at desc);
