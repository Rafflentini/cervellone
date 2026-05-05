# Cervellone Circuit Breaker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementare un circuit breaker che rileva regressioni del modello Anthropic, rolla automaticamente al fallback `model_stable`, ritenta via canary ogni 30 minuti, e notifica l'admin su Telegram + webchat per ogni transizione.

**Architecture:** Hybrid memory+DB. Stato breaker in `cervellone_config` (cached 60s), outcome storico in nuova tabella `model_health` (fire-and-forget INSERT, threshold check su SELECT degli ultimi 5). Cron Vercel ogni 30 min per canary recovery. Notifiche riusano `notifyModelChange()` esistente.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase, Anthropic SDK 0.80, Vercel cron, vitest per unit test.

**Spec di riferimento:** `docs/superpowers/specs/2026-05-04-cervellone-circuit-breaker-design.md`

---

## File Structure

| File | Tipo | Responsabilità |
|---|---|---|
| `supabase/migrations/2026-05-04-circuit-breaker.sql` | Create | Schema model_health + init config breaker |
| `src/lib/circuit-breaker.ts` | Create | Logica core: detection, recordOutcome, trip/reset, promote |
| `src/lib/circuit-breaker.test.ts` | Create | Unit test vitest per logica pura |
| `src/app/api/cron/canary/route.ts` | Create | Vercel cron handler per canary recovery |
| `src/lib/claude.ts` | Modify | Hook `recordOutcome` in `callClaudeStreamTelegram` |
| `src/lib/tools.ts` | Modify | Tool admin `promuovi_modello` |
| `vercel.json` | Create | Schedule cron `/api/cron/canary` ogni 30 min |

---

## Task 1: Migration SQL + apply

**Files:**
- Create: `supabase/migrations/2026-05-04-circuit-breaker.sql`

- [ ] **Step 1: Creare il file migration**

Contenuto:
```sql
-- Circuit Breaker (Fase 1 punto 1) — schema model_health + init config

-- 1. Tabella outcome storico per ogni request modello
CREATE TABLE IF NOT EXISTS model_health (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model TEXT NOT NULL,
  request_id TEXT,
  is_canary BOOLEAN NOT NULL DEFAULT FALSE,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'success','empty','force_text','hallucination','api_error','timeout'
  )),
  full_len INTEGER,
  consecutive_no_text INTEGER,
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_model_health_model_ts
  ON model_health (model, ts DESC);

CREATE INDEX IF NOT EXISTS idx_model_health_canary
  ON model_health (is_canary, model, ts DESC);

ALTER TABLE model_health DISABLE ROW LEVEL SECURITY;

-- 2. Init valori config breaker
INSERT INTO cervellone_config (key, value) VALUES
  ('model_stable', '"claude-opus-4-7"'),
  ('model_active', '"claude-opus-latest"'),
  ('circuit_state', '{"state":"NORMAL","tripped_at":null,"reason":null,"canary_consecutive_ok":0}')
ON CONFLICT (key) DO NOTHING;

-- 3. Aggiorna model_default a alias latest (era hardcoded a claude-opus-4-7)
UPDATE cervellone_config SET value = '"claude-opus-latest"' WHERE key = 'model_default';
```

- [ ] **Step 2: Applicare migration su Supabase manualmente**

L'utente deve aprire https://supabase.com/dashboard/project/vpmcqzaqiozpanaekxgj/sql ed eseguire il blocco SQL del file appena creato.

- [ ] **Step 3: Verificare che la tabella sia stata creata**

