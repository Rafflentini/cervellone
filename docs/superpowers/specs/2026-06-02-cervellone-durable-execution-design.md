# Cervellone — Esecuzione Durable (zero-timeout) — Design

**Data:** 2026-06-02
**Autore:** Claude Code (brainstorming con Raffaele)
**Stato:** approvato (direzione A, due fasi, Vercel-native)

## Problema
Cervellone gira su Vercel Functions. Sia il webhook Telegram sia la webapp processano il loop agentico in `waitUntil(bgProcess())`, legato alla funzione → **tetto ~300s**, oltre il quale Vercel uccide la funzione. Conseguenze osservate (incidente 2 giu, task "carica polizza Ducato"):
1. Task lungo (leggi mail → scarica 3 allegati → carica su Drive, con loop agentico multi-tool) → **timeout**.
2. Al kill, il `finally` che rilascia il mutex `telegram_active_jobs` **non viene eseguito** → lock appeso → l'utente resta bloccato su "⏳ Sto ancora elaborando" fino allo stale-cleanup a 5 min.

Requisito utente: **un coordinatore AI non può avere timeout.** Task futuri saranno più lunghi/ardui (anche ore). UX desiderata: **fire-and-forget + notifica a fine**, resumable.

## Vincoli
- **Vercel-native** (no servizi esterni): Workflow DevKit + Fluid Compute. (Supera la vecchia decisione "Trigger.dev" del 1 mag, presa quando WDK era beta — ora WDK è prodotto: `vercel.com/docs/workflows`, `'use workflow'`, span minuti→mesi, retry, sleep, hook approvazione.)
- Manovalanza codice = Codex (.loop/queue) / subagenti; Claude orchestra/rivede/mergia/deploy.
- Cost-sensitive (>€100/sett): serve cap di costo/step.
- Rollout incrementale e a basso rischio sul bot di produzione.

## Architettura
Classificatore all'ingresso (Telegram + webapp), due regimi:
- **Veloce** (chat/domande/task <~60s): resta in-process come ora (latenza bassa).
- **Durable** (task lunghi/pesanti): il webhook **avvia un workflow WDK e risponde subito**; l'esecuzione vive fuori dalla request, senza limite di tempo.

Il workflow è **agnostico al canale**: porta con sé l'origine (`chat_id` Telegram o `conversation_id` web) e a fine lavoro notifica lì. Stesso motore per entrambi i canali.

## Fase 0 — Stopgap (immediato, piccolo, deployabile stanotte)
Obiettivo: eliminare lo stato "bloccato per sempre" mentre si costruisce la Fase 1.
- **Mutex con heartbeat**: `telegram_active_jobs` acquisisce `last_heartbeat`; il bgProcess lo aggiorna ogni ~20s; lo stale-check considera morto un lock con heartbeat >90s (invece dei 5 min fissi dallo `started_at`). Un task ucciso si sblocca in ~90s.
- **Comando `/reset`**: cancella il lock della propria chat a mano (via `telegram_active_jobs.delete eq chat_id`).
- **Fluid Compute on** (`"fluid": true`) + `maxDuration` al massimo consentito per `/api/telegram` e `/api/chat`.
- **UX onesta**: per i task lunghi, heartbeat utente periodico ("ci sto ancora lavorando…") invece del silenzio→morte.

File toccati (Fase 0): `src/app/api/telegram/route.ts`, `src/app/api/chat/route.ts` (se applicabile), `vercel.json`, eventuale migration `telegram_active_jobs.last_heartbeat` (ALTER ADD COLUMN, nullable).

