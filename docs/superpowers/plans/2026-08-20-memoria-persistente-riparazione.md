# Riparazione memoria persistente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Far sì che il lavoro fatto con Cervellone entri davvero in memoria persistente, invece di essere scartato in silenzio ogni notte.

**Architecture:** Quattro riparazioni indipendenti sulla catena della memoria (estrazione notturna, sanitizzazione, persistenza messaggi, ricerca) più il cablaggio di `auto-debrief`, già scritto e testato ma mai collegato. Ogni task è isolato, testabile da solo e committabile da solo.

**Tech Stack:** Next.js 15 (App Router), TypeScript, Supabase (Postgres), Anthropic SDK, Vitest.

**Spec:** questo documento. Diagnosi completa nella sezione seguente.

## Diagnosi verificata sui dati di produzione (20 ago 2026)

| Misura | Valore |
|---|---|
| Righe in `cervellone_summary_giornaliero` | 89 |
| Di cui con contenuto reale | **0** |
| Righe in `cervellone_entita_menzionate` | **0** |
| Run marcati `ok` | 89 |
| Primo giorno | 2026-05-19 |

Prova del meccanismo, da `api_usage` con `entry_point='cron:memoria'`:

| Giorno estratto | input_tokens | output_tokens |
|---|---|---|
| 2026-08-17 | 45.398 | **1024** (= `max_tokens`, troncato) |
| 2026-08-05 | 28.825 | **1024** (= `max_tokens`, troncato) |
| 2026-07-03 | 1.696 | 189 (completo) |

Catena causale: transcript grande → risposta tagliata a `max_tokens` → JSON incompleto → `JSON.parse` lancia → il `catch` a `memoria-extract.ts:207-210` scarta la conversazione con un `console.warn` → `allSummaries` resta vuoto → la riga 231 scrive il fallback `Nessuna attività rilevante` → il run viene marcato `ok`.

Più intensa è la giornata, più è certo che venga persa.

## Global Constraints

- Nessuna modifica di schema DB in questo piano: nessuna migration, solo codice.
- Ogni task termina con `npx vitest run` verde sull'intera suite. Baseline attuale: **890 passed, 4 skipped**.
- Ogni task termina con `npx tsc --noEmit` pulito.
- Niente `any` nuovo: il progetto è in strict mode.
- I test seguono lo stile dei file di test già presenti nella stessa cartella: i mock di `@/lib/supabase` e del client Anthropic esistono già in `src/lib/memoria-extract.test.ts`.
- Commit in italiano, all'imperativo, come lo storico del repo.
- Il build completo NON va eseguito nei worktree: manca `.env.local` e fallisce con `supabaseUrl is required`. Usare `tsc` + `vitest`.

---

### Task 1: L'estrattore non perde più le giornate intense

Il difetto che ha svuotato tre mesi di memoria. Tre cause vanno rimosse insieme, perché una sola non basta: il tetto di output troppo basso, il transcript non spezzato, e il fallimento silenzioso.

**Files:**
- Modify: `src/lib/memoria-extract.ts` — costanti in testa, e il ciclo di estrazione alle righe 177-215
- Test: `src/lib/memoria-extract.test.ts`

**Interfaces:**
- Produces: `export function chunkTranscript(transcript: string, budget?: number): string[]`
- Produces: `export function parseExtraction(text: string): ExtractionPayload | null`
- Produces: `export interface ExtractionPayload { summary?: string; entita?: Array<{ name: string; type: string; context: string }>; eventi?: Array<{ data_iso?: string; descrizione: string }> }`
- `ExtractResult` guadagna il campo opzionale `skipped_chunks?: number`

- [ ] **Step 1: Scrivi il test che riproduce il guasto**

In `src/lib/memoria-extract.test.ts`, col client Anthropic mockato in modo che la risposta sia JSON troncato, esattamente come in produzione:

```ts
it('una risposta troncata non fa sparire la giornata', async () => {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: '{"summary":"Contenzioso Blasi, calcolo del 15%","entita":[{"name":"Blasi Giuse' }],
    usage: { input_tokens: 28825, output_tokens: 1024 },
    stop_reason: 'max_tokens',
  })

  const res = await runMemoriaExtract('2026-08-05')

  expect(res.skipped_chunks).toBeGreaterThan(0)
  expect(upsertedSummary.summary_text).not.toBe('Nessuna attività rilevante')
})
```

- [ ] **Step 2: Esegui il test e verifica che fallisce**

Run: `npx vitest run src/lib/memoria-extract.test.ts -t "risposta troncata"`
Expected: FAIL — oggi `skipped_chunks` è `undefined` e `summary_text` è la frase di ripiego.

- [ ] **Step 3: Aggiungi `chunkTranscript` con il suo test**

In testa a `src/lib/memoria-extract.ts`:

```ts
const CHUNK_CHAR_BUDGET = 40_000
const MAX_OUTPUT_TOKENS = 4096

/** Spezza il transcript sui confini di riga, senza mai superare budget caratteri. */
export function chunkTranscript(transcript: string, budget = CHUNK_CHAR_BUDGET): string[] {
  if (transcript.length <= budget) return [transcript]
  const chunks: string[] = []
  let cur = ''
  for (const rawLine of transcript.split('\n')) {
    const parts = Math.max(1, Math.ceil(rawLine.length / budget))
    for (let i = 0; i < parts; i++) {
      const piece = rawLine.slice(i * budget, (i + 1) * budget)
      if (cur.length + piece.length + 1 > budget && cur.length > 0) {
        chunks.push(cur)
        cur = ''
      }
      cur += (cur ? '\n' : '') + piece
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}
```

Test da aggiungere:

```ts
it('chunkTranscript non supera il budget e non perde caratteri', () => {
  const t = Array.from({ length: 5000 }, (_, i) => `[user]: riga numero ${i}`).join('\n')
  const chunks = chunkTranscript(t, 10_000)
  expect(chunks.length).toBeGreaterThan(1)
  for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10_000)
  expect(chunks.join('\n').replace(/\n/g, '')).toBe(t.replace(/\n/g, ''))
})
```

- [ ] **Step 4: Aggiungi `parseExtraction` con il suo test**

```ts
export interface ExtractionPayload {
  summary?: string
  entita?: Array<{ name: string; type: string; context: string }>
  eventi?: Array<{ data_iso?: string; descrizione: string }>
}

/** Legge il JSON anche se il modello lo incornicia o lo fa precedere da testo. Null se irrecuperabile. */
export function parseExtraction(text: string): ExtractionPayload | null {
  const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  try {
    return JSON.parse(cleaned) as ExtractionPayload
  } catch {
    // passa al recupero
  }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as ExtractionPayload
    } catch {
      // irrecuperabile
    }
  }
  return null
}
```

Test da aggiungere:

```ts
it('parseExtraction recupera JSON incorniciato o preceduto da testo', () => {
  expect(parseExtraction('```json\n{"summary":"ok"}\n```')?.summary).toBe('ok')
  expect(parseExtraction('Ecco il risultato:\n{"summary":"ok"}')?.summary).toBe('ok')
  expect(parseExtraction('{"summary":"tronc')).toBeNull()
})
```

- [ ] **Step 5: Riscrivi il ciclo di estrazione**

Sostituisci l'intero blocco `for (const [convId, convMsgs] of groups.entries()) { ... }` (righe 177-215) con:

```ts
let skippedChunks = 0

for (const [convId, convMsgs] of groups.entries()) {
  const transcript = convMsgs
    .map(m => `[${m.role}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')

  const chunks = chunkTranscript(transcript)

  for (let i = 0; i < chunks.length; i++) {
    let resp
    try {
      resp = await client.messages.create({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: EXTRACTION_PROMPT,
        messages: [{
          role: 'user',
          content: `Conversazione (${convId}) — parte ${i + 1} di ${chunks.length}:\n${chunks[i]}`,
        }],
      })
    } catch (err) {
      skippedChunks++
      console.warn(`[memoria-extract] parte ${i + 1}/${chunks.length} di ${convId} fallita: ${(err as Error).message}`)
      continue
    }

    totalInputTokens += resp.usage?.input_tokens ?? 0
    totalOutputTokens += resp.usage?.output_tokens ?? 0
    totalCacheReadTokens += (resp.usage as { cache_read_input_tokens?: number })?.cache_read_input_tokens ?? 0
    totalCacheCreationTokens += (resp.usage as { cache_creation_input_tokens?: number })?.cache_creation_input_tokens ?? 0

    const textBlock = resp.content.find((b): b is AnthropicTextBlock => b.type === 'text')
    const parsed = textBlock ? parseExtraction(textBlock.text) : null

    if (!parsed) {
      skippedChunks++
      console.warn(`[memoria-extract] parte ${i + 1}/${chunks.length} di ${convId} illeggibile (stop_reason=${resp.stop_reason}) — scartata`)
      continue
    }
    if (parsed.summary) allSummaries.push(parsed.summary)
    if (Array.isArray(parsed.entita)) allEntita.push(...parsed.entita)
  }
}
```

Nota importante per chi implementa: il `throw err` che c'era nel `catch` sparisce. Un errore su una singola conversazione non deve più far cadere l'intera giornata.

- [ ] **Step 6: Rendi visibile il fallimento**

Un run che ha buttato via del contenuto non può più dichiararsi `ok`. Nel punto in cui si scrive lo stato finale, righe ~264-270:

```ts
status: skippedChunks > 0 ? 'partial' : 'ok',
error_message: skippedChunks > 0 ? `${skippedChunks} parti illeggibili scartate` : null,
```

e aggiungi `skipped_chunks: skippedChunks` all'oggetto `ExtractResult` ritornato.

- [ ] **Step 7: Esegui i test del file**

Run: `npx vitest run src/lib/memoria-extract.test.ts`
Expected: PASS, compreso il test dello Step 1.

- [ ] **Step 8: Suite completa e typecheck**

Run: `npx vitest run` poi `npx tsc --noEmit`
Expected: 890+ passed, zero errori TypeScript.

- [ ] **Step 9: Commit**

```bash
git add src/lib/memoria-extract.ts src/lib/memoria-extract.test.ts
git commit -m "fix(memoria): le giornate intense non spariscono piu nell estrazione notturna"
```

---

### Task 2: Il filtro anti-segreti non distrugge più i numeri di protocollo

`Ass.Blasi_50%_ASID 00326273-00376303-3K881C.pdf` è finito nello storico come `Ass.Blasi_50%_ASID [REDACTED]-3K881C.pdf`: il pattern delle carte di credito ha scambiato il protocollo ENEA per un numero di carta. In uno studio tecnico i numeri lunghi sono la norma — protocolli, partite IVA, matricole — quindi il filtro va reso preciso, non tolto.

**Files:**
- Modify: `src/lib/sanitize.ts`
- Create: `src/lib/sanitize.test.ts` — oggi non esiste alcun test su questo file

**Interfaces:**
- `sanitizeForStorage(text: string): string` resta invariata nella firma. Cambia solo il comportamento sul pattern numerico.

- [ ] **Step 1: Scrivi i test che riproducono il danno**

```ts
import { describe, it, expect } from 'vitest'
import { sanitizeForStorage } from './sanitize'

