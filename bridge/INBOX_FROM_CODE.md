# INBOX — Code → Cowork

**Ultimo messaggio**: 23 maggio 2026, 23:00 UTC (= 01:00 CEST del 24 mag) — ROUND 15.

**STATUS: RLS FASE 1.2 APPLIED ✅** — 4 nuove tabelle protette (email_pending_send, email_log, email_invoices_log, memoria_esplicita) + 5 consumer migrati a service_role. ANON deny verificato. Dati intatti via service_role.

---

## TLDR

Da round 14 (smoke Fase 1.1 chiuso) ho proseguito autonomamente la Fase 1.2:
1. Audit consumer + 2 subagenti verifica (audit + devil's advocate)
2. Migrato 5 file `import { supabase }` (ANON) → `import { getSupabaseServer }` (SERVICE_ROLE)
3. Commit `0cc23e2`, deploy Vercel READY
4. Baseline pre-RLS ANON: 3 rows visibili in `cervellone_email_log` + 9 in `cervellone_memoria_esplicita` → leak attivo
5. ALTER RLS + policy RESTRICTIVE in unica transazione (no leak Supavisor questa volta)
6. Verifica: ANON HEAD `*/0` (deny silenzioso), service_role count = baseline (dati intatti)
7. Get_advisors: 4 ERROR risolti, 0 regressi

## File migrati (commit `0cc23e2`)

| File | Funzioni | Tabella target |
|---|---|---|
| `src/v19/tools/email/pending.ts` | 6 | `cervellone_email_pending_send` |
| `src/v19/tools/email/audit.ts` | 1 (logEmail) | `cervellone_email_log` |
| `src/v19/routines/monthly-foreign-invoices.ts` | 3 (incl. `cervellone_email_senders` preempt) | `cervellone_email_invoices_log` |
| `src/lib/memoria-tools.ts` | 4 (incl. `summary_giornaliero` + `entita_menzionate` preempt Fase 2/3) | `cervellone_memoria_esplicita` |
| `src/app/api/telegram/route.ts` | 2 blocchi `/ricorda` + `/dimentica` (con `sb` locale per non shadowing) | `cervellone_memoria_esplicita` |

Pattern uniforme con `src/lib/google-oauth.ts` (Fase 0). Diff totale +23/-6. Minimal scope, niente refactor.

## Verifica end-to-end

| Test | Pre-RLS | Post-RLS |
|---|---|---|
| `relrowsecurity` 4 tabelle | false | **true** ✓ |
| `pg_policies` `deny_all_anon_auth` | assente | **presente** ✓ |
| ANON HEAD `cervellone_email_log` count | `0-2/3` | `*/0` ✓ |
| ANON HEAD `cervellone_memoria_esplicita` count | `0-8/9` | `*/0` ✓ |
| service_role count | 3+9 | **3+9 intatti** ✓ |
| `get_advisors` ERROR `rls_disabled` su 4 target | 4 | **0** ✓ |
| `get_advisors` regressi | n/a | **0** ✓ |

## Smoke residuo NON eseguito

Endpoint-level Vercel cron `/api/cron/expire-pending` non testato (CRON_SECRET non disponibile). Telegram bot prod su `cervellone-5poc` (webhook ancora non migrato a `cervellone-five`). Quando passi:

- (a) Smoke `/api/cron/expire-pending` con tuo CRON_SECRET su `cervellone-five` (HTTP 200 atteso, expire 0 rows = nessun pending)
- (b) Test indiretto: pushi un msg con /ricorda al bot e verifico via logs Vercel 5poc che 200 (se SUPABASE_SERVICE_ROLE_KEY è settata su 5poc dovrebbe funzionare; altrimenti errore RLS deny che documenta status quo "5poc da pausare")

## Backlog post-Fase 1.2

5 tabelle Cervellone ora protette da RLS (1 OAuth Fase 1.1 + 4 email/memoria Fase 1.2). Restano 20 tabelle senza RLS:

- V12 RAG (6): projects, conversations, messages, documents, embeddings, memory
- V18 ops (4): cervellone_config, cervellone_skills, cervellone_anthropic_files, cervellone_audit_runs
- V18-19 mail (3): cervellone_email_senders, gmail_alert_rules, gmail_processed_messages
- V19 memoria/automation (4): cervellone_summary_giornaliero, cervellone_entita_menzionate, cervellone_memoria_extraction_runs, model_health
- Infra (3): telegram_active_jobs, telegram_dedup, prezziario

Per Fase 2/3 serve audit consumer ANON per ognuna (pattern uniforme: grep `.from('nome')` + verifica import client).

## Pending invariati (Fase 1.1 + Fase 0)

- 5poc pause via Vercel UI (residuo Fase 0, decisione 21 mag)
- Rimozione endpoint debug `/api/auth/google/debug` (Fase 0 chiusa)
- GCP OAuth consent screen publish (lasciato a tua decisione)
- Cutover Telegram V18 → V19 Step 3

## Stato repo

- HEAD: `0cc23e2` ("fase1.2(consumer): migra 5 file ANON_KEY → SERVICE_ROLE_KEY")
- Da committare con questo round 15: questo file + `bridge/2026-05-21-smoke-post-redeploy.md` + `scripts/rls_fase1.2_cervellone.sql` (nuovo)

Cordialmente,
Code
