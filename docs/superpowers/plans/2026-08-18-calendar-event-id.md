# Eventi Calendar fantasma: salvare l'id dell'evento e cancellare il vecchio

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development o
> superpowers:executing-plans. Gli step usano checkbox (`- [ ]`).

**Goal:** quando una scadenza viene SOSTITUITA, il vecchio evento su Google Calendar
deve sparire dall'agenda. Oggi resta, **coi suoi reminder**: una notifica futura per una
scadenza che non esiste più.

**Perché non è un caso limite:** la sostituzione è il flusso NOMINALE. Il bot riepiloga e
chiede conferma proprio perché la lettura delle date può sbagliare, quindi **ogni
correzione di data produce un fantasma**. Il commento della migration stima ~9 eventi
omonimi attivi per dipendente dopo tre anni di rinnovi (DURC ogni 120 giorni, visita
medica annuale).

**Architecture:** l'id dell'evento **arriva già oggi** e viene buttato via. Il lavoro è
in quattro punti di `src/lib/scadenze-tools.ts`: estrarlo, persisterlo, recuperarlo per
le righe sostituite (nello stesso round-trip che già esiste), cancellare.
`calendar-tools.ts` **non si tocca**.

**Tech Stack:** TypeScript, vitest. Nessuna dipendenza nuova.

**Prerequisito:** la migration `supabase/migrations/2026-08-17-scadenze-calendar-event-id.sql`
aggiunge la colonna `calendar_event_id text` ed è **idempotente**. Se NON è applicata, gli
update di questo lavoro falliscono — ma sono tutti **best-effort**, quindi la
registrazione della scadenza continua a funzionare e si degrada al comportamento
odierno. Non è determinabile dal repo se sia stata applicata (non esiste un ledger delle
migration): va verificato sul DB.

---

## Global Constraints

- **`src/lib/calendar-tools.ts` NON si modifica.** È il registry condiviso dei tool.
- Tutto ciò che riguarda Calendar resta **BEST-EFFORT**: un errore Calendar non deve MAI
  far fallire la registrazione della scadenza. È la dottrina già scritta a
  `scadenze-tools.ts:383-385` e va preservata.
- L'ordine **INSERT-prima, sostituzione-dopo** di `registraScadenzaCore` non si tocca:
  chiude un P0 di perdita dati.
- `calendar_event_id` **NON va aggiunto a `summarize()`** (`scadenze-tools.ts:218-232`):
  è un id tecnico, esporlo all'LLM è rumore che invita ad allucinarlo.
- Comandi: `npx vitest run <file>` per un file, `npx vitest run` per la suite,
  `npx tsc --noEmit`. **NON** usare `npm test` (è Playwright E2E).
- Un commit per task, messaggi in italiano.

## ⚠️ Le tre trappole misurate (non scoprirle in produzione)

1. **La fixture del mock NON contiene l'id.** In `scadenze-tools.test.ts:105` il default è
   `CALENDAR_OK = '✅ Evento creato'` — **senza** la riga `id=...`. Un test sulla
   persistenza dell'id scritto contro questa fixture proverebbe il nulla. Serve una
   risposta realistica, nel formato vero di `formatEvent`.
2. **La delete NON risponde `✅`.** `calendar-tools.ts:197` restituisce
   `` `🗑 Evento ${eventId} eliminato dal calendario.` ``. Il check `res.startsWith('✅')`
   usato oggi a `scadenze-tools.ts:575` darebbe la cancellazione per FALLITA anche quando
   è riuscita.
3. **L'id si estrae da TESTO LIBERO.** `executeCalendarTool` ritorna `string | null`; l'id
   è dentro la stringa come `id=<valore>`, prodotto da `formatEvent`
   (`calendar-tools.ts:101`). È un accoppiamento fragile: il Task 1 lo rende sicuro
   pinnando il formato con l'output REALE, non con una stringa inventata.

---

### Task 1: estrarre l'id dell'evento, invece di buttarlo

**Perché:** `createCalendarForScadenza` (`scadenze-tools.ts:547-582`) riceve la stringa
che CONTIENE l'id e alla riga `576` la sostituisce con la nota fissa
`'evento creato su Google Calendar'`. L'informazione c'è già: la stiamo scartando.

**Files:**
- Modify: `src/lib/scadenze-tools.ts` (`CalendarEsito` a `:508-511`, `createCalendarForScadenza` a `:547-582`)
- Test: `src/lib/scadenze-tools.test.ts` (describe `registra_scadenza — esito Calendar non ignorabile`, `:499`)

**Interfaces:** `CalendarEsito` guadagna `eventId: string | null`. Nessuna API pubblica
nuova (la funzione non è esportata).

- [ ] **Step 1: pinna il formato VERO, non uno inventato**

Il test deve usare l'output reale di `formatEvent`, non una stringa scritta a mano.
Nel file di test esiste già il precedente di un `importActual` di `./calendar-tools`
(`scadenze-tools.test.ts:634`, con timeout `20000` — quel timeout serve, vedi sotto).

