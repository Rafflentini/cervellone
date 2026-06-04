-- Memoria di lavoro + memoria procedurale (4 giu 2026).
-- Obiettivo: Cervellone conserva il contesto del progetto attivo TRA i messaggi/sessioni,
-- e impara "come si fa" un tipo di documento, perfezionandosi con le correzioni dell'utente.
-- RLS: solo service_role (coerente con hardening RLS, nessuna policy permissiva).

-- ── Memoria procedurale: un "playbook" per tipo di documento/task ──
create table if not exists procedures (
  id bigint generated always as identity primary key,
  task_type text not null unique,          -- 'pos' | 'preventivo' | 'cme' | 'ddt' | 'perizia' | ...
  title text not null,
  checklist jsonb not null default '[]',    -- [{ "step": "...", "source": "dove stanno i dati" }] passi OBBLIGATORI
  output_spec text,                         -- es. ">=20 pagine A4, Allegato XV D.Lgs 81/2008"
  save_location text,                       -- es. "cantiere/04_Sicurezza/POS; POS appaltatore -> 04_Sicurezza/PSC"
  lessons jsonb not null default '[]',      -- append-only: apprendimenti confermati dall'utente
  updated_at timestamptz not null default now()
);
alter table procedures enable row level security;

-- ── Memoria di lavoro: stato del progetto ATTIVO per conversazione ──
-- Chiave: conversation_id. Per Telegram è chatIdToUuid(chatId), DETERMINISTICO e stabile
-- per chat tra sessioni (telegram/route.ts:474) → la memoria progetto persiste cross-sessione.
-- Per il web è l'id del thread di conversazione.
create table if not exists project_state (
  id bigint generated always as identity primary key,
  conversation_id text not null,
  channel text,                             -- 'telegram' | 'web' (informativo)
  project_name text,
  cliente text,
  cantiere text,
  task_type text,
  status text not null default 'active',    -- 'active' | 'done'
  key_files jsonb not null default '{}',    -- { "dvr": "<id/url>", "psc": "...", "contratto": "..." }
  done jsonb not null default '[]',         -- passi completati
  pending jsonb not null default '[]',      -- cosa manca
  decisions jsonb not null default '[]',    -- decisioni prese (es. "scope = massetto")
  updated_at timestamptz not null default now()
);
alter table project_state enable row level security;

-- Un solo progetto ATTIVO per conversazione (i 'done' storici non sono vincolati).
create unique index if not exists project_state_active_uniq
  on project_state (conversation_id) where status = 'active';
create index if not exists project_state_lookup_idx
  on project_state (conversation_id, status);

-- Flag di attivazione (OFF di default: con flag off il comportamento è invariato).
insert into cervellone_config (key, value)
values ('working_memory_enabled', 'false')
on conflict (key) do nothing;

-- ── Seed: procedura POS (appresa la sera del 4 giu 2026) ──
insert into procedures (task_type, title, checklist, output_spec, save_location, lessons)
values (
  'pos',
  'POS Restruktura (impresa esecutrice) — Allegato XV D.Lgs 81/2008',
  '[
    {"step": "Leggi il DVR Restruktura su Drive ed estrai organico sicurezza", "source": "DVR Restruktura (DOC. IMPRESA EDILE): RSPP, medico competente, RLS, addetti emergenza/antincendio/primo soccorso, organico"},
    {"step": "Leggi il PSC del cantiere ed estrai i dati cantiere", "source": "PSC del cantiere: indirizzo, committente, CSE/CSP, opere, importi, durata"},
    {"step": "Prendi le posizioni assicurative dall''anagrafica Restruktura", "source": "anagrafica: INPS 6405841659, PAT INAIL 96119656/99, Cod. INAIL 20748666/52, Cassa Edile 11338, sede Via Roma 60 Marsicovetere, P.IVA 02087420762"},
    {"step": "Determina lo scope lavorazioni dal contratto/subappalto", "source": "contratto/subappalto (NON indovinare: es. Celano = massetto)"},
    {"step": "Compila TUTTI i campi prima di chiedere all''utente; chiedi SOLO ciò che manca dopo aver letto DVR+PSC+contratto"}
  ]'::jsonb,
  '>=20 pagine A4 verticale, Allegato XV D.Lgs 81/2008, copertina + indice + analisi rischi P x D x R per ogni fase di lavorazione',
  'cantiere/04_Sicurezza/POS (PDF). ATTENZIONE: il POS dell''appaltatore/committente che ci danno va in 04_Sicurezza/PSC, MAI nella cartella POS.',
  '[
    "I nomi di RSPP/medico competente/RLS NON si inventano e NON si chiedono all''utente: sono nel DVR Restruktura su Drive — leggilo.",
    "Restruktura per Celano fa il MASSETTO (subappalto), non le opere strutturali in c.a.",
    "Il POS deve essere di almeno 20 pagine."
  ]'::jsonb
)
on conflict (task_type) do nothing;
