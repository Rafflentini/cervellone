-- I messaggi arrivati mentre il bot stava gia' lavorando.
--
-- Prima venivano SCARTATI. Il codice rispondeva "⏳ Sto ancora elaborando il
-- messaggio precedente, attenda un momento" — che suona come un rinvio, e
-- invece era un addio: nessuna coda, nessun retry, e il testo non finiva
-- nemmeno in `messages` (la scrittura avviene a valle dell'acquisizione del
-- mutex). Con l'aggravante che il dedup su (chat_id, message_id) veniva scritto
-- PRIMA del controllo del lock: anche una riconsegna di Telegram sarebbe stata
-- ignorata come "gia' processato".
--
-- Quanto durava la finestra: il lock scade 150s dopo l'ultimo battito, ma
-- l'heartbeat lo rinfresca ogni 20s finche' il processo respira — quindi un job
-- vivo ma piantato tiene la chat bloccata fino al tetto della function (~13
-- minuti), e sul ramo durable fino a 30. Ogni messaggio in quella finestra
-- spariva.
--
-- Le foto si salvavano comunque (l'ingest sta prima del mutex): a sparire era
-- il testo, cioe' proprio la didascalia che dice cosa farne.

create table if not exists public.telegram_coda (
  id           bigserial primary key,
  chat_id      bigint not null,
  testo        text not null,
  created_at   timestamptz not null default now(),
  -- Quando e' stato consegnato al bot. Le righe restano: si deve poter
  -- rispondere a "quel messaggio che ti avevo mandato che fine ha fatto?".
  consumato_at timestamptz
);

create index if not exists idx_telegram_coda_da_leggere
  on public.telegram_coda (chat_id, created_at)
  where consumato_at is null;

alter table public.telegram_coda enable row level security;

drop policy if exists "service_role_all_telegram_coda" on public.telegram_coda;
create policy "service_role_all_telegram_coda"
  on public.telegram_coda
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.telegram_coda is
  'Messaggi arrivati mentre il bot stava gia elaborando. Prima venivano SCARTATI: nessuna coda, e il dedup era gia scritto, quindi Telegram non poteva riconsegnarli.';
