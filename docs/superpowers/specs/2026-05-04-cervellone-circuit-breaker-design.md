# Cervellone Circuit Breaker — design spec

**Data:** 4 maggio 2026
**Autori:** Code (con brainstorming Cowork)
**Stato:** approvato dal committente, pronto per writing-plans
**Stima:** 1-1.5 giornate di lavoro effettivo
**Contesto strategico:** Cervellone deve essere stabile per 3-4 anni, sostituire personale d'ufficio, evolversi automaticamente. Questa è la prima componente di Fase 1 (Resilienza).

## 1. Problema

Cervellone usa modelli Anthropic (oggi `claude-opus-4-7`). Quando Anthropic rilascia un nuovo modello (es. Opus 4.8), oggi richiede:
- Update manuale del codice (cambio stringa hardcoded)
- Comando `/opus` per aggiornare DB
- Eventualmente fix di regressioni introdotte dal nuovo modello (vedi Bug 5 di oggi: Opus 4.7 chiama tool_use in fan-out senza emettere text, comportamento diverso da Opus 4.6)

Questo workflow è insostenibile su 3-4 anni: ogni release Anthropic richiede una sessione di debugging come quella di oggi.

## 2. Obiettivo

Implementare un **circuit breaker** che:
1. Detecta automaticamente le regressioni quando un nuovo modello introduce comportamenti rotti
2. Rolla automaticamente al modello stabile precedente (definito manualmente dall'amministratore)
3. Riprova periodicamente il modello "latest" tramite canary requests
4. Riprenderlo automaticamente quando torna affidabile
5. Notifica l'amministratore su Telegram + webchat per ogni transizione
6. Permette promozione manuale di nuovi modelli a "default" tramite comando

## 3. Scelte architetturali (dal brainstorming)

| Decisione | Scelta | Razionale |
|---|---|---|
| Scope | B — completo con auto-recovery (no auto-PR) | Auto-PR (C) prematuro senza prima vedere B in azione |
| Failure signals | Z — empty + force_text + hallucination | Massima detection per scenario 4 anni |
| Recovery strategy | R — canary-based (canary prompt ogni 30 min) | Distingue regressione persistente da fluke, costo trascurabile |
| Fallback target | V — `model_stable` configurato manualmente dall'admin | Massimo controllo del rischio nelle mani dell'utente |
| Threshold rollback | γ — 3 fallimenti su 5 ultimi messaggi | Compromesso bilanciato per low-volume |
| Notifiche | Telegram + webchat per ogni transizione (rollback, recovery, promozione) | Visibilità totale, riusa `notifyModelChange()` esistente |
| Implementazione | 2 — Hybrid memory+DB | Hot path veloce, stato persistente per debugging futuro |

## 4. Schema dati

### 4.1 Nuova tabella `model_health`

```sql
CREATE TABLE model_health (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model TEXT NOT NULL,
  request_id TEXT,
  is_canary BOOLEAN NOT NULL DEFAULT FALSE,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'success',
    'empty',
    'force_text',
    'hallucination',
    'api_error',
    'timeout'
  )),
  full_len INTEGER,
  consecutive_no_text INTEGER,
  details TEXT
);

CREATE INDEX idx_model_health_model_ts ON model_health (model, ts DESC);
CREATE INDEX idx_model_health_is_canary_model ON model_health (is_canary, model, ts DESC);

ALTER TABLE model_health DISABLE ROW LEVEL SECURITY;
```

### 4.2 Nuove keys in `cervellone_config`

| key | esempio value | descrizione |
|---|---|---|
| `model_default` | `claude-opus-4-7` | Modello di default da usare in stato NORMAL (già esiste, semantica chiarita) |
| `model_stable` | `claude-opus-4-6` | Fallback target manuale, usato quando circuit breaker scatta |
| `model_active` | `claude-opus-4-7` | Modello attualmente in uso (cambia su rollback/recovery) |
| `circuit_state` | `{"state":"NORMAL","tripped_at":null,"reason":null,"canary_consecutive_ok":0}` | JSON con stato breaker |

Inserimento iniziale:
```sql
INSERT INTO cervellone_config (key, value) VALUES
  ('model_stable', '"claude-opus-4-6"'),
  ('model_active', '"claude-opus-4-7"'),
  ('circuit_state', '{"state":"NORMAL","tripped_at":null,"reason":null,"canary_consecutive_ok":0}')
ON CONFLICT (key) DO NOTHING;
```

## 5. State machine

```
                ┌─────────┐
                │ NORMAL  │ <─────────┐
                │ (latest)│           │
                └────┬────┘           │
                     │                │
        3 fail su 5  │                │ canary OK 3 volte consecutive
        (non-canary) │                │
                     ▼                │
              ┌─────────────┐         │
              │ ROLLED_BACK │ ────────┘
              │  (stable)   │
              └─────────────┘
                     │
                     │ canary fail
                     ▼
              (resta ROLLED_BACK,
               canary_consecutive_ok = 0)
```

**Promozione (transizione orizzontale):**
- In stato NORMAL, admin chiama tool `promuovi_modello(new_default)`
- `model_stable` = ex-`model_default`
- `model_default` = `new_default`
- `model_active` = `new_default`
- State resta NORMAL
- Notifica "🚀 Promosso X a default, Y ora è stable backup"

## 6. Componenti software

### 6.1 `src/lib/circuit-breaker.ts` (nuovo file)

API esposta:

```typescript
// Outcome di una request normale (chiamata da callClaudeStreamTelegram)
export type ModelOutcome =
  | 'success'
  | 'empty'
  | 'force_text'
  | 'hallucination'
  | 'api_error'
  | 'timeout'

export interface OutcomeDetails {
  fullLen?: number
  consecutiveNoText?: number
  details?: string
  isCanary?: boolean
  requestId?: string
}

// Registra l'outcome e (se non canary) verifica il threshold per rollback
export async function recordOutcome(
  model: string,
  outcome: ModelOutcome,
  details?: OutcomeDetails,
): Promise<void>

// Detecta hallucination basata su pattern di promesse senza tool_use
export function detectHallucination(text: string, toolCount: number): boolean

// Forza rollback al modello stabile
export async function tripBreaker(reason: string): Promise<void>

// Resetta lo stato a NORMAL e ritorna a model_default
export async function resetBreaker(): Promise<void>

// Restituisce il modello attualmente attivo (cached)
export async function getActiveModel(): Promise<string>

// Promozione manuale di un nuovo modello
export async function promoteModel(newDefault: string): Promise<{
  oldDefault: string
  oldStable: string
  newDefault: string
  newStable: string
}>
```

Logica interna:

- **`detectHallucination`**:
  ```typescript
  const PROMISE_PATTERNS = [
    /\b(lo|la)\s+(cerco|controllo|leggo|scarico|guardo|verifico|trovo|prendo)\b/i,
    /\b(ora|adesso|subito)\s+(cerco|controllo|leggo|scarico|guardo|verifico)\b/i,
    /\bfaccio\s+(subito|adesso|ora)\b/i,
    /\bvado\s+a\s+(leggere|scaricare|cercare|guardare|verificare)\b/i,
    /\b(cerco|leggo|verifico)\s+subito\b/i,
  ]
  ```
  Returns `true` se text matcha almeno un pattern AND toolCount === 0.

- **`recordOutcome`**:
  1. INSERT nella tabella `model_health` (fire-and-forget — `.catch(() => {})` per non bloccare la response)
  2. Se `outcome !== 'success'` AND `!isCanary`:
     - SELECT degli ultimi 5 outcome del modello (excluding canary), ordinati DESC
     - Se ≥3 sono fail → chiamare `tripBreaker(reason)`

- **`tripBreaker`**:
  1. Read `circuit_state` corrente, se già ROLLED_BACK skip (idempotente)
  2. Read `model_stable` da config
  3. UPDATE `cervellone_config` SET model_active = stable, circuit_state = ROLLED_BACK con `tripped_at = NOW()`, `reason`
  4. Invalidate cache config in claude.ts (chiama `invalidateConfigCache()`)
  5. Chiama `notifyModelChange("⚠️ Rollback a {stable}, rilevata regressione su {default}: {reason}")`

- **`resetBreaker`**:
  1. UPDATE config: model_active = model_default, circuit_state = NORMAL
  2. Invalidate cache
  3. Notifica "✅ {default} tornato stabile, riattivato come modello principale"

- **`getActiveModel`**:
  Riusa o estende il `getConfig()` esistente in `claude.ts` per leggere `model_active` invece di `model_default`. TTL cache 60s.

- **`promoteModel(newDefault)`**:
  1. Validate newDefault (non vuoto, non uguale al corrente)
  2. UPDATE config: model_stable = old default, model_default = newDefault, model_active = newDefault, circuit_state = NORMAL
  3. Invalidate cache
  4. Notifica "🚀 Promosso {newDefault} a default. {oldDefault} ora è stable di backup."

### 6.2 `src/app/api/cron/canary/route.ts` (nuovo)

Vercel cron route. Schedule in `vercel.json`:
```json
{
  "crons": [
    { "path": "/api/cron/canary", "schedule": "*/30 * * * *" }
  ]
}
```

GET handler logic:
1. Verifica autenticazione (Vercel cron header `x-vercel-cron-signature` o secret in env)
2. Read `circuit_state`
3. Se `state !== 'ROLLED_BACK'`: skip, return 200 con `{skipped: true, reason: 'not in rollback'}`
4. Read `model_default`
5. Chiama Anthropic SDK con un prompt canary minimale:
   ```
   system: "Rispondi solo con la parola OK e nient'altro."
   user: "Ping"
   ```
   Con timeout 30s, max_tokens 10, no tools.
6. Determina outcome:
   - Risposta contiene "OK" o "ok" → success
   - Risposta vuota → empty
   - Errore API → api_error
   - Timeout → timeout
7. Chiama `recordOutcome(model_default, outcome, { isCanary: true })`
8. Se success:
   - Read circuit_state, increment `canary_consecutive_ok`
   - Se >= 3: chiama `resetBreaker()`
9. Se fail:
   - UPDATE circuit_state, set `canary_consecutive_ok = 0`
10. Return 200 con stato

### 6.3 `src/lib/tools.ts` — aggiunta tool admin

Tool `promuovi_modello`:
```typescript
{
  name: 'promuovi_modello',
  description: 'Promuove un nuovo modello Claude a default (model_default). L\'attuale default diventa stable di backup. SOLO admin. Usa quando Anthropic rilascia una nuova versione e l\'hai testata.',
  input_schema: {
    type: 'object',
    properties: {
      new_default: { type: 'string', description: 'Identificatore modello, es. "claude-opus-4-8"' },
    },
    required: ['new_default'],
  },
}
```

Implementazione: chiama `promoteModel(input.new_default)` da `circuit-breaker.ts`.

### 6.4 `src/lib/claude.ts` — hook outcome

In fondo a `callClaudeStreamTelegram`, dopo `await onChunk(fullResponse)`:

```typescript
// Determina outcome basato su signals
let outcome: ModelOutcome = 'success'
const details: OutcomeDetails = {
  fullLen: fullResponse.length,
  consecutiveNoText,
  requestId: conversationId,
}

if (fullResponse === FALLBACK_MESSAGE) {
  outcome = 'empty'
  details.details = 'Fallback message fired (fullResponse vuoto dopo loop)'
} else if (consecutiveNoText >= NO_TEXT_LIMIT) {
  outcome = 'force_text'
  details.details = `Force-text triggered after ${consecutiveNoText} no-text iters`
} else if (detectHallucination(fullResponse, totalToolCalls)) {
  outcome = 'hallucination'
  details.details = `Promise pattern in text without tool_use`
}

// Fire-and-forget per non bloccare
recordOutcome(modelConfig.model, outcome, details).catch(err => {
  console.error('recordOutcome failed:', err)
})
```

Nota: serve tracciare `totalToolCalls` (somma dei `toolBlocks.length` di tutte le iter).

### 6.5 `vercel.json` — schedule cron

```json
{
  "crons": [
    { "path": "/api/cron/canary", "schedule": "*/30 * * * *" }
  ]
}
```

## 7. Migration di rilascio

Prima del deploy, eseguire su Supabase SQL editor:

```sql
-- 1. Tabella model_health
CREATE TABLE IF NOT EXISTS model_health (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model TEXT NOT NULL,
  request_id TEXT,
  is_canary BOOLEAN NOT NULL DEFAULT FALSE,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','empty','force_text','hallucination','api_error','timeout')),
  full_len INTEGER,
  consecutive_no_text INTEGER,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_health_model_ts
  ON model_health (model, ts DESC);

CREATE INDEX IF NOT EXISTS idx_model_health_canary
  ON model_health (is_canary, model, ts DESC);

ALTER TABLE model_health DISABLE ROW LEVEL SECURITY;

-- 2. Init circuit breaker config
INSERT INTO cervellone_config (key, value) VALUES
  ('model_stable', '"claude-opus-4-6"'),
  ('model_active', '"claude-opus-4-7"'),
  ('circuit_state', '{"state":"NORMAL","tripped_at":null,"reason":null,"canary_consecutive_ok":0}')
ON CONFLICT (key) DO NOTHING;
```

File: `supabase/migrations/2026-05-04-circuit-breaker.sql`

## 8. Testing

### 8.1 Unit (vitest)

`tests/circuit-breaker.test.ts`:

- **`detectHallucination`**:
  - "Ora cerco il file" + 0 tool → true
  - "Ora cerco il file" + 1 tool → false (tool è stato chiamato, non hallucinato)
  - "Ho letto il file" + 0 tool → false (no promise pattern)
  - "Le rispondo a momenti" + 0 tool → false (no specific promise)
  - 10 esempi con promise+no-tool=true
  - 10 esempi normali=false

- **Threshold logic** (mock Supabase):
  - Mock model_health con 0 fail su 5 → no trip
  - Mock con 2 fail su 5 → no trip
  - Mock con 3 fail su 5 → trip
  - Mock con 5 fail su 5 → trip
  - Mock con 3 fail su 4 (sample size insufficiente) → no trip (richiede 5 sample)

### 8.2 Integration (manuale post-deploy)

- Inserire artificialmente 5 record con outcome=force_text in model_health, verificare che la prossima request scatti rollback
- Verificare che canary cron parta dopo 30 min e ritenti
- Test promozione manuale via tool

### 8.3 Manuale prod

- Deploy → osservare log Vercel per "[CB] state=NORMAL" su ogni request
- Quando arriverà nuovo Opus, verificare auto-rollback se ha regressioni

## 9. Costi e impatti

- **API Anthropic canary**: solo in stato ROLLED_BACK. Ogni 30 min, 1 prompt minimale (10 token output) ≈ €0.0005/canary. Se rolled back per 24h: ~48 canary ≈ €0.024. Trascurabile.
- **Supabase storage**: ~10KB/mese di model_health a uso medio. Trascurabile.
- **Latenza request**: +10-30ms per fire-forget INSERT. Invisibile su conversazione.

## 10. Rischi e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Canary cron fallisce silenziosamente, bot resta rolled back per sempre | Log esplicito `[CRON canary]` ogni esecuzione, alert se nessuna esecuzione in 1h |
| `recordOutcome` fallisce (Supabase down), threshold non si attiva | Fire-and-forget non blocca request. Su Supabase up, threshold check riprende |
| False positive hallucination (regex troppo aggressiva) | Threshold richiede 3/5, 1 falso positivo non scatta rollback |
| Promozione errata (bot promosso a `claude-opus-7-9` inesistente) | Validation in `promoteModel`: tentare 1 chiamata di test prima di committare promotion |
| Loop di rollback (stable rotto, latest rotto) | Detect: se 5 fail consecutive ANCHE su stable → notifica "💀 Tutti i modelli falliscono, intervento manuale" e congelare state |

## 11. Out of scope (esplicito)

- Auto-PR via `github_propose_fix` quando rollback ricorrente: rimandato a versione C (1.5gg extra). Implementabile come Fase 1.5 dopo aver visto B in azione.
- Multi-provider fallback (Gemini, OpenAI): è il punto 2 di Fase 1, brainstorm separato.
- Health dashboard web per visualizzare metriche: out of scope, ma `model_health` è interrogabile via Supabase per debugging.
- A/B testing tra modelli: out of scope, possibile estensione futura.

## 12. Setup utente richiesto post-deploy

1. Eseguire migration su Supabase SQL editor (paste del blocco al §7)
2. Aggiornare `vercel.json` se non già rilasciato col deploy
3. Verificare che il cron sia attivo: dashboard Vercel → Cron Jobs
4. Opzionale: eseguire una request canary manuale via tool admin per testare il flow

## 13. Definition of Done

- [ ] Migration applicata e verificata in Supabase
- [ ] File `src/lib/circuit-breaker.ts` creato con tutte le funzioni
- [ ] Hook `recordOutcome` integrato in `callClaudeStreamTelegram`
- [ ] Cron route `/api/cron/canary` deployato e schedulato
- [ ] Tool `promuovi_modello` registrato in `tools.ts`
- [ ] Unit test passanti (≥10 casi per detectHallucination, threshold logic)
- [ ] Test manuale: induco 3 fail con outcome=force_text, verifico rollback + notifica
- [ ] Test manuale: cron canary parte ogni 30 min in stato ROLLED_BACK
- [ ] Test manuale: promozione tool funziona end-to-end
- [ ] Notifiche Telegram + webchat verificate sui 3 eventi (rollback, recovery, promozione)
- [ ] Documento README aggiornato con sezione "Circuit Breaker Operations"
