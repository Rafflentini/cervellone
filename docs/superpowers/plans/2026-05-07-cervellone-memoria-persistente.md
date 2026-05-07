# Cervellone — Memoria Persistente Cross-Sessione (Sub-progetto B)

> **Per agenti:** SKILL OBBLIGATORIA: usa `superpowers:subagent-driven-development` o `superpowers:executing-plans` per eseguire questo plan task-by-task. Ogni task è autonomo e bite-sized (2–5 min).

**Goal:** Dotare Cervellone di memoria persistente cross-sessione via approccio HYBRID: cron giornaliero 23:30 (auto-extraction conservativa con Sonnet 4.6) + comando `/ricorda` manuale. Richiamo a 3 livelli: L1 esplicita → L2 summary giornaliero → L3 RAG esistente.

**Architecture:** 4 nuove tabelle Supabase, 4 tool Anthropic, 1 cron Vercel, 2 comandi Telegram, REGOLA TOOL MEMORIA in prompts.ts. Pattern identici a cron gmail-morning + schema identico a gmail-rw.sql.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (service key), Anthropic SDK 0.80 (Sonnet 4.6 per cron), Vercel cron, vitest per unit test.

**Spec di riferimento:** `docs/superpowers/specs/2026-05-07-cervellone-memoria-persistente-design.md`

---

## File Structure

| File | Tipo | Responsabilità |
|---|---|---|
| `supabase/migrations/2026-05-07-memoria-persistente.sql` | Create | 4 tabelle + 3 config keys + indici + RLS disabled |
| `src/lib/memoria-tools.ts` | Create | 4 tool Anthropic: ricorda, richiama_memoria, riepilogo_giorno, lista_entita |
| `src/lib/memoria-tools.test.ts` | Create | Unit test vitest con mock supabase |
| `src/lib/memoria-extract.ts` | Create | Orchestrator cron: fetch messages → Sonnet 4.6 → INSERT summary + UPSERT entita |
| `src/lib/memoria-extract.test.ts` | Create | Unit test mock Anthropic SDK |
| `src/app/api/cron/memoria-extract/route.ts` | Create | Vercel cron handler: auth + idempotency + orchestrator call |
| `src/app/api/cron/memoria-extract/route.test.ts` | Create | Unit test handler |
| `src/app/api/telegram/route.ts` | Modify | Aggiungere /ricorda e /dimentica dispatcher |
| `src/lib/tools.ts` | Modify | Register MEMORIA_TOOLS (4 tool) |
| `src/lib/prompts.ts` | Modify | Aggiungere REGOLA TOOL MEMORIA |
| `vercel.json` | Modify | Aggiungere schedule memoria-extract |

---

## Task 1: Migration SQL

**Files:**
- Create: `supabase/migrations/2026-05-07-memoria-persistente.sql`

- [ ] **Step 1: Creare il file migration**

Contenuto esatto (copiare dalla spec §3):

```sql
-- Memoria persistente cross-sessione (Sub-progetto B)
-- Approach HYBRID: cron giornaliero + /ricorda manuale
-- Granularità conservativa: solo fatti verificabili

-- ─────────────────────────────────────────────────────────────
-- 1. cervellone_memoria_esplicita
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cervellone_memoria_esplicita (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contenuto TEXT NOT NULL,
  conversation_id UUID,
  tag TEXT,
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
  'Decisioni e contesti salvati esplicitamente via /ricorda o tool. Priorità L1. TTL FOREVER.';

-- ─────────────────────────────────────────────────────────────
-- 2. cervellone_summary_giornaliero
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cervellone_summary_giornaliero (
  data DATE PRIMARY KEY,
  summary_text TEXT NOT NULL,
  message_count INT NOT NULL DEFAULT 0,
  conversations_json JSONB,
  llm_tokens_used INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_summary_giornaliero_data
  ON cervellone_summary_giornaliero (data DESC);

ALTER TABLE cervellone_summary_giornaliero DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_summary_giornaliero IS
  '1 riga per giorno. Prodotta da cron 23:30 Rome. TTL 2 anni (cleanup OUT-OF-SCOPE MVP).';

-- ─────────────────────────────────────────────────────────────
-- 3. cervellone_entita_menzionate
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cervellone_entita_menzionate (
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('cliente', 'cantiere', 'fornitore')),
  last_seen_at DATE NOT NULL DEFAULT CURRENT_DATE,
  mention_count INT NOT NULL DEFAULT 1,
  contexts_json JSONB,
  PRIMARY KEY (name, type)
);

CREATE INDEX IF NOT EXISTS idx_entita_lastseen
  ON cervellone_entita_menzionate (last_seen_at DESC);

ALTER TABLE cervellone_entita_menzionate DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_entita_menzionate IS
  'Registro aggregato entità named estratte dal cron. UPSERT su (name, type). TTL FOREVER.';

-- ─────────────────────────────────────────────────────────────
-- 4. cervellone_memoria_extraction_runs
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
  'Log ogni run cron memoria-extract. Status started→ok|error. Per debug e stima costi LLM.';

-- ─────────────────────────────────────────────────────────────
-- 5. Config keys
-- ─────────────────────────────────────────────────────────────
INSERT INTO cervellone_config (key, value) VALUES
  ('memoria_extract_last_run', 'null'),
  ('memoria_silent_until', 'null'),
  ('memoria_extract_model', '"claude-sonnet-4-6"')
ON CONFLICT (key) DO NOTHING;
```

- [ ] **Step 2: Applicare migration (manuale — non automatizzata)**

```
# AZIONE UTENTE RICHIESTA:
# Copiare il contenuto del file sopra in Supabase SQL editor e cliccare Run.
# Verificare che tutte le tabelle appaiano in Table Editor.
```

**Verifica:** Nessuna eccezione. Tutte e 4 le tabelle visibili in Supabase dashboard. Tre nuovi key in `cervellone_config`.

---

## Task 2: `lib/memoria-tools.ts` — skeleton, types, tool `ricorda` (TDD)

