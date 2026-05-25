# Loop semi-automatico Codex ↔ Claude Code (zero-touch) — design

**Data:** 2026-05-25
**Stato:** approvato ("proviamo"), in collaudo

## Obiettivo
Delegare a Codex (OpenAI, locale) il lavoro di "manovalanza" che brucerebbe token a
Claude. Quando Codex finisce un task, lo segnala automaticamente; Claude (orchestratore)
rivede il branch in locale, mergia, fa deployare Vercel, e rifornisce la coda — con
intervento manuale di Raffaele ridotto al minimo.

## Decisioni (brainstorming)
- **Autonomia:** zero-touch continuo. Codex macina una coda da solo.
- **Merge/deploy:** Claude mergia su main + deploy prod automatici, verifica READY. Stop e
  richiesta a Raffaele SOLO su aree sensibili o fallimenti build/smoke.
- **Backlog:** gestito da Claude (parte piccolo per validare, sale di complessità).
- **Canale:** cartella `.loop/` (gitignored) dentro la worktree di Codex + branch Git nel
  repo condiviso (no push, no rete). Watcher Claude in background.

## Componenti
Tutto in `cervellone-codex/.loop/` (gitignored):
- `queue/NNN-slug.md` — task spec scritti da Claude. Codex lavora il numero più basso pending.
- `done.log` — append-only; Codex aggiunge 1 riga per task finito. Segnale per il watcher.
- `review/NNN.md` — verdetto di rework di Claude (CHANGES + note); Codex corregge sul branch.
- `PROTOCOL.md` — il loop che Codex segue (riferimento stabile).

Il codice viaggia su branch `codex/NNN-slug` nel repo condiviso (visibile a Claude in locale).

## Loop Codex
1. Controlla `review/` per rework pendenti, poi prende il task `NNN` più basso pending in `queue/`.
2. Crea branch `codex/NNN-slug` da `codex/main` aggiornato.
3. Lavora SOLO sui file dichiarati, committa.
4. Appende riga a `done.log`: `NNN | codex/NNN-slug | sommario | files: ...`.
5. Torna a 1. Coda vuota → ricontrolla ogni 30s per ~20 min, poi `IDLE` e stop.
   Bloccato → `BLOCKED NNN | motivo` e prosegue.

## Ciclo Claude (watcher + review)
1. Watcher in background sorveglia `done.log` (+ heartbeat ~25 min per drift detection).
2. Su nuova riga DONE: diff `codex/NNN-slug` vs main → check scope/correttezza/sicurezza.
3. OK e non sensibile → merge main → push → Vercel deploy → verifica READY → ff `codex/main`.
4. Rifornisce la coda (buffer ≥3 task) e ri-arma il watcher.

## Gestione errori
- Review fallita → `review/NNN.md` CHANGES; Codex corregge.
- Build/deploy Vercel rosso → auto-rollback (`git revert` del merge) + ri-accodo con l'errore.
- Codex fermo oltre heartbeat → avviso a Raffaele.
- Area sensibile (`.env`/segreti, migration Supabase/`*.sql`, `prompts.ts`, `package.json`,
  webhook Telegram, `src/lib/supabase.ts`, workflow CI) → mai auto-merge, chiedo a Raffaele.

## Sicurezza/concorrenza
Codex solo in worktree `cervellone-codex` su branch `codex/*`; Claude mergia solo su main nel
checkout principale. Scrittori disgiunti per file (Claude: queue+review; Codex: done.log).

## Collaudo
Primo task in coda: `001-mail-tool-descriptions` (basso rischio) per validare end-to-end.
