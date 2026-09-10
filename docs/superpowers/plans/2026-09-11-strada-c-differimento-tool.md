# Strada C — differimento dei tool: piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** far scendere il contesto di ogni turno da 46.915 a ~18.244 token differendo le definizioni dei tool e lasciando che sia il modello a cercarle, senza togliere nessuna capacità.

**Architecture:** `getToolDefinitions()` prende un parametro **facoltativo**: senza, il comportamento è identico a oggi. Con il parametro, ogni tool fuori dal nucleo riceve `defer_loading: true` e in testa all'elenco viene dichiarato `tool_search_tool_bm25_20251119`, il tool server dell'API che il modello usa per scoprire da sé quello che gli serve. `executeTool` e il loop **non si toccano**. Un interruttore d'ambiente permette di tornare indietro senza deploy.

**Tech Stack:** TypeScript, Next.js, vitest, `@anthropic-ai/sdk`, Supabase.

**Spec:** `docs/superpowers/specs/2026-09-11-strada-c-differimento-tool-design.md`

## Global Constraints

- **Modello di produzione: `claude-sonnet-4-6`.** La ricerca dei tool è GA, **senza beta header**, e su questo modello è stata provata.
- **Nessun tool viene cancellato.** Il differimento cambia *quando* si caricano, non *se* esistono.
- **`executeTool` (`src/lib/tools.ts:895-901`) non cambia comportamento.** Definizione ed esecuzione sono disaccoppiate: la catena `EXECUTORS` non consulta mai le definizioni.
- **Il `BASE_PROMPT` non si tocca in questo piano.** È il Passo 2, ha un disegno suo.
- **Il database non si tocca** nei suoi contenuti appresi (skill, regole, memorie, modelli). L'unica scrittura nuova è una tabella nuova.
- **I 2.203 test di `main` restano verdi.** Linea di base misurata l'11 set: `npx vitest run` → 2203 passati, 4 saltati, 174 file totali (173 passati + 1 saltato), 41s.
- **`npx tsc --noEmit` deve restare COMPLETAMENTE pulito, a ogni task.** Misurato su `90aadcc`: `main` è pulito, zero righe di output. ⚠️ Questo vincolo è stato aggiunto *dopo* il Task 1, che aveva lasciato 5 errori nel suo file di test senza che nessuno se ne accorgesse: la revisione guardava i test, non il typecheck.
- **Il tipo `ToolDefinition`** (`src/lib/tools/types.ts`) è `{ name, description, input_schema }`. Il differimento aggiunge `defer_loading?: boolean`.
- **Nessun merge su `main`.** Il ramo è `feat/strada-c-differimento-tool`; il merge lo decide Raffaele.
- **I sorgenti sono CRLF.** Mai `Get-Content -Raw` + `Set-Content`; per le mutazioni `cp` + `perl -0pi` + `md5sum` di prova.

---

### Task 1: Il registro delle chiamate ai tool

Senza questo non si può scegliere il nucleo su prove, e una capacità persa resterebbe invisibile. Va in produzione **da solo**, prima del differimento.

**Files:**
- Create: `supabase/migrations/2026-09-11-registro-chiamate-tool.sql`
- Create: `src/lib/tool-call-log.ts`
- Modify: `src/lib/tools.ts:895-901` (`executeTool`)
- Test: `src/lib/tool-call-log.test.ts`

**Interfaces:**
- Produces: `registraChiamataTool(nome: string, conversationId: string | undefined, durataMs: number, riconosciuto: boolean): void` — **non ritorna una promessa e non lancia mai**.

- [ ] **Step 1: Scrivere la migrazione**

```sql
-- Registro delle chiamate ai tool. Serve a due cose:
-- 1) scegliere il nucleo dei tool su dati veri invece che a intuito;
-- 2) accorgersi se un tool smette di essere raggiunto dopo il differimento.
-- Senza, un guasto si travestirebbe da colpa dell'utente.
create table if not exists cervellone_tool_calls (
  id bigserial primary key,
  nome text not null,
  conversation_id uuid,
  durata_ms integer,
  riconosciuto boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_tool_calls_created on cervellone_tool_calls (created_at desc);
create index if not exists idx_tool_calls_nome on cervellone_tool_calls (nome, created_at desc);
```