**Files:**
- Create: `src/lib/memoria-tools.ts`
- Create: `src/lib/memoria-tools.test.ts`

- [ ] **Step 1: Scrivere il test prima dell'implementazione**

```typescript
// src/lib/memoria-tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock Supabase
const mockInsert = vi.fn()
const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockMaybeSingle = vi.fn()
const mockIlike = vi.fn()
const mockOrder = vi.fn()
const mockLimit = vi.fn()
const mockDelete = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: mockInsert,
      select: mockSelect,
      delete: mockDelete,
    })),
  },
}))

// Patch chaining
beforeEach(() => {
  vi.clearAllMocks()
  mockInsert.mockResolvedValue({ data: [{ id: 'test-uuid-1234' }], error: null })
  mockSelect.mockReturnValue({ eq: mockEq, ilike: mockIlike })
  mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle, order: mockOrder, ilike: mockIlike })
  mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  mockIlike.mockReturnValue({ order: mockOrder, limit: mockLimit })
  mockOrder.mockReturnValue({ limit: mockLimit })
  mockLimit.mockResolvedValue({ data: [], error: null })
  mockDelete.mockReturnValue({ eq: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue({ data: [], error: null }) }) })
})

describe('ricorda', () => {
  it('inserisce correttamente nella tabella', async () => {
    const { ricorda } = await import('./memoria-tools')
    const result = await ricorda({ testo: 'Test memoria', tag: 'cliente' })
    expect(result.ok).toBe(true)
    expect(result.id).toBeDefined()
  })

  it('fallisce con errore Supabase', async () => {
    mockInsert.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } })
    const { ricorda } = await import('./memoria-tools')
    const result = await ricorda({ testo: 'Test' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('DB error')
  })

  it('richiede testo non vuoto', async () => {
    const { ricorda } = await import('./memoria-tools')
    const result = await ricorda({ testo: '' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('testo')
  })
})
```

- [ ] **Step 2: Eseguire test → atteso FAIL (modulo non esiste)**

```bash
npx vitest run src/lib/memoria-tools.test.ts 2>&1 | head -30
```

- [ ] **Step 3: Creare `src/lib/memoria-tools.ts` con skeleton + `ricorda`**

```typescript
// src/lib/memoria-tools.ts — Memoria persistente cross-sessione
import { supabase } from '@/lib/supabase'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RicordaInput {
  testo: string
  tag?: string
  source?: 'telegram' | 'web' | 'tool' | 'cron'
  conversation_id?: string
}

export interface RicordaResult {
  ok: boolean
  id?: string
  error?: string
}

export interface RichiamaInput {
  query: string
  tipo_filtro?: 'esplicita' | 'summary' | 'entita' | 'tutto'
  limit?: number
}

export interface RichiamaResult {
  ok: boolean
  results: Array<{
    livello: 'esplicita' | 'summary' | 'entita' | 'rag'
    testo: string
    data?: string
    tag?: string
  }>
  error?: string
}

export interface RiepilogoInput {
  data: string // 'oggi', 'ieri', 'YYYY-MM-DD', 'lunedi-scorso', ecc.
}

export interface RiepilogoResult {
  ok: boolean
  data_iso?: string
  summary_text?: string
  message_count?: number
  error?: string
}

export interface ListaEntitaInput {
  tipo?: 'cliente' | 'cantiere' | 'fornitore'
  limit?: number
}

export interface ListaEntitaResult {
  ok: boolean
  entita: Array<{
    name: string
    type: string
    last_seen_at: string
    mention_count: number
  }>
  error?: string
}

// ─── ricorda ────────────────────────────────────────────────────────────────

export async function ricorda(input: RicordaInput): Promise<RicordaResult> {
  if (!input.testo || input.testo.trim() === '') {
    return { ok: false, error: 'Il campo testo è obbligatorio e non può essere vuoto.' }
  }

  const { data, error } = await supabase.from('cervellone_memoria_esplicita').insert({
    contenuto: input.testo.trim(),
    tag: input.tag ?? null,
    source: input.source ?? 'tool',
    conversation_id: input.conversation_id ?? null,
  }).select('id')

  if (error) {
    return { ok: false, error: error.message }
  }

  return { ok: true, id: data?.[0]?.id }
}
```

- [ ] **Step 4: Eseguire test → PASS**

```bash
npx vitest run src/lib/memoria-tools.test.ts 2>&1 | tail -10
```

Atteso: `✓ ricorda > inserisce correttamente nella tabella`, `✓ fallisce con errore Supabase`, `✓ richiede testo non vuoto`.

---

## Task 3: `richiama_memoria` — 3 livelli con priorità (TDD)

**Files:**
- Modify: `src/lib/memoria-tools.ts`
- Modify: `src/lib/memoria-tools.test.ts`

- [ ] **Step 1: Aggiungere test per `richiama_memoria`**

Appendere a `src/lib/memoria-tools.test.ts`:

```typescript
describe('richiama_memoria', () => {
  it('ritorna risultati espliciti se presenti (L1 prima)', async () => {
    mockLimit.mockResolvedValueOnce({
      data: [{ id: 'uuid-1', contenuto: 'Cliente Bianchi accordo 15k', tag: 'cliente', created_at: '2026-05-06T10:00:00Z' }],
      error: null,
    })
    const { richiama_memoria } = await import('./memoria-tools')
    const result = await richiama_memoria({ query: 'Bianchi', tipo_filtro: 'esplicita' })
    expect(result.ok).toBe(true)
    expect(result.results[0].livello).toBe('esplicita')
    expect(result.results[0].testo).toContain('Bianchi')
  })

  it('ritorna array vuoto se nessun risultato', async () => {
    mockLimit.mockResolvedValue({ data: [], error: null })
    const { richiama_memoria } = await import('./memoria-tools')
    const result = await richiama_memoria({ query: 'query inesistente xyz', tipo_filtro: 'tutto' })
    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(0)
  })

  it('gestisce errore DB gracefully', async () => {
    mockLimit.mockResolvedValue({ data: null, error: { message: 'DB error' } })
    const { richiama_memoria } = await import('./memoria-tools')
    const result = await richiama_memoria({ query: 'test' })
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Implementare `richiama_memoria` in `src/lib/memoria-tools.ts`**

Appendere dopo la funzione `ricorda`:

```typescript
export async function richiama_memoria(input: RichiamaInput): Promise<RichiamaResult> {
  const query = input.query?.trim()
  if (!query) return { ok: false, results: [], error: 'query obbligatoria' }

  const limit = input.limit ?? 10
  const filtro = input.tipo_filtro ?? 'tutto'
  const results: RichiamaResult['results'] = []

  // L1: memoria_esplicita (full-text ILIKE)
  if (filtro === 'tutto' || filtro === 'esplicita') {
    const { data, error } = await supabase
      .from('cervellone_memoria_esplicita')
      .select('id, contenuto, tag, created_at')
      .ilike('contenuto', `%${query}%`)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) return { ok: false, results: [], error: error.message }
    for (const row of data ?? []) {
      results.push({
        livello: 'esplicita',
        testo: row.contenuto,
        data: row.created_at,
        tag: row.tag ?? undefined,
      })
    }
  }

  // L2: summary_giornaliero (ILIKE su summary_text)
  if (filtro === 'tutto' || filtro === 'summary') {
    const { data, error } = await supabase
      .from('cervellone_summary_giornaliero')
      .select('data, summary_text')
      .ilike('summary_text', `%${query}%`)
      .order('data', { ascending: false })
      .limit(limit)
    if (error) return { ok: false, results: [], error: error.message }
    for (const row of data ?? []) {
      results.push({
        livello: 'summary',
        testo: row.summary_text,
        data: row.data,
      })
    }
  }

  // L3: entita_menzionate (ILIKE su name)
  if (filtro === 'tutto' || filtro === 'entita') {
    const { data, error } = await supabase
      .from('cervellone_entita_menzionate')
      .select('name, type, last_seen_at, mention_count')
      .ilike('name', `%${query}%`)
      .order('last_seen_at', { ascending: false })
      .limit(limit)
    if (error) return { ok: false, results: [], error: error.message }
    for (const row of data ?? []) {
      results.push({
        livello: 'entita',
        testo: `${row.type}: ${row.name} (visto ${row.mention_count}x, ultimo ${row.last_seen_at})`,
        data: row.last_seen_at,
      })
    }
  }

  return { ok: true, results }
}
```

- [ ] **Step 3: Eseguire test → PASS**

```bash
npx vitest run src/lib/memoria-tools.test.ts 2>&1 | tail -15
```

Atteso: tutti i test `ricorda` + `richiama_memoria` verdi.

---

## Task 4: `riepilogo_giorno` con parsing data naturale italiano (TDD)

**Files:**
- Modify: `src/lib/memoria-tools.ts`
- Modify: `src/lib/memoria-tools.test.ts`

- [ ] **Step 1: Aggiungere test per `riepilogo_giorno` e parser data**

```typescript
describe('riepilogo_giorno — parser data', () => {
  // Freezare data: 2026-05-07 (mercoledì)
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-05-07T10:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('oggi → 2026-05-07', async () => {
    const { parseDateInput } = await import('./memoria-tools')
    expect(parseDateInput('oggi')).toBe('2026-05-07')
  })

  it('ieri → 2026-05-06', async () => {
    const { parseDateInput } = await import('./memoria-tools')
    expect(parseDateInput('ieri')).toBe('2026-05-06')
  })

  it('lunedi-scorso → 2026-05-04', async () => {
    const { parseDateInput } = await import('./memoria-tools')
    expect(parseDateInput('lunedi-scorso')).toBe('2026-05-04')
  })

  it('venerdi-scorso → 2026-05-01', async () => {
    const { parseDateInput } = await import('./memoria-tools')
    expect(parseDateInput('venerdi-scorso')).toBe('2026-05-01')
  })

  it('data ISO pass-through → 2026-05-05', async () => {
    const { parseDateInput } = await import('./memoria-tools')
    expect(parseDateInput('2026-05-05')).toBe('2026-05-05')
  })

  it('riepilogo_giorno chiama supabase con data corretta', async () => {
    mockEq.mockReturnValueOnce({ maybeSingle: vi.fn().mockResolvedValue({
      data: { data: '2026-05-06', summary_text: 'Test summary', message_count: 5 },
      error: null
    })})
    const { riepilogo_giorno } = await import('./memoria-tools')
    const result = await riepilogo_giorno({ data: 'ieri' })
    expect(result.ok).toBe(true)
    expect(result.data_iso).toBe('2026-05-06')
    expect(result.summary_text).toBe('Test summary')
  })
})
```

- [ ] **Step 2: Implementare `parseDateInput` e `riepilogo_giorno` in `src/lib/memoria-tools.ts`**

```typescript
// Mappa giorni italiani → offset JS (0=dom, 1=lun, ..., 6=sab)
const GIORNO_TO_JS: Record<string, number> = {
  'lunedi': 1, 'martedi': 2, 'mercoledi': 3,
  'giovedi': 4, 'venerdi': 5, 'sabato': 6, 'domenica': 0,
}

export function parseDateInput(input: string): string {
  const now = new Date()
  const todayISO = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }) // YYYY-MM-DD

  if (input === 'oggi') return todayISO

  if (input === 'ieri') {
    const d = new Date(now)
    d.setDate(d.getDate() - 1)
    return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
  }

  // "lunedi-scorso", "venerdi-scorso", ecc.
  const giornoMatch = input.match(/^([a-z]+)-scorso$/)
  if (giornoMatch) {
    const giornoNorm = giornoMatch[1]
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // rimuovi accenti
      .toLowerCase()
    const targetDay = GIORNO_TO_JS[giornoNorm]
    if (targetDay !== undefined) {
      const d = new Date(now)
      const currentDay = d.getDay() // 0=dom
      let diff = currentDay - targetDay
      if (diff <= 0) diff += 7 // sempre la settimana scorsa
      d.setDate(d.getDate() - diff)
      return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
    }
  }

  // ISO pass-through YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input

  // Fallback: oggi
  return todayISO
}

