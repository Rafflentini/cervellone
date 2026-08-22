-- 2026-08-21 — prima nota e riconciliazione sanno di quale società sono
--
-- PERCHE'. Le due tabelle contabili non hanno alcun campo che dica a chi
-- appartiene un movimento. Con due società questo significa una contabilità
-- sola in cui i dati delle due aziende si mescolano: un bonifico de La Real
-- Estate riconciliato con una fattura di Restruktura, e un bilancio che non
-- torna per nessuna delle due.
--
-- SICUREZZA: additiva, e le tabelle sono VUOTE (0 righe entrambe, verificato il
-- 21 ago). Nessuna bonifica di dati storici da fare, nessun rischio di
-- attribuire male righe esistenti. Il default 'restruktura' serve solo a non
-- rompere eventuali scritture che non passano ancora la società.
--
-- Il CHECK rifiuta un codice non previsto invece di scriverlo: se un domani si
-- aggiunge una terza società, va esteso qui e in src/lib/societa.ts insieme.

alter table public.cervellone_movimenti
  add column if not exists societa text not null default 'restruktura'
  check (societa in ('restruktura', 'larealestate'));

alter table public.cervellone_riconciliazioni
  add column if not exists societa text not null default 'restruktura'
  check (societa in ('restruktura', 'larealestate'));

-- Il vincolo di unicità va reso PER SOCIETÀ, e non è un dettaglio.
--
-- Oggi esiste `cervellone_movimenti_hash_key UNIQUE (hash)`, globale (verificato
-- in produzione), e l'hash NON contiene la società: è calcolato su
-- data|importo|descrizione|fonte|conto. Con due aziende che hanno un movimento
-- identico — stesso giorno, stesso importo, stessa causale: succede — accadeva
-- questo: il controllo anti-duplicato per società non trovava nulla, l'INSERT
-- partiva, Postgres alzava 23505, e il codice interpretava quel rifiuto come
-- "già presente" restituendo `false`. Il movimento spariva SENZA UN ERRORE.
--
-- È la stessa malattia che questo progetto esiste per curare, ricreata un piano
-- più in basso. Le tabelle sono vuote, quindi la correzione non costa nulla.

alter table public.cervellone_movimenti
  drop constraint if exists cervellone_movimenti_hash_key;

alter table public.cervellone_movimenti
  add constraint cervellone_movimenti_societa_hash_key unique (societa, hash);

-- Le letture filtrano sempre per società, quasi sempre insieme al periodo o
-- alla data: l'indice segue quell'uso.
create index if not exists idx_movimenti_societa_data
  on public.cervellone_movimenti(societa, data);

create index if not exists idx_riconciliazioni_societa_periodo
  on public.cervellone_riconciliazioni(societa, periodo);
