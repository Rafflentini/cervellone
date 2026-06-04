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
| Review audit-3giu | Codex | `fix/audit-3giu-batch` | 11 file (vedi diff) | REVIEW richiesta |

## Task queue (assigned by Claude)

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
