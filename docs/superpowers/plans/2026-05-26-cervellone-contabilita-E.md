# Contabilità Sub-progetto E (cron mensile) — Implementation Plan

> **For agentic workers:** eseguito da Codex (manovalanza). Claude: review/merge/deploy. Spec: `docs/superpowers/specs/2026-05-26-cervellone-contabilita-E-cron-mensile-design.md`.

**Goal:** cron a inizio mese che riconcilia (deterministico) il mese precedente, genera la bozza Prima Nota e notifica su Telegram.

**Architecture:** una route cron che riusa gli executor di C (`executeRiconciliazioneTool`) e D (`executePrimaNotaTool`) + sendTelegramMessage. Nessuna logica contabile nuova.

## File structure
- **Create** `src/app/api/cron/contabilita-mensile/route.ts` (Codex 062)
- **Modify** `vercel.json` — aggiungere il cron (Codex 062, autorizzato)
Nessuna migration.

## Task 062 (Codex): cron contabilità mensile
**Files:**
- Create `src/app/api/cron/contabilita-mensile/route.ts`
- Modify `vercel.json` (SOLO aggiunta entry cron)

Leggi la spec. Implementa:
- `route.ts`: GET con guard `Authorization: Bearer ${process.env.CRON_SECRET}` (401 altrimenti); `export const dynamic='force-dynamic'`, `export const maxDuration=300`. Calcola `periodo` = mese precedente `YYYY-MM` (fuso Europe/Rome). In try/catch separati: (1) `executeRiconciliazioneTool('riconcilia_automatico',{periodo})` da '@/lib/riconciliazione-tools', parse JSON; (2) `executePrimaNotaTool('genera_prima_nota',{periodo, folder_id: CONTABILITA_FOLDER_ID})` da '@/lib/prima-nota-tools', parse JSON; (3) notifica Telegram (`sendTelegramMessage` da '@/lib/telegram-helpers') all'admin (replica getAdminChatId di mail-sentinella: ADMIN_CHAT_ID env, fallback primo di TELEGRAM_ALLOWED_IDS). CONTABILITA_FOLDER_ID = `process.env.CONTABILITA_FOLDER_ID || '1mFgmx_BtCxvPk0IAy7ysDdQKsaFP9mBl'`. Messaggi: caso normale (riepilogo + url Prima Nota + abbinati_auto + da_riconciliare a mano); caso 'nessun movimento' (genera_prima_nota fallisce con quel messaggio) → notifica di caricare gli estratti. Ritorna NextResponse.json con esito. NIENTE backtick markdown problematici (è codice TS normale, ok template literal JS standard).
- `vercel.json`: aggiungi all'array crons `{ "path": "/api/cron/contabilita-mensile", "schedule": "0 7 1 * *" }`.

**Vincoli:** read-only/bozza, nessuna conferma automatica, nessuna scrittura FIC. NON toccare gli altri cron in vercel.json. `next build` verde.
Done: `062 | codex/062-cron-contabilita-mensile | <sommario> | files: contabilita-mensile/route.ts, vercel.json`

## Self-review
- Cron 1° del mese, periodo precedente → 062 ✓
- Riconciliazione deterministica + Prima Nota + notifica → 062 (riusa C/D executor) ✓
- Caso 0 movimenti → notifica caricamento ✓
- Read-only/bozza, no conferme auto → rispettato ✓
- vercel.json cron → 062 ✓