- [ ] **Step 2: Scrivere il test che fallisce**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'

const insert = vi.fn(() => Promise.resolve({ data: null, error: null }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: () => ({ insert }) }),
}))

import { registraChiamataTool } from './tool-call-log'

describe('registro delle chiamate ai tool', () => {
  beforeEach(() => insert.mockClear())

  it('registra nome, conversazione, durata e riconoscimento', async () => {
    registraChiamataTool('read_email', '11111111-1111-1111-1111-111111111111', 42, true)
    await new Promise((r) => setImmediate(r))
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert.mock.calls[0][0]).toMatchObject({
      nome: 'read_email',
      conversation_id: '11111111-1111-1111-1111-111111111111',
      durata_ms: 42,
      riconosciuto: true,
    })
  })

  it('NON lancia e NON restituisce una promessa se il database e giu', () => {
    insert.mockImplementationOnce(() => Promise.reject(new Error('supabase giu')))
    expect(() => registraChiamataTool('read_email', undefined, 1, true)).not.toThrow()
    expect(registraChiamataTool('x', undefined, 1, true)).toBeUndefined()
  })
})
```

- [ ] **Step 3: Eseguire il test e verificare che fallisca**

Run: `npx vitest run src/lib/tool-call-log.test.ts`
Expected: FAIL — `Cannot find module './tool-call-log'`

- [ ] **Step 4: Scrivere l'implementazione minima**

```typescript
// src/lib/tool-call-log.ts
import { supabase } from './supabase'

/**
 * Registra UNA chiamata a un tool. Fire-and-forget deliberato: il registro serve
 * a osservare, non a funzionare. Se Supabase e giu il turno dell'Ingegnere non
 * deve accorgersene — per questo non ritorna una promessa e non lancia mai.
 */
export function registraChiamataTool(
  nome: string,
  conversationId: string | undefined,
  durataMs: number,
  riconosciuto: boolean,
): void {
  try {
    const p = supabase.from('cervellone_tool_calls').insert({
      nome,
      conversation_id: conversationId ?? null,
      durata_ms: durataMs,
      riconosciuto,
    })
    void Promise.resolve(p).catch(() => {})
  } catch {
    // volutamente muto
  }
}
```

- [ ] **Step 5: Eseguire il test e verificare che passi**

Run: `npx vitest run src/lib/tool-call-log.test.ts`
Expected: PASS (2 test)

- [ ] **Step 6: Agganciare `executeTool`**

Sostituire `src/lib/tools.ts:895-901` con:

```typescript
export async function executeTool(name: string, input: Record<string, unknown>, conversationId?: string): Promise<string> {
  const inizio = Date.now()
  for (const executor of EXECUTORS) {
    const result = await executor(name, input, conversationId)
    if (result !== null) {
      registraChiamataTool(name, conversationId, Date.now() - inizio, true)
      return result
    }
  }
  registraChiamataTool(name, conversationId, Date.now() - inizio, false)
  return `Tool "${name}" non riconosciuto.`
}
```

E in testa al file, accanto agli altri import: `import { registraChiamataTool } from './tool-call-log'`

- [ ] **Step 7: Scrivere il test d'aggancio, col controllo positivo**

Aggiungere a `src/lib/tool-call-log.test.ts` un secondo `describe`:

```typescript
describe('aggancio in executeTool', () => {
  it('registra il tool eseguito e restituisce il risultato invariato', async () => {
    const { executeTool } = await import('./tools')
    const out = await executeTool('cervellone_info', {}, undefined)
    expect(typeof out).toBe('string')
    await new Promise((r) => setImmediate(r))
    expect(insert.mock.calls.map((c) => (c[0] as { nome: string }).nome)).toContain('cervellone_info')
  })

  // CONTROLLO POSITIVO: prova che il test sopra saprebbe accorgersi di un nome
  // sbagliato. Senza questo, "contiene cervellone_info" passerebbe anche se
  // registrassimo sempre la stessa stringa fissa.
  it('un tool inesistente viene registrato come NON riconosciuto', async () => {
    const { executeTool } = await import('./tools')
    const out = await executeTool('tool_che_non_esiste_xyz', {}, undefined)
    expect(out).toContain('non riconosciuto')
    await new Promise((r) => setImmediate(r))
    const riga = insert.mock.calls.map((c) => c[0] as { nome: string; riconosciuto: boolean })
      .find((r) => r.nome === 'tool_che_non_esiste_xyz')
    expect(riga?.riconosciuto).toBe(false)
  })
})
```

- [ ] **Step 8: Eseguire la suite intera**

Run: `npx vitest run`
Expected: 2203 + 4 nuovi passati, 4 saltati. **Nessun test rosso preesistente.**

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/2026-09-11-registro-chiamate-tool.sql src/lib/tool-call-log.ts src/lib/tool-call-log.test.ts src/lib/tools.ts
git commit -m "prima di differire, vedere: un registro delle chiamate ai tool"
```

