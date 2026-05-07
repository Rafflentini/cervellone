# Cervellone — Gmail Classification automatica (Sub-progetto C)

> **Per agenti:** SKILL OBBLIGATORIA `superpowers:subagent-driven-development` o `superpowers:executing-plans`. Task bite-sized 3-8 min.

**Goal:** Classifier Gmail automatico in 5 categorie data-driven con label persistenti `Cervellone/*`. Batch 8:30 lun-ven, Sonnet 4.6, threshold 0.7.

**Architecture:** 1 tabella `cervellone_gmail_categorie` + ALTER CHECK su `gmail_processed_messages.bot_action`, 1 modulo `gmail-classify.ts` (5 funzioni), 1 cron route, schedule vercel.json. Riusa `applyLabel`/`listInbox` esistenti.

**Tech Stack:** Next.js 16, TypeScript strict, Supabase, Anthropic Sonnet 4.6, googleapis, Vercel cron, vitest.

**Spec:** `docs/superpowers/specs/2026-05-07-cervellone-gmail-classification-design.md`

## File Structure

| File | Tipo | Responsabilità |
|---|---|---|
| `supabase/migrations/2026-05-07-gmail-classification.sql` | Create | Tabella + seed 5 + ALTER CHECK + config |
| `src/lib/gmail-classify.ts` | Create | 5 funzioni: loadCategories, buildPrompt, classifyEmail, applyClassification, runGmailClassify |
| `src/lib/gmail-classify.test.ts` | Create | Unit test mock Anthropic+Supabase+gmail-tools |
| `src/app/api/cron/gmail-classify/route.ts` | Create | Vercel cron handler |
| `vercel.json` | Modify | Aggiungere schedule |

## Task 1: Migration SQL

**Files:** Create `supabase/migrations/2026-05-07-gmail-classification.sql`

Contenuto SQL letterale dalla spec §4.1.

Step 1-3: crea file, applica migration via Supabase SQL editor, verifica:
```sql
SELECT name, enabled FROM cervellone_gmail_categorie ORDER BY id;
-- 5 righe enabled=t
SELECT key, value FROM cervellone_config WHERE key='gmail_classify_last_run';
-- 1 riga value='null'
```

Step 4: test CHECK extended:
```sql
INSERT INTO gmail_processed_messages (message_id, thread_id, bot_action) VALUES ('t1','tt1','classified');
INSERT INTO gmail_processed_messages (message_id, thread_id, bot_action) VALUES ('t2','tt2','classified_skip');
DELETE FROM gmail_processed_messages WHERE message_id IN ('t1','t2');
```

**DoD:** 5 seed presenti, CHECK accetta nuovi valori, config key creata.

## Task 2: TDD `loadCategories` + `buildPrompt`

**Files:** Create `src/lib/gmail-classify.ts` (skeleton + 2 funzioni), Create `src/lib/gmail-classify.test.ts` (3 test).

Step 1 RED — test:
- `loadCategories returns enabled categories sorted by id`
- `buildPrompt includes all category names + descriptions in markdown`
- `buildPrompt empty categories throws`

Step 2 GREEN:
```ts
import { supabase } from './supabase'

export interface Category { name: string; description: string }

export async function loadCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('cervellone_gmail_categorie')
    .select('name, description')
    .eq('enabled', true)
    .order('id')
  if (error) throw new Error(`loadCategories: ${error.message}`)
  return (data ?? []) as Category[]
}

export function buildPrompt(categories: Category[]): string {
  if (categories.length === 0) throw new Error('No categories configured')
  const lines = categories.map(c => `- ${c.name}: ${c.description}`).join('\n')
  return `Sei un classificatore di mail per uno studio tecnico/edile italiano.\n\nCategorie disponibili:\n${lines}\n\nOutput JSON (no markdown, no commenti):\n{"category": "<nome esatto categoria o null>", "confidence": <0-1>, "reason": "1-2 frasi"}\n\nSe nessuna categoria adatta o ambiguo: {"category": null, "confidence": 0, "reason": "..."}`
}
```

Step 3: `npx vitest run src/lib/gmail-classify.test.ts` → green.

## Task 3: TDD `classifyEmail`

**Files:** Modify gmail-classify.ts (+1 funzione), Modify test (+4).

Step 1 RED — test:
- valid JSON high confidence → returns category
- low confidence (0.4) → still parses, returns it
- malformed JSON → null safe (no throw)
- extracts text block from content[]

Mock Anthropic come in `memoria-extract.test.ts`.

Step 2 GREEN:
```ts
export interface ClassifyResult {
  category: string | null
  confidence: number
  reason: string
  inputTokens: number
  outputTokens: number
}

export async function classifyEmail(
  mail: { subject: string; from: string; snippet: string },
  systemPrompt: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  model: string,
): Promise<ClassifyResult> {
  const userMsg = `Subject: ${mail.subject}\nFrom: ${mail.from}\nSnippet: ${(mail.snippet || '').slice(0, 500)}`
  const resp = await client.messages.create({
    model,
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMsg }],
  })
  const inputTokens = resp.usage?.input_tokens ?? 0
  const outputTokens = resp.usage?.output_tokens ?? 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const block = resp.content.find((b: any) => b.type === 'text')
  if (!block || block.type !== 'text') {
    return { category: null, confidence: 0, reason: 'no text block', inputTokens, outputTokens }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parsed = JSON.parse((block as any).text)
    return {
      category: typeof parsed.category === 'string' ? parsed.category : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      inputTokens,
      outputTokens,
    }
  } catch {
    return { category: null, confidence: 0, reason: 'parse error', inputTokens, outputTokens }
  }
}
```

