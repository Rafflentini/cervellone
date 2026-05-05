# Cervellone Gmail R+W — design spec

**Data:** 5 maggio 2026
**Stato:** approvato dal committente, pronto per writing-plans
**Stima:** 4-6 giornate-uomo (1 sessione full + test)
**Contesto strategico:** Cervellone deve sostituire personale d'ufficio. Email è il canale più frequente di comunicazione lavorativa. Senza Gmail integration, il bot legge Drive ma è cieco sulla mail.

## 1. Problema

L'Ing. Lentini riceve mail di lavoro su `restruktura.drive@gmail.com` (lo stesso account già usato per Drive OAuth). Tipologie:
- Clienti (preventivi, comunicazioni cantieri)
- Fornitori (DDT, fatture, listini)
- Enti (INPS, INAIL, Cassa Edile, Comune)
- Commercialista (fatture, scadenze fiscali)
- Assicurazioni, banche, posta certificata
- Newsletter, spam

Una segretaria farebbe: smistare, archiviare, tag, riassumere il giorno, segnalare urgenze, preparare bozze risposta da approvare. Cervellone deve replicare questo workflow.

## 2. Obiettivo

Implementare un'integrazione Gmail bidirezionale che:
1. **Legge** inbox + storico via tool on-demand
2. **Notifica proattivamente** ogni mattina con riassunto + alert immediato su keyword critiche/mittenti VIP
3. **Prepara bozze** di risposta a partire da una mail ricevuta o da istruzioni utente
4. **Invia solo dopo conferma esplicita** dell'Ingegnere via Telegram (`/conferma`)
5. **Gestisce labels, archiviazione, mark-as-read** in autonomia
6. **NON cancella permanentemente, NON inoltra a terzi, NON modifica filtri/firma** (regole hard-coded)
7. **Anti-loop protection** automatica per evitare risposte a auto-reply o thread già gestiti
8. **Predispone Fase 2** (futura) per routine pre-autorizzate via cron (es. fatture mensili → commercialista)

## 3. Scelte architetturali (dal brainstorming)

| Decisione | Scelta | Razionale |
|---|---|---|
| Mailbox | `restruktura.drive@gmail.com` | Riusa OAuth Google Drive già autenticato, solo nuovi scope |
| Send autonomia | A (human-in-loop) + routine pre-autorizzate (Fase 2) | Mail in uscita = reputazione professionale, no autonomia generica |
| Read scope | X (tutto inbox, no filtri label) | Sostituzione personale = stesso accesso che avrebbe segretaria |
| Trigger pattern | R (hybrid: daily morning + on-demand + critical alert) | Replica workflow segretaria, signal-only via VIP/keyword curate |
| Privacy | Mail NON salvate in RAG embedding | Vivono solo in conversation Telegram, niente persistenza permanente |
| Permessi gestione | Apply/remove labels, mark read, archive ✅; trash ⚠️ on-demand; delete/forward/modify-filters/signature/bulk ❌ MAI |

## 4. OAuth scope da aggiungere

L'OAuth Google attuale (Drive) ha scope:
- `https://www.googleapis.com/auth/drive` (READ+WRITE Drive)
- `https://www.googleapis.com/auth/spreadsheets`
- `openid`, `email`, `profile`

Aggiungere:
- `https://www.googleapis.com/auth/gmail.modify` — read + label + archive + trash + mark read + draft (NO send)
- `https://www.googleapis.com/auth/gmail.send` — solo invio (separato per principle of least privilege)

L'utente dovrà ri-autorizzare il consent flow una volta (vai su `/api/auth/google` da web, conferma scope estesi). Refresh_token verrà aggiornato in tabella `google_oauth_credentials` con scope nuovi.

## 5. Schema dati

### 5.1 `gmail_alert_rules` (nuova)

Regole per critical alert push immediato.

