# Cervellone — Memoria Persistente Cross-Sessione (Sub-progetto B)

**Data:** 2026-05-07
**Autore:** Claude Sonnet 4.6 (engineer spec)
**Stato:** DRAFT → pronto per implementazione
**Spec rif. architettura:** `memory/cervellone-architettura-definitiva.md`, `memory/cervellone-principio-fondamentale.md`

---

## 1. Goal e Scope

### Goal

Dotare Cervellone di memoria persistente cross-sessione: le informazioni rilevanti dette oggi (clienti, cantieri, scadenze, eventi fattuali) devono essere accessibili in una sessione di domani, della prossima settimana, o dopo mesi — senza che l'Ingegnere debba ripetere il contesto ogni volta.

Oggi Cervellone ha memoria dentro la singola sessione (history in `messages`) e RAG semantico su documenti (`embeddings`). Manca la strato intermedio: "cosa ci siamo detti ieri" e "chi è il cliente Bianchi che abbiamo menzionato 3 volte".

### In-scope MVP

- Auto-extraction notturna giornaliera (cron 23:30) con Sonnet 4.6: entità named + eventi fattuali + summary sintetico
- Comando `/ricorda` manuale per salvare decisioni esplicite
- Comando `/dimentica <uuid>` per cancellare singola riga di memoria esplicita
- 4 tool per Cervellone: `ricorda`, `richiama_memoria`, `riepilogo_giorno`, `lista_entita`
- Richiamo a 3 livelli con priorità: esplicita → summary → RAG
- Cross-canale web + Telegram via `conversation_id`
- REGOLA TOOL MEMORIA in `src/lib/prompts.ts`

### Out-of-scope MVP (debito tecnico esplicito)

- **Cleanup cron summary >2 anni**: TTL 2 anni su `cervellone_summary_giornaliero`, ma il cron di pulizia automatica è fuori scope. Cleanup manuale via SQL fino a implementazione.
- **Auto-detection decisioni morbide con LLM**: la granularità MVP è conservativa (solo fatti verificabili). Un layer ML per auto-classificare "decisioni vere" richiede training set e validazione — iter futura.
- **ML retraining / feedback loop**: il prompt extraction è statico MVP. Fine-tuning o few-shot dinamico fuori scope.
- **Retroactive run su archivio storico**: processiamo solo da oggi in poi. La storia pre-MVP rimane nel RAG esistente.
- **UI di gestione memoria**: visualizzazione/editing memoria in webchat. Solo Telegram + tool nell'MVP.

---

## 2. Architettura HYBRID 3 Strati

### Flowchart testuale

```
USER INPUT → Cervellone riceve messaggio
                │
                ▼
        ┌───────────────────┐
        │  Trigger memoria? │  (parole chiave: "ricordi", "ieri", "la settimana scorsa",
        │                   │   "Bianchi", "quanto abbiamo detto per X", ecc.)
        └────────┬──────────┘
                 │ SÌ
                 ▼
         L1: cervellone_memoria_esplicita
         ┌─────────────────────────────────┐
         │ SELECT WHERE contenuto ILIKE %q%│  ← deterministico, priorità massima
         │ oppure full-text search         │
         └──────────────┬──────────────────┘
                        │ trovato? → usa + cita fonte
                        │ non trovato? ↓
                        ▼
         L2: cervellone_summary_giornaliero
         ┌─────────────────────────────────┐
         │ Per query temporali ("ieri",    │  ← lookup per data
         │ "lunedì scorso"): SELECT WHERE  │
         │ data = target_date              │
         └──────────────┬──────────────────┘
                        │ trovato? → usa summary_text
                        │ non trovato? ↓
                        ▼
         L3: search_memory (RAG pgvector esistente)
         ┌─────────────────────────────────┐
         │ RPC search_memory(query, limit) │  ← semantico, fallback
         └──────────────┬──────────────────┘
                        │ trovato? → usa con disclaimer "da archivio"
                        │ nulla? ↓
                        ▼
         Risposta onesta: "Non ho memoria esplicita di X."

─────────────────────────────────────────────────────────────

CRON 23:30 Europe/Rome (daily)
        │
        ▼
  memoria-extract orchestrator
        │
        ├─ SELECT messages WHERE created_at::date = ieri
        ├─ GROUP BY conversation_id
        ├─ Per ogni gruppo → Sonnet 4.6 extraction prompt conservativa
        ├─ Aggrega → INSERT summary_giornaliero (1 riga per data)
        ├─ UPSERT entita_menzionate (per name+type, incrementa count)
        └─ Log run in memoria_extraction_runs

─────────────────────────────────────────────────────────────

/ricorda <testo> (Telegram) o tool ricorda(testo, tag?)
        │
        ▼
  INSERT cervellone_memoria_esplicita
  source = 'telegram' | 'tool'
  (priorità L1 massima in richiamo)
```

