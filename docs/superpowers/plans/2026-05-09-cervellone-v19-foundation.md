# Plan eseguibile — Cervellone V19 Foundation

**Spec di riferimento:** `docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md`
**Branch:** `v19/foundation`
**Modalità:** sessione autonoma notturna Claude (9 mag 2026)
**Confine:** NO push su main, NO deploy prod, NO modifiche Supabase prod, NO modifiche env Vercel

---

## Strategia esecutiva

V19 nasce **in parallelo** a V18, sotto `src/v19/`. Il codice V18 (`src/lib/claude.ts`, `src/lib/tools.ts`, `src/lib/pdf-generator.ts`, ecc.) NON viene toccato stanotte. Cutover V18 → V19 sarà decisione utente in sessione successiva.

Ogni modulo V19 è:
- Implementato in TypeScript stretto (no `any` salvo cast espliciti documentati)
- Con test unitari Vitest dove possibile
- Commit atomico con messaggio descrittivo
- Free di dipendenze cicliche con V18

---

## Ordine task (dipendenze esplicite)

```
[8] Branch setup
   |
   +-- [9] Loop reasoning
   |      |
   |      +-- [10] Orchestrator
   |
   +-- [12] Memory API native (indipendente)
   |
   +-- [11] DOCX engine semantico (indipendente)
   |      |
   |      +-- [13] Tool bollettino Basilicata (indipendente, uso fetch puro)
   |      |
   |      +-- (Tool genera_allegato10_cigo - usa DOCX engine + bollettino)
   |
   +-- [14] E2B sandbox (indipendente, feature-flagged)
   |
   +-- [16] Migration Supabase (indipendente, file only)
   |
   +-- (System prompt V19 - nuovo file, indipendente)
   |
   +-- [15] Test ground-truth Allegato 10 (richiede 11 + 13 + tool cigo)
   |
   +-- [17] PR draft
   |
   +-- [18] ONBOARDING + memory update
```

I task con `(...)` non hanno ID nella TaskList ma sono sotto-componenti dei task numerati. Saranno trattati come commit separati dentro lo stesso task.

---

## Task #8 — Branch v19/foundation setup

### Obiettivo
Creare branch isolato per il lavoro V19, partendo dall'HEAD di `main` (commit `f973b2d`).

### Step
1. `git status` (già pulito su main verificato in discovery)
2. `git checkout -b v19/foundation`
3. Creare struttura cartelle:
   ```
   src/v19/
     agent/
     memory/
     render/
     tools/
     sandbox/
     prompts/
     __tests__/
       fixtures/
   ```
4. Aggiungere `src/v19/README.md` con disclaimer "V19 in costruzione, non usato in prod"
5. Commit: `chore(v19): bootstrap v19/ folder structure`

### Verification
- `git branch --show-current` → `v19/foundation`
- `ls src/v19/` mostra le 7 sottocartelle

---

## Task #9 — Loop reasoning V19 (`src/v19/agent/loop.ts`)

### Obiettivo
Implementare il loop di reasoning V19 conforme alla spec sez. 5: adaptive thinking, output_config xhigh/high, MAX_ITER 30, NO_TEXT 8, gestione `pause_turn`, capture output `code_execution`, container persistence.

### File da creare
- `src/v19/agent/loop.ts` — funzione principale `runAgent`
- `src/v19/agent/types.ts` — tipi (`AgentRequest`, `AgentResponse`, `Intent`, `StopReason`, ...)
- `src/v19/agent/anthropic-client.ts` — singleton client (centralizzato, betas configurati)
- `src/v19/agent/persist.ts` — `loadContainerId`/`saveContainerId` su Supabase
- `src/v19/agent/hallucination-validator.ts` — runtime validator URL Drive
- `src/v19/__tests__/loop.spec.ts` — test mockando `client.beta.messages.stream`

### TDD
1. Test 1: stream restituisce text_delta → fullResponse contiene il testo
2. Test 2: stop_reason=`pause_turn` → loop continua (non break)
3. Test 3: stop_reason=`end_turn` → loop break
4. Test 4: stop_reason=`tool_use` con tool client-side → executeTools chiamato, results pushati
5. Test 5: stop_reason=`tool_use` con solo server-side (web_search/code_execution) → loop continua
6. Test 6: code_execution_tool_result con file → `client.beta.files.download` chiamato, `persistArtifact` chiamato
7. Test 7: NO_TEXT_LIMIT=8 raggiunto → force-text con `tool_choice=none`
8. Test 8: container persistence → `containerId` salvato in DB e riusato
9. Test 9: hallucination validator → URL Drive non esistente trigger errore