Scrivi un test che verifichi che l'estrazione funziona su una risposta nel formato che
`formatEvent` produce davvero. **Ricava il formato dal codice** (`calendar-tools.ts:97-104`
e `:134`), non dalla tua memoria, e riporta nel commento del test da dove viene.

⚠️ Se aggiungi un `importActual` di `./calendar-tools`, dai al test un timeout esplicito
di `20000` come il precedente: l'import reale del modulo supera i 5s di default quando la
suite gira in parallelo (misurato: 4533 ms in isolamento su un caso analogo).

- [ ] **Step 2: eseguilo e verifica che FALLISCA** — `eventId` non esiste ancora.

- [ ] **Step 3: implementa**

Aggiungi `eventId: string | null` a `CalendarEsito` ed estrai l'id nel ramo di successo
(`:575-576`). Vincoli sull'estrazione:
- deve restituire `null`, non la stringa `'undefined'`, se Google non ha dato un id
  (`formatEvent` emetterebbe `id=undefined`);
- deve restituire `null` in tutti i rami di fallimento (timeout, risposta non `✅`, throw);
- non deve rompersi se la stringa contiene più righe.

- [ ] **Step 4: esegui** — `npx vitest run src/lib/scadenze-tools.test.ts` verde.

- [ ] **Step 5: commit** — `feat(scadenze): l id dell evento Calendar non si butta piu`

---

### Task 2: persistere l'id sulla riga appena creata

**Perché:** senza scriverlo in tabella, al momento della sostituzione non sapremo quale
evento cancellare.

**Files:**
- Modify: `src/lib/scadenze-tools.ts` (`ScadenzaRow` `:11-24`, `ScadenzaWrite` `:26-38`, `registraScadenzaCore` `:326-404`)
- Test: `src/lib/scadenze-tools.test.ts`

- [ ] **Step 1: scrivi il test che fallisce**

Deve asserire che, dopo una registrazione con Calendar OK, viene emesso un UPDATE su
`cervellone_scadenze` che scrive `calendar_event_id` **sulla riga appena creata**.
Il mock Supabase registra già ogni operazione in `mockOps` e ci sono gli helper
`updateOps()` (`:148`) e `insertOps()` (`:159`); i filtri `eq`/`in` sono già supportati
(`:73-80`), quindi **non serve estendere il mock**.

Aggiungi anche il caso negativo: **Calendar fallito → NESSUN update** di
`calendar_event_id` (non deve scrivere `null` sopra un valore, né emettere un update
inutile).

- [ ] **Step 2: eseguilo e verifica che FALLISCA.**

- [ ] **Step 3: implementa**

Aggiungi `calendar_event_id: string | null` a `ScadenzaRow` e a `ScadenzaWrite`.
Persisti **dopo** la riga `394` (l'esito Calendar è noto solo lì) e **prima** del `return`
a `:396`, solo se `calendar.eventId` non è null.

Usa lo stile di `marcaSostituite` (`:496-499`): `.update({...}).eq('id', created.id)`
senza `.select()`, con `updated_at` esplicito. **Best-effort**: un errore su questo update
non deve cambiare l'esito della scadenza — al massimo arricchisce `calendarNota`.

⚠️ Se la migration non è applicata, è QUI che si vede: l'update fallisce e (per la regola
best-effort) la scadenza viene comunque registrata. Assicurati che il fallimento sia
**visibile** in `calendarNota`, non silenzioso.

- [ ] **Step 4: esegui** — file verde, poi `npx tsc --noEmit`.

- [ ] **Step 5: commit** — `feat(scadenze): salva l id evento Calendar sulla riga`

---

### Task 3: recuperare gli id dei vecchi eventi senza query in più

**Perché:** `marcaSostituite` (`:455-506`) carica già le righe da sostituire con una
SELECT (`:461-463`) e ne restituisce **solo gli id** (`:492`, `:505`). Aggiungendo la
colonna a quella SELECT, i vecchi event id arrivano **nello stesso round-trip**: senza
questa modifica servirebbe una seconda query.

**Files:**
- Modify: `src/lib/scadenze-tools.ts` (`SostituzioneResult` `:430-433`, `marcaSostituite` `:455-506`)
- Test: `src/lib/scadenze-tools.test.ts`

- [ ] **Step 1: scrivi il test che fallisce** — la SELECT di `marcaSostituite` deve
  includere `calendar_event_id`, e il risultato deve trasportare gli id degli eventi
  delle righe sostituite, non solo i loro id di riga.

- [ ] **Step 2: eseguilo e verifica che FALLISCA.**

- [ ] **Step 3: implementa** — aggiungi la colonna alla `.select()` di `:463`, allarga il
  `Pick<...>` di `:480`, ed estendi `SostituzioneResult` per trasportare le coppie
  `{ id, calendar_event_id }` **senza rimuovere `ids`** (è già consumato a `:381`).

  ⚠️ Il filtro di identità vero è in JS a `:485-492` (`normalizeKey`), mentre l'ILIKE
  server-side (`:469`, `:473`) è un **sovrainsieme**: gli event id da restituire sono
  quelli delle righe che superano il filtro JS, non quelli della query grezza.

