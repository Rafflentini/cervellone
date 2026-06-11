# Cervellone — "Modelli documento" (binario A) — Design

**Data:** 2026-06-11
**Autore:** Claude Code (orchestratore) + Raffaele
**Stato:** approvato in brainstorming, in attesa di review utente → poi writing-plans
**Spec correlate:** `2026-06-10-cervellone-auto-debrief-design.md` (apprendimento implicito, binari b/c), `2026-05-09-cervellone-v19-rifondazione.md` (CIGO)

---

## 0. Contesto e problema

**Sintomo (11 giu 2026):** chiesto di riprodurre l'Allegato 10 CIGO (modello ufficiale INPS, impaginazione vincolata) ogni mese con dati variabili, il bot Telegram ha: (a) prodotto solo testo/tabelle markdown senza la formattazione del modello; (b) dichiarato "✅ salvato in memoria permanente / generato su Drive" **senza aver chiamato alcun tool** (allucinazione); (c) perso ripetutamente il template; (d) rischiato di inviare il documento nonostante l'istruzione "non inviare mai".

**Causa radice (verificata nel codice):**
1. Esiste già un generatore CIGO formattato e testato (`genera_allegato10_cigo`, `src/v19/tools/cigo/index.ts`) **mai cablato nel runtime** del bot (assente da `ALL_TOOLS`/`EXECUTORS`). Il bot non aveva alcuno strumento per produrre il documento → ha improvvisato.
2. La "memoria permanente" che il bot citava (`ricorda` → `cervellone_memoria_esplicita`) è recuperata per **substring ILIKE**: fragile, e spesso i salvataggi erano allucinati (il modello Sonnet, in uso per contenimento costi, tende a dichiarare azioni senza eseguirle).
3. Il substrato per "skill come dato" (`procedures`, `project_state`, tool `crea_procedura`) **esiste ma è inerte**: il modello quasi mai lo invoca di sua iniziativa (in prod `project_state` = 0 righe). L'approccio "glielo chiediamo gentilmente nel prompt" è fallito.

**Tesi dell'utente (vincolante):** Cervellone è "troppo debole" finché ogni nuova capacità passa da una modifica di codice fatta da Claude Code. Le skill/automazioni/modelli **deve poterli creare lui**, come *dato*, imparando dall'utente in chat — non con un deploy ogni volta.

**Obiettivo di questo binario (A — documenti):** costruire **una volta** un motore generico per cui:
- l'utente **insegna** un modello di documento (Word o PDF) in chat,
- Cervellone lo conserva come **dato riutilizzabile** (scheda-modello),
- e **riproduce** il documento a impaginazione fedele ogni volta, output Word o PDF, **senza mai inviarlo** e **senza codice nuovo per ogni documento**.

CIGO diventa il **primo modello insegnato**, non più codice bespoke. Binari B (automazioni) e C (procedure) seguiranno in sequenza, riusando lo stesso impianto.

**Non-obiettivi (esplicitamente fuori scope qui):**
- Auto-debrief / apprendimento implicito generale (binari b/c → spec dedicata).
- Self-extension via auto-PR di codice (resta il self-heal esistente, fuori scope).
- Trasmissione automatica a INPS/SdI/mail (vietata; sempre output al solo utente).

---

## 1. Approccio scelto: ibrido C (Motore B prima, Motore A poi)

Due motori di fedeltà che condividono storage, schema-campi, richiamo e consegna:

- **Motore B — "sosia HTML" (Fase 1):** il modello è rappresentato come HTML/CSS fedele; ogni riproduzione riempie i campi e stampa in **PDF** col motore WYSIWYG esistente (`src/lib/pdf-generator.ts`, Puppeteer + `@sparticuz/chromium`). Universale (vale anche per PDF piatto/immagine), si adatta a contenuti di lunghezza variabile (tabelle che crescono). Può produrre anche `.docx` via `genera_docx` esistente quando serve un Word editabile "fedele ma non byte-identico".
- **Motore A — "file vero riempito" (Fase 2):** per master **Word**, riempimento di segnaposto nel file `.docx` reale (`docxtemplater` + `pizzip`) → Word identico al byte. Per **PDF con campi-modulo (AcroForm)**, riempimento campi (`pdf-lib`).

Il bot **sceglie il motore** dal `tipo_sorgente` del master. Fase 1 sblocca il CIGO con un documento vero e fedele; Fase 2 aggiunge la fedeltà byte-perfect su Word.