---

## 3. Schema SQL Migration

File: `supabase/migrations/2026-05-07-memoria-persistente.sql`

```sql
-- Memoria persistente cross-sessione (Sub-progetto B)
-- Approach HYBRID: cron giornaliero + /ricorda manuale
-- Granularità conservativa: solo fatti verificabili

-- ─────────────────────────────────────────────────────────────
-- 1. cervellone_memoria_esplicita
--    Decisioni/contesti salvati manualmente via /ricorda o tool
--    TTL: FOREVER (delete manuale via /dimentica <id>)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cervellone_memoria_esplicita (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contenuto TEXT NOT NULL,
  conversation_id UUID,             -- nullable: link alla chat di origine
  tag TEXT,                         -- etichetta opzionale (es. 'cliente', 'scadenza')
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'telegram'
    CHECK (source IN ('telegram', 'web', 'tool', 'cron'))
);

CREATE INDEX IF NOT EXISTS idx_memoria_esplicita_conv
  ON cervellone_memoria_esplicita (conversation_id)
  WHERE conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memoria_esplicita_created
  ON cervellone_memoria_esplicita (created_at DESC);

ALTER TABLE cervellone_memoria_esplicita DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_memoria_esplicita IS
  'Decisioni e contesti salvati esplicitamente via /ricorda o tool. Priorità L1 nel richiamo. TTL FOREVER, cancellazione solo con /dimentica <uuid>.';

-- ─────────────────────────────────────────────────────────────
-- 2. cervellone_summary_giornaliero
--    1 riga per data, prodotta dal cron 23:30
--    TTL: 2 anni (cleanup cron OUT-OF-SCOPE MVP — debito tecnico)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cervellone_summary_giornaliero (
  data DATE PRIMARY KEY,
  summary_text TEXT NOT NULL,
  message_count INT NOT NULL DEFAULT 0,
  conversations_json JSONB,         -- array conversation_id processate
  llm_tokens_used INT,              -- token Sonnet usati per extraction
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_summary_giornaliero_data
  ON cervellone_summary_giornaliero (data DESC);

ALTER TABLE cervellone_summary_giornaliero DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_summary_giornaliero IS
  '1 riga per giorno lavorativo. Prodotta dal cron memoria-extract 23:30 Rome. TTL 2 anni (cleanup cron da implementare post-MVP).';

-- ─────────────────────────────────────────────────────────────
-- 3. cervellone_entita_menzionate
--    Registro aggregato clienti/cantieri/fornitori estratti
--    PK composita (name, type) — deduplication automatica
--    TTL: FOREVER
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cervellone_entita_menzionate (
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cliente', 'cantiere', 'fornitore')),
  last_seen_at DATE NOT NULL DEFAULT CURRENT_DATE,
  mention_count INT NOT NULL DEFAULT 1,
  contexts_json JSONB,              -- array ultimi 5 contesti testuali
  PRIMARY KEY (name, type)
);

CREATE INDEX IF NOT EXISTS idx_entita_lastseen
  ON cervellone_entita_menzionate (last_seen_at DESC);

ALTER TABLE cervellone_entita_menzionate DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_entita_menzionate IS
  'Registro aggregato entità named estratte dal cron. UPSERT su (name, type). TTL FOREVER.';

-- ─────────────────────────────────────────────────────────────
-- 4. cervellone_memoria_extraction_runs
--    Log di ogni run del cron extraction per debug e billing
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cervellone_memoria_extraction_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date_processed DATE NOT NULL,
  conversations_count INT NOT NULL DEFAULT 0,
  entities_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'ok', 'error')),
  llm_cost_estimate_usd DECIMAL(8,4),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_date
  ON cervellone_memoria_extraction_runs (date_processed DESC);

ALTER TABLE cervellone_memoria_extraction_runs DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_memoria_extraction_runs IS
  'Log immutabile di ogni run cron memoria-extract. Status started→ok|error. Usato per debug, monitoring, stima costi LLM.';

-- ─────────────────────────────────────────────────────────────
-- 5. Config keys in cervellone_config
-- ─────────────────────────────────────────────────────────────
INSERT INTO cervellone_config (key, value) VALUES
  ('memoria_extract_last_run', 'null'),
  ('memoria_silent_until', 'null'),
  ('memoria_extract_model', '"claude-sonnet-4-6"')
ON CONFLICT (key) DO NOTHING;
```

