-- Dove vanno le foto di questa conversazione: una tabella sua.
--
-- Perche' NON dentro project_state. Il primo tentativo teneva questo dato nella
-- riga del progetto attivo, ed e' stato bocciato due volte di fila per lo stesso
-- motivo: quella riga descrive il LAVORO IN CORSO (un POS, una perizia), e
-- appoggiarci sopra l'archiviazione foto crea accoppiamenti che non si vedono.
--
-- Quello che succedeva, in concreto:
--  - scrivendo la colonna `cantiere` si riassegnava il cantiere di un POS che
--    non c'entrava nulla con le foto (setActiveProject fa merge: project_name e
--    task_type restavano quelli vecchi, e la riga diventava contraddittoria);
--  - se la riga non esisteva veniva CREATA, con project_name nullo: un progetto
--    attivo fantasma iniettato nel system prompt, e — piu' caro — il gate
--    anti-costo dell'auto-debrief (`hasActiveProject`) diventava true per
--    sempre, facendo scattare una chiamata al modello a ogni "ok, perfetto";
--  - ogni archiviazione toccava `updated_at`, e siccome la soglia di staleness
--    a 7 giorni si basa su quella, archiviare foto teneva vivo nel prompt un
--    lavoro morto da settimane.
--
-- Una tabella separata li chiude tutti insieme, e non toglie niente: il progetto
-- attivo resta quello che era.

create table if not exists public.cervellone_foto_contesto (
  conversation_id text primary key,
  -- Il nome della cartella DAVVERO risolta su Drive, non l'input parziale del
  -- modello: questa stringa viene ri-usata per il matching alla foto dopo.
  cantiere        text not null,
  ambito          text not null check (ambito in ('cantiere', 'progetto')),
  -- Quando il cantiere e' stato indicato ESPLICITAMENTE dall'Ingegnere. La
  -- finestra entro cui si deduce in silenzio si ancora a questo, non
  -- all'ultima archiviazione: altrimenti una deduzione rinnova se stessa e un
  -- giro di tre cantieri finisce tutto nel primo, senza che scatti mai la
  -- richiesta di conferma.
  confermato_at   timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.cervellone_foto_contesto enable row level security;

drop policy if exists "service_role_all_cervellone_foto_contesto" on public.cervellone_foto_contesto;
create policy "service_role_all_cervellone_foto_contesto"
  on public.cervellone_foto_contesto
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.cervellone_foto_contesto is
  'Ultimo cantiere/progetto su cui sono state archiviate foto, per conversazione. Separata da project_state di proposito: vedi 2026-09-02-foto-contesto.sql.';