**DoD:** 7 test totali green.

## Task 4: TDD `applyClassification`

**Files:** Modify gmail-classify.ts (+1 funzione), Modify test (+4).

Step 1 RED — test:
- high confidence + valid category → applyLabel + recordBotAction('classified')
- low confidence (0.5) → no applyLabel, recordBotAction('classified_skip')
- null category → skip
- sanitize: '/' → '-'

Mock gmail-tools applyLabel + recordBotAction.

Step 2 GREEN:
```ts
import { applyLabel, recordBotAction } from './gmail-tools'

export const CONFIDENCE_THRESHOLD = 0.7
const LABEL_PREFIX = 'Cervellone/'

export async function applyClassification(
  mail: { id: string; threadId: string; from: string; subject: string },
  result: ClassifyResult,
  knownCategories: Set<string>,
): Promise<{ applied: boolean }> {
  const valid =
    result.category !== null &&
    knownCategories.has(result.category) &&
    result.confidence >= CONFIDENCE_THRESHOLD

  if (!valid) {
    await recordBotAction(mail.id, mail.threadId, 'classified_skip', mail.from, mail.subject)
    return { applied: false }
  }

  const safeName = result.category!.replace(/\//g, '-')
  const labelName = `${LABEL_PREFIX}${safeName}`
  await applyLabel(mail.id, labelName)
  await recordBotAction(mail.id, mail.threadId, 'classified', mail.from, mail.subject)
  return { applied: true }
}
```

**DoD:** 11 test totali green.

## Task 5: TDD `runGmailClassify` orchestrator

**Files:** Modify gmail-classify.ts (+1 funzione + cost helper), Modify test (+5).

Step 1 RED — test:
- 0 categorie → throw
- 0 mail → processed=0
- filter già processate
- 3 mail (2 classify + 1 skip), cost > 0
- batchMax respected

Step 2 GREEN:
```ts
import Anthropic from '@anthropic-ai/sdk'
import { listInbox } from './gmail-tools'
import { getActiveModel } from './circuit-breaker'

export interface RunOpts { sinceDays?: number; batchMax?: number }
export interface RunResult {
  ok: boolean
  processed: number
  classified: number
  skipped: number
  cost_usd: number
  errors: number
}

function estimateCost(input: number, output: number): number {
  return parseFloat(((input * 0.000003) + (output * 0.000015)).toFixed(6))
}

export async function runGmailClassify(opts: RunOpts = {}): Promise<RunResult> {
  const sinceDays = opts.sinceDays ?? 3
  const batchMax = opts.batchMax ?? 50

  const categories = await loadCategories()
  const knownNames = new Set(categories.map(c => c.name))
  const prompt = buildPrompt(categories)

  const inboxMails = await listInbox({ sinceDays, maxResults: 100 })
  if (inboxMails.length === 0) {
    return { ok: true, processed: 0, classified: 0, skipped: 0, cost_usd: 0, errors: 0 }
  }

  const ids = inboxMails.map(m => m.id)
  const { data: processed } = await supabase
    .from('gmail_processed_messages')
    .select('message_id, bot_action')
    .in('message_id', ids)
    .in('bot_action', ['classified', 'classified_skip'])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seen = new Set((processed ?? []).map((r: any) => r.message_id))
  const candidates = inboxMails.filter(m => !seen.has(m.id)).slice(0, batchMax)

  const circuitModel = await getActiveModel()
  const model = circuitModel.includes('opus') ? 'claude-sonnet-4-6' : circuitModel
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  let classified = 0
  let skipped = 0
  let errors = 0
  let totalIn = 0
  let totalOut = 0

  for (const mail of candidates) {
    try {
      const result = await classifyEmail(
        { subject: mail.subject, from: mail.from, snippet: mail.snippet },
        prompt, client, model,
      )
      totalIn += result.inputTokens
      totalOut += result.outputTokens
      const { applied } = await applyClassification(
        { id: mail.id, threadId: mail.threadId, from: mail.from, subject: mail.subject },
        result, knownNames,
      )
      if (applied) classified++; else skipped++
    } catch (err) {
      errors++
      console.error(`[gmail-classify] error processing ${mail.id}:`, err)
    }
  }

  return {
    ok: true,
    processed: candidates.length,
    classified,
    skipped,
    cost_usd: estimateCost(totalIn, totalOut),
    errors,
  }
}
```

**DoD:** 16 test totali green.

## Task 6: Route `/api/cron/gmail-classify/route.ts`

**Files:** Create.

Pattern identico a `gmail-morning/route.ts`:
- Auth Bearer CRON_SECRET (401 else)
- Silent mode (`gmail_silent_until`)
- Idempotency (`gmail_classify_last_run === today`)
- `runGmailClassify({ sinceDays: 3, batchMax: 50 })`
- UPDATE config last_run = today
- Return JSON con metriche

## Task 7: vercel.json schedule

**Files:** Modify vercel.json.

Aggiungi:
```json
{ "path": "/api/cron/gmail-classify", "schedule": "30 7 * * 1-5" }
```

7:30 UTC = 8:30 inverno / 9:30 estate Rome (dopo gmail-morning).

## Task 8: Push + verifica deploy + smoke

Commit + push. Verifica deploy READY. Smoke test:
1. curl prod cron endpoint con CRON_SECRET → ok
2. Apertura Gmail: verifica label `Cervellone/*`
3. Verifica costo Anthropic console < $0.50

**Effort totale stimato: 6-8h.**