---

## 2. Modello dati

### 2.1 Tabella `document_templates`

```sql
create table if not exists document_templates (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,              -- es. 'cigo_allegato10'
  titolo          text not null,
  parole_chiave   jsonb not null default '[]',       -- ['cigo','allegato 10','eventi meteo']
  tipo_sorgente   text not null,                      -- 'docx' | 'pdf_form' | 'pdf_flat' | 'html'
  metodo          text not null,                      -- 'A_docx' | 'A_pdf_form' | 'B_html'
  master_drive_id text,                               -- file originale su Drive (A)
  master_storage  text,                               -- path/bucket Supabase Storage (opz.)
  html_template   text,                               -- template HTML con {{segnaposto}} (B)
  campi           jsonb not null default '[]',        -- vedi 2.2
  formati_output  jsonb not null default '["pdf"]',   -- ['pdf'] | ['docx'] | ['pdf','docx']
  dove_salvare    text,                               -- hint cartella Drive (slug o id)
  mai_inviare     boolean not null default true,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      text default 'cervellone:insegna_modello'
);
create index on document_templates using gin (parole_chiave);
```

RLS: abilitata, policy `service_role` (coerente con l'hardening RLS già applicato a tutto `public`). Nessun accesso ANON.

### 2.2 Schema `campi` (jsonb)

Ogni campo variabile:
```jsonc
{
  "nome": "periodo_dal",            // chiave macchina
  "label": "Periodo — data inizio", // etichetta umana
  "tipo": "data",                   // 'testo' | 'data' | 'numero' | 'tabella' | 'scelta'
  "obbligatorio": true,
  "default": null,                  // valore di default (es. dati azienda fissi)
  "descrizione": "Primo giorno del periodo richiesto",
  // solo per tipo 'tabella':
  "colonne": [ {"nome":"cognome","tipo":"testo"}, {"nome":"ore","tipo":"numero"} ]
}
```

I **dati fissi ricorrenti** (es. azienda RESTRUKTURA, i 3 operai abituali) si modellano come campi con `default` valorizzato → l'utente non li ridetta ogni volta, ma restano sovrascrivibili.

### 2.3 Richiamo (riuso del substrato esistente, reso non-opzionale)

Il richiamo "questo è il modello CIGO" riusa l'infrastruttura `procedures`/`inferTaskType`/`buildProcedureContext` (`src/lib/working-memory.ts`) **senza duplicarla**: alla creazione di un modello, si crea/aggiorna una procedura collegata (o si estende `buildWorkingContext` per iniettare anche i `document_templates` per match di `parole_chiave`). Decisione implementativa nel piano; requisito qui: **l'iniezione deve avvenire deterministicamente** sul match di nome/parole-chiave, non dipendere dall'iniziativa del modello.

---

## 3. Strumenti del bot (generici, data-driven)

Tre tool generici sostituiscono il "un tool per documento". Si aggiungono a `ALL_TOOLS` + `EXECUTORS` in `src/lib/tools.ts` (pattern identico a `MAIL_TOOL_DEFINITIONS`), con regole in `src/lib/prompts.ts`.

### 3.1 `insegna_modello`
Crea/aggiorna una scheda-modello.
- **Input:** `slug`, `titolo`, `parole_chiave[]`, `tipo_sorgente`, `metodo`, `master_drive_id?`, `html_template?`, `campi[]`, `formati_output[]`, `dove_salvare?`, `mai_inviare?` (default true).
- **Comportamento:** valida, normalizza lo slug, inserisce/aggiorna `document_templates`, (ri)crea la procedura di richiamo, invalida cache. Ritorna conferma con lo **slug reale** e l'elenco campi salvati.
- **Quando lo chiama il bot:** quando l'utente dice "questo è un modello / ricordatelo / da ora riproducimelo". Regola di prompt: identificare i campi variabili e **proporli all'utente per conferma** prima di salvare.

### 3.2 `compila_modello` (cavallo da lavoro)
- **Input:** `slug`, `valori` (oggetto chiave→valore secondo `campi`), `formato?` ('pdf'|'docx', default dal modello), `dove_salvare?`.
- **Comportamento:**
  1. Carica la scheda-modello; se assente → errore esplicito (no invenzione).
  2. **Valida i campi obbligatori**: se mancano valori → ritorna l'elenco dei campi mancanti (il bot li chiede, non li inventa).
  3. Applica i `default` per i campi non forniti.
  4. Richiama il motore (A o B) → produce il `Buffer`.
  5. Verifica `assertWriteAllowed(dove_salvare)` (policy Drive esistente) → carica su Drive via `uploadBinaryToDrive` → ottiene `webViewLink` reale.
  6. Ritorna **il link reale** + nome file + eventuali warning. **Non invia mai.**
- **Garanzia anti-allucinazione:** il messaggio all'utente deve contenere il link ritornato dal tool; il bot non può dichiarare "generato/salvato" senza questo risultato.

### 3.3 `lista_modelli` / `ritrova_modello`
Elenca i modelli insegnati / restituisce una scheda-modello (campi richiesti compresi), per trasparenza e per permettere al bot di chiedere i dati giusti.

---

## 4. Motori di fedeltà

### 4.1 Motore B — HTML → PDF (Fase 1)
- `html_template` con segnaposto `{{campo}}` e blocchi ripetuti per le tabelle (es. righe operai).
- Riempimento: sostituzione sicura (escape HTML dei valori) + espansione delle righe-tabella.
- Rendering: `generatePdfFromHtml(html, titolo)` esistente (`src/lib/pdf-generator.ts`). Output PDF A4 WYSIWYG.
- Per output `.docx` "fedele ma editabile": riuso `genera_docx` (libreria `docx`) dal medesimo modello semantico/HTML.
- **Funzione pura testabile:** `riempiHtml(template, valori) → htmlString` (TDD).

### 4.2 Motore A — file vero (Fase 2)
- **Word (`A_docx`):** `docxtemplater` + `pizzip`. Master = `.docx` con segnaposto `{campo}`. Conversione "esempio compilato → template": funzione che apre il `.docx`, sostituisce i valori-esempio noti con i segnaposto e ri-zippa (così l'utente può fornire un esempio già compilato e Cervellone lo "templatizza" da solo).
- **PDF-modulo (`A_pdf_form`):** `pdf-lib`, riempimento dei campi AcroForm del PDF ufficiale (caso ideale per moduli INPS con campi). Rilevamento campi via `pdf-lib`.
- **Funzioni pure testabili:** `riempiDocx(masterBuffer, valori) → Buffer`, `riempiPdfForm(masterBuffer, valori) → Buffer`.

### 4.3 Nuove dipendenze
`docxtemplater`, `pizzip`, `pdf-lib` (solo Fase 2). Modifica `package.json` → richiede OK esplicito (vincolo AGENTS.md). Fase 1 non aggiunge dipendenze (riusa Puppeteer + `docx` già presenti).

---

## 5. CIGO come primo modello

Il CIGO è il banco di prova e il primo `document_templates`:
- **Documento principale (Allegato 10):** via Motore B (HTML fedele al fac-simile INPS) **oppure** riuso del builder semantico esistente `renderAllegato10` (`src/v19/tools/cigo/build-allegato10.ts`), già fedele al fac-simile e testato. Decisione nel piano (preferenza: partire dal builder esistente come Motore-B specializzato, già verde a test, poi valutare HTML).
- **Extra di dominio (restano tool dedicati, codice legittimo):**
  - **Bollettino meteo CFD Basilicata** (`src/v19/tools/meteo-basilicata`) — vincolante: solo Centro Funzionale Decentrato Regione Basilicata.
  - **CSV beneficiari** tracciato Msg INPS 3566/2018 (`build-beneficiari-csv.ts`).
  - **SR41** (opzionale, pagamento diretto) — oggi placeholder; Fase 2 con `pdf-lib`.
- Il bot **compone** modello + extra in uno ZIP (`zip.ts` esistente) e lo carica su Drive (oggi `genera_allegato10_cigo` ha un TODO sull'upload: lo completiamo nell'executor via `uploadBinaryToDrive`).
- I **dati fissi** (azienda RESTRUKTURA: CF, matricola INPS, U.P.; i 3 operai abituali Pacilli/Pirrone/Guru con CF/qualifica/livello) entrano come `default` dei campi → l'utente passa solo cantiere, periodo, giornate di stop, lavorazioni, ore (e operai solo se diversi dai soliti).

---

## 6. Anti-allucinazione e sicurezza

- **Richiamo deterministico:** scheda-modello iniettata nel system prompt sul match di nome/parole-chiave (non opzionale). Risolve l'"acceso ma inerte".
- **Niente "salvato" finto:** `compila_modello`/`insegna_modello` ritornano risultati reali (link Drive / slug). Regola di prompt dura + riuso `detectHallucination`/force-action (`src/lib/circuit-breaker.ts`, `claude.ts`): se l'utente chiede un documento insegnato e non c'è il `tool_use` corrispondente, il turno viene forzato a eseguirlo; vietato dichiarare esito senza risultato del tool.
- **Campi mancanti → si chiedono**, non si inventano (no dati fittizi in documenti ufficiali).
- **`mai_inviare` = true di default:** nessun invio mail/PEC/SdI. Eventuale invio solo su richiesta esplicita successiva, con la doppia conferma già in uso per le mail.
- **Policy Drive:** `assertWriteAllowed` sui salvataggi (recinzione scritture esistente). RLS service_role sulla nuova tabella.

---

## 7. Test e qualità

- **TDD** sui motori (funzioni pure): `riempiHtml`, `riempiDocx`, `riempiPdfForm`, validazione campi, applicazione default, enforcement `mai_inviare`.
- **Golden-file CIGO:** riuso del fixture esistente (`src/v19/__tests__/cigo-allegato10.spec.ts`, ground-truth Aprile 2026) per verificare struttura/sezioni del documento generato.
- **Test executor:** `compila_modello` con modello assente / campi mancanti / happy-path (link Drive mockato).
- **`npm run build` + typecheck** prima del deploy (lezione: il typecheck ha beccato build-breaker che 5 audit LLM avevano mancato).
- **Audit adversarial multi-agent PRIMA del deploy** (lezione 10 giu): race, atomicità, allucinazione residua, invio non richiesto, fedeltà formattazione.
- **Verifica sul campo reale** (smoke Telegram dell'utente) prima di dichiarare "fatto".

---

## 8. Wiring (punti di integrazione, da subagent audit)

1. `src/lib/document-templates.ts` (nuovo): CRUD su `document_templates` + funzioni motore B.
2. `src/lib/template-engines.ts` (nuovo, Fase 2): motori A (docx/pdf-form).
3. `src/lib/tools.ts`: import + `...DOCUMENT_TEMPLATE_TOOLS` in `ALL_TOOLS` (riga ~2389, prima di `MAIL_TOOL_DEFINITIONS`) + executor in `EXECUTORS` (stessa posizione relativa). Executor: validazione input, chiamata motore, `uploadBinaryToDrive`, ritorno link.
4. `src/lib/prompts.ts`: sezione "REGOLA MODELLI DOCUMENTO" (insegna/compila, chiedi campi mancanti, mostra link reale, mai inviare).
5. `src/lib/working-memory.ts`: estensione iniezione richiamo (o procedura collegata) per i modelli.
6. Migration SQL `document_templates` (+ RLS) — applicata da Cowork/MCP Supabase.
7. CIGO: completare upload Drive nell'executor; caricare la prima riga `document_templates` (slug `cigo_allegato10`) + extra.

---

## 9. Fasi di consegna

- **Fase 1 (sblocca CIGO):** tabella + 3 tool generici + Motore B (riuso builder Allegato 10 esistente) + wiring + regole prompt + CIGO come primo modello + extra (bollettino/CSV) + upload Drive. Nessuna nuova dipendenza. Audit + smoke reale.
- **Fase 2 (fedeltà byte-perfect Word/PDF-modulo):** `docxtemplater` + `pdf-lib` + "templatizza esempio" + SR41 reale. Richiede OK dipendenze.
- **Poi:** binario B (automazioni ricorrenti) e C (procedure operative), spec dedicate, riusando questo impianto + l'auto-debrief (spec 10 giu) per l'apprendimento implicito.

---

## 10. Domande aperte / decisioni da confermare

1. **Master CIGO:** partire dal builder semantico esistente (`renderAllegato10`, già fedele e testato) o ricostruire in HTML? *Proposta: builder esistente in Fase 1, HTML solo se la fedeltà non basta.*
2. **OK nuove dipendenze** (`docxtemplater`, `pizzip`, `pdf-lib`) in Fase 2? (Fase 1 non ne richiede.)
3. **Storage master:** Drive (coerente con tutto il resto) o Supabase Storage? *Proposta: Drive.*
4. **Output CIGO di default:** ZIP completo (relazione + CSV + bollettino) sempre, o solo la relazione quando l'utente chiede "solo il documento"? *Proposta: ZIP completo, con opzione "solo relazione".*
