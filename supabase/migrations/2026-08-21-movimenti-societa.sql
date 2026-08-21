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

-- Le letture filtrano sempre per società, quasi sempre insieme al periodo o
-- alla data: l'indice segue quell'uso.
create index if not exists idx_movimenti_societa_data
  on public.cervellone_movimenti(societa, data);

create index if not exists idx_riconciliazioni_societa_periodo
  on public.cervellone_riconciliazioni(societa, periodo);
