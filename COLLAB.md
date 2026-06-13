# COLLAB — Multi-agent coordination board

Single source of coordination between **Claude Code** (orchestrator) and **Codex**
(executor). Update this file whenever you start or finish work. The agent that owns a
file area is the only one allowed to edit those files until it releases them.

See `AGENTS.md` → "Multi-agent collaboration" for the full rules.

## Agents
- **Claude Code** (orchestrator) — main checkout, branch `main`. Backlog, reviews, merges.
- **Codex** (executor) — worktree `cervellone-codex`, branches `codex/*` / `feat/*` / `fix/*`.

## In-flight work
| Task | Owner | Branch | Files / area | Status |
|------|-------|--------|--------------|--------|
| 083 BUG4 fix 500 upload immagini | Codex | merged `bed8b7a` | `chat/route.ts` | ✅ LIVE prod |
| 084 modulo image-memory | Codex | merged `b5a2877` | `image-memory.ts`+test | ✅ LIVE (8/8 test) |
| 085 wiring web BUG1 | Codex | merged `7e93d2c` | `chat/route.ts` | ✅ LIVE prod |
| 086 wiring Telegram BUG1 | Subagente Claude | merged `eb6fc7e` | `agent-job.ts`+`telegram/route.ts` | ✅ LIVE prod |
| Audit BUG1 (3 auditor) + fix | Subagenti Claude | merged `7f80f35` | image-memory/draft/doc/share/tools/agent-job | ✅ LIVE (contaminazione+privacy+costo+dedup) |
| BUG5: force-action su path web | Subagente Claude | merged `19d6849` | `claude.ts` | ✅ LIVE prod |
| Increment 2: tool `rivedi_immagine` (re-attach pixel) | Subagente Claude | merged `a79aaab` | `tools.ts`+`claude.ts`+`image-memory.ts` | ✅ LIVE prod (audit 2 agenti GO) |
| Audit OLISTICO (3 agenti) + hardening | Subagenti Claude | merged `b80a2f2` | claude/circuit-breaker/draft-tools/doc-test | ✅ LIVE (persistenza force-action + test rotto + suppressor + defense-in-depth) |
| ~~S1/S2 stress test~~ | — | — | — | PARCHEGGIATE (mai partite) |

## Task queue (assigned by Claude)

### TASK S1 — Stress test durable anti-runaway (TEST-ONLY, vitest + mock, ZERO API vere)

**Contesto.** Il 4 giu un crash-restart loop WDK ha bruciato $118. Il 6 giu sono stati deployati i fix
(commit `1ef7a1f`..`c49fe31`): contatore `attempts` atomico (RPC `increment_workflow_run_attempts`) con
`MAX_RUN_ATTEMPTS=1` + doppio guard `Math.max(dbAttempts, getStepMetadata().attempt)` in
`src/workflows/agent-task-steps.ts`; budget `maxRunTokens` (1M durable / 200K default) in
`callClaudeStreamTelegram`; guard anti-paralleli `getActiveRunForChat` (running &lt;30min) in
`src/lib/workflow/runs.ts`; `/reset` chiude le run durable; cron `expire-pending` ripulisce
le zombie (&gt;2h). Questa task scrive gli stress test che INCHIODANO questi comportamenti.

**Regole.** Branch `codex/s1-stress-durable` da `origin/main` aggiornato. Crea SOLO file di test nuovi
(+ eventuali micro-export se un simbolo non è importabile: segnala nel PR, non cambiare logica).
Pattern mock: guarda `src/lib/workflow/runs.test.ts` e `src/lib/circuit-breaker.test.ts` (vi.mock dei
moduli supabase). NIENTE chiamate API vere (Anthropic/Telegram/Supabase): tutto mockato.
Se nel tuo ambiente mancano npx/node_modules: scrivi comunque i test con la massima cura, dichiara
nel PR che non li hai eseguiti — li eseguirà Claude in review.