- [ ] **Step 4: esegui.** — [ ] **Step 5: commit** — `feat(scadenze): marcaSostituite riporta anche gli id evento`

---

### Task 4: cancellare i vecchi eventi

**Perché:** è il punto del lavoro. Tutto il resto era preparazione.

**Files:**
- Modify: `src/lib/scadenze-tools.ts` (`registraScadenzaCore`, `RegistraScadenzaEsito` `:287-297`)
- Test: `src/lib/scadenze-tools.test.ts`

- [ ] **Step 1: scrivi i test che falliscono**

1. sostituzione con un vecchio evento → viene chiamato `calendar_delete_event` con
   l'`event_id` giusto (il mock registra nome e input in `calendarCalls`, `:107`);
2. riga sostituita **senza** `calendar_event_id` (registrata prima di questo lavoro) →
   **nessuna** chiamata di delete, e nessun errore;
3. delete fallita → la scadenza resta registrata e l'esito lo DICE;
4. più righe sostituite con più eventi → una delete per ciascuna.

⚠️ Il mock di `scadenze-tools.test.ts` passa `(name, input)` a `calendarImpl` (`:106`),
quindi puoi far rispondere diversamente create e delete. **Il mock dell'altro file**
(`doc-proposte-actions.test.ts:150-159`) invece chiama `calendarImpl()` **senza
argomenti**: se quei test toccano il percorso di sostituzione, quella firma va allargata.
Verificalo prima di dichiarare finito.

- [ ] **Step 2: eseguili e verifica che FALLISCANO.**

- [ ] **Step 3: implementa**

Dopo la creazione del nuovo evento, cancella i vecchi con `calendar_delete_event`
(input `{ event_id }`, `calendar-tools.ts:300-307`).

🔴 **Il check di successo NON è `startsWith('✅')`**: la delete risponde `🗑` 
(`calendar-tools.ts:197`). Riusare il check esistente farebbe risultare fallite tutte le
cancellazioni riuscite. Riconosci il fallimento per `❌`/`⚠️`, non il successo per `✅`.

Applica il `withTimeout` come per la creazione, e mantieni il best-effort.

**Decisione già presa — cancellare anche se la creazione del nuovo evento è fallita.**
La riga vecchia è già `sostituito` in DB, quindi il suo reminder è per una scadenza che
non esiste più: un promemoria SBAGLIATO è peggio di nessun promemoria, e il caso "evento
nuovo assente" è già segnalato all'utente da `calendarNota`. *Costo se la decisione è
sbagliata:* in caso di doppio fallimento l'utente resta senza alcun evento in agenda,
con la scadenza però registrata in DB e l'avviso in chiaro nell'esito.

- [ ] **Step 4: esegui la suite intera** — `npx vitest run` + `npx tsc --noEmit`.

- [ ] **Step 5: commit** — `fix(scadenze): il vecchio evento Calendar non resta piu in agenda`

---

### Task 5: aggiornare il commento che documenta il difetto

**Perché:** `scadenze-tools.ts:386-388` dichiara *"il vecchio evento NON viene rimosso
(nessuna colonna calendar_event_id → niente dedup). Follow-up se diventa fastidioso."*
Dopo il Task 4 è **falso**. Una sessione futura lo leggerebbe e ri-implementerebbe il
lavoro già fatto.

- [ ] **Step 1** — riscrivi il commento dicendo cosa fa il codice ORA, e annota il limite
  che resta: le righe registrate **prima** di questo lavoro non hanno
  `calendar_event_id`, quindi i loro eventi fantasma **restano in agenda** e vanno
  ripuliti a mano.
- [ ] **Step 2: commit** — `docs(scadenze): il commento diceva che il vecchio evento resta`

---

## Verifica finale (obbligatoria)

- [ ] `npx vitest run` — suite intera verde (baseline al 18 ago: **850 passati, 4 skipped**)
- [ ] `npx tsc --noEmit` — 0 errori
- [ ] `src/lib/calendar-tools.ts` NON modificato (`git diff --stat` non deve nominarlo)
- [ ] La registrazione di una scadenza continua a funzionare **con Calendar rotto**
      (è la dottrina best-effort: verificalo con un test, non a occhio)
- [ ] `calendar_event_id` NON compare in `summarize()`

## Fuori scope, ma da sapere

- **Bonifica dei duplicati storici.** Fino al 17/08 il match su `tipo_documento` era
  case-sensitive: `'DURC'` e `'Durc'` non si sostituivano, quindi ci sono righe attive
  duplicate che oggi mandano **promemoria doppi**. La query diagnostica è nel commento
  della migration (`:62-69`). Vanno bonificate a mano: tenere la più recente, portare le
  altre a `stato='sostituito'`.
- **L'indice unico resta vietato** finché la scrittura è su due round-trip PostgREST
  separati: romperebbe ogni RINNOVO. Per averlo serve una RPC Postgres che faccia
  INSERT + UPDATE in un'unica transazione. È un lavoro a sé.