---

## 4. Tool Anthropic Format (4 nuovi tool)

### 4.1 `ricorda`

```typescript
{
  name: 'ricorda',
  description: 'Salva in memoria persistente una decisione, contesto o fatto importante. ' +
    'Usare quando l\'Ingegnere dice esplicitamente di voler ricordare qualcosa, ' +
    'o quando si prende una decisione che dovrà essere recuperata in sessioni future. ' +
    'NON usare per fatti generici già presenti nella conversazione corrente.',
  input_schema: {
    type: 'object',
    properties: {
      testo: {
        type: 'string',
        description: 'Testo da salvare in memoria. Essere precisi e auto-contenuti: ' +
          'includere chi, cosa, quando se rilevante. Es: "Cliente Bianchi: accordo orale ' +
          'di €15.000 per ponteggio via Roma 45, da formalizzare entro 15 maggio 2026."',
      },
      tag: {
        type: 'string',
        description: 'Etichetta opzionale per categorizzare il ricordo. ' +
          'Es: "cliente", "scadenza", "cantiere", "fornitore", "decisione".',
      },
    },
    required: ['testo'],
  },
}
```

### 4.2 `richiama_memoria`

```typescript
{
  name: 'richiama_memoria',
  description: 'Cerca nella memoria persistente (3 livelli: esplicita → summary giornaliero → RAG). ' +
    'Usare quando l\'Ingegnere chiede di ricordare qualcosa, o quando serve contesto storico ' +
    'per rispondere correttamente (es. "come avevamo detto per il cliente X"). ' +
    'Cerca sempre PRIMA in questo tool, poi nella conversazione corrente.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Testo della ricerca. Usare parole chiave significative: nome cliente, ' +
          'tipo decisione, argomento. Es: "accordo cliente Bianchi", "scadenza DURC maggio".',
      },
      tipo_filtro: {
        type: 'string',
        enum: ['esplicita', 'summary', 'entita', 'tutto'],
        description: 'Filtra il livello di ricerca. Default "tutto" cerca in tutti e 3 i livelli.',
        default: 'tutto',
      },
      limit: {
        type: 'number',
        description: 'Numero massimo risultati per livello. Default 10.',
        default: 10,
      },
    },
    required: ['query'],
  },
}
```

### 4.3 `riepilogo_giorno`

```typescript
{
  name: 'riepilogo_giorno',
  description: 'Recupera il summary di una giornata specifica estratto dal cron notturno. ' +
    'Usare per query temporali esplicite: "cosa abbiamo fatto ieri", "lunedì scorso", ' +
    '"il 5 maggio". Ritorna il testo sintetico della giornata e le entità menzionate.',
  input_schema: {
    type: 'object',
    properties: {
      data: {
        type: 'string',
        description: 'Data richiesta. Formati accettati: ' +
          '"oggi", "ieri", "YYYY-MM-DD" (es "2026-05-06"), ' +
          '"lunedi-scorso", "martedi-scorso", "mercoledi-scorso", ' +
          '"giovedi-scorso", "venerdi-scorso". ' +
          'Per "il 5 maggio" → convertire in YYYY-MM-DD.',
      },
    },
    required: ['data'],
  },
}
```

### 4.4 `lista_entita`

```typescript
{
  name: 'lista_entita',
  description: 'Elenca le entità (clienti, cantieri, fornitori) conosciuti estratti dalle conversazioni. ' +
    'Usare quando l\'Ingegnere chiede "quali clienti abbiamo", "elenca i cantieri", ' +
    'o quando si ha bisogno di verificare se un\'entità è già nota al sistema.',
  input_schema: {
    type: 'object',
    properties: {
      tipo: {
        type: 'string',
        enum: ['cliente', 'cantiere', 'fornitore'],
        description: 'Filtra per tipo entità. Se omesso, ritorna tutti i tipi.',
      },
      limit: {
        type: 'number',
        description: 'Numero massimo entità ritornate, ordinate per last_seen_at DESC. Default 20.',
        default: 20,
      },
    },
    required: [],
  },
}
```

