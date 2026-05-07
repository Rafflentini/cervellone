# Cervellone — Gmail Classification automatica + label persistenti (Sub-progetto C)

**Stato:** Design approvato
**Data:** 2026-05-07
**Autore:** Architect Plan (Opus 4.7)
**Spec correlate:**
- `docs/superpowers/specs/2026-05-05-cervellone-gmail-rw-design.md` (Gmail R+W base)
- `docs/superpowers/specs/2026-05-07-cervellone-memoria-persistente-design.md` (pattern cron Sonnet)

## 1. Goal

Classificare automaticamente le mail in arrivo nelle ultime 72h (batch giornaliero, lun-ven 8:30) con un classifier LLM Sonnet 4.6 in 5 categorie data-driven, applicando label Gmail persistenti con prefix `Cervellone/`. L'Ingegnere apre Gmail e trova la inbox già pre-categorizzata, riducendo il triage cognitivo da ~30 min/giorno a ~5 min/giorno.

## 2. Scope

**In scope:**
- 5 categorie seed: Cliente, Fornitore, DURC, Bandi, Spam tecnico
- Categorie data-driven (estendibili via tabella `cervellone_gmail_categorie`, no hardcode)
- Cron giornaliero `/api/cron/gmail-classify` 8:30 lun-ven Rome
- Classifier Sonnet 4.6 con confidence threshold 0.7
- Auto-create label Gmail con prefix `Cervellone/` (niente collisione con label utente)
- Idempotency: skip mail già classificate via `bot_action` IN (`classified`, `classified_skip`)
- 1 nuova migration SQL + estensione CHECK constraint `gmail_processed_messages.bot_action`

**Out of scope (debt esplicito):**
- Webhook real-time Gmail Pub/Sub
- Learning da feedback utente (riclassificazione manuale)
- Multi-language (assume mail italiane)
- Auto-archiviazione spam (rischio nascondere rilevanti)
- Riclassificazione retroattiva (solo mail nuove)

## 3. Decisioni di Design

### 3.1 Categorie data-driven via tabella
Tabella `cervellone_gmail_categorie` con `name`, `description`, `seed_examples`. Description usata letteralmente nel prompt → cambiare comportamento classifier = INSERT/UPDATE riga DB.

### 3.2 Trigger batch invece che real-time
Cron 8:30 lun-ven, finestra 72h. Pub/Sub Gmail richiede setup GCP topic/subscription complesso, MVP costoso, ROI basso vs batch giornaliero.

### 3.3 Confidence threshold 0.7 con skip silenzioso
Sotto soglia → log come `classified_skip`, no label applicata. Errori di label peggio di nessuna label.

### 3.4 Riuso `applyLabel(messageId, labelName)` esistente
`gmail-tools.ts` già implementa `ensureLabelId` che auto-crea label se mancante. Niente nuovo tool, niente colonna `gmail_label_id` schema.

### 3.5 Modello Sonnet 4.6 con fallback Circuit Breaker
Forzare Sonnet (consistent con `memoria-extract.ts`). Opus over-engineered per JSON 3-field, costo ~6x inferiore.

## 4. Architettura

### 4.1 Schema SQL — Migration `2026-05-07-gmail-classification.sql`

```sql
-- Cervellone — Gmail classification automatica (Sub-progetto C)

CREATE TABLE IF NOT EXISTS cervellone_gmail_categorie (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  seed_examples TEXT[] NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_gmail_categorie_enabled
  ON cervellone_gmail_categorie (enabled);

ALTER TABLE cervellone_gmail_categorie DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_gmail_categorie IS
  'Categorie classifier Gmail. description usata nel prompt LLM. seed_examples come hint.';

INSERT INTO cervellone_gmail_categorie (name, description, seed_examples) VALUES
  ('Cliente',
   'Mail da committenti privati o aziende che richiedono lavori, sopralluoghi, preventivi, perizie',
   ARRAY['richiesta preventivo', 'sopralluogo', 'incarico', 'commissione', 'lavoro']),
  ('Fornitore',
   'Mail da fornitori di materiali edili o servizi: preventivi ricevuti, fatture passive, listini',
   ARRAY['listino', 'preventivo allegato', 'fattura n', 'ordine confermato', 'consegna']),
  ('DURC',
   'Mail relative al DURC: richieste, scadenze, comunicazioni Cassa Edile, INPS, INAIL',
   ARRAY['DURC', 'regolarità contributiva', 'cassa edile', 'INPS', 'INAIL']),
  ('Bandi',
   'Mail su bandi pubblici, gare d''appalto, MEPA, opportunità di partecipazione',
   ARRAY['bando', 'gara appalto', 'MEPA', 'CIG', 'CUP', 'avviso pubblico']),
  ('Spam tecnico',
   'Newsletter tecniche, marketing prodotti edili, eventi, fiere, comunicati commerciali non personalizzati',
   ARRAY['newsletter', 'webinar', 'fiera', 'sconto', 'novità prodotto', 'unsubscribe'])
ON CONFLICT (name) DO NOTHING;

ALTER TABLE gmail_processed_messages DROP CONSTRAINT IF EXISTS gmail_processed_messages_bot_action_check;
ALTER TABLE gmail_processed_messages ADD CONSTRAINT gmail_processed_messages_bot_action_check
  CHECK (bot_action IN (
    'notified_critical','in_summary','draft_created','sent_reply',
    'labeled','archived','trashed','marked_read',
    'classified','classified_skip'
  ));

INSERT INTO cervellone_config (key, value) VALUES
  ('gmail_classify_last_run', 'null')
ON CONFLICT (key) DO NOTHING;
```