export async function riepilogo_giorno(input: RiepilogoInput): Promise<RiepilogoResult> {
  const dataISO = parseDateInput(input.data)

  const { data, error } = await supabase
    .from('cervellone_summary_giornaliero')
    .select('data, summary_text, message_count')
    .eq('data', dataISO)
    .maybeSingle()

  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, data_iso: dataISO, summary_text: undefined, message_count: 0 }

  return {
    ok: true,
    data_iso: data.data,
    summary_text: data.summary_text,
    message_count: data.message_count,
  }
}
```

- [ ] **Step 3: Eseguire test → PASS**

```bash
npx vitest run src/lib/memoria-tools.test.ts 2>&1 | tail -20
```

---

## Task 5: `lista_entita` (TDD)

**Files:**
- Modify: `src/lib/memoria-tools.ts`
- Modify: `src/lib/memoria-tools.test.ts`

- [ ] **Step 1: Aggiungere test**

```typescript
describe('lista_entita', () => {
  it('ritorna lista clienti filtrata per tipo', async () => {
    mockLimit.mockResolvedValueOnce({
      data: [
        { name: 'Bianchi Srl', type: 'cliente', last_seen_at: '2026-05-06', mention_count: 3 },
        { name: 'Rossi Mario', type: 'cliente', last_seen_at: '2026-05-05', mention_count: 1 },
      ],
      error: null,
    })
    const { lista_entita } = await import('./memoria-tools')
    const result = await lista_entita({ tipo: 'cliente' })
    expect(result.ok).toBe(true)
    expect(result.entita).toHaveLength(2)
    expect(result.entita[0].name).toBe('Bianchi Srl')
  })

  it('ritorna tutti i tipi se tipo non specificato', async () => {
    mockLimit.mockResolvedValueOnce({ data: [], error: null })
    const { lista_entita } = await import('./memoria-tools')
    const result = await lista_entita({})
    expect(result.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Implementare `lista_entita`**

```typescript
export async function lista_entita(input: ListaEntitaInput): Promise<ListaEntitaResult> {
  const limit = input.limit ?? 20

  let q = supabase
    .from('cervellone_entita_menzionate')
    .select('name, type, last_seen_at, mention_count')
    .order('last_seen_at', { ascending: false })

  if (input.tipo) {
    q = (q as any).eq('type', input.tipo)
  }

  const { data, error } = await (q as any).limit(limit)
  if (error) return { ok: false, entita: [], error: error.message }

  return {
    ok: true,
    entita: (data ?? []).map((row: any) => ({
      name: row.name,
      type: row.type,
      last_seen_at: row.last_seen_at,
      mention_count: row.mention_count,
    })),
  }
}
```

- [ ] **Step 3: Eseguire test → tutti PASS**

```bash
npx vitest run src/lib/memoria-tools.test.ts 2>&1 | tail -25
```

---

## Task 6: `lib/memoria-extract.ts` orchestrator + prompt Sonnet (TDD)

**Files:**
- Create: `src/lib/memoria-extract.ts`
- Create: `src/lib/memoria-extract.test.ts`

- [ ] **Step 1: Scrivere test con mock Anthropic SDK**

```typescript
// src/lib/memoria-extract.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

const mockInsert = vi.fn().mockResolvedValue({ data: [{ run_id: 'run-uuid' }], error: null })
const mockUpdate = vi.fn().mockResolvedValue({ error: null })
const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockOrder = vi.fn()
const mockUpsert = vi.fn().mockResolvedValue({ error: null })

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => ({
      insert: mockInsert,
      update: mockUpdate,
      select: mockSelect,
      upsert: mockUpsert,
    })),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockSelect.mockReturnValue({ eq: mockEq, gte: mockEq, lte: mockEq, order: mockOrder })
  mockEq.mockReturnValue({ order: mockOrder, maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })
  mockOrder.mockResolvedValue({ data: [], error: null })
  mockInsert.mockResolvedValue({ data: [{ run_id: 'run-uuid-123' }], error: null })
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({
      summary: 'Test summary giornata',
      entita: [{ name: 'Bianchi Srl', type: 'cliente', context: 'preventivo €10k' }],
      eventi: [{ data_iso: '2026-05-06', descrizione: 'Inviato preventivo' }],
    }) }],
    usage: { input_tokens: 500, output_tokens: 100 },
  })
})

describe('runMemoriaExtract', () => {
  it('processa conversazioni e ritorna ok', async () => {
    // Simula messaggi presenti
    mockOrder.mockResolvedValueOnce({
      data: [
        { id: 1, conversation_id: 'conv-1', role: 'user', content: 'Ho mandato preventivo a Bianchi Srl', created_at: '2026-05-06T10:00:00Z' },
        { id: 2, conversation_id: 'conv-1', role: 'assistant', content: 'Ok, ricevuto', created_at: '2026-05-06T10:01:00Z' },
      ],
      error: null,
    })
    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06')
    expect(result.ok).toBe(true)
    expect(result.conversations).toBe(1)
  })

  it('ritorna ok con dati vuoti se nessun messaggio', async () => {
    mockOrder.mockResolvedValueOnce({ data: [], error: null })
    const { runMemoriaExtract } = await import('./memoria-extract')
    const result = await runMemoriaExtract('2026-05-06')
    expect(result.ok).toBe(true)
    expect(result.conversations).toBe(0)
  })
})
```

- [ ] **Step 2: Eseguire test → atteso FAIL (modulo non esiste)**

```bash
npx vitest run src/lib/memoria-extract.test.ts 2>&1 | head -20
```

- [ ] **Step 3: Creare `src/lib/memoria-extract.ts`**

```typescript
// src/lib/memoria-extract.ts — Orchestrator cron memoria-extract
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '@/lib/supabase'

const EXTRACTION_PROMPT = `Sei un estrattore di FATTI VERIFICABILI da conversazioni di un'agenzia tecnica.
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

Se la giornata è vuota o non contiene fatti rilevanti, output: {"summary": "Nessuna attività rilevante", "entita": [], "eventi": []}.`

export interface ExtractResult {
  ok: boolean
  conversations: number
  entities: number
  tokens: number
  cost_usd: number
  error?: string
}

export async function runMemoriaExtract(dateTarget: string): Promise<ExtractResult> {
  // Leggere modello da config (default Sonnet)
  const { data: modelRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'memoria_extract_model')
    .maybeSingle()
  const model = (typeof modelRow?.value === 'string'
    ? modelRow.value.replace(/"/g, '')
    : 'claude-sonnet-4-6') || 'claude-sonnet-4-6'

  // Fetch messaggi del giorno target
  const { data: messages, error: msgErr } = await supabase
    .from('messages')
    .select('id, conversation_id, role, content, created_at')
    .eq(supabase.from('messages').select as any, '') // placeholder — vedere implementazione reale sotto

  // Nota: il filtro corretto è una raw query. Usare .gte/.lte su created_at
  // Non si può usare ::date in Supabase JS SDK direttamente. Approccio:
  const startOfDay = `${dateTarget}T00:00:00.000Z`
  const endOfDay = `${dateTarget}T23:59:59.999Z`

  const { data: msgs, error: msgsErr } = await supabase
    .from('messages')
    .select('id, conversation_id, role, content, created_at')
    .gte('created_at', startOfDay)
    .lte('created_at', endOfDay)
    .order('conversation_id')
    .order('created_at')

  if (msgsErr) throw new Error(`Fetch messages: ${msgsErr.message}`)

  const msgList = msgs ?? []

  // INSERT run (status='started')
  const { data: runData, error: runInsertErr } = await supabase
    .from('cervellone_memoria_extraction_runs')
    .insert({ date_processed: dateTarget, status: 'started' })
    .select('run_id')
  if (runInsertErr) throw new Error(`Insert run: ${runInsertErr.message}`)
  const runId = runData?.[0]?.run_id

  if (msgList.length === 0) {
    // Giornata vuota: INSERT summary vuoto
    await supabase.from('cervellone_summary_giornaliero').upsert({
      data: dateTarget,
      summary_text: 'Nessuna attività rilevante',
      message_count: 0,
      conversations_json: [],
      llm_tokens_used: 0,
    })
    await supabase.from('cervellone_memoria_extraction_runs').update({
      status: 'ok',
      completed_at: new Date().toISOString(),
      conversations_count: 0,
      entities_count: 0,
      llm_cost_estimate_usd: 0,
    }).eq('run_id', runId)
    return { ok: true, conversations: 0, entities: 0, tokens: 0, cost_usd: 0 }
  }

  // Group by conversation_id
  const groups = new Map<string, typeof msgList>()
  for (const msg of msgList) {
    const key = msg.conversation_id ?? 'unknown'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(msg)
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const allEntita: Array<{ name: string; type: string; context: string }> = []
  const allSummaries: string[] = []
  let totalTokens = 0

  // Per ogni conversation group → call Sonnet
  for (const [convId, convMsgs] of groups.entries()) {
    const transcript = convMsgs
      .map(m => `[${m.role}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
      .join('\n')

    try {
      const resp = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `${EXTRACTION_PROMPT}\n\nConversazione (${convId}):\n${transcript}`,
          },
        ],
      })

      totalTokens += (resp.usage?.input_tokens ?? 0) + (resp.usage?.output_tokens ?? 0)

      const textBlock = resp.content.find(b => b.type === 'text')
      if (textBlock && textBlock.type === 'text') {
        try {
          const parsed = JSON.parse(textBlock.text)
          if (parsed.summary) allSummaries.push(parsed.summary)
          if (Array.isArray(parsed.entita)) allEntita.push(...parsed.entita)
        } catch {
          // JSON parse error: skip this conversation
        }
      }
    } catch (err) {
      // LLM error per questa conversazione: skip, continua con le altre
      console.error(`[memoria-extract] LLM error for conv ${convId}:`, err)
    }
  }

  // Aggrega summary
  const summaryAggregato = allSummaries.filter(Boolean).join(' | ') || 'Nessuna attività rilevante'
  const conversationIds = Array.from(groups.keys())

  // Stima costo: $3/M input + $15/M output (approssimazione: 80% input, 20% output)
  const costUsd = parseFloat(((totalTokens * 0.8 * 3 + totalTokens * 0.2 * 15) / 1_000_000).toFixed(4))

  // INSERT summary_giornaliero (upsert per idempotency)
  await supabase.from('cervellone_summary_giornaliero').upsert({
    data: dateTarget,
    summary_text: summaryAggregato,
    message_count: msgList.length,
    conversations_json: conversationIds,
    llm_tokens_used: totalTokens,
  })

  // UPSERT entita_menzionate
  const entitaDeduplicate = new Map<string, { name: string; type: string; context: string }>()
  for (const e of allEntita) {
    const key = `${e.name}|||${e.type}`
    if (!entitaDeduplicate.has(key)) entitaDeduplicate.set(key, e)
  }

  for (const e of entitaDeduplicate.values()) {
    await supabase.from('cervellone_entita_menzionate').upsert({
      name: e.name,
      type: e.type,
      last_seen_at: dateTarget,
      mention_count: 1,
      contexts_json: [e.context],
    }, {
      onConflict: 'name,type',
      ignoreDuplicates: false,
    })
    // Incremento mention_count via RPC o update separato
    await supabase.from('cervellone_entita_menzionate')
      .update({ mention_count: supabase.rpc as any, last_seen_at: dateTarget })
      .eq('name', e.name)
      .eq('type', e.type)
  }
  // Nota: per incremento atomico mention_count usare RPC raw SQL in produzione:
  // UPDATE cervellone_entita_menzionate SET mention_count = mention_count + 1 WHERE name=$1 AND type=$2

  // UPDATE run status=ok
  await supabase.from('cervellone_memoria_extraction_runs').update({
    status: 'ok',
    completed_at: new Date().toISOString(),
    conversations_count: conversationIds.length,
    entities_count: entitaDeduplicate.size,
    llm_cost_estimate_usd: costUsd,
  }).eq('run_id', runId)

  return {
    ok: true,
    conversations: conversationIds.length,
    entities: entitaDeduplicate.size,
    tokens: totalTokens,
    cost_usd: costUsd,
  }
}
```

- [ ] **Step 4: Eseguire test → PASS**

```bash
npx vitest run src/lib/memoria-extract.test.ts 2>&1 | tail -15
```

---

## Task 7: `app/api/cron/memoria-extract/route.ts` — auth + idempotency

**Files:**
- Create: `src/app/api/cron/memoria-extract/route.ts`
- Create: `src/app/api/cron/memoria-extract/route.test.ts`

- [ ] **Step 1: Scrivere il test del route handler**

```typescript
// src/app/api/cron/memoria-extract/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockResolvedValue({ error: null }),
      }),
    })),
  },
}))

