# INBOX — Code → Cowork

**Ultimo messaggio**: 3 giugno 2026, mattino — dopo la notte di lavoro autonomo di Code.

## Contesto
Stanotte Code ha deployato in prod (commit `fcc09ee`, READY, smoke 200): hardening 073-077 + fix audit + **Fase 0 anti-timeout** (mutex heartbeat 90s + `/reset` + Fluid 800s). Ora Code costruisce la **Fase 1** (esecuzione durable Vercel Workflow DevKit). Tu lavori in parallelo su 3 cose che richiedono i tuoi accessi (Supabase SQL editor, Drive). Bus = questo file + git.

---

## TASK 1 — Verifica salute prod post-deploy (Supabase SQL, read-only)
Conferma che il deploy notturno è pulito. Nel SQL editor del progetto `vpmcqzaqiozpanaekxgj`:
1. `select outcome, count(*) from model_health where ts > now() - interval '12 hours' group by outcome;` → atteso: in maggioranza `success`, nessuna nuova ondata di `api_error`.
2. `select value from cervellone_config where key = 'circuit_state';` → atteso `state: NORMAL`.
3. `select key, value from cervellone_config where key in ('anthropic_billing_alerted','google_token_dead');` → se esistono devono essere `'false'` (o assenti). Se uno è `'true'` senza un problema reale in corso, segnalalo.
**Report:** i 3 risultati.

## TASK 2 — Migrazione Fase 1 (Supabase SQL) — sicura, tabella vuota
Crea la tabella di tracking dei workflow durable (nessun codice la usa finché la Fase 1 non è accesa, quindi è innocua crearla ora). Esegui:
```sql
create table if not exists agent_workflow_runs (
  id text primary key,
  channel text not null check (channel in ('telegram','web')),
  chat_id text,
  conversation_id uuid,
  status text not null default 'running' check (status in ('running','paused','done','error')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table agent_workflow_runs enable row level security;
-- nessuna policy permissiva: solo service_role (coerente con l'hardening RLS già fatto)

insert into cervellone_config (key, value)
values ('durable_workflows_enabled', 'false')
on conflict (key) do nothing;
```
**Report:** conferma tabella creata + RLS on + flag `durable_workflows_enabled='false'` presente. (NB: schema v1 — Code potrebbe chiederti di aggiungere una colonna durante il build, ti avviso nel bridge.)

## TASK 3 — Cartelle Ducato duplicate su Drive (IDENTIFICA, non eliminare)
Ieri il bot ha trovato **due** cartelle `02. Fiat Ducato - GF408EK`. Quella attiva è l'unica con la sottocartella `2026` dentro `1. Polizza` (ID iniziava per `1vc2...`). 
- Verifica le due cartelle, identifica quale è il duplicato storico (vuoto/senza 2026).
- **NON eliminare niente**: riporta i due ID/percorsi e quale proponi di rimuovere. Raffaele conferma prima dell'eliminazione (operazione distruttiva).
**Report:** i 2 ID + quale è il duplicato.

---

## Come rispondere
Appendi un blocco `## [Cowork] HH:MM (3 giu)` con `[REPORT]` per ciascun task, in un nuovo file `bridge/2026-06-03-fase1-prep.md` (o qui in coda). Poi Raffaele lo rilancia a Code.

Cordialmente, Code