describe('sanitizeForStorage', () => {
  it('NON tocca i numeri di protocollo tecnici', () => {
    const s = 'Ass.Blasi_50%_ASID 00326273-00376303-3K881C.pdf'
    expect(sanitizeForStorage(s)).toBe(s)
  })

  it('NON tocca una partita IVA o un protocollo CILA', () => {
    const s = 'CILA-S prot. 0050230 del 23/09/2021, P.IVA 01234567890'
    expect(sanitizeForStorage(s)).toBe(s)
  })

  it('redige una vera carta di credito', () => {
    expect(sanitizeForStorage('carta 4539 1488 0343 6467')).toContain('[REDACTED]')
  })

  it('continua a redigere le chiavi API', () => {
    expect(sanitizeForStorage('sk-ant-api03-abcdefghij1234567890xyz')).toContain('[REDACTED]')
  })
})
```

- [ ] **Step 2: Esegui e verifica che i primi due falliscono**

Run: `npx vitest run src/lib/sanitize.test.ts`
Expected: FAIL sui test 1 e 2, PASS sui test 3 e 4.

- [ ] **Step 3: Sostituisci il pattern numerico con un controllo di Luhn**

In `src/lib/sanitize.ts`, togli dall'array `SENSITIVE_PATTERNS` la riga della carta di credito e aggiungi:

```ts
/** Verifica di Luhn: ogni numero di carta reale la supera, un protocollo tecnico quasi mai. */
function isLuhnValid(digits: string): boolean {
  if (digits.length < 13) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** Redige solo le sequenze numeriche che superano Luhn. */
function redactCardNumbers(text: string): string {
  return text.replace(/\b(?:\d[ -]?){13,19}\b/g, (match) => {
    const digits = match.replace(/\D/g, '')
    return isLuhnValid(digits) ? '[REDACTED]' : match
  })
}
```

e applicala in coda a `sanitizeForStorage`:

```ts
export function sanitizeForStorage(text: string): string {
  let sanitized = text
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]')
  }
  return redactCardNumbers(sanitized)
}
```

- [ ] **Step 4: Esegui i test**

Run: `npx vitest run src/lib/sanitize.test.ts`
Expected: PASS su tutti e quattro.

- [ ] **Step 5: Suite completa e typecheck**

Run: `npx vitest run` poi `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/lib/sanitize.ts src/lib/sanitize.test.ts
git commit -m "fix(sanitize): i numeri di protocollo non vengono piu scambiati per carte di credito"
```

---

### Task 3: Un turno web scrive una riga sola

Oggi ogni turno dell'app web finisce due volte in `messages`: una scritta dal browser, con i metadati dei file, e una dal server, sanitizzata e con embedding. Le righe doppie gonfiano lo storico, raddoppiano il costo dell'estrazione notturna e falsano ogni conteggio.

Scelta di progetto: **resta la scrittura del browser**, perché è quella che porta i metadati dei file e che la UI rilegge. Le si aggiungono le due cose che oggi fa solo il server: la sanitizzazione e l'embedding.

**Files:**
- Modify: `src/lib/memory.ts` — estrai la metà embedding di `saveMessageWithEmbedding`
- Modify: `src/app/api/conversations/[id]/messages/route.ts` — sanitizza prima dell'insert, indicizza dopo
- Modify: `src/lib/claude.ts` — rimuovi le scritture alle righe 407 e 536
- Test: `src/lib/memory.test.ts`, da creare se assente

**Interfaces:**
- Produces: `export async function saveEmbeddingOnly(conversationId: string, role: string, content: string, projectId?: string | null): Promise<void>` — genera e salva l'embedding di un messaggio già presente in `messages`, senza scrivere in `messages`
- `saveMessageWithEmbedding` mantiene firma e comportamento: fa l'insert e poi delega a `saveEmbeddingOnly`

- [ ] **Step 1: Scrivi il test della doppia scrittura**

```ts
it('callClaudeStream non scrive piu in messages', async () => {
  await callClaudeStream(/* argomenti minimi, come negli altri test di claude.ts */)
  expect(insertCountSu('messages')).toBe(0)
})
```

- [ ] **Step 2: Esegui e verifica che fallisce**

Expected: FAIL — oggi gli insert sono 2.

- [ ] **Step 3: Estrai `saveEmbeddingOnly` in `src/lib/memory.ts`**

Sposta tutto il corpo che segue il commento `// Skip embedding per messaggi brevi o triviali` dentro:

```ts
export async function saveEmbeddingOnly(
  conversationId: string,
  role: string,
  content: string,
  projectId?: string | null,
): Promise<void> {
  const sanitized = sanitizeForStorage(content)
  if (sanitized.length < MIN_EMBEDDING_LENGTH) return
  if (TRIVIAL_PATTERN.test(sanitized.trim())) return
  // ...corpo attuale della generazione embedding, invariato...
}
```

e riscrivi `saveMessageWithEmbedding` perché faccia l'insert in `messages` e poi chiami `saveEmbeddingOnly`.

- [ ] **Step 4: Sanitizza e indicizza nella route del browser**

In `src/app/api/conversations/[id]/messages/route.ts`: applica `sanitizeForStorage(content)` prima dell'insert — oggi il path web salva testo grezzo — e dopo l'insert riuscito chiama `saveEmbeddingOnly(id, role, content).catch(() => {})`.

- [ ] **Step 5: Rimuovi le due scritture dal path web**

In `src/lib/claude.ts`, cancella la chiamata a `saveMessageWithEmbedding` alla riga 407 e quella alla riga 536.

**Non toccare le righe 648 e 912**: sono il path Telegram, dove `messages` è la memoria di lavoro e la scrittura deve restare.

- [ ] **Step 6: Esegui i test**

Run: `npx vitest run`

- [ ] **Step 7: Typecheck e commit**

```bash
npx tsc --noEmit
git add src/lib/memory.ts src/lib/claude.ts src/app/api/conversations/
git commit -m "fix(web): un turno scrive una riga sola in messages, sanitizzata e indicizzata"
```

---

### Task 4: La ricerca in memoria cerca le parole, non la frase

`richiama_memoria` mette la domanda intera dentro un `ILIKE '%...%'`: cercando *le due lettere di risposta per Blasi* pretende quella sequenza letterale e non trova mai nulla. L'altra via di ricerca del sistema, in `memory.ts:158-176`, le parole le spezza già: qui si allineano i due comportamenti.

**Files:**
- Modify: `src/lib/memoria-tools.ts`, righe 88-150
- Test: `src/lib/memoria-tools.test.ts`

**Interfaces:**
- Produces: `export function buildSearchTokens(query: string): string[]` — parole più lunghe di 2 caratteri, minuscole, con `%` e `_` neutralizzati, massimo 6

- [ ] **Step 1: Scrivi i test che riproducono il guasto**

```ts
it('trova una memoria su Blasi anche se la domanda è una frase', async () => {
  seedMemoriaEsplicita([{ contenuto: 'Contenzioso Blasi: la controreplica poggia su art. 5.1' }])
  const res = await richiama_memoria({ query: 'le due lettere di risposta per Blasi' })
  expect(res.results.length).toBeGreaterThan(0)
})

it('buildSearchTokens neutralizza i caratteri jolly', () => {
  expect(buildSearchTokens('100% Blasi_x')).toEqual(['100\\%', 'blasi\\_x'])
})
```

- [ ] **Step 2: Esegui e verifica che fallisce**

Expected: FAIL — zero risultati.

- [ ] **Step 3: Implementa la tokenizzazione**

```ts
export function buildSearchTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 6)
    .map(w => w.replace(/[%_]/g, c => `\\${c}`))
}
```

Nelle tre query sostituisci `.ilike(col, '%' + query + '%')` con un `.or()` costruito sui token, come già fa `src/lib/memory.ts:168-176`:

```ts
const tokens = buildSearchTokens(query)
const orFilter = tokens.map(t => `${col}.ilike.%${t}%`).join(',')
```

Se `tokens` risulta vuoto — domanda fatta di sole paroline corte — ricadi sul comportamento attuale con la query intera.

- [ ] **Step 4: Esegui i test**

Run: `npx vitest run src/lib/memoria-tools.test.ts`

