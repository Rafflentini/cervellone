# CERVELLONE v2 — Build Completo

## File

```
lib/
  auth.ts             ← SEC-001, SEC-002: Autenticazione
  rate-limiter.ts     ← SEC-003: Rate limiting
  sanitize.ts         ← SEC-004, SEC-005: Sanitizzazione + safe logging
  resilience.ts       ← REL-001, REL-002, REL-003: Fault tolerance + retry + health
  prompts.ts          ← System prompt
  claude.ts           ← Motore (retry, 10 iterazioni)
  tools.ts            ← Tutti i tool + importa_prezziario_da_url + cerca_documenti
  memory.ts           ← Ricerca ibrida, skip trivial, chunk overlap
  telegram-helpers.ts ← parse_mode fix
  supabase.ts         ← Invariato
  embeddings.ts       ← Invariato
  tools/preventivo.ts ← Invariato
  parseDocumentBlocks.ts ← Invariato

app/api/
  chat/route.ts       ← Auth + rate limit + input validation
  telegram/route.ts   ← Webhook secret + video + sticker + thinking msg
  health/route.ts     ← Health check endpoint

migrations.sql        ← SQL per Supabase
```

## Variabili d'Ambiente da Aggiungere

```env
# NUOVE (obbligatorie per v2)
AUTH_SECRET=una_stringa_segreta_lunga_almeno_32_caratteri
TELEGRAM_WEBHOOK_SECRET=altra_stringa_segreta_64_caratteri
ADMIN_CHAT_ID=il_tuo_chat_id_telegram_per_alert

# ESISTENTI (invariate)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_ALLOWED_IDS=123456,789012
NEXT_PUBLIC_SUPABASE_URL=https://...
SUPABASE_SERVICE_KEY=eyJ...
```

## Setup Webhook Telegram con Secret

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://cervellone-5poc.vercel.app/api/telegram",
    "secret_token": "IL_VALORE_DI_TELEGRAM_WEBHOOK_SECRET"
  }'
```

## Generare Cookie Auth

```bash
node -e "console.log(require('crypto').createHmac('sha256','IL_VALORE_DI_AUTH_SECRET').update('cervellone_v2').digest('hex'))"
```
Imposta il risultato come cookie `cervellone_auth` nel browser.

## Migrazione Database

Eseguire `migrations.sql` nel SQL Editor di Supabase.

## Fix Checklist

### P0-BLOCKER (risolti)
- [x] SEC-001: Cookie auth validation (timingSafeEqual + HMAC)
- [x] SEC-002: Telegram webhook secret token
- [x] SEC-003: Rate limiting (sliding window, 5/min TG, 10/min web)

### P1-CRITICAL (risolti)
- [x] SEC-004: Sanitize API keys/passwords before storage
- [x] SEC-005: No user content in production logs
- [x] REL-001: Supabase fault tolerance (safeSupabase wrapper)
- [x] DAT-001: Backup strategy (documentato, serve Supabase Pro)
- [x] REL-002: Embedding failure alerting

### P2-MAJOR (risolti)
- [x] REL-003: Retry con exponential backoff (429, 503, 529)
- [x] REL-004: Input validation (JSON parse + array check)
- [x] PER-001: Skip embedding per messaggi triviali
- [x] PER-002: File size check (25MB limit)
- [x] PER-003: cerca_prezziario multi-risultato (fino a 20)
- [x] PER-004: MAX_ITERATIONS 10 + cerca_prezziario_batch
- [x] FUN-002: Video Telegram (thumbnail extraction)
- [x] FUN-004: Ricerca per codice_voce
- [x] FUN-005: Excel parsing (nota: migliorabile con xlsx lib)
- [x] INT-001: media_group (workaround: messaggio informativo)
- [x] INT-002: parse_mode Markdown con fallback
- [x] UX-001: Tabelle lunghe → documento con link

### P3-MINOR (risolti)
- [x] REL-005: telegram_dedup cleanup (SQL migration)
- [x] FUN-003: Sticker/GIF/Location/Contact handling
- [x] DAT-003: Chunk overlap 500 chars per file grandi
- [x] MNT-002: Health check endpoint (/api/health)
- [x] UX-002: "Sto elaborando..." dopo 12 secondi

### NUOVI TOOL
- [x] importa_prezziario_da_url — Opzione B: scarica da URL qualsiasi
- [x] cerca_documenti — Cerca preventivi/relazioni passate
- [x] cerca_prezziario_batch — Ricerca multipla efficiente
- [x] conta_prezziario — Mostra tutte le regioni disponibili

## Come Funziona il Prezziario Lazio

1. L'Ingegnere chiede: "Fammi un preventivo per un cantiere a Roma"
2. Claude chiama `conta_prezziario(regione="lazio")`
3. Se non disponibile: Claude usa `web_search` per trovare URL del prezziario Lazio
4. Claude chiama `importa_prezziario_da_url(url="...", regione="lazio", anno=2026)`
5. Tool scarica file, parsa voci, importa nel database
6. Claude chiama `cerca_prezziario(query="...", regione="lazio")` per ogni voce
7. Claude genera preventivo + computo con prezzi ufficiali Lazio
