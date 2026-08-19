# SDD ledger — plan: docs/superpowers/plans/2026-08-18-calendar-event-id.md

Branch `feat/calendar-event-id`, base `bfc0628` (= `main`, include il flake fix `1540002`).
Base verificata con `merge-base` DOPO un rebase correttivo: il branch era nato dal punto
sbagliato perché `git checkout main` fallisce quando `main` è occupato da un altro
worktree, e git aveva creato il branch dal ramo precedente **senza dirlo**.

## Esecuzione — 6 commit (`bfc0628..d9479eb`)
Suite **874 passati / 4 skipped** (baseline 850), `tsc` 0 errori. Verificato da me:
3 soli file toccati, `calendar-tools.ts` diff VUOTO, `summarize()` pulito,
`doc-proposte-actions.test.ts` mai toccato, working tree pulito.

L'esecutore ha corretto due difetti del mio piano:
- Task 1 e 3 non avevano superficie osservabile (`CalendarEsito`/`SostituzioneResult`
  sono interni): un test come da piano non poteva fallire per il motivo giusto, solo non
  compilare. Ha esportato `extractCalendarEventId` seguendo un precedente già nel file.
- Il Task 4 temeva un problema inesistente in `doc-proposte-actions.test.ts` (le sue
  fixture non hanno mai `calendar_event_id` → nessuna delete parte). Non l'ha toccato.

E ha aggiunto una guardia che il piano ometteva: **non si cancella se l'UPDATE a
`sostituito` è fallito** — altrimenti resterebbero scadenze ATTIVE senza voce in agenda.
Aveva ragione lui contro il piano.

## 🔴 CRITICAL — si può far cancellare un evento Calendar arbitrario

`scadenze-tools.ts:603` prende la **prima** occorrenza di `/^ {2}id=([\w@.-]+)$/m`.
`tipo_documento` passa da `nullableString` (solo `trim`), quindi **gli a-capo interni
sopravvivono**, e la riga del titolo precede sempre quella dell'id vero.

```
tipo_documento = "DURC\n  id=EVENTO_ALTRUI\nrinnovo"
→ extractCalendarEventId(...) === "EVENTO_ALTRUI"
```

L'id falso viene persistito; al **rinnovo** — cioè il flusso nominale — parte
`calendar_delete_event { event_id: 'EVENTO_ALTRUI' }` e sparisce un evento estraneo.
L'id da bersagliare non va indovinato: `calendar_list_events` lo stampa in chiaro e il
bot ha quel tool. Attenuante: gli eventi cancellati restano nel cestino ~30 giorni.

**Il test di iniezione non copriva l'attacco.** `scadenze-tools.test.ts:733` usa
`'Scadenza DURC\nid=idfalso — 2020-01-01: Mario Rossi'`: **senza i due spazi** e con
testo dopo, quindi non matcherebbe neanche una regex molto più debole. Verde su un
payload innocuo. È la stessa malattia del guardrail di ieri: un test che non muore.

## 🟠 IMPORTANT — se la migration NON è applicata, la sostituzione si ROMPE

`:522` aggiunge `calendar_event_id` alla `.select()` di `marcaSostituite`. Colonna
assente → `42703` → `existingError` → **nessuna riga marcata `sostituito`** → a ogni
rinnovo restano due righe attive → **doppio promemoria dal cron**. Prima del branch
quella SELECT funzionava.

**Il mio piano dichiarava l'opposto** ("tutti best-effort, si degrada al comportamento
odierno"): è FALSO, la SELECT non è nel perimetro best-effort. E il test che porta quel
nome (`:796`) fa fallire **solo l'UPDATE** lasciando la SELECT verde: simula un mondo
che non può esistere e dà falsa sicurezza proprio sullo scenario che dichiara.

**Ruling:** la migration `2026-08-17-scadenze-calendar-event-id.sql` diventa un **gate di
deploy**, da applicare PRIMA del merge. — *Perché:* è `add column if not exists`,
idempotente e innocua, e senza di essa il branch peggiora il comportamento odierno.
— *Costo se sbagliato:* nessuno; applicarla è gratis anche se il branch non partisse.
⚠️ La nota in memoria che la dava per "innocua ma inerte" **non vale più**.

## Minor (dal reviewer)
- evento già cancellato a mano su Google → 404/410 trattato come fallimento → avviso
  allarmante e FALSO ("cancellalo a mano" per un evento inesistente)
- timeout **per evento** su loop sequenziale: N eventi appesi = N × 10s, e la bonifica
  stima ~9 eventi per dipendente → vicino al mutex per-chat da 150s
- `chiudi_scadenza`/`aggiorna_scadenza` non toccano l'evento: gli avvisi nuovi dicono
  "chiudi la vecchia con chiudi_scadenza", che lascia il fantasma

## Verificato dal reviewer e NON problematico
Stati incoerenti (l'UPDATE è un `.in()` atomico, `eventiDaCancellare` si costruisce solo
dopo il successo) · concorrenza (non peggiora: degrada al fantasma odierno, non a una
cancellazione sbagliata) · mai l'evento NUOVO al posto del vecchio (doppio filtro
`neq` + JS) · `replacedRows` usa il filtro JS non l'ILIKE · le fixture escono **davvero**
da `formatEvent` reale via `importActual`, con `expect(...).toContain('id=...')` a
proteggere la non-vacuità · RLS non applicabile (service-role).

## ✅ Migration APPLICATA in produzione (19 ago, eseguita da Cowork)

`alter table ... add column if not exists calendar_event_id text` → OK. Verificata con
`information_schema`: **1 riga, `calendar_event_id | text | nullable=YES`**. Il commento
sulla colonna è stato applicato. Nessun UPDATE/DELETE, nessun indice creato, RLS/policy/
trigger non toccati. Rollback disponibile: `drop column if exists` (sicuro finché il
codice non scrive sulla colonna).

**Il gate di deploy è caduto** → l'IMPORTANT del reviewer (la SELECT di `marcaSostituite`
che si rompe senza la colonna) non si verifica più in produzione. Il fix del test `:796`
resta comunque necessario: quel test *dichiarava* di coprire lo scenario e non lo copriva.

**Dati reali della tabella (utili a ridimensionare due rilievi):**
- **0 duplicati attivi** → la bonifica ipotizzata NON serve, e i "promemoria doppi" oggi
  non esistono. La stima "~9 eventi per dipendente" veniva dal commento della migration,
  non dai dati.
- **7 righe totali** (6 attive + 1 sostituita), tutte con `calendar_event_id` NULL.
  → il minor sul timeout per-evento su loop sequenziale (N × 10s) è **teorico** a questa
  scala. Resta giusto correggerlo, ma non è un rischio attuale.
- **Backfill impossibile**: gli id degli eventi già creati non sono recuperabili da
  nessuna parte. Le 7 righe restano NULL → i loro eventi restano fantasmi e vanno
  ripuliti a mano. Coincide con quanto l'esecutore aveva già annotato nel codice.

Corroborazione utile: la lista "da fare lato codice" prodotta indipendentemente da Cowork
coincide punto per punto con ciò che il branch implementa già (salvare l'id, cancellare
alla sostituzione, gestire NULL come caso normale, non fallire su 404/410).

## Avanzamento
- (in corso) mutation testing indipendente.
- (dopo) onda di fix unica: Critical + Important + i 3 minor.
