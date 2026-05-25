# Toolkit segretaria: scadenzario + archiviazione documentale (generico) — design

**Data:** 2026-05-25
**Stato:** approvato ("procedi"), Fase 1 (senza Google Calendar)

## Principio
NON costruire un modulo rigido "automezzi". Dare a Cervellone **strumenti generici** che Claude
compone con la sua intelligenza per svolgere compiti da segretaria: ricevere un documento → leggerlo
→ archiviarlo nel posto giusto → tracciare una scadenza → avvisare prima della scadenza. Stessi tool
per mezzi, contratti, DURC, certificazioni, polizze cantiere, scadenze personale, ecc. (rif. principio
`cervellone-principio-design`: non hardcodare template, lasciare Claude libero).

## Scenario guida (un USO, non una feature dedicata)
Carico la foto/PDF di una polizza/revisione/bollo di un mezzo → Claude legge (vision), capisce
soggetto/categoria/tipo/scadenza → archivia il doc nella cartella Drive del soggetto → registra la
scadenza → un cron manda la mail ai 2 indirizzi Restruktura 5 giorni prima.

## Architettura

### Dati (Supabase) — UNA tabella generica
`cervellone_scadenze`:
- `id` uuid pk
- `soggetto` text (libero, es. "Fiat Ducato AB123CD")
- `categoria` text (libero/tag, es. "automezzo")
- `tipo_documento` text (libero, es. "polizza")
- `data_scadenza` date NOT NULL
- `reminder_days` int DEFAULT 5
- `recipients` text[] DEFAULT ['info@restruktura.it','raffaele.lentini@restruktura.it']
- `drive_file_id` text NULL, `drive_url` text NULL
- `note` text NULL
- `reminders_sent` jsonb DEFAULT '[]'  (storico reminder già inviati, per idempotenza)
- `stato` text DEFAULT 'attivo'  (attivo|sostituito|archiviato)
- `created_at`/`updated_at` timestamptz
- RLS ON, policy deny_all_anon_auth (coerente con le 25 tabelle già hardenate). Accesso solo service_role server-side.
- Nessuna anagrafica entità hardcoded: il raggruppamento è via `soggetto` (Claude lo normalizza).

### Tool nuovi (esposti al LLM, pattern wrapper come Drive/Mail/GitHub in `src/lib/tools.ts`)
1. `archivia_documento(folder_path, filename?)` — archivia il documento appena caricato dall'utente
   in una cartella Drive al `folder_path` scelto da Claude (crea le sottocartelle mancanti).
   Riusa `createFolder`/`uploadBinaryToDrive` (src/lib/drive.ts); risolve il path segmento per segmento
   sotto una radice configurabile. Ritorna `{ drive_file_id, drive_url }`.
2. `registra_scadenza(soggetto, categoria, tipo_documento, data_scadenza, reminder_days?, recipients?, drive_file_id?, note?)`
   — insert in `cervellone_scadenze`. Se esiste già una scadenza attiva stesso soggetto+tipo, marca la
   vecchia `stato='sostituito'` (storico) e crea la nuova.
3. `lista_scadenze(filtro?)` — query (per soggetto/categoria/finestra temporale/stato).
4. `aggiorna_scadenza(id, campi)` / `chiudi_scadenza(id)` — manutenzione.

### Motore reminder (generico)
- Nuovo cron `GET /api/cron/scadenze` (giornaliero ~07:00 Rome; aggiungere a `vercel.json`, protetto da CRON_SECRET come gli altri).
- Logica: seleziona scadenze `stato='attivo'` con `data_scadenza` tra oggi e oggi+`reminder_days`,
  per cui il reminder di quella finestra non è in `reminders_sent` → invia email ai `recipients`
  (via tool/funzione send-email V19) con soggetto/tipo/data + link Drive → append a `reminders_sent`.
  Idempotente (re-run nello stesso giorno non duplica).

### Flusso Telegram (comportamento via prompt, non hardcoded)
Il file-pipeline già passa foto/PDF a Claude vision (src/lib/file-pipeline.ts). Nel system prompt si
istruisce Claude: quando l'utente carica un documento con una scadenza, leggi soggetto/tipo/data,
**riepiloga e chiedi conferma** (la vision può sbagliare date/targhe), poi su conferma chiama
`archivia_documento` + `registra_scadenza`. La conferma è comportamento del modello, non una macchina a stati rigida.

## Agganci nel codice (verificati)
- Input immagini/PDF: `src/app/api/telegram/route.ts` (photo ~138-146, document ~94-135), `src/lib/telegram-helpers.ts` downloadTelegramFile, `src/lib/file-pipeline.ts` (image/document block).
- Drive: `src/lib/drive.ts` — `uploadBinaryToDrive` (~504), `createFolder` (~254), `searchFiles` (~91), `DRIVE_FOLDERS` (~44).
- Registry tool: `src/lib/tools.ts` (ALL_TOOLS + executors, pattern wrapper).
- Email: `src/v19/tools/email/send-email.ts` (account info/raffaele).
- Cron: `vercel.json` + `src/app/api/cron/*` (pattern CRON_SECRET).
- DB: `supabase/migrations/` (+ pattern RLS già usato per le 25 tabelle).

## Sicurezza / guardrail
- Migration Supabase (tabella + RLS) e relativo deploy: **applicate da Claude (orchestratore), non da Codex** (area sensibile). Codex scrive il codice tool/cron/flusso/test su branch; Claude rivede, applica migration, mergia, deploya, smoke.
- `recipients` default i 2 indirizzi interni → invio auto (no pending) verso @restruktura.it.

## Error handling
- Vision incerta → passo di conferma para gli errori. Targa/soggetto non leggibile → Claude lo chiede. Data ambigua → conferma esplicita.
- `archivia_documento`: se l'upload Drive fallisce, registra comunque la scadenza (senza file) e segnala, così non si perde il reminder.

## Testing (TDD)
- Unit tool: risoluzione/creazione path Drive (mock), upsert scadenza + logica "sostituito", query lista.
- Cron: selezione finestra `reminder_days`, idempotenza (reminders_sent), invio ai recipients.

## Fuori scope Fase 1
- Google Calendar (Fase 2).
- Anagrafica strutturata entità / UI dedicata (Claude usa `soggetto` libero).
