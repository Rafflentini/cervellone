-- IL REGISTRO A STATI delle fatture di commissione dei portali (Booking, Airbnb).
--
-- Perche' esiste, e il difetto vero che chiude (15 settembre 2026).
--
-- Per quattro fatture Booking nessuno sapeva se un documento esistesse. Un id
-- (552625594) e' stato inseguito per un'ora con letture ripetute a Fatture in
-- Cloud — issued_documents, received_documents, elenco per anno — prima di
-- capire che NON ERA MAI STATO CREATO: la creazione era fallita con un 422 e
-- il tool aveva comunque restituito un id preso da un tentativo precedente.
-- Nel frattempo si e' sospettato che fosse finito sulla societa' sbagliata, e
-- si e' cercato anche li'.
--
-- Una riga per fattura del fornitore, con lo STATO dell'adempimento, e quella
-- confusione non nasce: c'e' un posto solo dove guardare, e dice a che punto
-- siamo.
--
-- 🚨 IL REGISTRO NON E' LA VERITA'. Fatture in Cloud lo e'. Questa tabella e'
-- un indice di lavoro, e per questo esiste `registro_portali_riconcilia`: una
-- riga che cita un documento cancellato a mano su FIC va scoperta, non
-- creduta.
--
-- ⚠️ DUE STATI DELLA SPECIFICA DELL'INGEGNERE NON CI SONO, ed e' una scelta:
-- `pdf_archiviato` (noi il PDF non lo archiviamo su Drive: sta ALLEGATO al
-- documento di spesa su FIC, ed e' la rilettura di quel documento a dire se
-- c'e') e `controlli_ok` (i controlli sono dentro i tool — verifica formale
-- dell'XML, anti-doppione, rilettura — e non c'e' nessun atto separato che li
-- «faccia»). Uno stato che non corrisponde a un fatto verificabile non lo sa
-- far avanzare nessuno: resterebbe li' per sempre, e un registro fermo su uno
-- stato inventato e' rumore che fa sembrare in ritardo quello che non lo e'.

