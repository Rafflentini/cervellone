-- Modelli documento (binario A) — Fase 1
create table if not exists document_templates (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  titolo          text not null,
  parole_chiave   jsonb not null default '[]'::jsonb,
  tipo_sorgente   text not null,                 -- 'docx' | 'pdf_form' | 'pdf_flat' | 'html' | 'builtin'
  metodo          text not null,                 -- 'B_html' | 'builtin_cigo'
  master_drive_id text,
  html_template   text,
  campi           jsonb not null default '[]'::jsonb,
  dati_fissi      jsonb not null default '{}'::jsonb,
  formati_output  jsonb not null default '["pdf"]'::jsonb,
  dove_salvare    text,
  mai_inviare     boolean not null default true,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      text default 'cervellone:insegna_modello'
);

alter table document_templates add column if not exists dati_fissi jsonb not null default '{}'::jsonb;

create index if not exists idx_document_templates_keywords
  on document_templates using gin (parole_chiave);

alter table document_templates enable row level security;

-- Coerente con l'hardening RLS: solo service_role (nessun accesso ANON).
drop policy if exists "service_role_all_document_templates" on document_templates;
create policy "service_role_all_document_templates"
  on document_templates for all
  to service_role
  using (true) with check (true);

-- Seed: CIGO Allegato 10 come primo modello (metodo builtin_cigo).
-- dati_fissi e' vuoto: l'utente li imposta una-tantum via imposta_dati_fissi.
-- I campi fissi (azienda, LR) sono obbligatori ma senza default: devono venire da dati_fissi o dalla richiesta.
insert into document_templates (slug, titolo, parole_chiave, tipo_sorgente, metodo, formati_output, dove_salvare, mai_inviare, dati_fissi, campi)
values (
  'cigo_allegato10',
  'CIGO — Allegato 10 (relazione tecnica eventi meteo)',
  '["cigo","allegato 10","allegato10","eventi meteo","cig","integrazione salariale","maltempo"]'::jsonb,
  'builtin',
  'builtin_cigo',
  '["pdf"]'::jsonb,
  null,
  true,
  '{}'::jsonb,
  '[
    {"nome":"azienda_denominazione","label":"Azienda — denominazione","tipo":"testo","obbligatorio":true},
    {"nome":"azienda_cf","label":"Azienda — codice fiscale","tipo":"testo","obbligatorio":true},
    {"nome":"azienda_matricola_inps","label":"Azienda — matricola INPS","tipo":"testo","obbligatorio":true},
    {"nome":"azienda_unita_produttiva","label":"Azienda — unita'' produttiva","tipo":"testo","obbligatorio":false},
    {"nome":"azienda_data_inizio_attivita","label":"Azienda — data inizio attivita'' (YYYY-MM-DD)","tipo":"data","obbligatorio":false},
    {"nome":"lr_nome_cognome","label":"Legale rappresentante — nome e cognome","tipo":"testo","obbligatorio":true},
    {"nome":"lr_qualifica","label":"Legale rappresentante — qualifica","tipo":"scelta","obbligatorio":false,"descrizione":"titolare oppure legale_rappresentante"},
    {"nome":"lr_luogo_nascita","label":"Legale rappresentante — luogo di nascita","tipo":"testo","obbligatorio":false},
    {"nome":"lr_data_nascita","label":"Legale rappresentante — data di nascita (YYYY-MM-DD)","tipo":"data","obbligatorio":false},
    {"nome":"lr_residenza","label":"Legale rappresentante — residenza","tipo":"testo","obbligatorio":false},
    {"nome":"lr_telefono","label":"Legale rappresentante — telefono","tipo":"testo","obbligatorio":false},
    {"nome":"cantiere_comune","label":"Cantiere — Comune","tipo":"testo","obbligatorio":true,"descrizione":"Comune del cantiere"},
    {"nome":"cantiere_indirizzo","label":"Cantiere — indirizzo","tipo":"testo","obbligatorio":true},
    {"nome":"cantiere_data_apertura","label":"Data apertura cantiere (YYYY-MM-DD)","tipo":"data","obbligatorio":false},
    {"nome":"periodo_dal","label":"Periodo — dal (YYYY-MM-DD)","tipo":"data","obbligatorio":true},
    {"nome":"periodo_al","label":"Periodo — al (YYYY-MM-DD)","tipo":"data","obbligatorio":true},
    {"nome":"giornate_stop","label":"Giornate di sospensione (date)","tipo":"testo","obbligatorio":true,"descrizione":"Elenco date di stop, es. 04/06, 09/06"},
    {"nome":"lavorazioni","label":"Lavorazioni in corso","tipo":"testo","obbligatorio":true},
    {"nome":"evento_meteo","label":"Motivazione meteorologica","tipo":"testo","obbligatorio":true},
    {"nome":"conseguenze","label":"Conseguenze sull''''attivita''''","tipo":"testo","obbligatorio":true},
    {"nome":"beneficiari","label":"Operai coinvolti","tipo":"tabella","obbligatorio":false,
      "descrizione":"Per ciascun operaio: cognome, nome, codice fiscale, qualifica e ore TOTALI di sospensione nel periodo (non per settimana).",
      "colonne":[{"nome":"cognome","tipo":"testo"},{"nome":"nome","tipo":"testo"},{"nome":"codice_fiscale","tipo":"testo"},{"nome":"qualifica","tipo":"testo"},{"nome":"ore","tipo":"numero"}]
    },
    {"nome":"pagamento_diretto","label":"Pagamento diretto (SR41)","tipo":"scelta","obbligatorio":false,"default":false}
  ]'::jsonb
)
on conflict (slug) do nothing;