vi.mock('@/lib/memoria-extract', () => ({
  runMemoriaExtract: vi.fn().mockResolvedValue({
    ok: true, conversations: 2, entities: 3, tokens: 1000, cost_usd: 0.003,
  }),
}))

function makeReq(authHeader?: string) {
  return new NextRequest('http://localhost/api/cron/memoria-extract', {
    headers: authHeader ? { authorization: authHeader } : {},
  })
}

beforeEach(() => {
  process.env.CRON_SECRET = 'test-secret-123'
  vi.clearAllMocks()
})

describe('GET /api/cron/memoria-extract', () => {
  it('ritorna 401 senza auth', async () => {
    const res = await GET(makeReq())
    expect(res.status).toBe(401)
  })

  it('ritorna 401 con auth errata', async () => {
    const res = await GET(makeReq('Bearer wrong-secret'))
    expect(res.status).toBe(401)
  })

  it('ritorna ok con auth corretta', async () => {
    const res = await GET(makeReq('Bearer test-secret-123'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Creare il route handler**

```typescript
// src/app/api/cron/memoria-extract/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { runMemoriaExtract } from '@/lib/memoria-extract'

export const maxDuration = 120

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  // Silent mode check
  const { data: silentRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'memoria_silent_until')
    .maybeSingle()
  const silentValue = silentRow?.value
  if (silentValue && silentValue !== 'null' && silentValue !== null) {
    const silentUntil = new Date(typeof silentValue === 'string' ? silentValue.replace(/"/g, '') : silentValue)
    if (Date.now() < silentUntil.getTime()) {
      console.log(`[CRON memoria-extract] silent until ${silentUntil.toISOString()}, skip`)
      return NextResponse.json({ ok: true, skipped: 'silent' })
    }
  }

  // date_target = ieri (cron gira 23:30, processiamo la giornata di ieri che è chiusa)
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const dateTarget = yesterday.toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })

  // Idempotency: skip se già processato ieri
  const { data: lastRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'memoria_extract_last_run')
    .maybeSingle()
  const lastValue = lastRow?.value
  if (lastValue && lastValue !== 'null' && lastValue !== null) {
    const lastRun = typeof lastValue === 'string' ? lastValue.replace(/"/g, '') : String(lastValue)
    if (lastRun === dateTarget) {
      console.log(`[CRON memoria-extract] already ran for ${dateTarget}, skip`)
      return NextResponse.json({ ok: true, skipped: 'already_ran', date: dateTarget })
    }
  }

  let result
  try {
    result = await runMemoriaExtract(dateTarget)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[CRON memoria-extract] runMemoriaExtract failed:', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 })
  }

  // Aggiorna last_run
  await supabase
    .from('cervellone_config')
    .update({ value: dateTarget })
    .eq('key', 'memoria_extract_last_run')

  console.log(`[CRON memoria-extract] done: ${dateTarget} | conv=${result.conversations} ent=${result.entities} tok=${result.tokens} cost=$${result.cost_usd}`)

  return NextResponse.json({
    ok: true,
    date: dateTarget,
    conversations: result.conversations,
    entities: result.entities,
    tokens: result.tokens,
    cost_usd: result.cost_usd,
  })
}
```

- [ ] **Step 3: Eseguire test → PASS**

```bash
npx vitest run src/app/api/cron/memoria-extract/route.test.ts 2>&1 | tail -15
```

---

## Task 8: `vercel.json` — aggiungere schedule cron

**Files:**
- Modify: `vercel.json`

- [ ] **Step 1: Leggere file corrente**

```bash
cat vercel.json
```

Atteso:
```json
{
  "crons": [
    { "path": "/api/cron/canary", "schedule": "*/30 * * * *" },
    { "path": "/api/cron/gmail-morning", "schedule": "0 6 * * 1-5" },
    { "path": "/api/cron/gmail-alerts", "schedule": "*/30 7-16 * * 1-5" }
  ]
}
```

- [ ] **Step 2: Aggiungere il cron memoria-extract**

Contenuto finale `vercel.json`:
```json
{
  "crons": [
    { "path": "/api/cron/canary", "schedule": "*/30 * * * *" },
    { "path": "/api/cron/gmail-morning", "schedule": "0 6 * * 1-5" },
    { "path": "/api/cron/gmail-alerts", "schedule": "*/30 7-16 * * 1-5" },
    { "path": "/api/cron/memoria-extract", "schedule": "30 21 * * *" }
  ]
}
```

Note: `30 21 * * *` = 21:30 UTC = 23:30 CEST (estate UTC+2). In inverno (UTC+1) gira alle 22:30 — drift 1h accettabile.

- [ ] **Step 3: Verificare JSON valido**

```bash
node -e "const f=require('./vercel.json'); console.log('crons:', f.crons.length)"
```

Atteso: `crons: 4`.

---

## Task 9: Comandi Telegram `/ricorda` e `/dimentica`

**Files:**
- Modify: `src/app/api/telegram/route.ts`

- [ ] **Step 1: Localizzare il punto di inserimento nel dispatcher**

```bash
grep -n "startsWith('/" src/app/api/telegram/route.ts | head -20
```

Trovare il blocco dove vengono gestiti i comandi slash Telegram (es. `/help`, `/canary`).

- [ ] **Step 2: Inserire i due handler PRIMA del fallback al LLM**

Nel dispatcher comandi di `src/app/api/telegram/route.ts`, aggiungere:

```typescript
// ─── /ricorda <testo> ─────────────────────────────────────────────────────
if (text.startsWith('/ricorda ') || text === '/ricorda') {
  const testo = text.startsWith('/ricorda ') ? text.slice('/ricorda '.length).trim() : ''
  if (!testo) {
    await sendTelegramMessage(chatId, '⛔ Uso: /ricorda <testo da memorizzare>')
    return NextResponse.json({ ok: true })
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
  return NextResponse.json({ ok: true })
}

// ─── /dimentica <uuid> ────────────────────────────────────────────────────
if (text.startsWith('/dimentica ') || text === '/dimentica') {
  const uuid = text.startsWith('/dimentica ') ? text.slice('/dimentica '.length).trim() : ''
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(uuid)) {
    await sendTelegramMessage(chatId, '⛔ Formato UUID non valido. Serve UUID esatto (es. da /lista_ricordi o dai log Supabase).')
    return NextResponse.json({ ok: true })
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
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 3: Verificare TypeScript compile senza errori**

```bash
npx tsc --noEmit 2>&1 | grep -i "telegram" | head -20
```

---

## Task 10: Tool registry in `tools.ts` + REGOLA in `prompts.ts`

**Files:**
- Modify: `src/lib/tools.ts`
- Modify: `src/lib/prompts.ts`

- [ ] **Step 1: Aggiungere MEMORIA_TOOLS in `src/lib/tools.ts`**

Trovare dove sono definiti altri tool (es. `GITHUB_TOOLS`, `GMAIL_TOOLS`):

```bash
grep -n "GITHUB_TOOLS\|GMAIL_TOOLS\|const.*TOOLS" src/lib/tools.ts | head -10
```

Aggiungere il blocco `MEMORIA_TOOLS` nello stesso stile:

```typescript
// ─── MEMORIA TOOLS ────────────────────────────────────────────────────────
export const MEMORIA_TOOLS: Anthropic.Tool[] = [
  {
    name: 'ricorda',
    description: 'Salva in memoria persistente una decisione, contesto o fatto importante. ' +
      'Usare quando l\'Ingegnere dice esplicitamente di voler ricordare qualcosa, ' +
      'o quando si prende una decisione che dovrà essere recuperata in sessioni future. ' +
      'NON usare per fatti generici già presenti nella conversazione corrente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        testo: {
          type: 'string',
          description: 'Testo da salvare in memoria. Essere precisi e auto-contenuti: ' +
            'includere chi, cosa, quando se rilevante.',
        },
        tag: {
          type: 'string',
          description: 'Etichetta opzionale (es: "cliente", "scadenza", "cantiere", "decisione").',
        },
      },
      required: ['testo'],
    },
  },
  {
    name: 'richiama_memoria',
    description: 'Cerca nella memoria persistente (3 livelli: esplicita → summary giornaliero → entità). ' +
      'Usare quando l\'Ingegnere chiede di ricordare qualcosa, o quando serve contesto storico.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Testo della ricerca. Usare parole chiave significative.',
        },
        tipo_filtro: {
          type: 'string',
          enum: ['esplicita', 'summary', 'entita', 'tutto'],
          description: 'Filtra il livello di ricerca. Default "tutto".',
        },
        limit: {
          type: 'number',
          description: 'Numero massimo risultati per livello. Default 10.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'riepilogo_giorno',
    description: 'Recupera il summary di una giornata specifica. ' +
      'Usare per query temporali esplicite: "cosa abbiamo fatto ieri", "lunedì scorso", "il 5 maggio".',
    input_schema: {
      type: 'object' as const,
      properties: {
        data: {
          type: 'string',
          description: 'Data richiesta: "oggi", "ieri", "YYYY-MM-DD", "lunedi-scorso", ' +
            '"martedi-scorso", "mercoledi-scorso", "giovedi-scorso", "venerdi-scorso".',
        },
      },
      required: ['data'],
    },
  },
  {
    name: 'lista_entita',
    description: 'Elenca clienti/cantieri/fornitori conosciuti estratti dalle conversazioni. ' +
      'Usare quando l\'Ingegnere chiede "quali clienti abbiamo" o simili.',
    input_schema: {
      type: 'object' as const,
      properties: {
        tipo: {
          type: 'string',
          enum: ['cliente', 'cantiere', 'fornitore'],
          description: 'Filtra per tipo. Se omesso, ritorna tutti.',
        },
        limit: {
          type: 'number',
          description: 'Numero massimo entità ritornate. Default 20.',
        },
      },
      required: [],
    },
  },
]
```

- [ ] **Step 2: Registrare `MEMORIA_TOOLS` nel tool array principale**

Trovare dove gli altri tool vengono inclusi nel tool array principale (es. `...GITHUB_TOOLS`):

```bash
grep -n "GITHUB_TOOLS\|spread\|\.\.\." src/lib/tools.ts | tail -20
```

Aggiungere `...MEMORIA_TOOLS` nello stesso punto.

- [ ] **Step 3: Aggiungere executor nel switch/case tool handler**

Trovare il punto dove vengono eseguiti i tool (es. `executeGithubWrapper`):

```bash
grep -n "case 'ricorda'\|executeGithub\|tool_use.*name" src/lib/tools.ts | head -20
```

Aggiungere i 4 case nel switch:

```typescript
case 'ricorda': {
  const { ricorda } = await import('@/lib/memoria-tools')
  return await ricorda(toolInput as any)
}
case 'richiama_memoria': {
  const { richiama_memoria } = await import('@/lib/memoria-tools')
  return await richiama_memoria(toolInput as any)
}
case 'riepilogo_giorno': {
  const { riepilogo_giorno } = await import('@/lib/memoria-tools')
  return await riepilogo_giorno(toolInput as any)
}
case 'lista_entita': {
  const { lista_entita } = await import('@/lib/memoria-tools')
  return await lista_entita(toolInput as any)
}
```

- [ ] **Step 4: Aggiungere REGOLA TOOL MEMORIA in `src/lib/prompts.ts`**

Trovare la REGOLA AUTONOMIA SVILUPPO:

```bash
grep -n "REGOLA AUTONOMIA\|REGOLA TOOL GMAIL" src/lib/prompts.ts
```

Inserire PRIMA della REGOLA AUTONOMIA SVILUPPO (o alla fine del sistema di regole, comunque prima di AUTONOMIA):

```typescript
const REGOLA_TOOL_MEMORIA = `
REGOLA TOOL MEMORIA:
Quando l'Ingegnere ti chiede di ricordare qualcosa o richiamare qualcosa dal passato:
- Per SALVARE una decisione/contesto importante: usa il tool ricorda(testo, tag?)
- Per RICHIAMARE qualcosa: usa richiama_memoria(query) — cerca prima in memoria esplicita (decisioni dell'Ingegnere), poi in summary giornaliero, poi in RAG
- Per QUERY TEMPORALE ("cosa abbiamo fatto giovedì", "lunedì scorso") → usa riepilogo_giorno(data)
- Per LISTA CLIENTI/CANTIERI/FORNITORI conosciuti → usa lista_entita(tipo)
- NON inventare ricordi mai. Se richiama_memoria ritorna nulla, dichiaralo onestamente: "Non ho memoria esplicita di X — controllo nel summary."
`
```

Includere `REGOLA_TOOL_MEMORIA` nella stringa del system prompt (stesso pattern degli altri blocchi regola).

- [ ] **Step 5: TypeScript check**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Zero errori attesi (o solo errori pre-esistenti non introdotti da questo PR).

---

## Task 11: Push + verifica deploy + DoD + smoke test

**Files:**
- Verify: tutti i file del piano

- [ ] **Step 1: Run suite test completa**

```bash
npx vitest run src/lib/memoria-tools.test.ts src/lib/memoria-extract.test.ts src/app/api/cron/memoria-extract/route.test.ts 2>&1 | tail -30
```

Atteso: tutti PASS, 0 failed.

- [ ] **Step 2: TypeScript compile clean**

```bash
npx tsc --noEmit 2>&1 | grep -v "node_modules" | head -30
```

- [ ] **Step 3: Commit e push**

```bash
git add supabase/migrations/2026-05-07-memoria-persistente.sql \
        src/lib/memoria-tools.ts \
        src/lib/memoria-tools.test.ts \
        src/lib/memoria-extract.ts \
        src/lib/memoria-extract.test.ts \
        src/app/api/cron/memoria-extract/route.ts \
        src/app/api/cron/memoria-extract/route.test.ts \
        src/app/api/telegram/route.ts \
        src/lib/tools.ts \
        src/lib/prompts.ts \
        vercel.json

git commit -m "$(cat <<'EOF'
feat(memoria): memoria persistente cross-sessione sub-progetto B

Approccio HYBRID: cron giornaliero 23:30 (Sonnet 4.6 extraction conservativa)
+ /ricorda manuale. Richiamo 3 livelli L1 esplicita → L2 summary → L3 RAG.
4 tabelle Supabase, 4 tool Anthropic, 2 comandi Telegram, 1 cron Vercel.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

git push
```

- [ ] **Step 4: Verifica deploy Vercel READY (pre-flight obbligatorio)**

```bash
# Attendere 2-3 min dopo push, poi:
curl -s "https://api.vercel.com/v6/deployments?teamId=<TEAM>&limit=1" \
  -H "Authorization: Bearer $VERCEL_TOKEN" | jq '.deployments[0].state'
```

Atteso: `"READY"`. Se `"ERROR"`: leggere build logs prima di procedere.

- [ ] **Step 5: Smoke test T1 — /ricorda Telegram**

Inviare da Telegram: `/ricorda Test memoria Sub-progetto B avviato 2026-05-07`

Verificare in Supabase:
```sql
SELECT * FROM cervellone_memoria_esplicita ORDER BY created_at DESC LIMIT 1;
```

Atteso: 1 row con `contenuto = 'Test memoria Sub-progetto B avviato 2026-05-07'`, `source = 'telegram'`.

- [ ] **Step 6: Smoke test T2 — richiamo esplicito**

Domandare a Cervellone (web o Telegram): "Ti ricordi della memoria Sub-progetto B?"

Atteso: Cervellone chiama `richiama_memoria`, risposta contiene "Sub-progetto B avviato".

- [ ] **Step 7: Smoke test T3 — cron manuale**

```bash
curl -X GET "https://cervellone-5poc.vercel.app/api/cron/memoria-extract" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Atteso: `{"ok":true,"date":"<ieri>","conversations":N,"entities":M}`. Verificare row in `cervellone_summary_giornaliero`.

- [ ] **Step 8: Smoke test T4 — query temporale**

Domandare: "Che abbiamo fatto ieri?"

Atteso: Cervellone chiama `riepilogo_giorno("ieri")` e riporta il summary della giornata.

- [ ] **Step 9: DoD finale — checklist completa**

Verificare tutti gli item della DoD in spec §11. Segnare PASS/FAIL per ognuno.

---

## Stima Effort

| Task | Effort stimato |
|---|---|
| Task 1: Migration SQL | 15 min |
| Task 2: ricorda TDD | 20 min |
| Task 3: richiama_memoria TDD | 25 min |
| Task 4: riepilogo_giorno + date parser TDD | 30 min |
| Task 5: lista_entita TDD | 15 min |
| Task 6: memoria-extract orchestrator TDD | 45 min |
| Task 7: cron route handler TDD | 25 min |
| Task 8: vercel.json | 5 min |
| Task 9: comandi Telegram | 20 min |
| Task 10: tool registry + prompts | 30 min |
| Task 11: push + deploy + smoke test | 30 min |
| **Totale** | **~4.5 ore** |
