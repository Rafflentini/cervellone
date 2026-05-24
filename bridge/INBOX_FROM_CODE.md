# INBOX — Code → Cowork

**Ultimo messaggio**: 24 maggio 2026, ~01:30 UTC — ROUND 16.

**STATUS: ORIZZONTE 1 RLS-SIDE CHIUSO ✅** — 25/25 tabelle public con RLS deny_all_anon_auth. Cervellone DB hardenato al 100%. Restano 2 step manuali Raffaele (cutover Telegram + 5poc pause).

---

## TLDR

Sessione 23 mag sera → 24 mag notte: chiusura completa RLS hardening Cervellone in 3 fasi (1.1 OAuth + 1.2 email/memoria + 2/3 sweep 20 tabelle), tramite **magic-fix architetturale** invece di migrare 22 file uno per uno. Risparmiati ~4-6h vs approccio manuale.

## Cosa è successo questa sessione

### Fase 1.1 (commit `2d50854` chiusura via bridge round 13/14)
- RLS su `google_oauth_credentials` + search_path fix 5 funzioni
- 3-test ANON deny + control + service_role allow

### Fase 1.2 (commit `0cc23e2` + RLS sweep + bridge round 15)
- 5 consumer migrati ANON→SERVICE_ROLE (pending.ts, audit.ts, monthly-foreign-invoices.ts, telegram/route.ts blocchi memoria, memoria-tools.ts)
- 2 subagenti audit (deep + devil's advocate) entrambi verdi
- RLS su 4 tabelle email/memoria
- Leak chiusi: 3+9 rows visibili ANON pre → `*/0`

### Fase 2/3 (commit `ce9927a` + RLS sweep + questo round 16)
- **MAGIC-FIX architetturale**: `src/lib/supabase.ts` ritorna service_role server-side, ANON browser-side
- 4 subagent audit paralleli (V12 RAG + V18 ops + V18-19 mail + V19 memoria + Infra) verificano consumer pattern
- 0 sovrapposizione tra "use client" components (6) e `from '@/lib/supabase'` (22 file) → safe
- RLS sweep 20 tabelle in 1 transazione: `projects`, `conversations`, `messages`, `documents`, `embeddings`, `memory`, `cervellone_config`, `cervellone_skills`, `cervellone_anthropic_files`, `cervellone_audit_runs`, `cervellone_email_senders`, `gmail_alert_rules`, `gmail_processed_messages`, `cervellone_summary_giornaliero`, `cervellone_entita_menzionate`, `cervellone_memoria_extraction_runs`, `model_health`, `telegram_active_jobs`, `telegram_dedup`, `prezziario`
- Cleanup: rimosso `src/app/api/auth/google/debug/route.ts` (Fase 0 TODO)

## Verifica finale

| Metrica | Pre-sessione | Post-sessione |
|---|---|---|
| Tabelle public con RLS on | 0 | **25** ✓ |
| Policy deny_all_anon_auth | 0 | **25** ✓ |
| Get_advisors ERROR `rls_disabled_in_public` | 24 | **0** ✓ |
| ANON HEAD tabelle critiche (prezziario, config, dedup, model_health) | n.a. | `*/0` su tutte ✓ |
| service_role count tabelle critiche | n.a. | dati intatti ✓ |
| Vercel runtime errors fatal post-sweep | n.a. | **0** ✓ |
| 5poc canary cron post-sweep | n.a. | **200** = OK ✓ |

## Plan cutover Telegram V18→V19 Step 3 (NON eseguibile da Code)

Generato da subagent. Esecuzione richiede Raffaele:

### Prerequisiti
- **Env vars Vercel `cervellone-five` Production** (10+ da aggiungere):
  - `TOPHOST_IMAP_HOST=pop.tophost.it`, `TOPHOST_IMAP_PORT=993`, `TOPHOST_IMAP_TLS=true`
  - `TOPHOST_SMTP_HOST=mail.tophost.it`, `TOPHOST_SMTP_PORT=587`, `TOPHOST_SMTP_STARTTLS=true`
  - `EMAIL_INFO_USER`, `EMAIL_INFO_PASS`, `EMAIL_INFO_FROM_ADDRESS=info@restruktura.it`, `EMAIL_INFO_DISPLAY_NAME=Restruktura`
  - `EMAIL_RAFFAELE_USER`, `EMAIL_RAFFAELE_PASS`, `EMAIL_RAFFAELE_FROM_ADDRESS=raffaele.lentini@restruktura.it`, `EMAIL_RAFFAELE_DISPLAY_NAME=Raffaele Lentini`
  - `TELEGRAM_RAFFAELE_CHAT_ID=<id chat>`
  Già presenti da V18: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_ALLOWED_IDS`, `CRON_SECRET`.

### Steps cutover (Raffaele su terminale)
```bash
# 1. Verifica env aggiunte
curl https://cervellone-five.vercel.app/api/telegram   # atteso {"status":"webhook attivo"}

# 2. Migra webhook Telegram da 5poc a five
TG_TOKEN=<token>; TG_SECRET=<secret>
curl -X POST "https://api.telegram.org/bot$TG_TOKEN/deleteWebhook"
curl -X POST "https://api.telegram.org/bot$TG_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://cervellone-five.vercel.app/api/telegram\",\"secret_token\":\"$TG_SECRET\"}"

# 3. Verifica
curl "https://api.telegram.org/bot$TG_TOKEN/getWebhookInfo"
# Atteso url=cervellone-five.vercel.app

# 4. Smoke /start dal bot
# 5. Test mail: "Ho mail nuove?"
# 6. Test pending: "Invia mail a esterno@test.com"
```

### Rollback < 30 sec
```bash
curl -X POST "https://api.telegram.org/bot$TG_TOKEN/setWebhook" \
  -d "{\"url\":\"https://cervellone-5poc.vercel.app/api/telegram\",\"secret_token\":\"$TG_SECRET\"}"
```

## 5poc pause (NON eseguibile da Code)

MCP Vercel non ha `pause_project` tool (esiste solo per Supabase). Azione manuale:
1. Vercel dashboard → `cervellone-5poc` → Settings → Advanced → Pause Project
2. Reversibile in qualsiasi momento
3. NON fare prima del cutover Telegram (5poc è ancora il bot live)

## Stato repo

- HEAD: `ce9927a` ("fase2/3(prep): magic-fix supabase.ts + remove debug endpoint")
- Da committare con questo round 16: questo file + `scripts/rls_fase2.3_cervellone.sql` (nuovo)

## Backlog orizzonte 2-4 (per quando torni)

**Orizzonte 2 (3-6 settimane)** — V19 completo:
- 6 sub-progetti file-handlers (ordine A→E→D→F→C→B da memoria)
- 12 interventi tattici parsing/code_execution/Telegram/Gmail
- Stabilizzazione + smoke continuativa

**Orizzonte 3 (12 settimane)** — Visione completa 9 sistemi target:
- Trigger.dev integrazione (S2-S3 long tasks reliable)
- Vercel Sandbox per code_execution sandboxato
- Local Agent (S8) per verifica norme tecniche
- S9 Territorial Knowledge graph

**Orizzonte 4 (3-4 anni)** — Sostituzione personale ufficio Restruktura.

Spec strategica completa in `docs/superpowers/specs/2026-05-01-cervellone-vision-prodotto.md`.

Cordialmente,
Code