---

## 5. Cron `/api/cron/memoria-extract` — Flow Dettagliato

### Configurazione Vercel

In `vercel.json`, aggiungere:
```json
{ "path": "/api/cron/memoria-extract", "schedule": "30 21 * * *" }
```
Note: 21:30 UTC = 23:30 CEST (estate, UTC+2). In inverno (UTC+1) il cron gira alle 22:30 locale.
Drift di 1 ora in inverno è accettabile per questo use case.

### Flow step-by-step

```
GET /api/cron/memoria-extract
│
├─ [STEP 0] Auth: header Authorization === `Bearer ${CRON_SECRET}`
│   └─ 401 se mancante/errato
│
├─ [STEP 1] Silent mode check
│   ├─ READ cervellone_config WHERE key = 'memoria_silent_until'
│   └─ Se valore != null e future → return { ok: true, skipped: 'silent' }
│
├─ [STEP 2] Idempotency check
│   ├─ READ cervellone_config WHERE key = 'memoria_extract_last_run'
│   ├─ date_target = ieri (new Date() - 1 day, solo data YYYY-MM-DD)
│   └─ Se last_run === date_target → return { ok: true, skipped: 'already_ran' }
│
├─ [STEP 3] Fetch messages
│   └─ SELECT * FROM messages WHERE created_at::date = date_target ORDER BY conversation_id, created_at
│
├─ [STEP 4] Group by conversation_id
│   └─ Map<string, Message[]> — se 0 conversazioni → summary vuoto, vai a STEP 8
│
├─ [STEP 5] INSERT extraction run (status='started')
│   └─ run_id = UUID generato
│
├─ [STEP 6] Per ogni conversation group → call Anthropic Sonnet 4.6
│   ├─ Model: READ cervellone_config.memoria_extract_model (default 'claude-sonnet-4-6')
│   ├─ Prompt: vedi §5.1 (prompt conservativo)
│   ├─ Accumula response.usage.input_tokens + output_tokens
│   └─ Parse JSON output → { summary, entita[], eventi[] }
│
├─ [STEP 7] Aggrega risultati
│   ├─ Merge summary di tutte le conversazioni → summary_aggregato (1-3 frasi)
│   ├─ Deduplica entita per (name, type)
│   └─ Calcola llm_cost_estimate_usd = (total_tokens * 0.000003) circa Sonnet
│
├─ [STEP 8] INSERT cervellone_summary_giornaliero
│   └─ (data=date_target, summary_text, message_count, conversations_json, llm_tokens_used)
│   └─ ON CONFLICT (data) DO UPDATE — idempotent
│
├─ [STEP 9] UPSERT cervellone_entita_menzionate
│   └─ Per ogni entità: INSERT ... ON CONFLICT (name, type) DO UPDATE
│      SET last_seen_at=date_target, mention_count = mention_count+1,
│          contexts_json = (append nuovo context, keep last 5)
│
├─ [STEP 10] UPDATE run → status='ok', completed_at=NOW(), entities_count, conversations_count, llm_cost
│
├─ [STEP 11] UPDATE cervellone_config SET value=date_target WHERE key='memoria_extract_last_run'
│
└─ return { ok: true, date: date_target, conversations: N, entities: M, tokens: T }

Su qualsiasi errore non gestito:
└─ UPDATE runs SET status='error', error_message=err.message
   return { ok: false, error: err.message }, status 500
```

### 5.1 Prompt Extraction Conservativo (testo letterale da usare nel code)

```
Sei un estrattore di FATTI VERIFICABILI da conversazioni di un'agenzia tecnica.
Dalle conversazioni qui sotto, estrai SOLO:
1. Entità named (clienti, cantieri, fornitori menzionati per NOME esplicito)
2. Date e scadenze esplicite ("il 15 maggio", "DURC scade ad agosto", "lunedì 8")
3. Eventi fattuali oggettivi ("ho mandato preventivo", "sopralluogo eseguito", "ricevuto DURC")

NON estrarre:
- Decisioni morbide ("forse passiamo")
- Valutazioni ("Bianchi è cliente difficile")
- Inferenze emotive
- Opinioni o previsioni

Output JSON strutturato:
{
  "summary": "1-2 frasi di sintesi fattuale della giornata",
  "entita": [{"name": "...", "type": "cliente|cantiere|fornitore", "context": "..."}],
  "eventi": [{"data_iso": "YYYY-MM-DD?", "descrizione": "..."}]
}

Se la giornata è vuota o non contiene fatti rilevanti, output: {"summary": "Nessuna attività rilevante", "entita": [], "eventi": []}.
```

