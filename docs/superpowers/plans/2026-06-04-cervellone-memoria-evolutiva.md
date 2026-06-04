# Cervellone — Memoria evolutiva Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Risolvere i 3 bug strutturali emersi il 4 giu: (1) perdita di memoria del progetto attivo, (2) il bot non ritrova/salva le bozze che genera, (3) non impara le procedure. Bug #3 (memoria procedurale) è già fatto in Fase 1 (`working-memory.ts`, flag-gated). Questo piano aggiunge bug #1 (memoria progetto attivo) e bug #2 (indicizzazione/recupero/salvataggio bozze), integrandoli nello stesso flag `working_memory_enabled`.

**Architecture:** Tutto FLAG-GATED su `working_memory_enabled` (OFF→comportamento invariato). Memoria progetto in tabella `project_state` (1 riga attiva per conversazione). Le bozze sono già salvate in `documents` (per `conversation_id`); aggiungiamo tool di lista/recupero + un tool di esportazione PDF→Drive affidabile (riusa `generatePdfFromHtml` + `uploadBinaryToDrive`). Il contesto (progetto attivo + procedura) è iniettato nel system prompt come blocco NON cachato (estende `buildProcedureContext` → `buildWorkingContext`).

**Tech Stack:** Next.js/TS, Supabase (service_role), libreria `docx`/Puppeteer (PDF), Anthropic SDK. Test: vitest.

---

## File Structure
- `supabase/migrations/2026-06-04-working-memory-procedures.sql` — MODIFICA: project_state keyed su `conversation_id` (uniforme tra canali, disponibile nei tool).
- `src/lib/working-memory.ts` — ESTENDI: funzioni project_state + `buildWorkingContext(userQuery, conversationId)` che unisce progetto attivo + procedura.
- `src/lib/working-memory.test.ts` — CREA: test logica (inferTaskType, buildWorkingContext, project merge).
- `src/lib/draft-tools.ts` — CREA: `listRecentDrafts`, `getDraft`, `saveDraftPdfToDrive` (PDF→Drive).
- `src/lib/tools.ts` — MODIFICA: registra tool progetto (imposta/aggiorna/chiudi_progetto) + bozze (lista_bozze, ritrova_bozza, salva_bozza_pdf).
- `src/lib/agent-job.ts` + `src/app/api/chat/route.ts` — MODIFICA: passa `conversationId` a `buildWorkingContext` (Fase 1 passava solo userQuery).
- `src/lib/prompts.ts` — MODIFICA: regole "memoria progetto" + "ritrova/non rigenerare" + "salva la bozza con salva_bozza_pdf".

---

## Task 0: Verifica chiave conversazione + migration project_state

**Files:**
- Read: `src/app/api/telegram/route.ts` (come nasce conversationId per telegram — deve essere STABILE per chat tra sessioni)
- Modify: `supabase/migrations/2026-06-04-working-memory-procedures.sql`

- [ ] **Step 1:** Verifica in telegram/route.ts che `conversationId` sia stabile per `chatId` tra sessioni (es. `getOrCreateConversation(chatId)`). Se NON è stabile (nuovo per sessione), la memoria progetto non persisterebbe tra giorni → in tal caso usare un identificatore stabile (es. `telegram:<chatId>`). Annota la scelta in cima alla migration.
- [ ] **Step 2:** Modifica la tabella `project_state` nella migration: rimuovi `(channel, chat_key)`, usa `conversation_id text not null` come chiave; indice unico parziale `where status='active'`:
```sql
create table if not exists project_state (
  id bigint generated always as identity primary key,
  conversation_id text not null,
  channel text,
  project_name text, cliente text, cantiere text, task_type text,
  status text not null default 'active',
  key_files jsonb not null default '{}',
  done jsonb not null default '[]', pending jsonb not null default '[]', decisions jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
alter table project_state enable row level security;
create unique index if not exists project_state_active_uniq on project_state (conversation_id) where status='active';
```
- [ ] **Step 3:** Aggiungi seed config: `insert into cervellone_config(key,value) values ('working_memory_enabled','false') on conflict do nothing;`
- [ ] **Step 4:** Commit.

## Task 1: Funzioni project_state in working-memory.ts (TDD)

**Files:**
- Modify: `src/lib/working-memory.ts`
- Test: `src/lib/working-memory.test.ts`

- [ ] **Step 1 — test (vitest, mock getSupabaseServer):** `buildActiveProjectContext` ritorna '' se nessun progetto attivo; ritorna blocco con project_name/cliente/cantiere/pending se presente. `inferTaskType('prepara un POS')==='pos'`.
- [ ] **Step 2 — implementa** in working-memory.ts:
  - `interface ProjectState { conversation_id, project_name, cliente, cantiere, task_type, status, key_files, done, pending, decisions }`
  - `getActiveProject(conversationId): Promise<ProjectState|null>` — select where conversation_id e status='active' maybeSingle. Best-effort.
  - `setActiveProject(conversationId, fields): Promise<boolean>` — upsert su conversation_id (onConflict implicito via chiudi+insert oppure update-if-exists). Implementa: se esiste attivo → update merge; altrimenti insert. Non clobberare campi non passati (merge jsonb done/pending/decisions/key_files).
  - `closeActiveProject(conversationId)` — update status='done'.
  - `buildActiveProjectContext(conversationId): Promise<string>` — blocco `=== PROGETTO ATTIVO ===` con project_name, cliente, cantiere, task_type, file chiave (key_files), fatto (done), manca (pending), decisioni. '' se nessuno.
