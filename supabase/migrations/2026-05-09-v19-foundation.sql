-- Cervellone V19 — Foundation migration
-- Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 12
-- NON applicare in prod senza review utente.

-- ============================================================
-- 1) agent_runs — track ogni run del loop V19
-- ============================================================
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  parent_run_id uuid references agent_runs(id) on delete cascade,
  kind text not null,
    -- 'orchestrator' | 'parsing-files' | 'numerical-engine' |
    -- 'document-render' | 'domain-italiano' | 'web-research' | 'gmail-router'
  intent text not null, -- 'chat' | 'generation' | 'agentic'
  status text not null default 'running',
    -- 'running' | 'completed' | 'failed' | 'paused'
  container_id text,
    -- Anthropic code_execution container id, riusabile cross-request
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  iterations int default 0,
  tokens_input bigint default 0,
  tokens_output bigint default 0,
  thinking_tokens bigint default 0,
  error_message text,
  summary text
);

create index if not exists agent_runs_conversation_idx
  on agent_runs(conversation_id, started_at desc);
create index if not exists agent_runs_parent_idx
  on agent_runs(parent_run_id);
create index if not exists agent_runs_status_idx
  on agent_runs(status) where status = 'running';

-- ============================================================
-- 2) sub_agent_jobs — queue specifica spawn_subagent
-- ============================================================
create table if not exists sub_agent_jobs (
  run_id uuid primary key references agent_runs(id) on delete cascade,
  task text not null,
  input_files jsonb not null default '[]'::jsonb,
  artifacts jsonb default '[]'::jsonb
);

-- ============================================================
-- 3) document_renders — audit trail Quality Gate
-- ============================================================
create table if not exists document_renders (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  run_id uuid references agent_runs(id),
  kind text not null, -- 'docx' | 'xlsx' | 'pdf' | 'csv' | 'zip' | 'other'
  semantic_input jsonb not null,
  drive_file_id text,
  drive_url text,
  state text not null default 'draft',
    -- 'draft' | 'review' | 'firmato' | 'archiviato'
  created_at timestamptz not null default now(),
  signed_at timestamptz,
  audit_log jsonb default '[]'::jsonb
);

create index if not exists document_renders_conversation_idx
  on document_renders(conversation_id, created_at desc);
create index if not exists document_renders_state_idx
  on document_renders(state);

-- ============================================================
-- 4) e2b_sandboxes — riuso sandbox cross-request (feature-flagged)
-- ============================================================
create table if not exists e2b_sandboxes (
  conversation_id text primary key,
  sandbox_id text not null,
  created_at timestamptz not null default now(),
  last_used timestamptz not null default now(),
  killed_at timestamptz
);

-- ============================================================
-- RLS DISABLED (allineato a pattern V18: admin-only)
-- ============================================================
alter table agent_runs disable row level security;
alter table sub_agent_jobs disable row level security;
alter table document_renders disable row level security;
alter table e2b_sandboxes disable row level security;
