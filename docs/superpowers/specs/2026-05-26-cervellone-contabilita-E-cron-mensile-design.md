# Design — Sub-progetto E: Cron mensile contabilità

**Data:** 2026-05-26 · **Feature madre:** Amministrazione Contabile (roadmap A→F).

## Obiettivo
A inizio mese, in automatico: riconciliazione deterministica del mese precedente + bozza Prima Nota su Drive + notifica Telegram con il riepilogo e cosa resta da fare a mano. Scelta utente: **semi-automatico + notifica** (i casi ragionati e le conferme restano in chat).

## Comportamento (route `src/app/api/cron/contabilita-mensile/route.ts`)
- `GET`, auth `Authorization: Bearer ${CRON_SECRET}` (come gli altri cron). `export const dynamic = 'force-dynamic'`, `maxDuration = 300`.
- Calcola `periodo` = mese PRECEDENTE in formato `YYYY-MM`, fuso Europe/Rome.
- Passi (best-effort, ognuno in try/catch, accumula esiti):
  1. **Riconciliazione deterministica**: `await executeRiconciliazioneTool('riconcilia_automatico', { periodo })` → parse JSON → `abbinati_auto`, `residui.movimenti_totali`. Se FIC non configurato/errore → annota e prosegui.
  2. **Prima Nota**: `await executePrimaNotaTool('genera_prima_nota', { periodo, folder_id: CONTABILITA_FOLDER_ID })` → parse JSON → `url`, totali. Se `nessun movimento` → ramo "no movimenti".
  3. **Notifica Telegram** all'admin (`sendTelegramMessage`):
     - Caso normale: "Contabilità <periodo>: X movimenti (entrate €.., uscite €.., saldo €..). Prima Nota: <url>. Abbinati in automatico: N. Da riconciliare a mano: M — scrivimi per sistemarli, poi rigenero la Prima Nota."
     - Caso 0 movimenti: "Contabilità <periodo>: non trovo movimenti. Carica gli estratti conto in Contabilità e dimmi quale cartella, poi estraggo (estrai_movimenti)."
- `CONTABILITA_FOLDER_ID`: const = `1mFgmx_BtCxvPk0IAy7ysDdQKsaFP9mBl` (cartella Contabilità, già autorizzata) oppure `process.env.CONTABILITA_FOLDER_ID` se presente.
- Admin chat: come `mail-sentinella` (`getAdminChatId`: `ADMIN_CHAT_ID` env, fallback primo di `TELEGRAM_ALLOWED_IDS`).
- Ritorna JSON `{ ok, periodo, abbinati_auto, da_riconciliare, prima_nota_url, notified }`.

## vercel.json
Aggiungere il cron: `{ "path": "/api/cron/contabilita-mensile", "schedule": "0 7 1 * *" }`.

## Sicurezza
Read-only su FIC/banca; genera solo la bozza Prima Nota (cartella autorizzata); NESSUNA conferma automatica (le riconciliazioni restano 'proposta'); nessuna scrittura su FIC. Riusa interamente gli executor di C e D (nessuna logica contabile nuova).

## Error handling
- Ogni passo in try/catch: un fallimento (es. FIC giù) non blocca la notifica; l'esito riporta cosa è andato e cosa no.
- Token FIC assente → riconciliazione saltata, Prima Nota generata comunque (senza rif. fattura nuovi), notifica lo segnala.
- Nessun admin chat configurato → logga, ritorna comunque ok.

## Test / verifica
- review + build + smoke: chiamare la route con Bearer CRON_SECRET (curl) per un periodo con movimenti → riceve notifica + Prima Nota creata; per un periodo vuoto → notifica "carica estratti".

## Non-goal di E
Nessun ragionamento Claude (cron server-side); nessuna conferma automatica; nessun ingest automatico degli estratti (B resta manuale: l'utente carica i PDF). La compilazione (F) è separata.