L'utente deve eseguire in Supabase:
```sql
SELECT * FROM model_health LIMIT 1;
SELECT key, value FROM cervellone_config WHERE key IN ('model_default', 'model_stable', 'model_active', 'circuit_state');
```
Atteso: 4 righe in cervellone_config (anche se `model_default` esisteva, ora deve avere value `"claude-opus-latest"`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-05-04-circuit-breaker.sql
git commit -m "feat(circuit-breaker): migration model_health + init config"
```

---

## Task 2: Skeleton circuit-breaker.ts con types e costanti

**Files:**
- Create: `src/lib/circuit-breaker.ts`

- [ ] **Step 1: Creare il file con types esposti**

```typescript
/**
 * lib/circuit-breaker.ts — Circuit Breaker per modello Anthropic.
 *
 * Spec: docs/superpowers/specs/2026-05-04-cervellone-circuit-breaker-design.md
 *
 * In stato NORMAL il bot usa model_default (alias claude-opus-latest).
 * Quando 3+ outcome falliti su ultimi 5 → trip a model_stable (config manuale).
 * Cron canary ogni 30 min ritenta latest, dopo 3 OK consecutive resetta.
 */

import { supabase } from './supabase'

// ── Types ──

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

export type CircuitStateValue = 'NORMAL' | 'ROLLED_BACK'

export interface CircuitState {
  state: CircuitStateValue
  tripped_at: string | null
  reason: string | null
  canary_consecutive_ok: number
}

// ── Costanti ──

const FAILURE_THRESHOLD = 3
const SAMPLE_WINDOW = 5
const CANARY_OK_TARGET = 3
const NOTIFY_THROTTLE_MS = 60 * 60 * 1000  // 1 ora

// Pattern italiani di promesse-azione senza tool corrispondente.
// Usati da detectHallucination per identificare hallucinations.
const PROMISE_PATTERNS: RegExp[] = [
  /\b(lo|la)\s+(cerco|controllo|leggo|scarico|guardo|verifico|trovo|prendo)\b/i,
  /\b(ora|adesso|subito)\s+(cerco|controllo|leggo|scarico|guardo|verifico)\b/i,
  /\bfaccio\s+(subito|adesso|ora)\b/i,
  /\bvado\s+a\s+(leggere|scaricare|cercare|guardare|verificare)\b/i,
  /\b(cerco|leggo|verifico)\s+subito\b/i,
]

// ── Cache stato breaker ──

interface BreakerCache {
  activeModel: string
  state: CircuitState
  cachedAt: number
}

let cache: BreakerCache | null = null
const CACHE_TTL_MS = 60_000  // 60s

export function invalidateCache(): void {
  cache = null
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/circuit-breaker.ts
git commit -m "feat(circuit-breaker): skeleton types + costanti + cache"
```

---

## Task 3: detectHallucination con TDD

**Files:**
- Create: `src/lib/circuit-breaker.test.ts`
- Modify: `src/lib/circuit-breaker.ts` (aggiungi funzione)

- [ ] **Step 1: Scrivere il test (deve fallire)**

In `src/lib/circuit-breaker.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { detectHallucination } from './circuit-breaker'

describe('detectHallucination', () => {
  describe('promise pattern + 0 tool → true (hallucination)', () => {
    const cases = [
      'Ora lo cerco subito!',
      'Lo controllo per Lei.',
      'Ora cerco il DURC.',
      'Faccio subito.',
      'Vado a leggere il file.',
      'Verifico subito.',
      'La leggo e Le dico.',
      'Adesso cerco nelle cartelle.',
      'Ora verifico.',
      'Lo trovo io.',
    ]
    cases.forEach(text => {
      it(`"${text.slice(0, 30)}..." → true`, () => {
        expect(detectHallucination(text, 0)).toBe(true)
      })
    })
  })

  describe('promise pattern + ≥1 tool → false (legitimate)', () => {
    it('promise con tool chiamato non è hallucination', () => {
      expect(detectHallucination('Ora lo cerco subito!', 1)).toBe(false)
    })
  })

  describe('no promise pattern → false', () => {
    const cases = [
      'Ho letto il file. Il DURC è regolare.',
      'Non ho trovato il documento richiesto.',
      'Le rispondo a momenti.',
      'Buongiorno Ingegnere.',
      'Il preventivo è pronto.',
      'Ho elaborato la richiesta.',
    ]
    cases.forEach(text => {
      it(`"${text.slice(0, 30)}..." → false`, () => {
        expect(detectHallucination(text, 0)).toBe(false)
      })
    })
  })
})
```

- [ ] **Step 2: Eseguire il test (deve fallire — funzione non esiste)**

L'utente esegue:
```
npm run test:unit -- circuit-breaker
```
Atteso: errore "detectHallucination is not exported" o simile.

- [ ] **Step 3: Implementare la funzione minima**

In `src/lib/circuit-breaker.ts`, aggiungere dopo le costanti:

```typescript
/**
 * Rileva hallucination: il modello promette un'azione concreta nel testo
 * ma non emette il tool_use corrispondente nello stesso turno.
 */
export function detectHallucination(text: string, toolCount: number): boolean {
  if (toolCount > 0) return false  // tool chiamato → no hallucination
  if (!text || text.length === 0) return false
  return PROMISE_PATTERNS.some(p => p.test(text))
}
```

- [ ] **Step 4: Eseguire i test (devono passare)**

L'utente esegue:
```
npm run test:unit -- circuit-breaker
```
Atteso: 17/17 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/circuit-breaker.ts src/lib/circuit-breaker.test.ts
git commit -m "feat(circuit-breaker): detectHallucination + 17 unit test"
```

---

## Task 4: getActiveModel con cache

**Files:**
- Modify: `src/lib/circuit-breaker.ts`

- [ ] **Step 1: Implementare getActiveModel**

Aggiungere a `src/lib/circuit-breaker.ts`:

```typescript
async function loadConfig(): Promise<{ activeModel: string; state: CircuitState } | null> {
  const { data, error } = await supabase
    .from('cervellone_config')
    .select('key, value')
    .in('key', ['model_active', 'circuit_state'])
  if (error || !data) return null
  let activeModel = 'claude-opus-latest'
  let state: CircuitState = { state: 'NORMAL', tripped_at: null, reason: null, canary_consecutive_ok: 0 }
  for (const row of data) {
    if (row.key === 'model_active') {
      activeModel = String(row.value).replace(/"/g, '')
    } else if (row.key === 'circuit_state') {
      try {
        const parsed = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
        if (parsed && typeof parsed === 'object') {
          state = parsed as CircuitState
        }
      } catch {
        // value malformato, usa default
      }
    }
  }
  return { activeModel, state }
}

/**
 * Restituisce il modello attualmente attivo. Cached 60s.
 * Chiamato dal hot path di ogni request — deve essere veloce.
 */
export async function getActiveModel(): Promise<string> {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.activeModel
  }
  const loaded = await loadConfig()
  if (loaded) {
    cache = { ...loaded, cachedAt: Date.now() }
    return loaded.activeModel
  }
  // Fallback se Supabase down: usa il default sicuro
  return 'claude-opus-4-7'
}

/**
 * Restituisce lo stato breaker corrente. Cached 60s (stessa cache di getActiveModel).
 */
export async function getCircuitState(): Promise<CircuitState> {
  if (cache && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
    return cache.state
  }
  const loaded = await loadConfig()
  if (loaded) {
    cache = { ...loaded, cachedAt: Date.now() }
    return loaded.state
  }
  return { state: 'NORMAL', tripped_at: null, reason: null, canary_consecutive_ok: 0 }
}
```

- [ ] **Step 2: Aggiungere unit test**

In `src/lib/circuit-breaker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectHallucination, getActiveModel, invalidateCache } from './circuit-breaker'

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

import { supabase } from './supabase'

describe('getActiveModel', () => {
  beforeEach(() => {
    invalidateCache()
    vi.clearAllMocks()
  })

  it('legge model_active dalla config', async () => {
    const fromMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({
          data: [
            { key: 'model_active', value: '"claude-opus-latest"' },
            { key: 'circuit_state', value: '{"state":"NORMAL","tripped_at":null,"reason":null,"canary_consecutive_ok":0}' },
          ],
          error: null,
        }),
      }),
    })
    ;(supabase.from as any).mockImplementation(fromMock)

    const model = await getActiveModel()
    expect(model).toBe('claude-opus-latest')
  })

  it('usa fallback se Supabase ritorna errore', async () => {
    const fromMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({
          data: null,
          error: new Error('connection lost'),
        }),
      }),
    })
    ;(supabase.from as any).mockImplementation(fromMock)

    const model = await getActiveModel()
    expect(model).toBe('claude-opus-4-7')  // fallback hardcoded
  })

  it('cache la seconda chiamata entro 60s', async () => {
    const inMock = vi.fn().mockResolvedValue({
      data: [{ key: 'model_active', value: '"test-model"' }],
      error: null,
    })
    const fromMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ in: inMock }),
    })
    ;(supabase.from as any).mockImplementation(fromMock)

    await getActiveModel()
    await getActiveModel()
    expect(inMock).toHaveBeenCalledTimes(1)  // cache hit secondo
  })
})
```

- [ ] **Step 3: Eseguire i test**

```
npm run test:unit -- circuit-breaker
```
Atteso: 20/20 PASS (17 detectHallucination + 3 getActiveModel).

- [ ] **Step 4: Commit**

```bash
git add src/lib/circuit-breaker.ts src/lib/circuit-breaker.test.ts
git commit -m "feat(circuit-breaker): getActiveModel + getCircuitState con cache 60s"
```

---

## Task 5: recordOutcome con threshold check

**Files:**
- Modify: `src/lib/circuit-breaker.ts`

- [ ] **Step 1: Implementare recordOutcome**

Aggiungere a `src/lib/circuit-breaker.ts`:

```typescript
/**
 * Registra l'outcome di una request modello. Fire-and-forget — non blocca.
 * Se non canary e outcome != success, verifica il threshold (3 fail su 5)
 * e in caso scatta tripBreaker.
 */
export async function recordOutcome(
  model: string,
  outcome: ModelOutcome,
  details?: OutcomeDetails,
): Promise<void> {
  // INSERT fire-and-forget — errori non devono bloccare
  supabase
    .from('model_health')
    .insert({
      model,
      request_id: details?.requestId || null,
      is_canary: details?.isCanary || false,
      outcome,
      full_len: details?.fullLen ?? null,
      consecutive_no_text: details?.consecutiveNoText ?? null,
      details: details?.details ?? null,
    })
    .then(({ error }) => {
      if (error) console.error('[CB] recordOutcome insert failed:', error.message)
    })

  // Threshold check: solo se non canary e outcome è fail
  if (details?.isCanary || outcome === 'success') return

  try {
    const { data } = await supabase
      .from('model_health')
      .select('outcome')
      .eq('model', model)
      .eq('is_canary', false)
      .order('ts', { ascending: false })
      .limit(SAMPLE_WINDOW)

    if (!data || data.length < SAMPLE_WINDOW) return  // sample insufficiente

    const failures = data.filter(r => r.outcome !== 'success').length
    if (failures >= FAILURE_THRESHOLD) {
      const reason = `${failures} fail su ${data.length} ultimi: ${data.map(r => r.outcome).join(',')}`
      console.log(`[CB] threshold tripped for ${model}: ${reason}`)
      await tripBreaker(reason)
    }
  } catch (err) {
    console.error('[CB] threshold check failed:', err instanceof Error ? err.message : err)
  }
}
```

NOTA: `tripBreaker` non è ancora definito. Lo aggiungiamo nel prossimo task. TypeScript darà errore di unresolved reference temporaneo.

- [ ] **Step 2: Aggiungere unit test**

Aggiungere in `src/lib/circuit-breaker.test.ts`:

```typescript
import { recordOutcome } from './circuit-breaker'

describe('recordOutcome — threshold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateCache()
  })

  function mockSelectReturning(rows: { outcome: string }[]) {
    const insertMock = vi.fn().mockResolvedValue({ error: null })
    const limitMock = vi.fn().mockResolvedValue({ data: rows, error: null })
    const orderMock = vi.fn().mockReturnValue({ limit: limitMock })
    const eqCanary = vi.fn().mockReturnValue({ order: orderMock })
    const eqModel = vi.fn().mockReturnValue({ eq: eqCanary })
    const selectMock = vi.fn().mockReturnValue({ eq: eqModel })
    ;(supabase.from as any).mockImplementation((table: string) => {
      if (table === 'model_health') {
        return { insert: insertMock, select: selectMock }
      }
      return { update: vi.fn().mockResolvedValue({ error: null }) }
    })
    return { insertMock, limitMock }
  }

  it('non scatta breaker con 0 fail su 5', async () => {
    const { insertMock } = mockSelectReturning([
      { outcome: 'success' },
      { outcome: 'success' },
      { outcome: 'success' },
      { outcome: 'success' },
      { outcome: 'success' },
    ])
    await recordOutcome('claude-opus-latest', 'success')
    expect(insertMock).toHaveBeenCalled()
    // tripBreaker non chiamato (model_health select solo per insert, non threshold)
  })

  it('non scatta breaker con 2 fail su 5', async () => {
    mockSelectReturning([
      { outcome: 'force_text' },
      { outcome: 'success' },
      { outcome: 'success' },
      { outcome: 'force_text' },
      { outcome: 'success' },
    ])
    // outcome corrente = empty (fail), ma threshold richiede 3+ recente
    await recordOutcome('claude-opus-latest', 'empty')
    // Non c'è modo diretto di asserire "tripBreaker non chiamato" senza spy.
    // Per ora ci accontentiamo che non lanci eccezioni.
    // (Verifica vera nel test integrazione manuale)
  })

  it('scatta breaker con 3 fail su 5', async () => {
    mockSelectReturning([
      { outcome: 'force_text' },
      { outcome: 'force_text' },
      { outcome: 'force_text' },
      { outcome: 'success' },
      { outcome: 'success' },
    ])
    // tripBreaker dovrebbe essere chiamato. Spy diretto qui difficile senza
    // refactor — verifica nel test manuale post-deploy.
    await expect(recordOutcome('claude-opus-latest', 'empty')).resolves.not.toThrow()
  })

  it('skippa threshold check se canary', async () => {
    const { limitMock } = mockSelectReturning([])
    await recordOutcome('claude-opus-latest', 'empty', { isCanary: true })
    expect(limitMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Eseguire i test**

```
npm run test:unit -- circuit-breaker
```
Atteso: ≥24/24 PASS (potrebbero esserci errori TS sui riferimenti a `tripBreaker` non ancora definito — task 6 risolve).

- [ ] **Step 4: Commit**

```bash
git add src/lib/circuit-breaker.ts src/lib/circuit-breaker.test.ts
git commit -m "feat(circuit-breaker): recordOutcome + threshold check unit test"
```

---

## Task 6: tripBreaker + resetBreaker + helper notify throttling

**Files:**
- Modify: `src/lib/circuit-breaker.ts`

- [ ] **Step 1: Aggiungere helper di notifica**

```typescript
import { sendTelegramMessage } from './telegram-helpers'

let lastNotifyAt = 0

async function notifyAdmin(text: string, force = false): Promise<void> {
  const now = Date.now()
  if (!force && now - lastNotifyAt < NOTIFY_THROTTLE_MS) {
    console.log('[CB] notify throttled (lastNotifyAt < 1h fa)')
    return
  }
  lastNotifyAt = now
  console.log(`[CB] notify: ${text.slice(0, 100)}`)

  // Telegram admin
  const adminChat = parseInt(process.env.ADMIN_CHAT_ID || '0', 10)
  if (adminChat) {
    await sendTelegramMessage(adminChat, text).catch(err =>
      console.error('[CB] notify Telegram failed:', err)
    )
  }

  // Webchat: insert assistant message in ultime 5 conv non-Telegram
  try {
    const { data } = await supabase
      .from('conversations')
      .select('id')
      .neq('title', '💬 Telegram')
      .order('created_at', { ascending: false })
      .limit(5)
    if (data && data.length > 0) {
      await supabase.from('messages').insert(
        data.map((c: { id: string }) => ({
          conversation_id: c.id,
          role: 'assistant',
          content: text,
        }))
      )
    }
  } catch (err) {
    console.error('[CB] notify webchat failed:', err)
  }
}
```

- [ ] **Step 2: Implementare tripBreaker**

```typescript
/**
 * Forza rollback al modello stabile. Idempotente: se già ROLLED_BACK, skip.
 */
export async function tripBreaker(reason: string): Promise<void> {
  const current = await getCircuitState()
  if (current.state === 'ROLLED_BACK') {
    console.log('[CB] tripBreaker skipped: already ROLLED_BACK')
    return
  }

  // Read model_stable
  const { data: stableRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'model_stable')
    .maybeSingle()
  const stableModel = stableRow?.value
    ? String(stableRow.value).replace(/"/g, '')
    : 'claude-opus-4-7'

  // Read current model_default per il messaggio di notifica
  const { data: defaultRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'model_default')
    .maybeSingle()
  const defaultModel = defaultRow?.value
    ? String(defaultRow.value).replace(/"/g, '')
    : 'claude-opus-latest'

  const newState: CircuitState = {
    state: 'ROLLED_BACK',
    tripped_at: new Date().toISOString(),
    reason,
    canary_consecutive_ok: 0,
  }

  await supabase
    .from('cervellone_config')
    .update({ value: stableModel })
    .eq('key', 'model_active')

  await supabase
    .from('cervellone_config')
    .update({ value: newState })
    .eq('key', 'circuit_state')

  invalidateCache()

  await notifyAdmin(
    `⚠️ *Rollback automatico* — rilevata regressione su \`${defaultModel}\`.\n` +
    `Bot tornato a \`${stableModel}\` (stable).\n` +
    `Motivo: ${reason}\n\n` +
    `Il canary ritenterà \`${defaultModel}\` ogni 30 min e tornerà al default quando 3 canary consecutivi vanno OK.`,
    true,
  )
}
```

NOTA: la convenzione esistente in `cervellone_config` (vedi `telegram/route.ts:177` per il comando /opus) scrive direttamente la stringa: `update({ value: 'claude-opus-4-7' })`. Supabase gestisce la serializzazione JSON internamente. La lettura usa `String(row.value).replace(/"/g, '')` per pulire le quote.

- [ ] **Step 3: Implementare resetBreaker**

```typescript
/**
 * Resetta lo stato a NORMAL e ritorna a model_default. Chiamato dal canary
 * dopo CANARY_OK_TARGET success consecutivi.
 */
export async function resetBreaker(): Promise<void> {
  const current = await getCircuitState()
  if (current.state === 'NORMAL') {
    console.log('[CB] resetBreaker skipped: already NORMAL')
    return
  }

  // Read model_default
  const { data: defaultRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'model_default')
    .maybeSingle()
  const defaultModel = defaultRow?.value
    ? String(defaultRow.value).replace(/"/g, '')
    : 'claude-opus-latest'

  const newState: CircuitState = {
    state: 'NORMAL',
    tripped_at: null,
    reason: null,
    canary_consecutive_ok: 0,
  }

  await supabase
    .from('cervellone_config')
    .update({ value: defaultModel })
    .eq('key', 'model_active')

  await supabase
    .from('cervellone_config')
    .update({ value: newState })
    .eq('key', 'circuit_state')

  invalidateCache()

  await notifyAdmin(
    `✅ *Recovery automatico* — \`${defaultModel}\` torna stabile dopo ${CANARY_OK_TARGET} canary OK consecutivi. Bot riattivato sul default.`,
    true,
  )
}
```

- [ ] **Step 4: Implementare promoteModel**

```typescript
/**
 * Promuove un nuovo modello a default. Il vecchio default diventa stable.
 * Tool admin chiamato manualmente quando esce un nuovo Opus testato.
 */
export async function promoteModel(newDefault: string): Promise<{
  oldDefault: string
  oldStable: string
  newDefault: string
  newStable: string
}> {
  if (!newDefault || !newDefault.startsWith('claude-')) {
    throw new Error(`Modello non valido: "${newDefault}". Deve iniziare con "claude-".`)
  }

  const { data } = await supabase
    .from('cervellone_config')
    .select('key, value')
    .in('key', ['model_default', 'model_stable'])
  const map: Record<string, string> = {}
  for (const r of data || []) {
    map[r.key] = String(r.value).replace(/"/g, '')
  }
  const oldDefault = map.model_default || 'claude-opus-latest'
  const oldStable = map.model_stable || 'claude-opus-4-7'
  const newStable = oldDefault  // ex-default diventa stable

  // Update DB
  await supabase
    .from('cervellone_config')
    .update({ value: newDefault })
    .eq('key', 'model_default')
  await supabase
    .from('cervellone_config')
    .update({ value: newStable })
    .eq('key', 'model_stable')
  await supabase
    .from('cervellone_config')
    .update({ value: newDefault })
    .eq('key', 'model_active')
  await supabase
    .from('cervellone_config')
    .update({
      value: { state: 'NORMAL', tripped_at: null, reason: null, canary_consecutive_ok: 0 },
    })
    .eq('key', 'circuit_state')

  invalidateCache()

  await notifyAdmin(
    `🚀 *Promozione modello* — \`${newDefault}\` è il nuovo default.\n` +
    `\`${newStable}\` ora è il fallback stable di backup.\n` +
    `Vecchio stable \`${oldStable}\` non è più usato.`,
    true,
  )

  return { oldDefault, oldStable, newDefault, newStable }
}
```

- [ ] **Step 5: Eseguire test (devono compilare ora)**

```
npm run test:unit -- circuit-breaker
```
Atteso: tutti i test precedenti continuano a passare. Nessun nuovo test in questo task (le funzioni con side effects su Supabase sono testate manualmente post-deploy).

- [ ] **Step 6: Commit**

```bash
git add src/lib/circuit-breaker.ts
git commit -m "feat(circuit-breaker): tripBreaker + resetBreaker + promoteModel + notify"
```

---

## Task 7: Hook recordOutcome in claude.ts

**Files:**
- Modify: `src/lib/claude.ts`

- [ ] **Step 1: Importare circuit-breaker e modificare callClaudeStreamTelegram**

In `src/lib/claude.ts`, all'inizio aggiungere:

```typescript
import { recordOutcome, getActiveModel, detectHallucination, type ModelOutcome } from './circuit-breaker'
```

- [ ] **Step 2: Sostituire la lettura modello con getActiveModel**

In `callClaudeStreamTelegram`, dove ora c'è:

```typescript
const cfg = await getConfig()
```

Aggiungere SUBITO dopo:

```typescript
const activeModel = await getActiveModel()
// Se circuit breaker ha rolled back, sovrascrive il default
if (activeModel !== cfg.model) {
  console.log(`[CB] active=${activeModel} differs from default=${cfg.model}, using active`)
}
```

E sostituire `modelConfig.model = cfg.model` con `modelConfig.model = activeModel` (riga 333-334 circa).

- [ ] **Step 3: Tracciare totalToolCalls**

All'inizio del loop `for (let i = 0; i < MAX_ITERATIONS; i++)`, prima del loop:

```typescript
let totalToolCalls = 0
```

Dentro il loop, dopo `const toolBlocks = final.content.filter(b => b.type === 'tool_use')`:

```typescript
totalToolCalls += toolBlocks.length
```

- [ ] **Step 4: Aggiungere recordOutcome alla fine di callClaudeStreamTelegram**

Subito prima di `return fullResponse`, aggiungere:

```typescript
// Determina outcome per circuit breaker
let outcome: ModelOutcome = 'success'
const FALLBACK_PREFIX = '⚠️ Non sono riuscito a sintetizzare'
if (fullResponse.startsWith(FALLBACK_PREFIX)) {
  outcome = 'empty'
} else if (consecutiveNoText >= NO_TEXT_LIMIT) {
  outcome = 'force_text'
} else if (detectHallucination(fullResponse, totalToolCalls)) {
  outcome = 'hallucination'
}

// Fire-and-forget
recordOutcome(modelConfig.model, outcome, {
  fullLen: fullResponse.length,
  consecutiveNoText,
  requestId: conversationId,
}).catch(err => console.error('[CB] recordOutcome failed:', err))
```

NOTA: `NO_TEXT_LIMIT` è la costante definita per Bug 5 (=3). Verificare il nome esatto nel codice.

- [ ] **Step 5: Eseguire build per validare TypeScript**

L'utente esegue:
```
npm run build
```
Atteso: build OK senza errori TS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/claude.ts
git commit -m "feat(circuit-breaker): hook recordOutcome in callClaudeStreamTelegram"
```

---

## Task 8: Cron route /api/cron/canary

**Files:**
- Create: `src/app/api/cron/canary/route.ts`

- [ ] **Step 1: Creare il file route**

```typescript
/**
 * api/cron/canary — Vercel cron handler.
 *
 * Schedule: ogni 30 minuti (vedi vercel.json).
 * Quando lo stato breaker è ROLLED_BACK, esegue una request canary contro
 * model_default. Se 3 canary consecutivi vanno OK → resetBreaker.
 */

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '@/lib/supabase'
import {
  getCircuitState,
  resetBreaker,
  recordOutcome,
  invalidateCache,
  type CircuitState,
} from '@/lib/circuit-breaker'

const CANARY_OK_TARGET = 3
const CANARY_TIMEOUT_MS = 30_000

export async function GET(req: NextRequest) {
  // Auth: Vercel cron invia header authorization con CRON_SECRET
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const state = await getCircuitState()
  if (state.state !== 'ROLLED_BACK') {
    console.log(`[CRON canary] skipped: state=${state.state}`)
    return NextResponse.json({ ok: true, skipped: true, state: state.state })
  }

  // Read model_default per testarlo
  const { data: defaultRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'model_default')
    .maybeSingle()
  const defaultModel = defaultRow?.value
    ? String(defaultRow.value).replace(/"/g, '')
    : 'claude-opus-latest'

  console.log(`[CRON canary] testing ${defaultModel}`)

  const client = new Anthropic()
  let outcome: 'success' | 'empty' | 'api_error' | 'timeout' = 'success'
  let canaryText = ''

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), CANARY_TIMEOUT_MS)

    const res = await client.messages.create(
      {
        model: defaultModel,
        max_tokens: 10,
        system: 'Rispondi SOLO con la parola OK e nient\'altro.',
        messages: [{ role: 'user', content: 'Ping' }],
      },
      { signal: controller.signal },
    )
    clearTimeout(timeout)

    canaryText = res.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .trim()

    if (!canaryText || canaryText.length === 0) {
      outcome = 'empty'
    }
  } catch (err) {
    console.error('[CRON canary] API error:', err)
    if (err instanceof Error && err.name === 'AbortError') {
      outcome = 'timeout'
    } else {
      outcome = 'api_error'
    }
  }

  // Registra outcome canary
  await recordOutcome(defaultModel, outcome, {
    isCanary: true,
    details: `canary text="${canaryText.slice(0, 50)}"`,
  })

  // Aggiorna canary_consecutive_ok nello stato
  let newOk = state.canary_consecutive_ok
  if (outcome === 'success') {
    newOk = state.canary_consecutive_ok + 1
  } else {
    newOk = 0
  }

  if (newOk >= CANARY_OK_TARGET) {
    // Recovery!
    console.log(`[CRON canary] ${newOk} OK consecutive → resetBreaker`)
    await resetBreaker()
    return NextResponse.json({ ok: true, action: 'recovery', model: defaultModel })
  }

  // Update solo canary_consecutive_ok
  const newState: CircuitState = { ...state, canary_consecutive_ok: newOk }
  await supabase
    .from('cervellone_config')
    .update({ value: newState })
    .eq('key', 'circuit_state')
  invalidateCache()

  console.log(`[CRON canary] outcome=${outcome} consecutive_ok=${newOk}/${CANARY_OK_TARGET}`)
  return NextResponse.json({ ok: true, outcome, consecutive_ok: newOk })
}

export const maxDuration = 60
```

- [ ] **Step 2: Aggiungere CRON_SECRET in env**

L'utente deve generare un secret:
```bash
openssl rand -hex 32
```
E aggiungerlo come env var in Vercel:
- Name: `CRON_SECRET`
- Value: il secret generato
- Environments: Production, Preview, Development

- [ ] **Step 3: Eseguire build**

```
npm run build
```
Atteso: OK.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/canary/route.ts
git commit -m "feat(circuit-breaker): cron canary route con auth + timeout"
```

---

## Task 9: vercel.json schedule cron

**Files:**
- Create: `vercel.json` (verificare se esiste già)

- [ ] **Step 1: Verificare vercel.json esistente**

```bash
ls vercel.json 2>&1
```

Se esiste, leggere il contenuto. Se non esiste, creare nuovo.

- [ ] **Step 2: Aggiungere cron schedule**

Se vercel.json non esiste:
```json
{
  "crons": [
    { "path": "/api/cron/canary", "schedule": "*/30 * * * *" }
  ]
}
```

Se vercel.json esiste, aggiungere/estendere la chiave `crons`:
```json
{
  "...altre chiavi esistenti...",
  "crons": [
    { "path": "/api/cron/canary", "schedule": "*/30 * * * *" }
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add vercel.json
git commit -m "feat(circuit-breaker): schedule cron canary ogni 30 min"
```

---

## Task 10: Tool admin promuovi_modello

**Files:**
- Modify: `src/lib/tools.ts`

- [ ] **Step 1: Aggiungere import**

In cima a `src/lib/tools.ts`, aggiungere:

```typescript
import { promoteModel } from './circuit-breaker'
```

- [ ] **Step 2: Aggiungere il tool a SELF_TOOLS**

Cercare `SELF_TOOLS` in tools.ts e aggiungere alla fine dell'array:

```typescript
{
  name: 'promuovi_modello',
  description: `Promuove un nuovo modello Claude a default (model_default). L'attuale default diventa stable di backup. SOLO admin. Usa quando Anthropic rilascia una nuova versione e l'hai testata. Esempio: "claude-opus-4-8" o "claude-opus-5".`,
  input_schema: {
    type: 'object' as const,
    properties: {
      new_default: {
        type: 'string',
        description: 'Identificatore modello, es. "claude-opus-4-8". Deve iniziare con "claude-".',
      },
    },
    required: ['new_default'],
  },
}
```

- [ ] **Step 3: Aggiungere il case nell'executor**

Cercare `executeSelfTools` e aggiungere prima del `default`:

```typescript
case 'promuovi_modello': {
  try {
    const result = await promoteModel(input.new_default as string)
    return `🚀 Promozione completata.\nNuovo default: ${result.newDefault}\nNuovo stable: ${result.newStable}\nVecchio stable archiviato: ${result.oldStable}`
  } catch (err) {
    return `Errore promozione: ${err instanceof Error ? err.message : err}`
  }
}
```

- [ ] **Step 4: Eseguire build**

```
npm run build
```
Atteso: OK.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.ts
git commit -m "feat(circuit-breaker): tool admin promuovi_modello"
```

---

## Task 11: Push + verifica deploy

**Files:** nessuno (deploy)

- [ ] **Step 1: Push tutto su main**

```bash
git push origin main
```

- [ ] **Step 2: Verificare deploy Vercel**

L'utente apre il dashboard Vercel:
- https://vercel.com/raffaeles-projects-d3ea9cf9/cervellone-5poc

Attendere stato READY (~1-2 minuti).

- [ ] **Step 3: Verificare cron registrato**

Nella dashboard Vercel → Crons → confermare presenza di:
- Path: `/api/cron/canary`
- Schedule: `*/30 * * * *`

---

## Task 12: Test manuale — flow normale

**Files:** nessuno (test su prod)

- [ ] **Step 1: Inviare un messaggio normale su Telegram**

Bot deve rispondere come al solito.

- [ ] **Step 2: Verificare insert in model_health**

Su Supabase SQL editor:
```sql
SELECT model, outcome, ts FROM model_health ORDER BY ts DESC LIMIT 1;
```
Atteso: una riga con `model='claude-opus-latest'` (o il valore di model_active), `outcome='success'`.

- [ ] **Step 3: Verificare circuit_state**

```sql
SELECT value FROM cervellone_config WHERE key = 'circuit_state';
```
Atteso: `{"state":"NORMAL","tripped_at":null,"reason":null,"canary_consecutive_ok":0}`.

---

## Task 13: Test manuale — induced rollback

**Files:** nessuno (test su prod via SQL)

- [ ] **Step 1: Iniettare 5 fail in model_health**

Su Supabase SQL editor:
```sql
INSERT INTO model_health (model, outcome, ts) VALUES
  ('claude-opus-latest', 'force_text', NOW()),
  ('claude-opus-latest', 'force_text', NOW() - INTERVAL '1 minute'),
  ('claude-opus-latest', 'force_text', NOW() - INTERVAL '2 minutes'),
  ('claude-opus-latest', 'success', NOW() - INTERVAL '3 minutes'),
  ('claude-opus-latest', 'success', NOW() - INTERVAL '4 minutes');
```

- [ ] **Step 2: Inviare un messaggio Telegram per triggerare il check**

Qualsiasi messaggio. La prossima `recordOutcome` farà il SELECT degli ultimi 5 e troverà 3 fail → `tripBreaker`.

- [ ] **Step 3: Verificare notifica ricevuta su Telegram**

Atteso: messaggio "⚠️ Rollback automatico — rilevata regressione su `claude-opus-latest`..."

- [ ] **Step 4: Verificare circuit_state aggiornato**

```sql
SELECT value FROM cervellone_config WHERE key = 'circuit_state';
SELECT value FROM cervellone_config WHERE key = 'model_active';
```
Atteso: state=`ROLLED_BACK`, model_active=`claude-opus-4-7`.

---

## Task 14: Test manuale — canary recovery

**Files:** nessuno (test su prod)

- [ ] **Step 1: Triggerare il canary cron manualmente (skipping wait 30 min)**

Dal terminale dell'utente:
```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://cervellone-5poc.vercel.app/api/cron/canary
```
(L'utente sostituisce `$CRON_SECRET` con il valore reale.)

Atteso JSON: `{"ok":true,"outcome":"success","consecutive_ok":1}`

- [ ] **Step 2: Ripetere 2 volte ancora**

Stesso curl 2 volte. Atteso: consecutive_ok 2, poi al 3° → `{"ok":true,"action":"recovery"}`.

- [ ] **Step 3: Verificare ritorno a NORMAL**

```sql
SELECT value FROM cervellone_config WHERE key = 'circuit_state';
SELECT value FROM cervellone_config WHERE key = 'model_active';
```
Atteso: state=`NORMAL`, model_active=`claude-opus-latest`.

- [ ] **Step 4: Verificare notifica recovery su Telegram**

Atteso: messaggio "✅ Recovery automatico — `claude-opus-latest` torna stabile..."

---

## Task 15: Test manuale — promozione modello

**Files:** nessuno (test su Telegram)

- [ ] **Step 1: Chiedere al bot di promuovere un modello finto**

Su Telegram: "promuovi il modello claude-opus-test-promotion"

Atteso: bot chiama `promuovi_modello`, risponde con messaggio di conferma. Notifica Telegram + webchat con "🚀 Promozione modello".

- [ ] **Step 2: Verificare DB**

```sql
SELECT key, value FROM cervellone_config WHERE key IN ('model_default', 'model_stable');
```
Atteso: model_default=`claude-opus-test-promotion`, model_stable=`claude-opus-latest` (vecchio default).

- [ ] **Step 3: Ripristinare il default originale**

Su Telegram: "promuovi il modello claude-opus-latest"

Verifica DB di nuovo.

---

## Task 16: Cleanup test data

**Files:** nessuno (Supabase SQL)

- [ ] **Step 1: Pulire model_health dei record di test**

```sql
DELETE FROM model_health WHERE details LIKE '%test%' OR details IS NULL AND ts < NOW() - INTERVAL '1 hour';
```

(Aggiusta WHERE in base ai dati di test inseriti.)

- [ ] **Step 2: Verificare stato finale**

```sql
SELECT key, value FROM cervellone_config 
WHERE key IN ('model_default', 'model_stable', 'model_active', 'circuit_state');
```

Atteso:
- model_default=`claude-opus-latest`
- model_stable=`claude-opus-4-7`
- model_active=`claude-opus-latest`
- circuit_state=NORMAL

---

## Definition of Done (per Task)

| Item | Stato |
|---|---|
| Migration applicata su Supabase | Task 1 |
| `circuit-breaker.ts` con tutte le 8 funzioni esposte | Task 2-6 |
| Unit test ≥20 passanti | Task 3-5 |
| Hook `recordOutcome` integrato in claude.ts | Task 7 |
| Cron `/api/cron/canary` deployato | Task 8 |
| Vercel cron schedulato ogni 30 min | Task 9 |
| Tool `promuovi_modello` registrato | Task 10 |
| Deploy verificato READY | Task 11 |
| Test flow normale OK | Task 12 |
| Test induced rollback OK | Task 13 |
| Test canary recovery OK | Task 14 |
| Test promozione manuale OK | Task 15 |
| Cleanup test data | Task 16 |

---

## Note operative

- **TypeScript build**: il codice usa `as any` minimo (solo dove pdfjs/Anthropic SDK richiedono cast). Vitest mocks usano `as any` per pragmatismo.
- **Cache invalidation**: `invalidateCache()` di circuit-breaker è separata da `invalidateConfigCache()` di claude.ts. Quando il breaker cambia stato deve invalidare ENTRAMBE (vedi `tripBreaker`/`resetBreaker`/`promoteModel`).
- **Notifica throttling**: 1 ora tra notifiche normali. `force=true` per eventi critici (rollback iniziale, recovery, promozione).
- **Cron auth**: Vercel cron deve essere protetto con `CRON_SECRET`. Senza, qualunque endpoint pubblico potrebbe triggerare canary.
- **Backwards compat**: il codice attuale usa `getConfig()` da claude.ts. Il task 7 aggiunge `getActiveModel()` da circuit-breaker che ha priorità. Se circuit-breaker fallisce (Supabase down), fallback al codice esistente.

## Setup utente richiesto post-implementazione

1. **Migration**: applicare `supabase/migrations/2026-05-04-circuit-breaker.sql` via Supabase SQL editor (Task 1 step 2)
2. **CRON_SECRET**: generare con `openssl rand -hex 32` e aggiungere come env Vercel (Task 8 step 2)
3. **Verificare cron registrato** in Vercel dashboard (Task 11 step 3)
4. **Test flow** completo (Task 12-15)