- [ ] **Step 5: Suite, typecheck, commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/lib/memoria-tools.ts src/lib/memoria-tools.test.ts
git commit -m "feat(memoria): la ricerca usa le parole della domanda, non la frase intera"
```

---

### Task 5: `auto-debrief` viene finalmente chiamato

`maybeRunDebrief` è scritto, testato e senza un solo chiamante in produzione. È il pezzo che salverebbe il *perché* delle decisioni — esattamente ciò che manca sul caso Blasi, dove in memoria non poteva restare che il nome del cliente.

Resta protetto dal flag `auto_debrief_enabled`, che è fail-closed a false: il cablaggio è quindi sicuro di per sé, e l'accensione è una decisione separata dell'Ingegnere.

**Files:**
- Modify: `src/lib/agent-job.ts` — in coda a `runAgentJob`, dopo l'invio della risposta
- Test: `src/lib/agent-job.debrief.test.ts`, nuovo

**Interfaces:**
- Consumes: `maybeRunDebrief(ctx)` da `src/lib/auto-debrief.ts`, dove `DebriefCtx = { conversationId: string; userText: string; transcript: string; sendSummary?: (line: string) => void }`

- [ ] **Step 1: Scrivi i test**

```ts
it('a fine turno invoca maybeRunDebrief', async () => {
  await runAgentJob({ /* input minimo, come negli altri test di agent-job */ })
  expect(maybeRunDebriefMock).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: expect.any(String), userText: expect.any(String) })
  )
})

it('un errore del debrief non fa fallire il turno', async () => {
  maybeRunDebriefMock.mockRejectedValueOnce(new Error('boom'))
  await expect(runAgentJob({ /* ... */ })).resolves.not.toThrow()
})
```

- [ ] **Step 2: Esegui e verifica che il primo fallisce**

Expected: FAIL — `maybeRunDebrief` non viene mai chiamato.

- [ ] **Step 3: Cabla la chiamata**

In coda a `runAgentJob`, **dopo** che la risposta è stata inviata all'utente:

```ts
const { maybeRunDebrief } = await import('./auto-debrief')
await maybeRunDebrief({
  conversationId,
  userText,
  transcript: history
    .map(m => `[${m.role}]: ${typeof m.content === 'string' ? m.content : ''}`)
    .join('\n'),
  sendSummary: (line) => { void sendTelegramMessage(chatId, line) },
}).catch(() => {})
```

Il `.catch` è deliberato: il debrief non deve mai poter rompere una risposta già consegnata.

- [ ] **Step 4: Esegui i test**

Run: `npx vitest run src/lib/agent-job.debrief.test.ts`

- [ ] **Step 5: Suite, typecheck, commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/lib/agent-job.ts src/lib/agent-job.debrief.test.ts
git commit -m "feat(memoria): auto-debrief viene invocato a fine turno, resta flag-gated"
```

---

### Task 6: Il cron accetta di rielaborare un giorno passato

Serve per ricostruire i tre mesi persi. Oggi `?date=` è ignorato: la route calcola sempre *ieri*, quindi nemmeno a mano si può recuperare una giornata. Verificato in `bridge/2026-05-21-smoke-post-redeploy.md`, dove uno smoke con `?date=2026-05-19` elaborò il 20.

**Files:**
- Modify: `src/app/api/cron/memoria-extract/route.ts`
- Test: `src/app/api/cron/memoria-extract/route.test.ts`, da creare se assente

- [ ] **Step 1: Scrivi i test**

```ts
it('rielabora il giorno richiesto con ?date=', async () => {
  await GET(new Request('https://x/api/cron/memoria-extract?date=2026-08-05', {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }))
  expect(runMemoriaExtractMock).toHaveBeenCalledWith('2026-08-05')
})

it('rifiuta una data malformata', async () => {
  const res = await GET(new Request('https://x/api/cron/memoria-extract?date=pippo', {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  }))
  expect(res.status).toBe(400)
})
```

- [ ] **Step 2: Esegui e verifica che fallisce**

Expected: FAIL — viene passata la data di ieri.

- [ ] **Step 3: Implementa**

```ts
const requested = new URL(req.url).searchParams.get('date')
if (requested && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
  return NextResponse.json({ ok: false, error: 'date deve essere YYYY-MM-DD' }, { status: 400 })
}
const dateTarget = requested ?? /* calcolo attuale di ieri, invariato */
```