- [ ] **Step 3:** `buildWorkingContext(userQuery, conversationId?): Promise<string>` — concatena `buildActiveProjectContext(conversationId)` + `buildProcedureContext(userQuery)` (entrambi best-effort, salta i vuoti).
- [ ] **Step 4:** Run `npx vitest run src/lib/working-memory.test.ts` → PASS. Commit.

## Task 2: Wiring iniezione con conversationId

**Files:**
- Modify: `src/lib/agent-job.ts`, `src/app/api/chat/route.ts`

- [ ] **Step 1:** Dove Fase 1 calcola `workingContext: await buildProcedureContext(userText)`, sostituisci con `buildWorkingContext(userText, conversationId)` (telegram: il conversationId della job; web: conversationId del thread). Resta flag-gated da `isWorkingMemoryEnabled()`.
- [ ] **Step 2:** Run `npx tsc --noEmit` (ignora errori pre-esistenti pdf-generator.test/.next). Commit.

## Task 3: Tool progetto attivo

**Files:**
- Modify: `src/lib/tools.ts`

- [ ] **Step 1:** Aggiungi gruppo `PROJECT_TOOLS` (pattern di WORKING_MEMORY_TOOLS già presente) + executor che usa il `conversationId` del contesto di esecuzione tool:
  - `imposta_progetto_attivo({project_name, cliente?, cantiere?, task_type?, key_files?, pending?})` → setActiveProject(conversationId, ...)
  - `aggiorna_progetto({done?, pending?, decisions?, key_files?})` → setActiveProject merge
  - `chiudi_progetto({})` → closeActiveProject(conversationId)
  Registra in ALL_TOOLS + EXECUTORS. (Verifica come l'executor riceve conversationId: `executeTool`/`executeToolBlocks` in claude.ts passa conversationId — usalo.)
- [ ] **Step 2:** Run tsc. Commit.

## Task 4: Tool recupero + salvataggio bozze (bug #2)

**Files:**
- Create: `src/lib/draft-tools.ts`
- Modify: `src/lib/tools.ts`

- [ ] **Step 1 — draft-tools.ts** (usa getSupabaseServer + generatePdfFromHtml + uploadBinaryToDrive + assertWriteAllowed):
  - `listRecentDrafts(conversationId, limit=10)` → select id,name,type,created_at from documents where conversation_id order created_at desc limit. Ritorna lista formattata + link `/doc/<id>`.
  - `getDraft(id)` → select name,content,type → ritorna {name, content, url:`/doc/<id>`}.
  - `saveDraftPdfToDrive(id, folderId)` → getDraft → `generatePdfFromHtml(content, name)` → `assertWriteAllowed(folderId)` → `uploadBinaryToDrive(name+'.pdf', buffer, 'application/pdf', folderId)` → ritorna link Drive. Best-effort con messaggi d'errore chiari.
- [ ] **Step 2 — tools.ts:** registra `lista_bozze({})`, `ritrova_bozza({id})`, `salva_bozza_pdf({doc_id, folder_id})`. lista_bozze usa conversationId del contesto.
- [ ] **Step 3:** Run tsc + un test su listRecentDrafts (mock). Commit.

## Task 5: Regole prompt

**Files:**
- Modify: `src/lib/prompts.ts`

- [ ] **Step 1:** Estendi la regola "MEMORIA PROCEDURALE" con:
  - "MEMORIA PROGETTO: se presente '=== PROGETTO ATTIVO ===', continua quel lavoro; aggiorna lo stato con aggiorna_progetto man mano. All'inizio di un lavoro nuovo chiama imposta_progetto_attivo."
  - "BOZZE: NON rigenerare un documento da zero se ne hai già uno — usa lista_bozze/ritrova_bozza per ritrovarlo. Per salvarlo su Drive usa salva_bozza_pdf(doc_id, folder_id): NON cercare il file su Drive, NON salvare testo piatto."
- [ ] **Step 2:** Commit.

## Task 6: Verifica end-to-end + deploy

- [ ] **Step 1:** `npx tsc --noEmit` pulito (solo errori pre-esistenti). `npx vitest run src/lib/working-memory.test.ts src/lib/draft-tools.test.ts` PASS.
- [ ] **Step 2:** Cowork applica la migration `2026-06-04-working-memory-procedures.sql` (tabelle procedures+project_state, seed POS + flag). Verifica tabelle + flag='false'.
- [ ] **Step 3:** Merge `feat/memoria-evolutiva` → main, push, deploy. Verifica READY + smoke (flag OFF → comportamento invariato).
- [ ] **Step 4:** Cowork mette `working_memory_enabled='true'`. Validazione: un POS di prova deve (a) caricare la procedura, (b) leggere DVR/PSC prima di chiedere, (c) salvare la bozza in PDF nella cartella giusta, (d) ritrovarla se richiesto. Se KO → flag OFF (revert istantaneo).

## Self-Review
- Spec coverage: bug #1 (Task 0-3: project_state), bug #2 (Task 4: lista/ritrova/salva bozze), bug #3 (Fase 1 già fatta, integrata in buildWorkingContext). ✓
- Persistenza cross-sessione: dipende dalla stabilità di conversation_id (Task 0 Step 1 la verifica). ✓
- Flag-gate ovunque: con OFF comportamento invariato. ✓