---

### Task 2: `getToolDefinitions` accetta un nucleo — additivo, senza cambiare niente

**Files:**
- Modify: `src/lib/tools.ts:887-893`
- Modify: `src/lib/tools/types.ts`
- Test: `src/lib/tools.differimento.test.ts`

**Interfaces:**
- Consumes: niente dai task precedenti.
- Produces: `getToolDefinitions(opzioni?: OpzioniTool)` dove `interface OpzioniTool { nucleo?: ReadonlySet<string>; ricerca?: boolean }`. **Senza argomenti l'output è byte per byte quello di oggi.**

- [ ] **Step 1: Scrivere il test che fallisce**

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { getToolDefinitions } from './tools'

type Def = { name: string; defer_loading?: boolean; type?: string }

describe('differimento delle definizioni dei tool', () => {
  it('SENZA opzioni l output e identico a prima: nessun defer_loading, nessuna ricerca', () => {
    const defs = getToolDefinitions() as Def[]
    expect(defs.some((d) => d.defer_loading !== undefined)).toBe(false)
    expect(defs.some((d) => d.type?.startsWith('tool_search'))).toBe(false)
  })

  it('col nucleo, i tool fuori dal nucleo sono differiti e quelli dentro no', () => {
    const nucleo = new Set(['cervellone_info', 'cerca_documenti'])
    const defs = getToolDefinitions({ nucleo }) as Def[]
    const dentro = defs.find((d) => d.name === 'cervellone_info')
    const fuori = defs.find((d) => d.name === 'read_email')
    expect(dentro?.defer_loading).toBeUndefined()
    expect(fuori?.defer_loading).toBe(true)
  })

  it('i due tool server non vengono MAI differiti', () => {
    const defs = getToolDefinitions({ nucleo: new Set<string>() }) as Def[]
    for (const n of ['web_search', 'code_execution']) {
      expect(defs.find((d) => d.name === n)?.defer_loading).toBeUndefined()
    }
  })

  it('con ricerca:true dichiara il tool di ricerca in testa', () => {
    const defs = getToolDefinitions({ nucleo: new Set(['cervellone_info']), ricerca: true }) as Def[]
    expect(defs[0].type).toBe('tool_search_tool_bm25_20251119')
    expect(defs[0].name).toBe('tool_search_tool_bm25')
  })

  // L'API rifiuta con 400 una richiesta in cui TUTTO e differito. Il nucleo
  // vuoto piu ricerca deve restare legale grazie ai due tool server.
  it('non differisce mai tutto: resta sempre almeno un tool caricato', () => {
    const defs = getToolDefinitions({ nucleo: new Set<string>(), ricerca: true }) as Def[]
    expect(defs.filter((d) => !d.defer_loading).length).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `npx vitest run src/lib/tools.differimento.test.ts`
Expected: FAIL — i test 2, 3, 4, 5 falliscono (`getToolDefinitions` ignora l'argomento); il test 1 passa già.

- [ ] **Step 3: Scrivere l'implementazione minima**

In `src/lib/tools/types.ts` aggiungere il campo e le opzioni:

```typescript
// Tipo condiviso delle definizioni tool esposte a Claude.
export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
  // Marcato true, il tool resta DICHIARATO nella richiesta ma non entra nel
  // contesto del modello finche' non lo trova cercandolo. L'esecuzione non
  // cambia: executeTool non guarda le definizioni.
  defer_loading?: boolean
}

export interface OpzioniTool {
  /** I tool che restano sempre caricati. Gli altri vengono differiti. */
  nucleo?: ReadonlySet<string>
  /** Dichiara il tool server con cui il modello cerca da se' quelli differiti. */
  ricerca?: boolean
}
```

In `src/lib/tools.ts` sostituire `getToolDefinitions` (righe 887-893):

```typescript
export function getToolDefinitions(opzioni?: OpzioniTool) {
  const nucleo = opzioni?.nucleo
  const custom = ALL_TOOLS.map(({ name, description, input_schema }) =>
    nucleo && !nucleo.has(name)
      ? { name, description, input_schema, defer_loading: true as const }
      : { name, description, input_schema },
  )
  return [
    // I tool server restano sempre caricati: sono due, pesano 124 byte in tutto,
    // e l'API rifiuta con 400 una richiesta in cui TUTTI i tool sono differiti.
    ...(opzioni?.ricerca ? [{ type: 'tool_search_tool_bm25_20251119' as const, name: 'tool_search_tool_bm25' }] : []),
    { type: 'web_search_20250305' as const, name: 'web_search', max_uses: 5 },
    { type: 'code_execution_20260120' as const, name: 'code_execution' },
    ...custom,
  ]
}
```

E in `src/lib/tools.ts:16` sostituire l'import (è già `import type`, e `OpzioniTool` è un tipo):

```typescript
import type { ToolDefinition, OpzioniTool } from './tools/types'
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `npx vitest run src/lib/tools.differimento.test.ts src/lib/tools.registry.test.ts`
Expected: PASS — 5 nuovi + i test del registry invariati.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.ts src/lib/tools/types.ts src/lib/tools.differimento.test.ts
git commit -m "getToolDefinitions accetta un nucleo: senza argomenti non cambia niente"
```

---

### Task 3: Il nucleo, dichiarato in un posto solo

**Files:**
- Create: `src/lib/tool-nucleo.ts`
- Test: `src/lib/tool-nucleo.test.ts`

**Interfaces:**
- Produces: `NUCLEO_TOOL: ReadonlySet<string>`.

- [ ] **Step 1: Scrivere il test che fallisce**

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { NUCLEO_TOOL } from './tool-nucleo'
import { getToolDefinitions } from './tools'

describe('il nucleo dei tool', () => {
  it('ogni nome del nucleo esiste davvero nel registro', () => {
    const esistenti = new Set((getToolDefinitions() as { name: string }[]).map((d) => d.name))
    for (const n of NUCLEO_TOOL) {
      expect(esistenti, `il nucleo nomina un tool inesistente: ${n}`).toContain(n)
    }
  })

  it('resta piccolo: un nucleo che cresce senza accorgersene annulla il guadagno', () => {
    expect(NUCLEO_TOOL.size).toBeLessThanOrEqual(15)
  })
})
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `npx vitest run src/lib/tool-nucleo.test.ts`
Expected: FAIL — `Cannot find module './tool-nucleo'`

- [ ] **Step 3: Scrivere l'implementazione minima**

```typescript
// src/lib/tool-nucleo.ts
/**
 * I tool che restano SEMPRE caricati nel contesto. Tutti gli altri vengono
 * differiti: il modello li trova cercandoli.
 *
 * CRITERIO DICHIARATO: e' di nucleo un tool che serve a CAPIRE la richiesta,
 * non a FARE il lavoro. Orientarsi (chi e' il cliente, che progetto e', cosa
 * si e' detto prima) deve essere possibile senza cercare niente.
 *
 * ⚠️ Questa e' un'IPOTESI, non una scelta su prove: l'11 settembre 2026 non
 * esisteva ancora nessun registro delle chiamate ai tool. Va rivista sui dati
 * di `cervellone_tool_calls` dopo una settimana di uso vero.
 */
export const NUCLEO_TOOL: ReadonlySet<string> = new Set([
  'cerca_documenti',          // cosa e' gia' stato prodotto
  'ricorda',                  // fissare un fatto
  'richiama_memoria',         // cosa si e' gia' detto
  'lista_entita',             // chi sono clienti, cantieri, fornitori
  'lista_scadenze',           // cosa incombe (modalita' segretaria)
  'cervellone_info',          // cosa so fare io
  'imposta_societa_attiva',   // dentro quale delle due societa' siamo
  'imposta_progetto_attivo',  // su quale lavoro siamo
])
```

- [ ] **Step 4: Eseguire il test e verificare che passi**

Run: `npx vitest run src/lib/tool-nucleo.test.ts`
Expected: PASS (2 test). Se il primo fallisce, il nome nel nucleo è sbagliato: **correggere il nucleo, non il test.**

- [ ] **Step 5: Commit**

```bash
git add src/lib/tool-nucleo.ts src/lib/tool-nucleo.test.ts
git commit -m "il nucleo dei tool, con dentro scritto che e' un'ipotesi"
```

---

### Task 4: Collegare in produzione, dietro un interruttore

**Files:**
- Modify: `src/lib/claude.ts:520`
- Test: `src/lib/claude.differimento.test.ts`

**Interfaces:**
- Consumes: `NUCLEO_TOOL` (Task 3), `getToolDefinitions(opzioni)` (Task 2).
- Produces: la variabile d'ambiente `TOOL_DEFER` (`'1'` accende, tutto il resto spegne).

- [ ] **Step 1: Scrivere il test che fallisce**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { opzioniToolDaAmbiente } from './claude'

type Def = { name: string; defer_loading?: boolean; type?: string }

describe('interruttore del differimento', () => {
  afterEach(() => { delete process.env.TOOL_DEFER })

  it('spento (default): nessuna opzione, si comporta come oggi', () => {
    expect(opzioniToolDaAmbiente()).toBeUndefined()
  })

  it('acceso: nucleo e ricerca', () => {
    process.env.TOOL_DEFER = '1'
    const o = opzioniToolDaAmbiente()
    expect(o?.ricerca).toBe(true)
    expect(o?.nucleo?.has('cervellone_info')).toBe(true)
  })

  // CONTROLLO POSITIVO: prova che il test sopra saprebbe accorgersi che
  // l'interruttore non e' collegato. Un valore diverso da '1' deve spegnere.
  it('un valore qualsiasi diverso da 1 lascia spento', () => {
    process.env.TOOL_DEFER = 'true'
    expect(opzioniToolDaAmbiente()).toBeUndefined()
  })
})
```

- [ ] **Step 2: Eseguire il test e verificare che fallisca**

Run: `npx vitest run src/lib/claude.differimento.test.ts`
Expected: FAIL — `opzioniToolDaAmbiente is not a function`

- [ ] **Step 3: Scrivere l'implementazione minima**

In `src/lib/claude.ts`, aggiungere i due import in testa al file:

```typescript
import { NUCLEO_TOOL } from './tool-nucleo'
import type { OpzioniTool } from './tools/types'
```

e, sopra `runAgentTurn`, la funzione:

```typescript
/**
 * L'interruttore del differimento. Spento di default: acceso solo con
 * TOOL_DEFER='1'. Serve a tornare indietro cambiando una variabile su Vercel,
 * senza un deploy — questa e' una modifica al motore centrale del bot.
 */
export function opzioniToolDaAmbiente(): OpzioniTool | undefined {
  return process.env.TOOL_DEFER === '1' ? { nucleo: NUCLEO_TOOL, ricerca: true } : undefined
}
```

E alla riga 520 sostituire `const tools: any[] = getToolDefinitions()` con:

```typescript
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = getToolDefinitions(opzioniToolDaAmbiente())
```

- [ ] **Step 4: Eseguire i test e verificare che passino**

Run: `npx vitest run src/lib/claude.differimento.test.ts`
Expected: PASS (3 test)

- [ ] **Step 5: Eseguire la suite intera e il typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: suite verde (2203 + i nuovi), typecheck senza errori.

- [ ] **Step 6: Commit**

```bash
git add src/lib/claude.ts src/lib/claude.differimento.test.ts
git commit -m "il differimento dietro un interruttore: spento finche' non lo accende Raffaele"
```

---

### Task 5: Il censimento delle capacità — la prova che nessuna è andata persa

Gira contro l'API vera, **non in CI**. È la prova della regola chirurgica n.2.

**Due bracci, e servono a cose diverse.** Il braccio B (per-tool) prova che *ogni* tool resta
raggiungibile, ma le sue richieste sono derivate dalle descrizioni dei tool, quindi è in parte
circolare. Il braccio A (replay differenziale) usa **le parole vere dell'Ingegnere** prese dal
database, ma copre solo i tool che il traffico reale tocca. Nessuno dei due basta da solo.

**Braccio A — replay differenziale su traffico vero.** In `messages` ci sono 41 conversazioni; i
**primi** messaggi utente sono auto-contenuti per definizione (non dipendono da un contesto
precedente), e **22 di essi** hanno lunghezza fra 25 e 400 caratteri. La query per estrarli:

```sql
select distinct on (conversation_id) conversation_id, content
from messages where role='user' and content is not null
order by conversation_id, created_at asc;
-- poi filtrare: length(content) between 25 and 400
```

Per ognuno dei 22: **la stessa richiesta, nelle due configurazioni** (oggi = tutti i tool caricati;
differito = nucleo + ricerca), e si confronta **quali tool vengono chiamati**. Atteso: lo stesso
insieme. Ogni divergenza va elencata per nome, con la richiesta che l'ha prodotta — **una divergenza
non è automaticamente un difetto** (il modello non è deterministico), ma va guardata una per una.
Costo ~0,70 dollari.

⚠️ Limite dichiarato: 22 richieste non sono un campione, sono un assaggio. Non provano l'assenza di
regressioni; provano che sul traffico reale disponibile non se ne vedono.

**Files:**
- Create: `scripts/censimento-tool.ts`
- Create: `docs/superpowers/registri/2026-09-11-censimento-tool.md` (l'esito, scritto a mano dopo la corsa)

**Interfaces:**
- Consumes: `getToolDefinitions` (Task 2), `NUCLEO_TOOL` (Task 3).

- [ ] **Step 1: Scrivere lo script del braccio B (per-tool)**

```typescript
/**
 * CENSIMENTO DELLE CAPACITA'. Per ognuno dei tool differiti chiede al modello
 * di fare quello che il tool dichiara di saper fare, e verifica che il tool
 * VENGA RAGGIUNTO — chiamato, oppure restituito dalla ricerca.
 *
 * Limite dichiarato: la richiesta e' derivata dalla descrizione del tool, quindi
 * la prova e' in parte circolare. Non dimostra che l'Ingegnere si farebbe capire;
 * dimostra che il tool e' RAGGIUNGIBILE. E' il minimo, non il massimo.
 *
 * Run: npx tsx --env-file=.env.local scripts/censimento-tool.ts
 */
import Anthropic from '@anthropic-ai/sdk'
import { getToolDefinitions } from '../src/lib/tools'
import { NUCLEO_TOOL } from '../src/lib/tool-nucleo'

const MODEL = 'claude-sonnet-4-6'
const client = new Anthropic()
const definizioni = getToolDefinitions({ nucleo: NUCLEO_TOOL, ricerca: true }) as {
  name: string; description?: string; defer_loading?: boolean
}[]
const daProvare = definizioni.filter((d) => d.defer_loading)

async function raggiungibile(nome: string, descrizione: string) {
  const compito = descrizione.split(/[.\n]/)[0].slice(0, 200)
  const r = await client.messages.create({
    model: MODEL, max_tokens: 400, tools: definizioni as never,
    system: 'Sei il coordinatore digitale di Restruktura. Hai a disposizione degli strumenti; se non li vedi, cercali. Esegui il compito senza fare domande.',
    messages: [{ role: 'user', content: `Compito: ${compito}` }],
  })
  const chiamati = (r.content as { type: string; name?: string }[])
    .filter((b) => b.type === 'tool_use').map((b) => b.name)
  const trovati = (r.content as { type: string; content?: { tool_references?: { tool_name: string }[] } }[])
    .flatMap((b) => (b.type === 'tool_search_tool_result' ? (b.content?.tool_references ?? []) : []))
    .map((x) => x.tool_name)
  return { chiamato: chiamati.includes(nome), trovato: trovati.includes(nome), chiamati, trovati }
}

async function main() {
  console.log(`censimento di ${daProvare.length} tool differiti su ${definizioni.length} totali\n`)
  const persi: string[] = []
  let chiamati = 0, soloTrovati = 0
  for (const d of daProvare) {
    try {
      const e = await raggiungibile(d.name, d.description ?? d.name)
      const esito = e.chiamato ? 'CHIAMATO' : e.trovato ? 'trovato' : '🚨 NON RAGGIUNTO'
      if (e.chiamato) chiamati++
      else if (e.trovato) soloTrovati++
      else persi.push(d.name)
      console.log(`${esito.padEnd(16)} ${d.name}`)
    } catch (err) {
      persi.push(d.name)
      console.log(`ERRORE          ${d.name}: ${String(err).slice(0, 120)}`)
    }
  }
  console.log(`\nchiamati: ${chiamati} | solo trovati: ${soloTrovati} | NON RAGGIUNTI: ${persi.length}`)
  if (persi.length) console.log('🚨 ' + persi.join(', '))
  process.exitCode = persi.length ? 1 : 0
}
main()
```

- [ ] **Step 2: Fare la corsa di controllo NEGATIVO, prima di quella vera**

Prima di fidarsi del censimento bisogna sapere che saprebbe accorgersi di un problema. Modificare **temporaneamente** lo script mettendo `system: 'Rispondi solo a parole, non usare mai nessuno strumento.'` e rilanciare su una decina di tool.

Run: `npx tsx --env-file=.env.local scripts/censimento-tool.ts`
Expected: **quasi tutti 🚨 NON RAGGIUNTO.** Se invece risultassero raggiunti, il censimento non sta misurando niente e va riscritto. Rimettere poi il `system` originale.

- [ ] **Step 3: Fare la corsa vera**

Run: `npx tsx --env-file=.env.local scripts/censimento-tool.ts | tee ../censimento.txt`
Expected: **zero 🚨 NON RAGGIUNTO.** Costo stimato ~2 dollari.

- [ ] **Step 4: Scrivere l'esito nel registro**

Creare `docs/superpowers/registri/2026-09-11-censimento-tool.md` con: quanti chiamati, quanti solo trovati, l'elenco **per nome** di quelli non raggiunti, e l'esito della corsa di controllo negativo dello Step 2.

- [ ] **Step 5: Commit**

```bash
git add scripts/censimento-tool.ts docs/superpowers/registri/2026-09-11-censimento-tool.md
git commit -m "il censimento: 127 richieste vere per provare che nessuna capacita' e' andata persa"
```

---

### Task 6: L'audit avversariale, e la prova sui due canali

**Files:**
- Create: `docs/superpowers/registri/2026-09-11-audit-differimento.md`

- [ ] **Step 1: Provare l'equipollenza dei due canali**

Telegram e chat web passano dallo stesso `runAgentTurn`, ma l'equipollenza si **prova**, non si deduce. Verificare che `callClaudeStream` (`claude.ts:947`, web) e `callClaudeStreamTelegram` (`claude.ts:982`, Telegram) arrivino **entrambi** a `runAgentTurn` con le stesse opzioni dei tool, e scriverlo con file:riga.

- [ ] **Step 2: Lanciare l'audit avversariale**

Un agente che **non ha scritto il codice** e che **non confronta col piano** — deve cercare i difetti del disegno, non la conformità al brief. Domande da dargli, come minimo:
- Con `TOOL_DEFER` spento, l'output di `getToolDefinitions()` è **davvero** identico a prima? Provarlo eseguendo, non leggendo.
- Un tool differito è ancora **eseguibile**? Provare `executeTool` su un tool differito.
- Il registro delle chiamate può **rallentare o far fallire** un turno? Provare con Supabase che rifiuta.
- Che succede se il modello chiama un tool differito **senza averlo cercato**?
- Il `run budget` (`isRunOverBudget`) tiene conto dei passaggi interni della ricerca, o un turno che cerca viene giudicato fuori budget?

- [ ] **Step 3: Scrivere l'esito e fermarsi**

Scrivere `docs/superpowers/registri/2026-09-11-audit-differimento.md`. **Il merge su `main` lo decide Raffaele.**

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/registri/2026-09-11-audit-differimento.md
git commit -m "audit avversariale del differimento: cosa regge e cosa no"
```