### Verification
- `npm run test src/v19/__tests__/loop.spec.ts` → 9/9 PASS
- TypeScript strict: `tsc --noEmit` → no errors per `src/v19/agent/`

### Commit
- `feat(v19): agent loop with adaptive thinking + container persistence`
- `feat(v19): runtime hallucination validator for Drive URLs`
- `test(v19): loop reasoning unit tests`

---

## Task #10 — Orchestrator multi-agent (`src/v19/agent/orchestrator.ts`)

### Obiettivo
Implementare pattern parent → sub-agent (sez. 6 spec): tool `spawn_subagent`, registry sub-agent kind, context isolation, summary-only return.

### File da creare
- `src/v19/agent/orchestrator.ts` — `spawnSubagent` + `buildOrchestratorTools`
- `src/v19/agent/subagent-registry.ts` — mapping kind → system prompt + tool subset
- `src/v19/prompts/subagent/parsing-files.ts`
- `src/v19/prompts/subagent/numerical-engine.ts`
- `src/v19/prompts/subagent/document-render.ts`
- `src/v19/prompts/subagent/domain-italiano.ts`
- `src/v19/prompts/subagent/web-research.ts`
- `src/v19/prompts/subagent/gmail-router.ts`
- `src/v19/__tests__/orchestrator.spec.ts`

### TDD
1. Test 1: `spawn_subagent` con kind valido → `runAgent` invocato con system prompt + tools del kind
2. Test 2: nesting cap a 1 → spawn da sub-agent rifiutato (nesting=1 → no further)
3. Test 3: parent riceve summary + artifacts (non transcript)
4. Test 4: kind sconosciuto → errore esplicito
5. Test 5: input_files passati come `container_upload` block

### Verification
- Test PASS
- Esempio runtime: orchestrator riceve "Genera Allegato 10 con dati X" → spawna sub-agent `domain-italiano` (per check norma) e `document-render` (per genera DOCX) in parallelo, compone risposta.

### Commit
- `feat(v19): multi-agent orchestrator with subagent registry`
- `feat(v19): subagent system prompts (parsing/numerical/document/domain-italiano/web/gmail)`
- `test(v19): orchestrator parent->subagent flow`

---

## Task #11 — DOCX engine semantico (`src/v19/render/docx.ts`)

### Obiettivo
Implementare renderer deterministico JSON semantico → DOCX usando `docx` v9 nativo (Table API, header colorati, content controls). Sostituisce `htmlToDocxBlocks` di V18.

### File da creare
- `src/v19/render/docx.ts` — `renderDocx(doc: DocxDocument): Promise<Buffer>`
- `src/v19/render/types.ts` — `DocxDocument`, `DocxSection`, `DocxTable`, `DocxCell`
- `src/v19/render/utils.ts` — `borderConfig`, `alignFromString`, `buildFooterParagraph`, `renderCell`
- `src/v19/__tests__/docx-engine.spec.ts`

### TDD
1. Test 1: rendering paragrafo → DOCX valido (ZIP magic + XML contiene testo)
2. Test 2: rendering tabella → XML contiene `<w:tbl>`, `<w:tr>`, `<w:tc>` (non solo `<w:p>`)
3. Test 3: header tabella con shading → XML contiene `<w:shd w:fill="..."/>`
4. Test 4: cell border `all` → XML contiene `<w:tcBorders>` su 4 lati
5. Test 5: heading levels h1/h2/h3 → XML contiene `<w:pStyle w:val="Heading1"/>` ecc.
6. Test 6: footer Restruktura presente in default
7. Test 7: snapshot test: DOCX prodotto da fixture deterministico = snapshot binario

### Verification
- Test PASS
- Apertura manuale di un DOCX prodotto su Word/LibreOffice (in dev locale, NON serverless) per ispezione visiva

### Commit
- `feat(v19): semantic DOCX renderer with native docx Table API`
- `test(v19): DOCX engine unit tests + snapshot`

---

## Task #12 — Memory API native (`src/v19/memory/`)

### Obiettivo
Implementare handler `memory_20250818` Anthropic con backend Supabase Storage (sez. 7 spec).

### File da creare
- `src/v19/memory/handler.ts` — `handleMemoryToolCall(call, userId): Promise<string>`
- `src/v19/memory/storage.ts` — wrapper Supabase Storage (view/create/replace/insert/delete/rename)
- `src/v19/memory/bootstrap.ts` — `bootstrapUserMemory(userId)` per popolare `/memories/{userId}/` iniziale
- `src/v19/memory/migrate-from-v18.ts` — script idempotente migrazione `memoria_esplicita` table → file
- `src/v19/__tests__/memory-handler.spec.ts`