```sql
CREATE TABLE gmail_alert_rules (
  id BIGSERIAL PRIMARY KEY,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('keyword', 'sender_vip')),
  pattern TEXT NOT NULL,  -- keyword o email/dominio mittente
  severity TEXT NOT NULL DEFAULT 'high' CHECK (severity IN ('high', 'medium', 'low')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
);
CREATE INDEX idx_gmail_alert_rules_enabled ON gmail_alert_rules (enabled, rule_type);
ALTER TABLE gmail_alert_rules DISABLE ROW LEVEL SECURITY;
```

Init values (suggeriti, da rivedere col committente):
```sql
INSERT INTO gmail_alert_rules (rule_type, pattern, severity, notes) VALUES
  ('keyword', 'urgente', 'high', 'Parola chiave esplicita di urgenza'),
  ('keyword', 'scadenza', 'high', 'Scadenze fiscali o burocratiche'),
  ('keyword', 'pignoramento', 'high', 'Atti giudiziari'),
  ('keyword', 'DURC', 'medium', 'Documenti regolarità contributiva'),
  ('keyword', 'INPS', 'medium', 'Comunicazioni INPS'),
  ('keyword', 'INAIL', 'medium', 'Comunicazioni INAIL'),
  ('keyword', 'fattura', 'low', 'Fatture in arrivo'),
  ('sender_vip', 'commercialista@', 'high', 'Commercialista (mettere indirizzo reale)'),
  ('sender_vip', 'noreply@pec.', 'high', 'PEC (sempre rilevante)');
```

L'utente può aggiungere/disattivare rules via tool admin (es. `gmail_add_alert_rule`).

### 5.2 `gmail_processed_messages` (nuova, anti-loop)

Track delle mail già viste/processate dal bot per evitare loop e doppie notifiche.

```sql
CREATE TABLE gmail_processed_messages (
  message_id TEXT PRIMARY KEY,  -- Gmail message ID
  thread_id TEXT NOT NULL,
  from_address TEXT,
  subject TEXT,
  bot_action TEXT,  -- 'notified_critical', 'in_summary', 'draft_created', 'sent_reply', 'labeled', 'archived'
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_gmail_processed_thread ON gmail_processed_messages (thread_id, ts DESC);
ALTER TABLE gmail_processed_messages DISABLE ROW LEVEL SECURITY;
```

Usata da:
- Daily summary: skip messaggi con `bot_action='in_summary'` per non duplicare
- Critical alert: skip messaggi con `bot_action='notified_critical'` (idempotenza)
- Anti-loop send: prima di inviare reply su un thread, verifica se bot ha già inviato in quel thread di recente (>1 risposta in 30 min = sospetto loop)

### 5.3 Estensioni `cervellone_config` (per cron)

Aggiungere keys:
- `gmail_summary_last_run` — timestamp ultimo daily summary, evita doppio invio
- `gmail_alert_check_last_run` — timestamp ultimo critical check
- `gmail_silent_until` — timestamp fino a quando sono disabilitati cron Gmail (es. vacanze)

## 6. Componenti software

### 6.1 `src/lib/gmail-tools.ts` (nuovo file)

Wrapper Gmail API via `googleapis` SDK (già installato).

API esposta:

```typescript
// Read
export async function listInbox(opts?: { maxResults?: number; onlyUnread?: boolean; sinceDays?: number }): Promise<GmailMessageMeta[]>
export async function searchGmail(query: string): Promise<GmailMessageMeta[]>
export async function readMessage(messageId: string, includeAttachments?: boolean): Promise<GmailMessage>
export async function readThread(threadId: string): Promise<GmailMessage[]>

// Write — drafts
export async function createDraft(opts: {
  to: string
  subject: string
  body: string  // markdown converted to text+html
  inReplyTo?: string  // message_id per reply
  attachments?: GmailAttachment[]
}): Promise<{ draftId: string; messageId: string }>

export async function listDrafts(): Promise<GmailDraftMeta[]>
export async function showDraft(draftId: string): Promise<GmailMessage>
export async function deleteDraft(draftId: string): Promise<void>

// Write — send (richiede /conferma utente prima)
export async function sendDraft(draftId: string): Promise<{ messageId: string; threadId: string }>

// Management
export async function applyLabel(messageId: string, labelName: string): Promise<void>
export async function removeLabel(messageId: string, labelName: string): Promise<void>
export async function listLabels(): Promise<{ id: string; name: string }[]>
export async function createLabel(name: string): Promise<{ id: string; name: string }>
export async function markAsRead(messageId: string): Promise<void>
export async function markAsUnread(messageId: string): Promise<void>
export async function archive(messageId: string): Promise<void>  // remove INBOX label
export async function trash(messageId: string): Promise<void>  // move to Trash (recoverable)

// Anti-loop protection (chiamato internamente prima di send)
export async function isThreadInBotLoop(threadId: string): Promise<boolean>
export async function recordBotAction(messageId: string, action: string, threadId?: string): Promise<void>
```

### 6.2 `src/lib/gmail-summary.ts` (nuovo)

Logica per riassunti e alert.

```typescript
export interface MailSummary {
  totalUnread: number
  byCategory: Record<string, number>  // { 'cliente': 3, 'fornitore': 2, ... }
  critical: GmailMessageMeta[]  // mail che hanno fatto match VIP/keyword
  digest: string  // testo Markdown del riassunto pronto per Telegram
}

export async function buildDailySummary(sinceTs: Date): Promise<MailSummary>
export async function checkCriticalAlerts(sinceTs: Date): Promise<GmailMessageMeta[]>
```

Internamente usa Claude (modello attivo) per:
- Categorizzare mail (cliente/fornitore/ente/etc.)
- Estrarre 1-2 frasi summary per ogni mail importante
- Detectare se una mail è "rispondibile rapidamente" (suggerisci bozza) vs "richiede te"

### 6.3 `src/app/api/cron/gmail-morning/route.ts` (nuovo)

Vercel cron handler. Schedule: ogni giorno 8:00 Europe/Rome (`0 6 * * 1-5` UTC mattina lun-ven).

GET handler:
1. Auth con `CRON_SECRET`
2. Read `gmail_silent_until` — se ancora attivo, skip
3. Read `gmail_summary_last_run` — se < 12h fa, skip (idempotenza)
4. Chiama `buildDailySummary(yesterday)` 
5. Manda Telegram summary all'admin (`TELEGRAM_ALLOWED_IDS[0]` o `ADMIN_CHAT_ID`)
6. Update `gmail_summary_last_run`
7. Per ogni mail in summary, INSERT `gmail_processed_messages` con `bot_action='in_summary'`

### 6.4 `src/app/api/cron/gmail-alerts/route.ts` (nuovo)

Vercel cron handler. Schedule: ogni 30 minuti durante orario lavoro (`*/30 9-18 * * 1-5` UTC).

GET handler:
1. Auth con `CRON_SECRET`
2. Read `gmail_alert_check_last_run`, query mail nuove dopo quel timestamp
3. Per ogni mail nuova: check rules da `gmail_alert_rules` (keyword in subject/body, sender match VIP)
4. Per ogni match HIGH severity: send Telegram immediato "🚨 Mail urgente da X: oggetto Y"
5. Per match MEDIUM: aggrega in 1 messaggio se >2 simili in finestra 30 min
6. Skip se `bot_action='notified_critical'` già esiste in `gmail_processed_messages`
7. INSERT processed con appropriate action

### 6.5 `src/lib/tools.ts` — registrazione tool

Aggiungere ~15 tool a `SELF_TOOLS` o nuovo `GMAIL_TOOLS`:

```
gmail_search, gmail_read_message, gmail_read_thread,
gmail_summary_inbox, gmail_summary_today,
gmail_create_draft, gmail_list_drafts, gmail_show_draft, gmail_send_draft (with /conferma), gmail_delete_draft,
gmail_apply_label, gmail_remove_label, gmail_list_labels, gmail_create_label,
gmail_mark_read, gmail_archive, gmail_trash,
gmail_add_alert_rule, gmail_list_alert_rules, gmail_disable_alert_rule,
gmail_set_silent_mode, gmail_unset_silent_mode
```

### 6.6 Estensione `prompts.ts`

Aggiungere REGOLA TOOL GMAIL:
```
- Quando l'utente menziona "mail", "email", "messaggio email", "ho ricevuto", "rispondi a", "scrivi a [email/persona]" → USA SUBITO i tool gmail_*
- Per "che mail nuove ho" → gmail_summary_inbox
- Per "cerca mail di X" → gmail_search query="from:X"
- Per "rispondi al messaggio di Y" → gmail_search → gmail_read_message → gmail_create_draft con in_reply_to → mostra anteprima
- INVIO bozza: SOLO con conferma utente esplicita ("conferma", "/conferma", "manda", "invia"). Mai send senza esplicito OK.
- TRASH: chiedi conferma esplicita prima di cestinare ("vuoi che la cestini?")
- DELETE PERMANENTE, FORWARD, MODIFY FILTERS, MODIFY SIGNATURE: NON disponibili. Spiega all'utente che non puoi farli.
```

### 6.7 Anti-loop protection (interno a `sendDraft`)

```typescript
export async function sendDraft(draftId: string): Promise<{ messageId: string; threadId: string }> {
  const draft = await showDraft(draftId)
  if (draft.thread_id) {
    if (await isThreadInBotLoop(draft.thread_id)) {
      throw new Error('Anti-loop: bot ha già inviato 1+ risposta in questo thread negli ultimi 30 min. Verifica manualmente prima di re-inviare.')
    }
    // Skip auto-replied / no-reply senders
    const lastMessage = (await readThread(draft.thread_id)).slice(-1)[0]
    if (lastMessage.headers['Auto-Submitted'] === 'auto-replied' || /noreply@/i.test(lastMessage.from)) {
      throw new Error('Anti-loop: thread contiene messaggi auto-reply / noreply. Bot non risponde in questi casi.')
    }
  }
  // Procedi con send + record action
  ...
}
```

## 7. Flussi tipici

### 7.1 Daily morning summary (8:00)
```
[Cron 8:00] → /api/cron/gmail-morning
→ Auth OK
→ check silent_until → no
→ buildDailySummary(da ieri 8:00)
   → listInbox(onlyUnread=true, sinceDays=1)
   → categorize via Claude (cliente/fornitore/ente/spam)
   → extract critical (match alert_rules)
   → format Markdown digest
→ send Telegram all'admin:
   "🌅 *Buongiorno Ingegnere* — 12 mail nuove da ieri.
   
   🚨 Urgenti (3):
   - Comune di Marsicovetere — 'Sollecito documentazione SUE'
   - Cassa Edile — 'DURC scadenza 12/05/2026'
   - Cliente Rossi — 'Conferma sopralluogo domani'
   
   📋 Routine (5): 2 fatture fornitori, 3 newsletter
   📁 Da archiviare (4): conferme automatiche, ricevute lette
   
   Vuoi i dettagli di una specifica?"
→ INSERT processed_messages per ognuna con action=in_summary
→ Update gmail_summary_last_run
```

### 7.2 On-demand search
```
[User Telegram] "cerca mail di Rossi degli ultimi 30 giorni"
→ Bot interpreta query
→ gmail_search "from:Rossi after:2026-04-05"
→ Restituisce N risultati con metadata
→ Bot formatta risposta:
   "Trovate 4 mail da Mario Rossi:
   1. 12/04 — 'Preventivo capannone' (allegato PDF)
   2. 28/04 — 'Sollecito risposta'
   ...
   
   Quale vuoi leggere?"
```