**Test richiesti (file → casi):**
1. `src/workflows/agent-task-steps.attempts.test.ts`
   - mock `incrementRunAttempts` → 1: `runAgentJob` VIENE chiamato; → 2: `runAgentJob` NON chiamato,
     `sendTelegramMessage` 1× (testo contiene "interrotta"), `updateRunStatus(runId,'error',fallback)` chiamato.
   - caso doppio-guard P1-D: mock `incrementRunAttempts`→1 (fail-open DB) ma `getStepMetadata`→{attempt:2}
     → DEVE abortire comunque (mocka il modulo 'workflow').
   - caso entrambi=1 → passa.
2. `src/lib/workflow/runs.getactive.test.ts` (o estendi runs.test.ts)
   - `getActiveRunForChat`: run created_at −10min → trovata; −40min → null; errore DB → null;
     verifica che il filtro `.gt('created_at', cutoff)` riceva ISO ≈ now−30min.
3. `src/lib/claude.budget-durable.test.ts`
   - mock dello stream Anthropic che accumula usage: con `maxRunTokens` ALTO il loop continua oltre 200K;
     senza (default) → break con testo "superato il budget" in risposta; `logApiUsage` meta.runAborted coerente.
   - NB: mockare `@anthropic-ai/sdk` è oneroso: guarda se esiste già un pattern di mock stream nel repo;
     se diventa fragile, testa in alternativa la sola funzione `isRunOverBudget` con cap custom + documenta.
4. `src/workflows/agent-task.crash-idempotent.test.ts`
   - `updateRunStatus` eseguito 2× stesso runId (simula re-run WDK di markRunStep): nessun throw;
     2ª chiamata con UPDATE count=0 + INSERT duplicate-key → ramo "no clobber" (spia su console.warn ok).
5. `src/lib/workflow/runs.createrun.test.ts` (o estendi)
   - `createRun` include `status:'running'` esplicito nel payload insert.

**PR:** titolo `test(durable): stress test anti-runaway (S1)`, descrizione con elenco casi e
(se eseguiti) esiti. NON mergiare. NON toccare file di produzione.

### TASK S2 — Stress test memoria + 3 micro-fix (dopo S1, branch separato)

**Contesto.** Il "disastro POS" del 4 giu: il bot perdeva/rigenerava i documenti e non ricordava i dati
tra i turni. Il sistema memoria (project_state + draft-tools, `src/lib/working-memory.ts` +
`src/lib/draft-tools.ts`) è attivo in prod ma va inchiodato con test + 3 micro-fix da audit.

**Regole.** Branch `codex/s2-stress-memoria`. Pattern mock: `working-memory.test.ts` / `draft-tools.test.ts`
esistenti, ma con store in-memory MUTABILE (insert/update riflessi) dove serve.

**Micro-fix richiesti (con test ciascuno):**
A. `ritrova_bozza` accetta anche ricerca per titolo: in `src/lib/draft-tools.ts` aggiungi a `getDraft`
   (o nuova funzione `findDraftByTitle(conversationId, query)`) la ricerca `name ilike %query%` scoped
   alla conversation; 1 match → ritorna la bozza; più match → ritorna lista breve (id+nome) chiedendo
   di scegliere; 0 → messaggio chiaro. Aggiorna la definizione del tool in `src/lib/tools.ts`
   (parametro `titolo` opzionale, `doc_id` resta preferito). NON cambiare la firma esistente per id.
B. `aggiorna_progetto`: gli array `done`/`pending` devono APPENDERE con dedup, non sostituire
   (in `setActiveProject`, src/lib/working-memory.ts). `decisions` idem. `key_files` resta merge shallow.
   Aggiorna il commento/JSDoc.
C. `aggiorna_bozza`: elimina il doppio round-trip per la colonna `updated_at` inesistente in `documents`
   (oggi primo update fallisce sempre e fa retry: rimuovi il tentativo, lascia solo il content update).

