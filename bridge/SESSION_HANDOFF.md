# SESSION HANDOFF — Code → Code (prossima sessione)

**Creato**: 22 maggio 2026, 17:05 CEST, da Code (Claude Code desktop, sessione di Raffaele).

**Contesto**: Raffaele sta uscendo, PC connesso ma potenzialmente spegnibile. Cowork al lavoro sul comando esplicito. Questa è una "letter to future me": se la sessione termina e una nuova istanza Code riprende, leggi questo file PRIMA di tutto.

## Stato al momento dell'handoff

- **Fase 0 RLS Cervellone**: ancora BLOCKED. `SUPABASE_SERVICE_ROLE_KEY` non disponibile a runtime production. Smoke `gmail-morning` con Bearer → HTTP 500 `summary_failed`.
- **Cowork**: ha ricevuto da Raffaele il comando esplicito (incollato dall'app Claude.ai). Sta lavorando — non risposto ancora.
- **Monitor armato**: id `bied3xs84`, 15-min timeout, polla origin/main + smoke ogni 30s. Se la sessione termina, il monitor muore con essa.
- **Repo HEAD**: `d0912d6`. Branch `main` allineato con `origin/main`.

## Cosa Cowork dovrebbe fare

Aggiungere/correggere `SUPABASE_SERVICE_ROLE_KEY` su Vercel project `cervellone` (id `prj_pkmsswkxSdkeytlBQDTfMZb5AG56`) scope Production+Preview. Valore dalla Supabase API page progetto `vpmcqzaqiozpanaekxgj`. Poi committare round 8 in `bridge/2026-05-21-smoke-post-redeploy.md`.

## Pickup automatico per prossima sessione Code

Quando riprendi:

1. **Fetch + check HEAD remoto**:
   ```powershell
   git -C "C:/Progetti claude Code/02.SuperING/cervellone" fetch origin main
   git -C "C:/Progetti claude Code/02.SuperING/cervellone" log --oneline origin/main -5
   ```
   Cerca commit con messaggio `bridge: round 8` o simile.

2. **Re-smoke `gmail-morning`** con Bearer:
   ```powershell
   $h = @{ 'Authorization' = 'Bearer cron20mag2026safekey7XQ4vR9NwT2K6' }
   Invoke-WebRequest -Uri 'https://cervellone-five.vercel.app/api/cron/gmail-morning' -Headers $h -UseBasicParsing
   ```

3. **Scenario A — Cowork ha pushato round 8 + smoke 500**: Cowork dice quale dei 4 casi.
   - Caso 1 (no fix needed): leggi memoria `cervellone-stato-22-mag-pomeriggio-handoff.md` per troubleshoot path: audit consumer `getSupabaseServer`, controllo `serverExternalPackages`, dump env via endpoint debug temporaneo.
   - Casi 2/3/4 (env modificata): empty commit + push per redeploy:
     ```powershell
     git -C "<repo>" commit --allow-empty -m "chore: redeploy post Cowork env fix"
     git -C "<repo>" push origin main
     ```
     Aspetta READY (~55s) via MCP Vercel `get_deployment`. Re-smoke. Atteso 200.

4. **Scenario B — Smoke 200 senza nuovo commit Cowork**: Cowork ha fatto silent fix. Scrivi tu round 8 a sua firma osservata:
   ```
   ## [Code] HH:MM
   `[REPORT]` Observed Cowork silent fix on Vercel UI: smoke gmail-morning now 200. Round 8 logged here for ledger continuity.
   ```
   Commit + push.

5. **Scenario C — Niente di tutto**: Cowork ancora non ha agito. Vedi `cervellone-stato-22-mag-pomeriggio-handoff.md` per opzioni alternative (Raffaele Vercel UI, VERCEL_TOKEN REST API, rollback Fase 0).

## Dopo Fase 0 chiusa (smoke 200)

1. Scrivi round 9 di chiusura nel bridge:
   ```
   ## [Code] HH:MM
   `[REPORT]` Fase 0 chiusa. Smoke gmail-morning 200. Ready per RLS Fase 1: Raffaele esegue scripts/rls_fase1_cervellone.sql in Supabase SQL Editor progetto vpmcqzaqiozpanaekxgj.
   ```
2. Commit + push.
3. Aggiorna memoria: nuovo file `cervellone-stato-22-mag-fase0-chiusa.md`, link in MEMORY.md.
4. Notifica Raffaele alla riapertura sessione che può eseguire RLS Fase 1.

## Riferimenti chiave

- **Memoria sessione 22 mag pomeriggio**: `~/.claude/projects/C--Progetti-claude-Code/memory/cervellone-stato-22-mag-pomeriggio-handoff.md`
- **Bridge ledger**: `bridge/2026-05-21-smoke-post-redeploy.md` (append-only)
- **Inbox per Cowork**: `bridge/INBOX_FROM_CODE.md`
- **Script RLS Fase 1 (validato, ready)**: `scripts/rls_fase1_cervellone.sql`
- **CRON_SECRET**: `cron20mag2026safekey7XQ4vR9NwT2K6` (per smoke autenticato)
- **Vercel project id**: `prj_pkmsswkxSdkeytlBQDTfMZb5AG56`
- **Vercel team id**: `team_QOxzPu6kcaxY8Jdc45arGmgL`
- **Supabase project ref**: `vpmcqzaqiozpanaekxgj`

## Pending NON bloccanti

- cervellone-5poc pause (Raffaele Vercel UI)
- RLS Fase 2/3 (19 tabelle ancora RLS off)
- Cutover Telegram V18 → V19 Step 3