### 4.2 Prompt classifier Sonnet 4.6

Caricato dinamicamente da `cervellone_gmail_categorie`:

```
Sei un classificatore di mail per uno studio tecnico/edile italiano.

Categorie disponibili:
- Cliente: <description from DB>
- Fornitore: <description from DB>
- DURC: <description from DB>
- Bandi: <description from DB>
- Spam tecnico: <description from DB>

Mail da classificare:
Subject: <subject>
From: <from>
Snippet: <primi 500 char>

Output JSON (no markdown, no commenti):
{"category": "<nome esatto categoria o null>", "confidence": <0-1>, "reason": "1-2 frasi"}

Se nessuna categoria adatta: {"category": null, "confidence": 0, "reason": "..."}
```

### 4.3 Flow `/api/cron/gmail-classify`

1. Auth Bearer CRON_SECRET (else 401)
2. Silent mode check (`gmail_silent_until`)
3. Idempotency: skip se `gmail_classify_last_run === today`
4. `runGmailClassify({ sinceDays: 3, batchMax: 50 })`
5. UPDATE config last_run = today
6. Return `{ ok, processed, classified, skipped, cost_usd }`

### 4.4 Flow `runGmailClassify(opts)`

1. `loadCategories()` (throw se zero categorie)
2. `buildPrompt(categories)`
3. `listInbox({ sinceDays, maxResults: 100 })`
4. Filtra mail già processate (`bot_action` IN `classified`, `classified_skip`)
5. Trim a `batchMax`
6. Per ogni mail: `classifyEmail` → `applyClassification`
7. Return `{ processed, classified, skipped, cost_usd, errors }`

## 5. Stima costi

- Mail/giorno: ~50 × 22 lavorativi = 1.100 call/mese
- Token medi: 250 input + 80 output = 330
- Sonnet 4.6: $3/M input + $15/M output
- Cost/call: ~$0.0021
- **~$2.30/mese** (margine ampio, trascurabile)

## 6. Test plan

### Smoke prod
1. `curl -H "Authorization: Bearer $CRON_SECRET" /api/cron/gmail-classify` → `{ ok: true, processed: N, classified: M }`
2. Gmail web: verifica label `Cervellone/Cliente`, `Cervellone/Fornitore`, ecc.
3. Idempotency: secondo curl → `skipped: 'already_ran'`
4. Estensibilità: INSERT nuova categoria → cron riconosce

### Unit test (vitest, mock Anthropic+Supabase+gmail-tools)
- `classifyEmail` valid JSON high confidence
- `classifyEmail` low confidence → applyClassification skips
- `classifyEmail` malformed JSON → null safe
- `runGmailClassify` 3 mail (2 classify + 1 skip)
- `runGmailClassify` 0 categories → throw
- Idempotency route

## 7. DoD

- [ ] Migration applicata su prod
- [ ] 5 categorie seed presenti
- [ ] CHECK constraint esteso (classified, classified_skip)
- [ ] `gmail-classify.ts` con 5 funzioni esportate
- [ ] `gmail-classify.test.ts` ≥6 test passing
- [ ] Route cron + auth + idempotency
- [ ] vercel.json schedule
- [ ] Deploy verificato
- [ ] Smoke 1-3 prod
- [ ] Costo prima settimana <$1

## 8. Rischi/mitigazioni

| # | Rischio | Mitigazione |
|---|---|---|
| 1 | JSON malformato | try/catch + classified_skip + log |
| 2 | Label esistenti utente conflitto | `ensureLabelId` riusa per nome |
| 3 | Mail PEC criptiche → confidence <0.7 | Threshold conservativa, skip ok |
| 4 | Cron timeout 120s | recordBotAction granulare → idempotent retry |
| 5 | Categorie con `/` nel nome | Sanitize: replace `/` con `-` |
| 6 | Quota Gmail API | batchMax=50 → 12k units/run, sotto 1M/giorno |
| 7 | Anthropic rate limit | Seriale, 429 → fallisce gracefully |
| 8 | OAuth refresh scaduto | getAuthorizedClient gestisce, gira post gmail-morning |
| 9 | Label utente-deleted → bot ricrea | Comportamento atteso, doc onboarding |
| 10 | Race migration vs deploy | Migration PRIMA del deploy codice |
