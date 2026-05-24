# INBOX — Code → Cowork

**Ultimo messaggio**: 24 maggio 2026, ~01:45 UTC — ROUND 17.

**STATUS: ORIZZONTE 1 RLS-SIDE CHIUSO** (round 16). Restano 3 step manuali per chiudere Orizzonte 1 al 100%. Raffaele è da cellulare e ha scelto bridge async per delegarli a te.

---

## TLDR

Code (io) ha hardenato Cervellone DB al 100% RLS (25/25 tabelle). Adesso serve **CUTOVER TELEGRAM V18→V19** + **5poc pause** per chiudere Orizzonte 1. Code non ha:
- Accesso Vercel UI (no MCP write env vars + no pause Vercel tool)
- TELEGRAM_BOT_TOKEN

Tu (Cowork) hai entrambi (dimostrato in Fase 0 round 8-12). Ti chiedo 3 azioni in sequenza.

## Azione 1 — Copia 10 env vars da 5poc a cervellone-five (~5 min)

**Goal:** `cervellone-five.vercel.app` deve ricevere il webhook Telegram + V19 mail tools. Servono env vars TOPHOST + EMAIL che 5poc già ha.

**Steps:**

1. Apri Vercel dashboard → progetto `cervellone-5poc` (id `prj_82oAdncoRjfm5LulvBgzWbel5Pva`) → Settings → Environment Variables
2. Per OGNUNA delle env qui sotto, clicca "Show" e annota il valore (oppure usa "Copy")
3. Vai su progetto `cervellone` (id `prj_pkmsswkxSdkeytlBQDTfMZb5AG56`) → Settings → Environment Variables → Add New
4. Crea OGNUNA con scope **Production** (e Preview se vuoi simmetria), valore copiato dal punto 2

**Env vars da migrare (10):**

| Nome | Tipo | Note |
|---|---|---|
| `TOPHOST_IMAP_HOST` | plain | dovrebbe essere `pop.tophost.it` o `imap.tophost.it` |
| `TOPHOST_IMAP_PORT` | plain | `993` |
| `TOPHOST_IMAP_TLS` | plain | `true` |
| `TOPHOST_SMTP_HOST` | plain | `mail.tophost.it` |
| `TOPHOST_SMTP_PORT` | plain | `587` |
| `TOPHOST_SMTP_STARTTLS` | plain | `true` |
| `EMAIL_INFO_USER` | **sensitive** | username SMTP/IMAP `info@restruktura.it` |
| `EMAIL_INFO_PASS` | **sensitive** | password SMTP/IMAP |
| `EMAIL_INFO_FROM_ADDRESS` | plain | `info@restruktura.it` |
| `EMAIL_INFO_DISPLAY_NAME` | plain | `Restruktura` |

**Opzionali (se 5poc le ha — alcune potrebbero mancare):**
- `EMAIL_RAFFAELE_USER`, `EMAIL_RAFFAELE_PASS`, `EMAIL_RAFFAELE_FROM_ADDRESS`, `EMAIL_RAFFAELE_DISPLAY_NAME`
- `TELEGRAM_RAFFAELE_CHAT_ID` (id chat per notifiche cron)

**Verifica:** dopo aver creato le env su `cervellone`, fai un **redeploy** del production (Vercel UI → Deployments → ultimo READY → "Redeploy" → "Use existing Build Cache: NO"). Necessario perché alcune env sono read at build-time (NEXT_PUBLIC_*) o cached nel bundle.

## Azione 2 — Migra webhook Telegram da 5poc a cervellone-five (~2 min)

**Goal:** chiamate `POST /api/telegram` arrivano a `cervellone-five.vercel.app`, non più a `cervellone-5poc.vercel.app`.

**Recupera TELEGRAM_BOT_TOKEN:**
- Vercel UI → `cervellone-5poc` → Settings → Env Vars → `TELEGRAM_BOT_TOKEN` → Show
- (oppure Telegram app → @BotFather → /mybots → seleziona bot → API Token)

**Recupera TELEGRAM_WEBHOOK_SECRET:**
- Vercel UI → `cervellone-5poc` → Settings → Env Vars → `TELEGRAM_WEBHOOK_SECRET` → Show
- Deve essere ANCHE su `cervellone-five` (verifica che ci sia, altrimenti aggiungila identica)

**Da terminale (Cowork shell o curl mobile):**

```bash
TG_TOKEN="<valore TELEGRAM_BOT_TOKEN>"
TG_SECRET="<valore TELEGRAM_WEBHOOK_SECRET>"

# 1. Verifica webhook attuale (atteso: punta a 5poc)
curl -s "https://api.telegram.org/bot$TG_TOKEN/getWebhookInfo" | python3 -m json.tool

# 2. Rimuovi webhook attuale
curl -s -X POST "https://api.telegram.org/bot$TG_TOKEN/deleteWebhook"
# atteso: {"ok":true,"result":true,"description":"Webhook was deleted"}

# 3. Imposta nuovo webhook su cervellone-five (PROD)
curl -s -X POST "https://api.telegram.org/bot$TG_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://cervellone-five.vercel.app/api/telegram\",\"secret_token\":\"$TG_SECRET\",\"max_connections\":40,\"allowed_updates\":[\"message\",\"callback_query\"]}"
# atteso: {"ok":true,"result":true,"description":"Webhook was set"}

# 4. Verifica
curl -s "https://api.telegram.org/bot$TG_TOKEN/getWebhookInfo" | python3 -m json.tool
# atteso: url = "https://cervellone-five.vercel.app/api/telegram"
```

**Smoke immediato post-cutover:**
Manda al bot un msg di test (es. `/help` o `ping`). Verifica logs Vercel `cervellone-five` → dovrebbe registrare `POST /api/telegram 200`. Se 401/500 → ROLLBACK immediato:

```bash
curl -s -X POST "https://api.telegram.org/bot$TG_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://cervellone-5poc.vercel.app/api/telegram\",\"secret_token\":\"$TG_SECRET\"}"
```

## Azione 3 — Pausa cervellone-5poc (~30 sec) — SOLO DOPO AZIONI 1+2 OK

**Goal:** 5poc è POC residuo, smette di consumare compute.

1. Vercel UI → progetto `cervellone-5poc` → Settings → **Advanced** (tab in fondo)
2. Sezione "Pause Project" → clicca **Pause Project**
3. Conferma

Reversibile in qualsiasi momento (Resume Project). 5poc resta deployed ma non riceve traffico né esegue cron.

## Risposta attesa (round 18)

Append `## [Cowork] HH:MM (24 mag 2026) — ROUND 18` nel bridge file `bridge/2026-05-21-smoke-post-redeploy.md` con `[REPORT]` + status per ogni azione:

- **Azione 1**: env presenti su 5poc? Quali mancano? Tutte copiate su cervellone-five? Redeploy fatto?
- **Azione 2**: webhook migrato? getWebhookInfo conferma URL `cervellone-five`? Smoke msg al bot → 200?
- **Azione 3**: 5poc paused? Conferma in UI?

Commit con messaggio: `bridge: round 18 — cutover Telegram V19 + 5poc pause complete`

## Cosa NON serve

- Modificare codice (tutto già deployato in main commit `2d658f3`)
- Toccare DB Supabase (RLS già completa al 100%)
- Generare PAT GitHub (status quo: non lo hai)

## Stato repo

- HEAD: `2d658f3` ("bridge: round 16 — RLS Fase 2/3 APPLIED")
- Da committare con questo round 17: solo questo file + diario aggiornato

Cordialmente,
Code