Attenzione: il controllo di idempotenza su `memoria_extract_last_run` va **saltato** quando `requested` è presente, altrimenti la rielaborazione di un giorno passato viene scartata. L'upsert su `cervellone_summary_giornaliero` è già per data, quindi riscrivere una giornata è sicuro.

- [ ] **Step 4: Esegui i test, typecheck, commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/app/api/cron/memoria-extract/
git commit -m "feat(memoria): il cron puo rielaborare un giorno passato con ?date="
```

---

### Task 7: L'audit settimanale vede anche i run parziali

Nato durante l'esecuzione del Task 1. Il Task 1 introduce lo stato `partial` per i run che hanno scartato del contenuto, ma il collettore dell'audit conta **solo** `ok` ed `error` (`src/lib/audit-collector.ts:253-254`): un run `partial` non finirebbe in nessuno dei due conteggi e sparirebbe dalla vista. Il nuovo segnale nascerebbe già cieco.

**Files:**
- Modify: `src/lib/audit-collector.ts:253-254`
- Modify: `src/lib/audit-analyzer.ts` — accanto a `MEMORIA_GAP`
- Test: `src/lib/audit-collector.test.ts` e `src/lib/audit-analyzer.test.ts`

**Interfaces:**
- Consumes dal Task 1: lo stato `'partial'` e il campo `error_message` con il numero di parti scartate.
- Produces: il campo `partial_count` nel risultato di `collectMemoriaRuns`, e il codice anomalia `MEMORIA_PARZIALE`.

- [ ] **Step 1: Scrivi i test**

```ts
it('conta i run parziali', () => {
  const d = collectMemoriaRuns([{ status: 'partial' }, { status: 'ok' }])
  expect(d.partial_count).toBe(1)
})

it('un run parziale genera un anomalia', () => {
  const a = analyze({ memoria: { partial_count: 2, missing_dates: [] } })
  expect(a.find(x => x.code === 'MEMORIA_PARZIALE')?.severity).toBe('high')
})
```

- [ ] **Step 2: Esegui e verifica che falliscono**

- [ ] **Step 3: Implementa**

In `audit-collector.ts`, accanto a `ok_count` ed `error_count`:

```ts
const partial_count = runs.filter(r => r.status === 'partial').length
```

e includilo nell'oggetto ritornato. In `audit-analyzer.ts`, accanto al blocco `MEMORIA_GAP`:

```ts
if (d.partial_count > 0) {
  anomalies.push({
    code: 'MEMORIA_PARZIALE',
    severity: 'high',
    description: `${d.partial_count} run memoria-extract hanno scartato contenuto illeggibile.`,
    proposed_action: 'Controlla error_message dei run: alza CHUNK_CHAR_BUDGET o indaga le risposte del modello.',
    raw: { partial_count: d.partial_count },
  })
}
```

Severity `high` e non `medium`: un run parziale significa memoria persa, ed è il difetto che è rimasto invisibile per tre mesi.

- [ ] **Step 4: Esegui i test, suite, typecheck, commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/lib/audit-collector.ts src/lib/audit-analyzer.ts src/lib/audit-collector.test.ts src/lib/audit-analyzer.test.ts
git commit -m "feat(audit): i run di memoria parziali non passano piu inosservati"
```

---

## Dopo il piano: la ricostruzione dei tre mesi

**Non è un task di codice, ed è una decisione dell'Ingegnere.**

Verificati in produzione il Task 1 e il Task 6, i messaggi dal 19 maggio a oggi sono ancora tutti in `messages`: si può rilanciare l'estrazione giorno per giorno e ricostruire summary ed entità, caso Blasi compreso.

Prima di lanciarla vanno stimati il costo — circa 90 giornate, con i volumi visibili in `api_usage` — e l'esito su una sola giornata di prova. Il candidato naturale è il **2026-08-05**: sappiamo esattamente cosa deve uscirne, e quindi sapremo riconoscere se è uscito bene.