## Fase 1 — Workflow durable WDK (strutturale)
**Scope v1 (minimo, onesto):** esecuzione durable dei task lunghi, senza timeout, con progress + notifica. Hook di conferma e cap-costo = v1.5 (sotto).
- **`src/lib/agent-workflow.ts`**: funzione `'use workflow'` `runAgentTask(input)` che incapsula il loop agentico oggi in `bgProcess`. Ogni **turno** (chiamata Claude + esecuzione tool) e ogni **operazione pesante** (download allegato, upload Drive) è uno **step** durable (checkpoint + retry automatico). Sopravvive a timeout/crash/redeploy.
- **Entry routing**: il classificatore instrada i task lunghi a `start(runAgentTask, input)` invece di `waitUntil(bgProcess)`. Ritorna subito un id di tracking; manda all'utente "Ci penso, ti aggiorno appena pronto".
- **Progress**: ogni step emette un avanzamento → step notifier invia l'update al canale d'origine ("step 3/7: …").
- **Notifica a fine** (fire-and-forget): step finale invia il risultato al canale d'origine, indipendentemente dalla connessione utente.
- **Mappatura run↔canale**: tabella leggera `agent_workflow_runs` (run_id, chat_id/conversation_id, channel, status, created_at) per instradare progress/fine + idempotenza. (WDK tiene lo stato del workflow; questa tabella è solo per il routing/diagnostica.)
- **Il mutex evolve**: niente più funzione-da-300s con lock; la serializzazione per-chat (se voluta) si basa sullo stato del workflow attivo, non su un lock DB appeso.

### Fase 1.5 (subito dopo v1, stessa direzione)
- **Hook di conferma**: `/fic_ok_`, `/ok2_`, `/accesso_ok_` → `Approval.wait` (il workflow si mette in pausa senza consumare compute finché non confermi). Rimuove gli stati appesi delle doppie conferme.
- **Guardrail costi**: cap per-workflow (step/token stimati/wall-clock) → pausa-e-chiede "ho speso X, continuo? /continua" invece di runaway (lega all'incidente billing 24-28 mag).

## Error handling
- **Retry automatici** WDK sugli step transitori (Drive hiccup, Anthropic 529/overloaded).
- **Credito Anthropic esaurito**: step fallisce → workflow **in pausa + alert** (riusa l'alert 073) → al ripristino **riprende dal checkpoint** (no restart).
- **Crash/redeploy a metà**: WDK riprende dall'ultimo step. Nessun lavoro perso, nessun lock appeso.

## Rollout (incrementale, basso rischio)
1. **Fase 0** deployata subito.
2. **Fase 1 v1** dietro a **feature flag** (`cervellone_config.durable_workflows_enabled`, default OFF) e dietro al classificatore: anche una volta in `main`/prod, non cambia comportamento finché il flag è OFF.
3. Validazione su **preview**: un task che superava i 300s arriva in fondo; crash simulato riprende; notifica a fine OK.
4. Attivazione: si instrada **un solo tipo di task** al workflow (es. upload multi-file Drive / "analizza tutte le fatture"), si valida in prod, si allarga.
5. Fase 1.5 (hook + cap costi) come iterazione successiva.

## Testing
- **Unit**: classificatore (veloce vs durable); step puri (notifier, mappatura run↔canale); parsing input.
- **Integration**: una run end-to-end del task "upload multi-file Drive" su preview, > vecchio limite 300s, con notifica finale.
- **Resilienza**: crash simulato a metà → resume; doppia-conferma (v1.5) → pausa/resume; credito esaurito → pausa/alert/resume.
- **Regressione**: la chat veloce esistente resta invariata (flag OFF = comportamento odierno).

## Non-goal (YAGNI per ora)
- Riscrittura completa della chat veloce (resta com'è).
- Multi-user / code di priorità (single-user).
- Sandbox esecuzione codice, Local Agent (sistemi separati della roadmap target).

## Riferimenti
- Vercel Workflow DevKit: https://vercel.com/docs/workflows
- Fluid Compute: https://vercel.com/docs/fluid-compute
- Incidente 2 giu (origine): `memory/cervellone-incidente-2giu-2026.md`
- Architettura target storica (Trigger.dev, ora superata da WDK): `memory/cervellone-architettura-target.md`