### 7.3 Critical alert in giornata
```
[Mail nuova arriva alle 14:30 — oggetto contiene "URGENTE"]
[Cron 14:30 — /api/cron/gmail-alerts]
→ listInbox(onlyUnread=true, sinceTs=ultimo check)
→ Per la mail "URGENTE":
   → match keyword "urgente" → severity=high
   → check processed_messages: non ancora notificata
   → send Telegram immediato:
     "🚨 *URGENTE da [Mittente]*:
     Oggetto: '...'
     Corpo (anteprima): '...'
     
     Vuoi leggere completa o preparo bozza risposta?"
   → INSERT processed con action=notified_critical
```

### 7.4 Prepare draft + send con conferma
```
[User Telegram] "rispondi al sollecito Cassa Edile dicendo che invio DURC entro venerdì"
→ Bot:
   → gmail_search "from:cassaedile sollecito"
   → gmail_read_message id=X (per leggere context)
   → gmail_create_draft (
        to="cassaedile@...",
        subject="Re: Sollecito DURC",
        body=bozza in italiano formale,
        in_reply_to=X,
     )
   → Risposta Telegram:
     "Bozza preparata:
     
     A: Cassa Edile
     Oggetto: Re: Sollecito DURC
     
     'Spettabile Cassa Edile, in riferimento alla Vs. del [data], confermo
     che provvederò all'invio del DURC aggiornato entro venerdì 8 maggio.
     Distinti saluti, Ing. Raffaele Lentini.'
     
     /conferma per inviare, /modifica per cambiare, /annulla per scartare."

[User] "/conferma"
→ Bot: 
   → check anti-loop su thread → OK (mai inviato dal bot prima)
   → gmail_send_draft(draftId)
   → INSERT processed action=sent_reply
   → Risposta Telegram: "✅ Inviata."
```

### 7.5 Modalità silenziosa
```
[User Telegram] "metti silent fino a domani sera"
→ gmail_set_silent_mode until="2026-05-06T22:00:00Z"
→ Risposta: "🔕 Notifiche Gmail in pausa fino al 6/5 22:00. Continuerò a leggere mail su tua richiesta."

[Cron 8:00 il giorno dopo]
→ /api/cron/gmail-morning
→ check silent_until = 2026-05-06T22:00:00Z, ancora attivo (now=2026-05-06T08:00:00Z)
→ skip
→ Log: "Cron gmail-morning skipped: silent mode until ..."
```

## 8. Setup utente richiesto

1. **Migration Supabase** (`2026-05-05-gmail-rw.sql`):
   - `gmail_alert_rules` (con seed iniziale)
   - `gmail_processed_messages`
   - INSERT keys in `cervellone_config` (last_run, silent_until)

2. **OAuth scope estensione**:
   - Login web a `https://cervellone-5poc.vercel.app`
   - Apri `/api/auth/google` per re-autorizzare con scope Gmail aggiunti
   - Conferma consent screen Google

3. **Vercel env**:
   - `CRON_SECRET` (già richiesto da Circuit Breaker, riusabile)
   - Niente env Gmail-specifico (riusa Google OAuth refresh_token già in DB)

4. **Lista mittenti VIP** (post-deploy, via comandi Telegram):
   - `gmail_add_alert_rule sender_vip [email] high` per ogni cliente VIP
   - `gmail_add_alert_rule sender_vip [commercialista@studio.it] high`

## 9. Testing

### 9.1 Unit (vitest)

`tests/gmail.test.ts`:
- `parseMessageHeaders` — estrae from/subject/date corretti
- `categorizeMessage` — keyword/sender match → categoria giusta
- `isThreadInBotLoop` — true se 2+ bot send in 30min, false altrimenti
- `formatDailyDigest` — prende lista messaggi → Markdown coerente

### 9.2 Integration (manuale post-deploy)