### TDD
1. Test 1: command=`view` esistente → ritorna contenuto
2. Test 2: command=`view` inesistente → errore "file not found"
3. Test 3: command=`create` → file scritto su Supabase
4. Test 4: command=`str_replace` → contenuto aggiornato
5. Test 5: command=`delete` → file rimosso
6. Test 6: command=`rename` → file rinominato
7. Test 7: path traversal `/memories/altro_user/` → REJECTED
8. Test 8: bootstrap user "raffaele" → 5 file creati (`identita.md`, `tono.md`, `ufficio.md`, `preferenze/git-policy.md`, `preferenze/doc-output.md`)

### Verification
- Test PASS
- Bucket `memories` definito in migration (task #16)

### Commit
- `feat(v19): Memory API native handler with Supabase Storage backend`
- `feat(v19): user memory bootstrap (raffaele preferences seed)`
- `test(v19): memory handler + path traversal protection`

---

## Task #13 — Tool `scarica_bollettino_meteo_basilicata` (`src/v19/tools/meteo-basilicata.ts`)

### Obiettivo
Implementare il tool che scarica bollettino criticità CFD Regione Basilicata per data specifica (sez. 9.2 spec).

### File da creare
- `src/v19/tools/meteo-basilicata.ts` — `scaricaBollettinoBasilicata(data: Date)`
- `src/v19/tools/meteo-basilicata.errors.ts` — `BollettinoNotFoundError`
- `src/v19/__tests__/meteo-basilicata.spec.ts`

### TDD
1. Test 1: data odierna → URL costruito con format `dd_MM_yyyy`
2. Test 2: response 200 PDF → ritorna `{pdfBuffer, pdfUrl, fonte}`
3. Test 3: response 404 lowercase → fallback uppercase `.PDF`
4. Test 4: entrambi 404 → throw `BollettinoNotFoundError` con messaggio PEC fallback
5. Test 5: response non-PDF → throw (magic bytes check)
6. Test 6: User-Agent custom inviato

### Verification
- Test PASS (mocking fetch)
- (NON facciamo chiamata reale a CFD stanotte per evitare rate limit + dipendenza esterna in test suite)

### Commit
- `feat(v19): tool scarica_bollettino_meteo_basilicata (CFD Regione Basilicata)`
- `test(v19): meteo Basilicata fetch + fallback logic`

---

## Task aggiuntivo (sotto #13) — Tool `genera_allegato10_cigo` + sotto-componenti

### Obiettivo
Implementare il tool principale CIGO (sez. 9.3 spec) che orchestra: bollettino + Allegato 10 DOCX + CSV beneficiari + (opz) SR41 + ZIP + upload Drive.

### File da creare
- `src/v19/tools/cigo/index.ts` — `genera_allegato10_cigo(input, opts)` (entry point)
- `src/v19/tools/cigo/build-allegato10.ts` — `buildAllegato10Doc(input): DocxDocument` (semantic input → DocxDocument)
- `src/v19/tools/cigo/build-beneficiari-csv.ts` — `buildBeneficiariCsv(beneficiari, periodo)` (tracciato Msg INPS 3566/2018)
- `src/v19/tools/cigo/build-sr41.ts` — `compilaSr41(input)` (placeholder con TODO se template Word non disponibile)
- `src/v19/tools/cigo/types.ts` — `Allegato10Input`, `Beneficiario`, `Azienda`, `LegaleRappresentante`
- `src/v19/tools/cigo/zip.ts` — `zipFiles(files): Buffer` con `jszip`
- `src/v19/__tests__/cigo-allegato10.spec.ts` (vedi task #15)

### Verification
Coperta dal test ground-truth task #15.

### Commit
- `feat(v19): tool genera_allegato10_cigo + Allegato 10 + CSV beneficiari + SR41 + ZIP`

---

## Task #14 — E2B sandbox integration (`src/v19/sandbox/e2b.ts`)

### Obiettivo
Implementare wrapper E2B feature-flagged (sez. 11 spec). Codice ready, disabilitato finché `E2B_FEATURE=on` e `E2B_API_KEY` settati.

### File da creare
- `src/v19/sandbox/e2b.ts` — `getOrCreateSandbox`, `runCodeInSandbox`
- `src/v19/sandbox/persist.ts` — `loadSandboxId`/`saveSandboxId` su Supabase `e2b_sandboxes`
- `src/v19/sandbox/errors.ts` — `SandboxDisabledError`, `SandboxKeyMissingError`
- `src/v19/__tests__/e2b.spec.ts`

### Dipendenza npm
- `@e2b/code-interpreter` (aggiungere a `package.json` con `npm install --save`)

### TDD
1. Test 1: E2B_FEATURE non settato → throw `SandboxDisabledError`
2. Test 2: E2B_FEATURE=on senza API_KEY → throw `SandboxKeyMissingError`
3. Test 3: feature on + key + nessun savedId → `Sandbox.create` chiamato, id salvato
4. Test 4: feature on + savedId esistente → `Sandbox.connect` chiamato (mocked)
5. Test 5: connect fallisce (sandbox scaduta) → fallback a create

### Verification
- Test PASS
- `npm run build` non rompe

### Commit
- `feat(v19): E2B sandbox wrapper (feature-flagged off by default)`
- `chore(v19): add @e2b/code-interpreter dependency`
- `test(v19): E2B feature flag + sandbox lifecycle`

---

## Task #16 — Migration Supabase V19 evolutive

### Obiettivo
Scrivere file SQL migration per nuove tabelle V19 (sez. 12 spec). NON applicare su Supabase prod stanotte.

### File da creare
- `supabase/migrations/2026-05-09-v19-foundation.sql` — `agent_runs`, `sub_agent_jobs`, `document_renders`, `e2b_sandboxes`
- `supabase/migrations/2026-05-09-v19-memories-bucket.sql` — Storage bucket `memories` + policy

### Verification
- Sintassi PostgreSQL valida (lint manuale + verifica con `\i` se utente vuole testare locale)
- `RLS DISABLED` su tutte le tabelle (allineato pattern V18 admin-only)
- Indici creati per query previste (conversation_id, parent_run_id, state)

### Commit
- `feat(v19): supabase migrations for agent_runs, document_renders, memories bucket`

---

## Task aggiuntivo (post #16) — System prompt V19 minimale (`src/v19/prompts/system.ts`)

### Obiettivo
Scrivere prompt sistema V19 ridotto (sez. 10 spec): ~50 righe, ~800-1500 token, principio "Claude al 100% + contesto Restruktura".

### File da creare
- `src/v19/prompts/system.ts` — `getSystemPromptV19(intent: Intent): string`
- `src/v19/prompts/identita.ts` — costanti identità Restruktura
- `src/v19/__tests__/system-prompt.spec.ts`

### TDD
1. Test 1: prompt contiene "Sei Claude Opus 4.7 al 100%"
2. Test 2: prompt contiene riferimento `/memories/raffaele/`
3. Test 3: prompt token count < 2000 (tiktoken approssimato)
4. Test 4: variante intent='generation' aggiunge istruzione su `genera_docx_v19`

### Verification
- Test PASS
- Diff vs `src/lib/prompts.ts` mostra riduzione 3-4x token

### Commit
- `feat(v19): minimal V19 system prompt (Claude at 100% + Restruktura context)`

---

## Task #15 — Test ground-truth Allegato 10 CIGO

### Obiettivo
Test end-to-end del tool `genera_allegato10_cigo` con fixture realistici (sez. 13 spec).

### File da creare
- `src/v19/__tests__/cigo-allegato10.spec.ts`
- `src/v19/__tests__/fixtures/cigo-aprile-2026.ts`
- `src/v19/__tests__/__snapshots__/allegato10-aprile-2026.docx` (binario, generato dal primo run del test)

### TDD
Test definiti in spec sez. 13.2:
1. Produce 3 file (DOCX + CSV + bollettino PDF)
2. DOCX contiene `<w:tbl>` (tabella nativa)
3. CSV rispetta tracciato INPS 3566/2018 (header esatto, righe corrette)
4. Bollettino è PDF valido (magic bytes)

### Verification
- `npm run test src/v19/__tests__/cigo-allegato10.spec.ts` → 4/4 PASS
- Manuale (utente domattina): aprire DOCX risultante in Word, confronto visivo con fac-simile INPS, verifica fedeltà layout

### Commit
- `test(v19): ground-truth Allegato 10 CIGO Aprile 2026 (3 file pacchetto)`

---

## Task #17 — PR draft v19/foundation

### Obiettivo
Aprire 1 Pull Request **draft** con tutto il lavoro foundation per review utente domattina.

### Step
1. `git push origin v19/foundation`
2. `gh pr create --draft --title "V19 Foundation: rifondazione totale Cervellone (multi-agent + memoria nativa + DOCX semantico + CIGO)" --body @docs/superpowers/plans/2026-05-09-cervellone-v19-foundation-pr-body.md`
3. NO `--web` (stiamo in CLI), NO merge

### File da creare per PR body
- `docs/superpowers/plans/2026-05-09-cervellone-v19-foundation-pr-body.md` con:
  - Sintesi spec
  - Lista commit per modulo
  - Test risultati (X/X PASS)
  - **Open questions** per utente (sez. 18 spec)
  - Confini operativi (NO main, NO prod)
  - Link a spec + plan

### Verification
- PR appare su GitHub in stato draft
- URL stampato in console

### Commit
Nessun nuovo commit (solo push + PR open).

---

## Task #18 — ONBOARDING.md + memory update

### Obiettivo
Handoff per utente: ripresa al risveglio.

### File da creare
- `ONBOARDING.md` (root del repo cervellone) — guida ripresa V19 con:
  - Cosa è stato fatto stanotte (sintesi 1 pagina)
  - Come testare il foundation (npm install, npm test, npm run build)
  - Open questions
  - Setup pendente (E2B_API_KEY, cartelle Drive semantiche, dati operai reali)
  - Path Hybrid (E) come safety net
  - Comandi git per ispezionare PR

### File da aggiornare
- `C:\Users\Raffaele\.claude\projects\C--Progetti-claude-Code\memory\cervellone-v19-stato.md` (NUOVO) — riassunto stato V19 post-foundation
- `C:\Users\Raffaele\.claude\projects\C--Progetti-claude-Code\memory\MEMORY.md` (Edit) — aggiungere riga V19 stato

### Commit
- `docs(v19): ONBOARDING.md for user resume + foundation summary`

### Verification
- File `ONBOARDING.md` esiste e leggibile
- Memory file aggiornata
- ToolCheck: `gh pr view <num>` ritorna PR draft creata

---

## Criteri di completamento foundation

Foundation V19 si dichiara "completed" se TUTTI:

- ✅ Branch `v19/foundation` esiste con commit ordinati
- ✅ Tutti i file di spec sez. 5-13 creati in `src/v19/`
- ✅ `npm run test` PASS su tutti i nuovi `__tests__/v19/`
- ✅ `npm run build` SUCCESS (no breaking V18)
- ✅ Migration `.sql` valide
- ✅ PR draft aperta su GitHub
- ✅ ONBOARDING.md creato
- ✅ Memory aggiornata

Foundation V19 si dichiara "partial" se almeno:

- ✅ Branch + spec + plan + ONBOARDING (sempre garantiti)
- ✅ Loop reasoning V19 funzionante con test PASS
- ✅ DOCX engine semantico funzionante con test PASS
- ✅ Test Allegato 10 ground-truth PASS o documentato perché no

In partial mode, i moduli mancanti saranno chiaramente segnalati in ONBOARDING con stato (TODO / WIP / blocked-by-X).

---

## Stop conditions (mi fermo e attendo utente)

Mi fermo automaticamente e documento checkpoint se:

- **Architettura ambigua**: scelta `code_execution` vs E2B per uno specifico task non risolvibile da solo
- **Credenziali mancanti**: E2B_API_KEY effettivamente bloccante (oltre il feature flag)
- **Breaking change utente-visibile**: modifica route Telegram esistente
- **Conflitto con audit di ieri**: scoperta nuova che contraddice spec → richiede re-design
- **Test ground-truth Allegato 10 fallisce** per motivo strutturale non risolvibile (es. la lib `docx` non supporta una feature richiesta)
- **Token budget Claude esaurito**: prossimo a saturazione context, meglio fermarsi e documentare che continuare male

In tutti i casi: `cervellone-v19-checkpoint.md` con stato + opzioni per utente.

---

## Anti-pattern da evitare

Sintesi `cervellone-errori-completi.md` applicata a stanotte:

- ❌ NON modificare `src/lib/*` V18 (V19 vive in `src/v19/`)
- ❌ NON aggiungere regole procedurali nel system prompt V19
- ❌ NON fare custom tool per cose Claude fa già
- ❌ NON intercettare file lato server (Claude legge nativamente)
- ❌ NON usare `--no-verify` o `--amend` su commit
- ❌ NON pushare su `main`
- ❌ NON applicare migration su Supabase prod
- ❌ NON modificare env Vercel
- ❌ NON chiudere PR esistenti
- ❌ NON usare `cervellone-progetto.md` come fonte di verità sui file path (è 3 giorni vecchio, verifica nel codice)

---

**Plan ready. Vado con task #8 (branch setup) e proseguo in sequenza, parallelizzando dove i task sono indipendenti.**
