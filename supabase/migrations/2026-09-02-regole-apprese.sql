-- Regole che Cervellone propone su se stesso, e che l'Ingegnere conferma.
--
-- Perche' esiste. Il 6 giugno 2026 due commit dello stesso giorno hanno prima
-- aperto e poi chiuso il canale di apprendimento: `3ad8e7a` iniettava
-- prompt_extra nel system prompt, `9a65f66` ha aggiunto il guardrail di
-- provenienza che scarta qualunque valore scritto dal bot. Da allora il bot non
-- ha piu' potuto fissare una sola regola su di se' — e il tool gli rispondeva
-- comunque "salvato in configurazione permanente".
--
-- Il guardrail e' giusto: Cervellone legge mail e documenti che arrivano da
-- fuori, e un contenuto malevolo non deve poter riscrivere il suo prompt. Ma la
-- difesa non deve costargli la capacita' di imparare. Qui la provenienza non e'
-- piu' una stringa da confrontare: e' STRUTTURALE. Una regola entra nel prompt
-- solo se ha stato 'attiva', e ci arriva solo passando da un comando digitato
-- dall'Ingegnere. Nessun testo letto da fuori puo' arrivarci da solo.
--
-- Append-only nei fatti: le regole non si sovrascrivono a vicenda (era il
-- difetto di prompt_extra e di modifica_skill, replace totale con un solo slot
-- di backup). Si aggiungono, e si disattivano cambiando stato — la riga resta.

create table if not exists public.cervellone_regole (
  id           uuid primary key default gen_random_uuid(),
  testo        text not null,
  motivo       text,
  stato        text not null default 'proposta'
                 check (stato in ('proposta', 'attiva', 'rifiutata', 'rimossa')),
  proposta_da  text,           -- contesto in cui e' nata (es. 'telegram:123')
  created_at   timestamptz not null default now(),
  decisa_at    timestamptz,    -- quando l'Ingegnere ha confermato o rifiutato
  updated_at   timestamptz not null default now()
);

-- L'iniezione legge solo le attive, in ordine di conferma.
create index if not exists idx_cervellone_regole_attive
  on public.cervellone_regole (decisa_at)
  where stato = 'attiva';

-- Le proposte in attesa scadono: una non confermata non deve restare
-- confermabile per sempre.
create index if not exists idx_cervellone_regole_proposte
  on public.cervellone_regole (created_at)
  where stato = 'proposta';

alter table public.cervellone_regole enable row level security;

-- Stesso profilo delle altre tabelle cervellone_*: solo il service role.
drop policy if exists "service_role_all_cervellone_regole" on public.cervellone_regole;
create policy "service_role_all_cervellone_regole"
  on public.cervellone_regole
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.cervellone_regole is
  'Regole permanenti che il bot propone su se stesso. Diventano attive solo dopo conferma esplicita dell''Ingegnere via /regola_ok_<id>. Vedi 2026-09-02-regole-apprese.sql.';