---

## 6. REGOLA TOOL MEMORIA — da inserire in `src/lib/prompts.ts`

Posizionare PRIMA della REGOLA AUTONOMIA SVILUPPO esistente:

```
REGOLA TOOL MEMORIA:
Quando l'Ingegnere ti chiede di ricordare qualcosa o richiamare qualcosa dal passato:
- Per SALVARE una decisione/contesto importante: usa il tool ricorda(testo, tag?)
- Per RICHIAMARE qualcosa: usa richiama_memoria(query) — cerca prima in memoria esplicita (decisioni dell'Ingegnere), poi in summary giornaliero, poi in RAG
- Per QUERY TEMPORALE ("cosa abbiamo fatto giovedì", "lunedì scorso") → usa riepilogo_giorno(data)
- Per LISTA CLIENTI/CANTIERI/FORNITORI conosciuti → usa lista_entita(tipo)
- NON inventare ricordi mai. Se richiama_memoria ritorna nulla, dichiaralo onestamente: "Non ho memoria esplicita di X — controllo nel summary."
```

---

## 7. Comandi Telegram

Da aggiungere in `src/app/api/telegram/route.ts` nel dispatcher comandi:

### `/ricorda <testo>`

```typescript
if (text.startsWith('/ricorda ')) {
  const testo = text.slice('/ricorda '.length).trim()
  if (!testo) {
    await sendTelegramMessage(chatId, '⛔ Uso: /ricorda <testo da memorizzare>')
    return
  }
  const { error } = await supabase.from('cervellone_memoria_esplicita').insert({
    contenuto: testo,
    source: 'telegram',
    conversation_id: conversationId ?? null,
  })
  if (error) {
    await sendTelegramMessage(chatId, `⛔ Errore salvataggio: ${error.message}`)
  } else {
    await sendTelegramMessage(chatId, '✅ Salvato in memoria esplicita.')
  }
  return
}
```

### `/dimentica <uuid>`

```typescript
if (text.startsWith('/dimentica ')) {
  const uuid = text.slice('/dimentica '.length).trim()
  // Validazione UUID basic (36 chars, 4 trattini)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(uuid)) {
    await sendTelegramMessage(chatId, '⛔ Formato UUID non valido. Usa /ricorda e poi /dimentica con UUID esatto.')
    return
  }
  const { data, error } = await supabase
    .from('cervellone_memoria_esplicita')
    .delete()
    .eq('id', uuid)
    .select('id')
  if (error) {
    await sendTelegramMessage(chatId, `⛔ Errore: ${error.message}`)
  } else if (!data || data.length === 0) {
    await sendTelegramMessage(chatId, '⛔ ID non trovato.')
  } else {
    await sendTelegramMessage(chatId, '✅ Riga rimossa.')
  }
  return
}
```

---

## 8. Costo Stimato

| Scenario | Messaggi/giorno | Chat | Token/run Sonnet | Costo/giorno |
|---|---|---|---|---|
| Baseline MVP | ~30 | ~5 | ~5.000 input + 500 output | ~$0.05 |
| Uso normale | ~80 | ~10 | ~12.000 input + 1.500 output | ~$0.08 |
| Peak | ~200 | ~20 | ~25.000 input + 3.000 output | ~$0.15 |

Prezzi Sonnet 4.6: $3/M input, $15/M output (stima, verificare pricing attuale).
Costo mensile stimato: $1.50–$4.50/mese. Trascurabile.

---

## 9. Setup Utente Richiesto

1. Aprire Supabase SQL editor → eseguire `supabase/migrations/2026-05-07-memoria-persistente.sql`
2. Verificare che `CRON_SECRET` sia settato in Vercel env (già presente per altri cron)
3. Dopo deploy: testare con `curl -H "Authorization: Bearer $CRON_SECRET" https://cervellone-5poc.vercel.app/api/cron/memoria-extract`

---

## 10. Test Plan Smoke (5 test)

