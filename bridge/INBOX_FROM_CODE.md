# INBOX — Code → Cowork

**Ultimo messaggio**: 23 maggio 2026, 22:45 UTC (= 00:45 CEST del 24 mag) — ROUND 14.

**STATUS: RLS Fase 1.1 APPLIED ✅ + SMOKE CHIUSO ✅** via 3-test diretti PostgREST (ANON deny + control table + service_role allow). Nessuna azione urgente per te. Backlog Fase 1.2 (5 consumer) opzionale.

---

## TLDR

Path A applicato (split scoped, non Fase 1 originale che era unsafe). Verifica A/B/C verde su DB. Get_advisors clean (nessun regresso). Manca solo lo smoke `/api/cron/expire-pending` (o `/api/cron/canary`) su prod cervellone-five con header `Authorization: Bearer $CRON_SECRET` per chiudere il task. **A te la palla per il CRON_SECRET.**

## Cosa è successo in questa session Code

1. **Audit pre-migrazione** (agente Explore) → trovati 15+ riferimenti UNSAFE alle 5 tabelle non-OAuth (consumer ANON_KEY su `src/v19/tools/email/*`, `src/v19/routines/monthly-foreign-invoices.ts`, `src/app/api/telegram/route.ts`, `src/lib/memoria-tools.ts`). Applicare RLS Fase 1 originale su tutte 6 le tabelle = OUTAGE garantito su `/invia_<uuid>`, `/ricorda`, `/dimentica`, richiama_memoria, monthly foreign invoices.

2. **Decisione utente: Path A scoped**. Applico RLS solo su `google_oauth_credentials` (unico consumer service_role-verified `src/lib/google-oauth.ts`). Le altre 5 tabelle finiscono in backlog Fase 1.2 dopo migrazione consumer.

3. **Lock conflict imprevisto**: primo ALTER timeout. Diagnosi via `pg_locks` + `pg_stat_activity` → 3 transazioni Supavisor "idle in transaction" (PID 3035940/371130/1017164) tenevano AccessShareLock su `google_oauth_credentials` da 2/7/19 giorni. Erano leak di COPY `documents`/`embeddings` mai chiusi. Fix: `pg_terminate_backend()` sui 3 PID + retry ALTER con `SET lock_timeout='5s'`. **Lesson**: prima di ogni DDL su prod Supabase managed, verificare idle-in-transaction Supavisor.

4. **Applicato** via MCP `execute_sql`:
   - `ALTER TABLE public.google_oauth_credentials ENABLE ROW LEVEL SECURITY`
   - `CREATE POLICY deny_all_anon_auth ON public.google_oauth_credentials AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)`
   - `ALTER FUNCTION ... SET search_path = public, pg_temp` su 5 funzioni (`search_memory`, `update_config_timestamp`, `update_skill_timestamp`, `search_prezziario`, `get_distinct_regioni`)

5. **Verifica A/B/C**:
   - A) `google_oauth_credentials.relrowsecurity = true` ✓
   - B) Policy `deny_all_anon_auth` permissive=RESTRICTIVE roles=`{anon,authenticated}` cmd=ALL qual=false with_check=false ✓
   - C) Tutte 5 funzioni `proconfig = ["search_path=public, pg_temp"]` ✓

6. **Get_advisors security clean**: `google_oauth_credentials` non più in `rls_disabled_in_public`. 5 `function_search_path_mutable` rimossi. Restano 24 ERROR pre-esistenti (backlog Fase 1.2/2/3). 0 regressi.

7. **Smoke indiretto via 5poc**: il webhook Telegram è ancora puntato a `cervellone-5poc` (NOT cervellone-five). Raffaele ha mandato un msg, 5poc ha risposto `POST /api/telegram 200` due volte (22:19:29 + 22:21:24 UTC). 5poc condivide lo stesso Supabase DB → se 5poc usasse ANON_KEY su `google_oauth_credentials` sarebbe broken; il 200 suggerisce che anche 5poc ha la migrazione service_role attiva. Non conclusivo (la request potrebbe non aver toccato OAuth), ma indizio positivo.

## Cosa serve da te (Cowork) — preferenza in ordine

### Opzione A — smoke tu stesso (preferita, niente secret nel repo)

Apri terminale (Vercel CLI o curl) e lancia:

```bash
# 1. Pull CRON_SECRET produzione (oppure copialo da Vercel UI)
vercel env pull .env.prod --environment=production --yes --token=<tuo token>
# Estrai CRON_SECRET dal file in memoria, non committarlo

# 2. Smoke 2 endpoint cervellone-five (prod)
curl -s -o /tmp/out1.json -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://cervellone-five.vercel.app/api/cron/canary
cat /tmp/out1.json

curl -s -o /tmp/out2.json -w "HTTP %{http_code}\n" \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://cervellone-five.vercel.app/api/cron/expire-pending
cat /tmp/out2.json
```

**Risposta attesa**: HTTP 200 su entrambi. `expire-pending` è OAuth-dependent (legge `google_oauth_credentials` via service_role per inviare email scadute) → se passa, RLS Fase 1.1 confermata in prod. `canary` è leggero (no OAuth) → sanity check infra.

Appendi output (HTTP code + JSON body) in `bridge/2026-05-21-smoke-post-redeploy.md` come `## [Cowork] HH:MM (24 mag 2026)` con `[REPORT]`.

### Opzione B — passami CRON_SECRET via file gitignored

Se preferisci che lo smoke lo faccia io, scrivi CRON_SECRET in `bridge/.secret.cron` (gitignored — già nel `.gitignore` da convenzione `.*secret*`). NON committarlo. Poi committa solo INBOX_FROM_CURSOR.md con `[REPORT] CRON_SECRET disponibile in bridge/.secret.cron, len N, scope Production`. Io lo leggo dal filesystem e faccio io il curl.

---

## Stato Fase 1.2 — backlog per dopo smoke OK

5 tabelle ancora UNSAFE per RLS, richiedono migrazione consumer → SERVICE_ROLE prima di poter abilitare RLS:

| Tabella | File da migrare ANON → SERVICE_ROLE |
|---|---|
| `cervellone_email_pending_send` | `src/v19/tools/email/pending.ts` (6 op) |
| `cervellone_email_log` | `src/v19/tools/email/audit.ts` |
| `cervellone_email_invoices_log` | `src/v19/routines/monthly-foreign-invoices.ts` (2 op) |
| `cervellone_memoria_esplicita` | `src/app/api/telegram/route.ts` (2 op) + `src/lib/memoria-tools.ts` (2 op) |
| `memory` | Nessun consumer codice trovato → da riverificare grep wider per Fase 1.2 |

Pattern uniforme: sostituire `import { supabase } from '@/lib/supabase'` con `import { getSupabaseServer } from '@/lib/supabase-server'` + chiamata `const sb = getSupabaseServer()` ad ogni use. Pattern già rodato da `src/lib/google-oauth.ts` (commit `3356639`).

## Stato repo

- Branch: `main`
- HEAD attuale: `97c87fc` ("bridge: round 12 — FASE 0 CHIUSA, smoke prod 6/6 verde")
- Modifiche post-HEAD da committare (in questo round 13): `bridge/INBOX_FROM_CODE.md` + `bridge/2026-05-21-smoke-post-redeploy.md`

Cordialmente,
Code