create table if not exists public.cervellone_registro_portali (
  id uuid primary key default gen_random_uuid(),

  -- Il codice societa' come lo usa `societa.ts` ('restruktura' | 'larealestate').
  -- Non e' un enum del database di proposito: l'elenco delle societa' vive nel
  -- codice, e duplicarlo qui vorrebbe dire tenerne allineate due copie.
  societa text not null,

  portale text not null check (portale in ('booking', 'airbnb')),

  -- Struttura/appartamento e suo id sulla piattaforma. NULLABILI: stanno solo
  -- sul PDF della fattura, che i tool non leggono. Un valore inventato qui
  -- sarebbe peggio del buco — vedi `descrizioneSpesaCommissioni`.
  struttura text,
  struttura_id_portale text,

  -- Il numero della fattura DEL FORNITORE, come sta scritto sul documento.
  numero_fattura text not null,
  data_fattura date not null,

  -- La data in cui la fattura estera e' stata RICEVUTA: e' quella che decide
  -- la scadenza dell'invio, ed e' anche la data che va sull'integrazione.
  -- Nullabile perche' non si inventa: se non la si sa, `scadenza_invio` resta
  -- nulla e il registro lo DICE invece di mostrare una scadenza finta.
  data_ricezione date,

  periodo_dal date,
  periodo_al date,

  imponibile numeric(12, 2),
  iva numeric(12, 2),

  -- 'RC' = reverse charge (fornitore UE, si integra con la TD17);
  -- 'IVA-IT' = la fattura riporta gia' l'IVA italiana e NON si integra
  -- (il caso delle fatture anteriori all'iscrizione al VIES).
  regime text check (regime in ('RC', 'IVA-IT')),

  -- 🚨 GLI STATI, e il fatto che ognuno pretende.
  --   nuova            la fattura del portale e' nel registro, e basta;
  --   spesa_registrata il documento RICEVUTO esiste su FIC — provato dalla
  --                    RILETTURA, non dalla risposta della POST;
  --   td17_generata    l'integrazione TD17 esiste su FIC, riletta e passata
  --                    dalla verifica formale dell'XML;
  --   td17_inviata     l'integrazione e' stata trasmessa allo SdI;
  --   sdi_consegnata   lo SdI l'ha consegnata;
  --   chiusa           adempimento concluso;
  --   da_verificare    RAMO: qualcosa non torna, e il motivo sta in `note`.
  --                    Non e' un avanzamento: e' un cartello.
  stato text not null default 'nuova'
    check (stato in ('nuova', 'spesa_registrata', 'td17_generata', 'td17_inviata',
                     'sdi_consegnata', 'chiusa', 'da_verificare')),

  -- Gli id dei documenti VERI su Fatture in Cloud. Si scrivono solo quando la
  -- rilettura ha confermato che quel documento esiste: un id scritto sulla
  -- fiducia della POST e' esattamente l'id 552625594 di stamattina.
  spesa_fic_id text,
  td17_fic_id text,
  td17_numero text,

  stato_sdi text,

  -- Giorno 15 del mese successivo a `data_ricezione`. Calcolata dal codice
  -- (`scadenzaInvio` in registro-portali.ts) e non da un default del
  -- database, perche' una riga senza `data_ricezione` non deve avere nessuna
  -- scadenza — nemmeno una sbagliata.
  scadenza_invio date,

  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 🚨 L'ANTI-DOPPIONE, E STA NEL DATABASE.
--
-- Un controllo applicativo si puo' dimenticare: basta un secondo punto di
-- ingresso — un altro tool, un import, una riga scritta a mano — e il registro
-- ha due righe per la stessa fattura, cioe' due risposte diverse alla domanda
-- «a che punto siamo?». Il vincolo qui sotto non si dimentica.
--
-- ⚠️ La chiave e' sul numero NORMALIZZATO, non sul testo grezzo: «FT 123/2026»
-- e «ft123-2026» sono lo STESSO documento, e un vincolo che non lo vede e'
-- un vincolo che non serve a niente. E' la stessa normalizzazione che
-- `chiaveNumeroFattura` gia' applica all'anti-doppione su Fatture in Cloud —
-- una regola sola, in due posti che devono concordare.
--
-- La colonna e' GENERATA dal database: non si puo' scrivere a mano, quindi non
-- puo' divergere dal numero vero.
alter table public.cervellone_registro_portali
  add column if not exists numero_chiave text
  generated always as (upper(regexp_replace(numero_fattura, '[^A-Za-z0-9]', '', 'g'))) stored;

create unique index if not exists uniq_registro_portali_fattura
  on public.cervellone_registro_portali (societa, portale, numero_chiave);

-- «A che punto siamo?» e «quali sono in ritardo?» sono le due letture vere.
create index if not exists idx_registro_portali_stato
  on public.cervellone_registro_portali (societa, stato, scadenza_invio);
create index if not exists idx_registro_portali_data
  on public.cervellone_registro_portali (societa, data_fattura desc);

alter table public.cervellone_registro_portali enable row level security;

-- Come le altre cervellone_*: nessuna policy permissiva, accesso solo via
-- service_role (server-side). La chiave anonima non deve poter leggere quali
-- fatture di quale societa' sono in ritardo.
drop policy if exists "service_role_all_cervellone_registro_portali" on public.cervellone_registro_portali;
create policy "service_role_all_cervellone_registro_portali"
  on public.cervellone_registro_portali
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.cervellone_registro_portali is
  'Registro a stati delle fatture di commissione dei portali (Booking, Airbnb). Una riga per fattura del fornitore. NON e la verita: Fatture in Cloud lo e — vedi registro_portali_riconcilia.';

-- ✅ PROVATA CONTRO POSTGRES, non contro un finto database — 15 settembre 2026.
--
-- Chi ha scritto questa migrazione non poteva verificarla: i suoi test parlano
-- con un finto Supabase che IMITA il 23505, e la colonna generata la dava per
-- buona leggendo il testo di questo file. Erano due cose diverse.
--
-- Applicata al database vero, poi messa alla prova con lo stesso numero scritto
-- in due modi, in un'unica istruzione:
--
--     insert ... values ('larealestate', 'booking', '1660950537',   '2026-08-03')
--     insert ... values ('larealestate', 'booking', '1660-950.537', '2026-08-03')
--
-- Postgres:
--     ERROR 23505: duplicate key value violates unique constraint
--     "uniq_registro_portali_fattura"
--     DETAIL: Key (societa, portale, numero_chiave)
--             = (larealestate, booking, 1660950537) already exists.
--
-- Quindi: la colonna generata normalizza davvero (trattini e punti cadono), e
-- l'indice unico morde sulla chiave normalizzata, non sul testo grezzo.
--
-- ⚠️ E la tabella e' rimasta a ZERO righe: le due insert stavano in una sola
-- istruzione, quindi il fallimento le ha annullate entrambe. Nessun dato di
-- collaudo e' rimasto in produzione — che in questa casa e' gia' successo, e
-- si e' scoperto mesi dopo.