| # | Test | Azione | Verifica |
|---|---|---|---|
| T1 | `/ricorda` Telegram | Inviare `/ricorda "Decisione X cliente Y"` su Telegram | Row INSERT in `cervellone_memoria_esplicita` con source='telegram', contenuto corretto |
| T2 | Richiamo esplicito | Domandare "ti ricordi della decisione X cliente Y?" | Cervellone chiama `richiama_memoria`, risposta cita testo salvato verbatim |
| T3 | Cron manuale | `curl -H "Authorization: Bearer $CRON_SECRET" /api/cron/memoria-extract` | Row in `cervellone_summary_giornaliero` + UPSERT in `cervellone_entita_menzionate` se ci sono messaggi da ieri |
| T4 | Query temporale | Domandare "che abbiamo fatto ieri?" | Cervellone chiama `riepilogo_giorno("ieri")`, risposta cita summary_text della data |
| T5 | Cross-canale | `/ricorda` da Telegram → richiama da webchat | Il record inserito da Telegram è visibile via `richiama_memoria` nella webchat (stesso DB, conversation_id linking secondario) |

---

## 11. Definition of Done (DoD)

- [ ] Migration `2026-05-07-memoria-persistente.sql` applicata su Supabase production senza errori
- [ ] 4 tabelle create e verificabili in Supabase dashboard
- [ ] 3 config keys inseriti in `cervellone_config`
- [ ] `src/lib/memoria-tools.ts` con tutti e 4 i tool implementati e unit test verdi
- [ ] `src/lib/memoria-extract.ts` orchestrator con test mock Anthropic che passa
- [ ] `src/app/api/cron/memoria-extract/route.ts` con auth + idempotency + full flow
- [ ] Cron `/api/cron/memoria-extract` aggiunto in `vercel.json`
- [ ] Comandi `/ricorda` e `/dimentica` in `telegram/route.ts` funzionanti
- [ ] 4 tool registrati in `src/lib/tools.ts`
- [ ] REGOLA TOOL MEMORIA inserita in `src/lib/prompts.ts` prima di REGOLA AUTONOMIA SVILUPPO
- [ ] Deploy Vercel READY verificato post-push (come da `feedback_pre_flight_verification.md`)
- [ ] T1–T5 smoke test eseguiti manualmente e tutti passati
- [ ] `memoria_extraction_runs` ha almeno 1 row con status='ok' dopo primo cron run

---

## 12. Rischi e Mitigazioni

| Rischio | Probabilità | Impatto | Mitigazione |
|---|---|---|---|
| Prompt LLM estrae troppo (valutazioni/inferenze) | Media | Alto — rumore in memoria | Prompt conservativo con lista NOT esplicita. Granularità da monitorare prime 2 settimane. |
| Cron gira su DB con 0 messaggi | Alta (weekend) | Basso | Guard: se 0 messaggi, INSERT summary con "Nessuna attività", non chiamare LLM |
| UUID dimentica tipografato errato | Bassa | Basso | Validazione regex UUID nel handler `/dimentica`, messaggio errore chiaro |
| Token context overflow su giornata molto verbosa | Bassa | Medio | Chunk per conversation_id: ogni chat processata separatamente, non in bulk |
| TTL summary non gestito → crescita DB | Certezza (lungo termine) | Basso (2 anni) | Debito tecnico esplicito in out-of-scope. Reminder in MEMORY.md dopo deploy |
| Drift fuso orario cron inverno (+1h) | Certezza | Trascurabile | Accettato. La giornata "ieri" è sempre completa anche alle 22:30 |
| `conversation_id` NULL in /ricorda Telegram | Alta | Basso | Campo nullable by design; richiamo funziona per contenuto testuale (L1 ILIKE) |

---

## 13. Out-of-scope Iterazioni Future

- **Cleanup cron summary TTL 2 anni**: cron mensile DELETE WHERE data < NOW() - INTERVAL '2 years'
- **`ricorda` smart auto-detection**: un layer LLM in `memoria-extract` che identifica decisioni "vere" (non solo fatti) e le inserisce automaticamente in `memoria_esplicita`
- **Retroactive run archivio storico**: esecuzione one-shot su tutti i messaggi pre-MVP in `messages`
- **UI gestione memoria in webchat**: lista/search/delete di `memoria_esplicita` dalla chat web
- **Export memoria in PDF**: report mensile delle decisioni registrate