**Test richiesti** (`src/lib/working-memory-stress.test.ts` + estensioni `draft-tools.test.ts`):
1. genera→modifica→ritrova: store documents con 1 riga; `updateDraft` → stesso `/doc/&lt;id&gt;`, store ha
   ANCORA 1 sola riga (assert anti-rigenerazione).
2. project_state sopravvive a /nuova (nessuna closeActiveProject) → `getActiveProject` ancora attivo;
   dopo `closeActiveProject` → null.
3. due bozze simili: `findDraftByTitle('POS Celano')` → lista 2 match; `('Celano v2')` → match unico.
4. `saveDraftPdfToDrive` happy path + `DrivePolicyError` → output 🔒 e NIENTE upload.
5. merge `setActiveProject`: campi omessi invariati, `key_files` merge, `done:['x']` poi `done:['y']`
   → `['x','y']` (nuova semantica append, con dedup se ripetuto).
6. race unique-active: 2ª insert 'active' stessa conversation → false senza throw, 1 sola riga active.
7. `buildWorkingContext('prepara un POS','c1')` → contiene `=== PROGETTO ATTIVO` e `=== PROCEDURA`;
   `('ciao', undefined)` → ''.
8. stale filter: progetto updated_at −8gg → contesto '' (già coperto da 3 test in working-memory.test.ts:
   NON duplicare, aggiungi solo il caso updated_at malformato → fail-open inietta).

**PR:** titolo `feat(memoria): stress test + ritrova per titolo, append done/pending, fix updated_at (S2)`.
Esegui tsc/test se l'ambiente lo consente, altrimenti dichiara. NON mergiare.

### TASK S3 — Stress test del CICLO DI APPRENDIMENTO (TEST-ONLY, dopo S2)

**Contesto.** Audit apprendimento 6 giu: Cervellone ora può imparare procedure nuove
(`crea_procedura` + `inferTaskType` data-driven con keywords, commit `aacba58`), le memorie
esplicite rilevanti sono auto-iniettate (`searchExplicitMemories` in memory.ts, `6a4cc03`),
`prompt_extra` è iniettato nel system con guardrail di provenienza (solo scritture umane,
`3ad8e7a`+`9a65f66`). Questa task inchioda il ciclo con test.

**Regole.** Branch `codex/s3-stress-learning` da origin/main aggiornato. SOLO file di test nuovi
(micro-export se servono: segnala nel PR). Mock store in-memory mutabile, zero API vere.

**Test richiesti:**
1. `src/lib/working-memory.learning.test.ts`
   - addLesson su 'pos' esistente → lessons contiene la lesson; buildProcedureContext('prepara un POS')
     dopo addLesson → output contiene "APPRENDIMENTI" + la lesson (riuso automatico).
   - ciclo completo NUOVO TIPO: createProcedure({taskType:'cigo', keywords:['cigo','cassa integrazione']})
     → invalidateProcedureCache → inferTaskType('prepara la cigo per dicembre') === 'cigo'
     → addLesson('cigo', ...) true → buildProcedureContext la inietta. È IL test "spiego una volta → ricorda".
   - createProcedure su tipo esistente → false; addLesson su tipo inesistente → false.
2. `src/lib/memory.explicit-recall.test.ts`
   - store cervellone_memoria_esplicita con 5 memorie; searchExplicitMemories('telefono Restruktura')
     → match per keyword su contenuto; match per tag; nessun match → ''; cap 3; troncamento 400;
     keyword con caratteri speciali (virgole, %) → nessun errore di sintassi .or().