1. Manda mail di test con keyword "urgente" → atteso alert immediato Telegram entro 30 min (o curl manuale al cron)
2. `/conferma` su una bozza → atteso send + log + INSERT processed
3. Tentare reply a thread con altra reply bot < 30 min → atteso anti-loop blocca
4. `gmail_set_silent_mode` → cron skipping verificato in log
5. Daily morning cron 8:00 → atteso digest Telegram

### 9.3 Test plan completo nei task del plan

Lista 10+ test scenarios coprendo: read, search, draft, send, label, archive, trash, anti-loop, silent mode, alert rules CRUD.

## 10. Rischi e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Spam loop (bot risponde a auto-reply) | `Auto-Submitted: auto-replied` header check + 30min thread cooldown |
| Send a destinatario sbagliato | Bozza sempre mostrata in Telegram con TO esplicito prima di /conferma |
| Mail private del personale finiscono in conv Telegram | Mailbox è work-only (committente conferma); RAG embedding skip |
| Costo API Gmail (limit 1B quota/giorno) | Per single user single mailbox, irrilevante |
| Costo Anthropic per categorize (1 chiamata Claude per mail nel digest) | ~10-50 mail/giorno × €0.005 token = €0.05-0.25/giorno = €1-7/mese, accettabile |
| OAuth refresh_token revocato da Google | Bot rilasci eccezione + Telegram alert + chiede re-auth |
| Loop di critical alert (mail trigger keyword genera reply che trigger keyword) | Skip se sender è il bot stesso o pattern noti di self-reply |
| Migrazione scope OAuth (utente deve re-auth) | Documentato chiaramente in setup, link diretto a `/api/auth/google` |

## 11. Out of scope (esplicito)

- **Routine pre-autorizzate** (es. fatture mensili → commercialista) → Fase 2 separata
- **Multi-casella** (Gmail multipli, Outlook, IMAP custom) → solo restruktura.drive@gmail.com
- **PEC** (posta certificata) → niente integrazione Aruba/InfoCert; PEC arriva su Gmail solo se inoltro è settato lato provider
- **Calendar integration** → progetto separato
- **Push real-time via Pub/Sub** (Google Cloud Pub/Sub topic per ricevere subito notifiche di mail nuove) → V1 usa cron 30min, sufficiente
- **Allegati pesanti >10MB** → bot legge metadata ma non scarica/processa contenuto
- **Inoltro automatico ad altri** → MAI, hardcoded
- **Modifica filtri/regole/firma Gmail** → MAI, hardcoded
- **Mark all as read** o operazioni bulk → MAI senza approvazione esplicita

## 12. Definition of Done

- [ ] Migration Supabase applicata
- [ ] Re-auth OAuth con scope nuovi completato dal committente
- [ ] `gmail-tools.ts` con tutte le 20 funzioni esposte
- [ ] `gmail-summary.ts` con logica digest + critical detect
- [ ] Cron `/api/cron/gmail-morning` deployato + schedulato 8:00 lun-ven
- [ ] Cron `/api/cron/gmail-alerts` deployato + schedulato ogni 30 min 9-18 lun-ven
- [ ] Tool registrati in `tools.ts` (~20)
- [ ] Prompt aggiornato con REGOLA TOOL GMAIL
- [ ] Anti-loop protection testato (manda 2 reply rapide su stesso thread → 2° bloccata)
- [ ] Silent mode testato (`gmail_set_silent_mode` + verifica cron skip)
- [ ] Daily summary ricevuto in Telegram entro la prossima 8:00
- [ ] Critical alert ricevuto entro 30 min su mail di test con keyword
- [ ] Send con `/conferma` funzionante
- [ ] Hard-block delete/forward/modify-filters/signature/bulk verificato (bot rifiuta)
- [ ] Unit test ≥10 passanti
- [ ] Manual test plan ≥8 scenarios coperti