3. `src/lib/prompts.prompt-extra.test.ts` (estendi quello esistente se c'è)
   - updated_by umano → iniettato; updated_by 'cervellone: ...' → NON iniettato (guardrail provenienza);
     denylist; troncamento 2000.
4. `src/lib/memoria-feedback-loop.test.ts` (RED-on-purpose, documenta il gap residuo)
   - le tabelle della distillazione notturna (summary giornaliero / entità) NON sono auto-iniettate:
     assert del comportamento ATTUALE. Diventerà la spec del fix futuro.

**PR:** titolo `test(learning): stress test ciclo apprendimento (S3)`. NON mergiare.

### TASK R1 — Review fix audit del 3 giu (REVIEW-ONLY, NON mergiare)
I subagenti di Claude hanno corretto 6 cluster di bug trovati in un audit del lavoro del 3 giu.
Branch da rivedere: **`origin/fix/audit-3giu-batch`** (4 commit sopra `origin/main` `2d9b0a7`).

Comandi:
```
git fetch origin
git log --oneline origin/main..origin/fix/audit-3giu-batch
git diff origin/main..origin/fix/audit-3giu-batch
```

Verifica con occhio critico, in particolare:
1. **`src/app/api/chat/route.ts` + `src/app/api/telegram/route.ts`** — la nuova regex di conferma invio mail
   (`^...$`, oggetto obbligatorio). Conferma che NON matchino i verbi nudi `invia`/`manda`/`spedisci`/`invialo`
   e che continuino a matchare `invia pure mail`, `manda la mail`, `confermo l'invio`. Cerca regressioni o ReDoS.
2. **`src/v19/tools/email/{pending,telegram-confirm}.ts`** — con >=2 pending validi NON deve inviare;
   con 1 invia (claim atomico preservato); con 0 messaggio "nessuna mail pronta". Verifica i filtri
   `status='pending'` + `expires_at > now`. Niente doppio invio.
3. **`src/lib/github-tools.ts`** — il fencing: prova mentalmente bypass `src/app/api/auth/google/route.ts`,
   `src/lib/../proxy.ts`, `package.json5`, `.github/workflows/x.yml`. La regola segmento `auth` e il blocco `..`
   devono reggere. Verifica il cleanup branch su PR fallita (no doppio DELETE/edge).
4. **`src/lib/workflow/runs.ts`** — l'upsert di recupero non deve clobberare `channel`/`created_at` su riga esistente.
5. **`src/lib/task-classifier.ts`** — i veri task documentali ("prepara un preventivo", "genera la relazione tecnica")
   devono ancora attivarsi; chat normale ("preparati", "in relazione a", "il pos del bar") no.
6. **`src/lib/foto-archive-tools.ts`** — il filtro `FOTO_FOLDER_RE` sull'override + strip prefisso numerico.

Esegui in locale: `npx tsc --noEmit` (ignora errori pre-esistenti in `pdf-generator.test.ts` e `.next/types`),
e se hai i test: `npm test` sui file toccati (circuit-breaker, ecc.).

**Output (NON mergiare):** appendi al fondo di questo COLLAB.md un blocco `## [Codex] REVIEW R1` con:
- verdetto per ciascuno dei 6 punti (OK / problema),
- ogni bug/regressione trovata con file:line e fix proposto,
- risultato `tsc`/test.
Poi committa SOLO questo COLLAB.md sul branch `fix/audit-3giu-batch` e pusha. Claude legge, integra e mergia lui.

## Log
- **2026-05-25** — Collaboration scaffolding created (AGENTS.md rules + this file).
  Worktree `cervellone-codex` set up on branch `codex/main` at `d58e2ca`. Awaiting first task.
- **2026-06-04** — Claude: audit del lavoro 3 giu (6 subagenti) → 6 cluster di fix su branch
  `fix/audit-3giu-batch` (4 commit). Assegnato TASK R1 a Codex per review indipendente. Claude mergia dopo.

## [Codex] REVIEW R1

Verdetto sintetico:
1. **OK** — `src/app/api/chat/route.ts` + `src/app/api/telegram/route.ts`: la regex e' ancorata e richiede un oggetto mail/messaggio per i verbi operativi. Verifica manuale con Node: `invia`, `manda`, `spedisci`, `invialo` non matchano; `invia pure mail`, `manda la mail`, `confermo l'invio` matchano. `invia una mail a Mario` non matcha, quindi non intercetta composizione. Nessun rischio ReDoS evidente: pattern lineare, senza alternanze ripetute annidate su input lungo.
2. **OK** — `src/v19/tools/email/pending.ts` + `src/v19/tools/email/telegram-confirm.ts`: `countValidPendingSends()` e `listValidPendingSends()` usano entrambi `status='pending'` + `expires_at > now`; con 0 pending torna "Non ho una mail pronta"; con >1 non chiama `confirmPendingSend()` e mostra `/invia_<uuid>` per ogni bozza; con 1 usa ancora `getLatestPendingSend()` e poi `confirmPendingSend()`. Il claim atomico resta preservato in `markPendingSent(uuid, claimMessageId)` prima dell'SMTP, quindi il doppio invio dello stesso uuid resta bloccato.
3. **OK** — `src/lib/github-tools.ts`: i bypass richiesti reggono. `src/app/api/auth/google/route.ts` e' bloccato da prefisso protetto e segmento `auth`; `src/lib/../proxy.ts` e' bloccato da `..`; `package.json5` non viene bloccato per falso prefisso; `.github/workflows/x.yml` e' bloccato come `.github/`. Il cleanup branch su PR fallita avviene solo dopo creazione branch riuscita e solo nel ramo PR failure/exception; non vedo doppio DELETE sullo stesso errore.
4. **PROBLEMA** — `src/lib/workflow/runs.ts:67`: la recovery usa `.upsert(..., { onConflict: 'id' })` con `channel`, `chat_id` e `conversation_id` nel payload. Se `UPDATE count=0` e `createRun()` inserisce la riga prima dell'upsert di recupero, Supabase fara' update-on-conflict e puo' sovrascrivere `channel`/campi run gia' esistenti. `created_at` non e' nel payload, quindi non viene clobberato, ma il requisito dice anche di non sovrascrivere `channel`. Fix proposto: usare `insert()` con gestione errore duplicate/no-op, oppure `upsert(..., { onConflict: 'id', ignoreDuplicates: true })` e fare poi solo un `update({ status, updated_at })` se serve; in ogni caso non includere campi immutabili nel ramo conflict.
5. **PROBLEMA** — `src/lib/task-classifier.ts:16-18` e `src/lib/task-classifier.ts:57-67`: gli esempi richiesti funzionano (`prepara un preventivo`, `genera la relazione tecnica`, `elabora il computo` true; `preparati`, `in relazione a`, `il pos del bar` false), ma c'e' una regressione sui task POS gia' coperti dai test: `src/lib/task-classifier.test.ts:17`, `:23`, `:40`, `:62` si aspettano true per `redigi un POS per cantiere Rossi`, `fai il POS`, `REDIGI UN POS`, `Fammi il POS per cantiere Test`; la nuova logica non considera piu' `POS` nudo come sostantivo forte e questi casi diventano false. Fix proposto: aggiungere una regola POS contestuale, ad esempio `POS` true solo con verbo/imperativo di task o contesto cantiere/sicurezza, mantenendo false le frasi conversazionali e `il pos del bar`.
6. **OK** — `src/lib/foto-archive-tools.ts`: l'override esplicito ora filtra i match con `FOTO_FOLDER_RE`, quindi "documentazione fotografica" non puo' puntare a una cartella non foto tipo "Documentazione"; `firstToken()` strippa prefissi numerici `08_`, `08 -`, `08.` e splitta anche su underscore, allineandosi allo scoring.

Build/test:
- `git log --oneline origin/main..HEAD` eseguito: 5 commit sopra `origin/main` (include anche il commit `docs(collab): TASK R1...` oltre ai fix).
- `npx tsc --noEmit`: non eseguibile in questa shell; `npx` non e' nel PATH (`Termine 'npx' non riconosciuto`). Il repo non ha `node_modules`, e non sono disponibili `npm`, `pnpm`, `yarn` o `corepack` nel PATH.
- Test mirati non eseguiti per lo stesso motivo (mancano package manager e dipendenze locali). Ho verificato manualmente la regex con il Node bundled dell'app.
