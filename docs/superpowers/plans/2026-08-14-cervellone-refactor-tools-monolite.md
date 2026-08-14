# Refactor monolite `tools.ts` (solo i giganti) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Estrarre i tre "giganti" (mail, self, studio-tecnico) da `src/lib/tools.ts` in moduli dedicati sotto `src/lib/tools/`, portando `tools.ts` da ~2560 a ~800-1000 righe. **Puro spostamento: zero cambi di comportamento.**

**Architecture:** Ogni gigante diventa un modulo `tools/<nome>.ts` che esporta `XXX_TOOLS: ToolDefinition[]` + `executeXxx(name, input, conversationId?): Promise<string|null>` (contratto identico a `sal-tools.ts`). `tools.ts` resta il registro sottile che importa i moduli e assembla `ALL_TOOLS`/`EXECUTORS`. Il tipo `ToolDefinition` va in `tools/types.ts` (foglia, importato da tutti). L'unica dipendenza problematica (`executeSelfTools → ALL_TOOLS`) si risolve con un `getAllToolNames()` importato dinamicamente (spezza il ciclo statico).

**Tech Stack:** TypeScript, Next.js (AGENTS.md: breaking changes, consultare `node_modules/next/dist/docs/`), Vitest (`npm run test:unit`).

## Global Constraints

- **Puro spostamento**: il corpo delle funzioni/array si sposta VERBATIM (byte-identico). Nessuna riscrittura di logica.
- Contratto executor: `(name: string, input: Record<string, unknown>, conversationId?: string) => Promise<string | null>` — ritorna `null` se il nome non è suo.
- Interfaccia pubblica invariata: `getToolDefinitions()` deve esporre lo STESSO set di `name` prima e dopo; `executeTool()` invariata.
- Ordine tappe (rischio crescente), ognuna commit + deploy verificato a sé: **mail → self → studio-tecnico**.
- I moduli in `tools/` NON importano da `tools.ts` staticamente (solo import dinamico dove indicato) per evitare cicli.
- `tools.ts` (monolite) lo edita Claude Code; l'estrazione meccanica può essere delegata a subagenti/Codex, verificata dai test.
- Verifica typecheck: `npx tsc --noEmit`, ignorare errori pre-esistenti in `pdf-generator.test.ts`.

---

### Task 1: Estrai `ToolDefinition` in `tools/types.ts` (fondazione)

**Files:**
- Create: `src/lib/tools/types.ts`
- Modify: `src/lib/tools.ts:84-88` (rimuovi la def locale, importa dal nuovo modulo)

**Interfaces:**
- Produces: `export interface ToolDefinition { name: string; description: string; input_schema: Record<string, unknown> }`

- [ ] **Step 1: Crea `tools/types.ts`**

```ts
// Tipo condiviso delle definizioni tool esposte a Claude.
export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}
```

- [ ] **Step 2: In `tools.ts` sostituisci la definizione locale con l'import**

Rimuovi le righe 84-88 (`interface ToolDefinition { ... }`) e aggiungi in cima agli import:
```ts
import type { ToolDefinition } from './tools/types'
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: nessun errore nuovo (tutti gli usi di `ToolDefinition` in `tools.ts` risolvono dall'import).

- [ ] **Step 4: Commit**

```bash
git add src/lib/tools/types.ts src/lib/tools.ts
git commit -m "refactor(tools): estrai ToolDefinition in tools/types.ts"
```

---

### Task 2: Estrai il blocco MAIL in `tools/mail.ts`

**Files:**
- Create: `src/lib/tools/mail.ts`
- Modify: `src/lib/tools.ts` (rimuovi i simboli mail; importa `GMAIL_TOOLS`, `executeGmailWrapper`, `executeMailWrapper` dal nuovo modulo; lascia invariati gli spread in `ALL_TOOLS`/`EXECUTORS`)
- Test: `src/lib/tools/mail.test.ts`

**Interfaces:**
- Consumes (import esterni che il modulo deve ricreare): da `./gmail-tools`: `listInbox, searchGmail, readMessage, readThread, createDraft, listDrafts, showDraft, deleteDraft, sendDraft, applyLabel, removeLabel, listLabels, markAsRead, archive, trash` + tipi `GmailMessageMeta, GmailMessage, GmailAttachmentMeta`; `buildDailySummary` da `./gmail-summary`; `MAIL_TOOL_EXECUTORS` da `@/v19/tools/email`; `recordSentMail` da `@/lib/sent-mail`; `supabase` da `../supabase`; `ToolDefinition` da `./types`.
- Produces: `export const GMAIL_TOOLS: ToolDefinition[]`, `export async function executeGmailWrapper(...)`, `export async function executeMailWrapper(...)`.
- Simboli da spostare (VERBATIM) da `tools.ts`: `MAIL_SEND_TOOLS` (1771-1776), `extractMailTo` (1779-1783), `extractMailSubject` (1786-1789), `mailWasActuallySent` (1796-1803), `extractPendingUuid` (1810-1820), `attachConversationToPending` (1828-1837), `executeMailWrapper` (1839-1869), `GMAIL_TOOLS` (1872-2026), `formatGmailList` (2028-2033), `formatGmailMessage` (2035-2047), `executeGmailWrapper` (2049-2140).

- [ ] **Step 1: Crea `tools/mail.ts`** con gli import sopra e i simboli spostati verbatim

Skeleton (gli import in testa; il CORPO delle funzioni/array va copiato IDENTICO da tools.ts alle righe indicate):
```ts
import { supabase } from '../supabase'
import type { ToolDefinition } from './types'
import {
  listInbox, searchGmail, readMessage, readThread, createDraft, listDrafts, showDraft,
  deleteDraft, sendDraft, applyLabel, removeLabel, listLabels, markAsRead, archive, trash,
  type GmailMessageMeta, type GmailMessage, type GmailAttachmentMeta,
} from '../gmail-tools'
import { buildDailySummary } from '../gmail-summary'
import { MAIL_TOOL_EXECUTORS } from '@/v19/tools/email'
import { recordSentMail } from '@/lib/sent-mail'

// ↓↓↓ spostare VERBATIM da tools.ts:
// MAIL_SEND_TOOLS, extractMailTo, extractMailSubject, mailWasActuallySent,
// extractPendingUuid, attachConversationToPending, executeMailWrapper (export),
// GMAIL_TOOLS (export), formatGmailList, formatGmailMessage, executeGmailWrapper (export)
```
Aggiungi `export` a `GMAIL_TOOLS`, `executeGmailWrapper`, `executeMailWrapper` (gli helper restano interni al modulo).

- [ ] **Step 2: In `tools.ts` rimuovi i simboli spostati e aggiungi l'import**

Rimuovi le righe corrispondenti (1771-1776, 1779-1789, 1796-1803, 1810-1820, 1828-1869, 1872-2047, 2049-2140 — cioè tutti i simboli mail elencati). Aggiungi in cima:
```ts
import { GMAIL_TOOLS, executeGmailWrapper, executeMailWrapper } from './tools/mail'
```
Lascia INVARIATI: `...GMAIL_TOOLS` in `ALL_TOOLS`, `executeGmailWrapper`/`executeMailWrapper` in `EXECUTORS`, e l'import esistente di `MAIL_TOOL_DEFINITIONS` da `@/v19/tools/email` (serve ancora al registry).

- [ ] **Step 3: Scrivi un test di dispatch** (`tools/mail.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { GMAIL_TOOLS, executeGmailWrapper, executeMailWrapper } from './mail'

describe('mail module', () => {
  it('GMAIL_TOOLS espone definizioni con name/description/input_schema', () => {
    expect(GMAIL_TOOLS.length).toBeGreaterThan(0)
    for (const t of GMAIL_TOOLS) {
      expect(typeof t.name).toBe('string')
      expect(typeof t.description).toBe('string')
      expect(t.input_schema).toBeTruthy()
    }
  })
  it('gli executor ritornano null per nomi non gestiti (fall-through)', async () => {
    expect(await executeGmailWrapper('non_esiste', {})).toBeNull()
    expect(await executeMailWrapper('non_esiste', {})).toBeNull()
  })
})
```

- [ ] **Step 4: Typecheck + test**

Run: `npx tsc --noEmit` → nessun errore nuovo.
Run: `npm run test:unit -- src/lib/tools/mail.test.ts` → PASS.

- [ ] **Step 5: Commit + deploy**

```bash
git add src/lib/tools/mail.ts src/lib/tools/mail.test.ts src/lib/tools.ts
git commit -m "refactor(tools): estrai blocco mail (GMAIL_TOOLS + mail V19) in tools/mail.ts"
git push origin main   # (o merge su main se su branch feature)
```

---

### Task 3: Estrai il blocco SELF in `tools/self.ts` (con fix ciclo `ALL_TOOLS`)

**Files:**
- Create: `src/lib/tools/self.ts`
- Modify: `src/lib/tools.ts` (rimuovi `SELF_TOOLS`, `executeSelfTools`, `notifyModelChange`; importa dal modulo; **aggiungi export `getAllToolNames()`**)
- Test: `src/lib/tools/self.test.ts`

**Interfaces:**
- Consumes: `supabase` da `../supabase`; `sendTelegramMessage` da `../telegram-helpers`; `promoteModel` da `../circuit-breaker`; `ToolDefinition` da `./types`; import dinamici `../claude` (`invalidateConfigCache`, `invalidateModelCapsCache`), `../skills` (`invalidateSkillCache`); e — al posto di `ALL_TOOLS` — import dinamico `const { getAllToolNames } = await import('../tools')`.
- Produces: `export const SELF_TOOLS: ToolDefinition[]`, `export async function executeSelfTools(...)`.
- Simboli da spostare VERBATIM: `notifyModelChange` (46-80), `SELF_TOOLS` (1357-1430), `executeSelfTools` (1432-1709).

- [ ] **Step 1: In `tools.ts` aggiungi l'helper esportato (rompe il ciclo, comportamento identico)**

Subito dopo la definizione di `ALL_TOOLS` (dopo riga 2546):
```ts
/** Nomi di tutti i tool registrati. Esposto per moduli (es. tools/self) che
 *  altrimenti importerebbero ALL_TOOLS creando un ciclo. Stesso set di ALL_TOOLS. */
export function getAllToolNames(): string[] {
  return ALL_TOOLS.map(t => t.name)
}
```

- [ ] **Step 2: Crea `tools/self.ts`** con gli import e i simboli spostati verbatim

Skeleton:
```ts
import { supabase } from '../supabase'
import { sendTelegramMessage } from '../telegram-helpers'
import { promoteModel } from '../circuit-breaker'
import type { ToolDefinition } from './types'

// ↓↓↓ spostare VERBATIM da tools.ts: notifyModelChange (46-80), SELF_TOOLS (export),
//     executeSelfTools (export). Gli import dinamici interni (./claude, ./skills) diventano
//     '../claude', '../skills'.
```
**Unica modifica non-verbatim** — dentro `executeSelfTools`, nel case `cervellone_info` (riga ~1447), sostituisci l'uso di `ALL_TOOLS.map(t => t.name)` con:
```ts
const { getAllToolNames } = await import('../tools')
const toolNames = getAllToolNames()
// ...usa toolNames dove prima usavi ALL_TOOLS.map(t => t.name)
```
(Import dinamico → nessun ciclo statico; `getAllToolNames()` ritorna lo stesso identico array di prima.)

- [ ] **Step 3: In `tools.ts` rimuovi i simboli spostati e aggiungi l'import**

Rimuovi righe 46-80 (`notifyModelChange`), 1357-1430 (`SELF_TOOLS`), 1432-1709 (`executeSelfTools`). Aggiungi:
```ts
import { SELF_TOOLS, executeSelfTools } from './tools/self'
```
Verifica che `notifyModelChange` NON sia usata altrove in `tools.ts` (era usata solo da self). Lascia INVARIATI `...SELF_TOOLS` in `ALL_TOOLS` ed `executeSelfTools` in `EXECUTORS`.

- [ ] **Step 4: Test di dispatch** (`tools/self.test.ts`)

```ts
import { describe, it, expect } from 'vitest'
import { SELF_TOOLS, executeSelfTools } from './self'

describe('self module', () => {
  it('SELF_TOOLS ha definizioni valide', () => {
    expect(SELF_TOOLS.length).toBeGreaterThan(0)
    expect(SELF_TOOLS.every(t => t.name && t.input_schema)).toBe(true)
  })
  it('executeSelfTools ritorna null per nomi non suoi', async () => {
    expect(await executeSelfTools('non_esiste', {})).toBeNull()
  })
})
```

- [ ] **Step 5: Typecheck + test**

Run: `npx tsc --noEmit` → nessun errore nuovo.
Run: `npm run test:unit -- src/lib/tools/self.test.ts` → PASS.

- [ ] **Step 6: Commit + deploy**

```bash
git add src/lib/tools/self.ts src/lib/tools/self.test.ts src/lib/tools.ts
git commit -m "refactor(tools): estrai blocco self in tools/self.ts (getAllToolNames rompe il ciclo ALL_TOOLS)"
git push origin main
```

---

### Task 4: Test di caratterizzazione per Studio Tecnico (PRIMA di spostare)

**Files:**
- Test: `src/lib/tools/studio-tecnico.characterization.test.ts`

**Interfaces:**
- Consumes: la funzione `executeStudioTecnico` (ancora dentro `tools.ts`). Poiché non è esportata, per il test **esportala temporaneamente** da `tools.ts` (`export async function executeStudioTecnico`) — l'export resterà anche dopo lo spostamento (dal modulo).

- [ ] **Step 1: Rendi esportabile `executeStudioTecnico`**

In `tools.ts:421` aggiungi `export` davanti a `async function executeStudioTecnico`. (Verifica typecheck.)

- [ ] **Step 2: Scrivi lo snapshot di caratterizzazione** con Supabase/random/date congelati

Il case `genera_preventivo_completo` usa `supabase`, `Math.random` (numero preventivo) e `new Date()` (data). Mockali per determinismo e cattura l'output.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Supabase mock con voci prezziario fisse (riusato da cerca_prezziario e genera_preventivo)
const VOCI = [
  { codice_voce: 'BAS25_E.03.068.01', descrizione: 'Calcestruzzo Rck 30', unita_misura: 'mc', prezzo: 204.49, anno: 2025 },
]
vi.mock('../supabase', () => {
  const chain: any = {
    select: () => chain, eq: () => chain, ilike: () => chain, gt: () => chain,
    order: () => chain, limit: async () => ({ data: VOCI }),
    single: async () => ({ data: { anno: 2025 } }),
  }
  return { supabase: { from: () => chain } }
})

import { executeStudioTecnico } from '../tools'

describe('caratterizzazione studio-tecnico (pre-refactor)', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.setSystemTime(new Date('2026-08-14T10:00:00Z'))
  })

  it('cerca_prezziario — output stabile', async () => {
    const out = await executeStudioTecnico('cerca_prezziario', { query: 'calcestruzzo', regione: 'basilicata' })
    expect(out).toMatchSnapshot()
  })

  it('genera_preventivo_completo — output stabile', async () => {
    const out = await executeStudioTecnico('genera_preventivo_completo', {
      committente: 'Test', comune: 'Villa dAgri', descrizione_lavoro: 'Getto cls',
      lavorazioni: [{ descrizione: 'calcestruzzo', quantita: 10, unita: 'mc' }], regione: 'basilicata',
    }, 'conv-test')
    expect(out).toMatchSnapshot()
  })
})
```

- [ ] **Step 3: Genera lo snapshot baseline (pre-refactor)**

Run: `npm run test:unit -- src/lib/tools/studio-tecnico.characterization.test.ts`
Expected: PASS, crea `__snapshots__/studio-tecnico.characterization.test.ts.snap`. Questo snapshot è la **verità di riferimento** dell'output attuale.

- [ ] **Step 4: Commit dello snapshot baseline**

```bash
git add src/lib/tools.ts src/lib/tools/studio-tecnico.characterization.test.ts src/lib/tools/__snapshots__/
git commit -m "test(tools): snapshot di caratterizzazione studio-tecnico (baseline pre-refactor)"
```

---

### Task 5: Estrai Studio Tecnico in `tools/studio-tecnico.ts`

**Files:**
- Create: `src/lib/tools/studio-tecnico.ts` (+ opzionale `tools/studio-tecnico-render.ts` se il file supera ~700 righe)
- Modify: `src/lib/tools.ts` (rimuovi i simboli; importa dal modulo)
- Modify: `src/lib/tools/studio-tecnico.characterization.test.ts` (aggiorna l'import: da `../tools` a `./studio-tecnico`)

**Interfaces:**
- Consumes: `supabase` da `../supabase`; `ToolDefinition` da `./types`; import dinamici `jszip`/`mammoth` (invariati).
- Produces: `export const STUDIO_TECNICO_TOOLS: ToolDefinition[]`, `export async function executeStudioTecnico(...)`.
- Simboli da spostare VERBATIM: `STUDIO_TECNICO_TOOLS` (92-203), `PREZZIARI_LEENO` (330-348), `REGIONI_ALIAS` (350-357), `executeStudioTecnico` (421-1306), `parseOdsToRows` (1309-1331), `parseXlsxToRows` (1334-1353). Gli helper locali (STOP, UM_COMPAT, getKeywords, cercaPerParola, isUmCompatible, scoreCandidato, ecc.) restano annidati dentro la funzione, si spostano con lei.

- [ ] **Step 1: Crea `tools/studio-tecnico.ts`** con gli import e i simboli verbatim

```ts
import { supabase } from '../supabase'
import type { ToolDefinition } from './types'
// jszip/mammoth restano import dinamici dentro parseOds/parseXlsx.

// ↓↓↓ VERBATIM da tools.ts: STUDIO_TECNICO_TOOLS (export), PREZZIARI_LEENO, REGIONI_ALIAS,
//     executeStudioTecnico (export), parseOdsToRows, parseXlsxToRows.
//     La chiamata ricorsiva a executeStudioTecnico(...) (auto-import prezziario) resta interna.
```
Se il file supera ~700 righe per via dei template HTML di `genera_preventivo_completo`, estrai SOLO le funzioni che costruiscono l'HTML (prive di stato/side-effect) in `tools/studio-tecnico-render.ts`, importandole; NON toccare la logica di calcolo.

- [ ] **Step 2: In `tools.ts` rimuovi i simboli e aggiungi l'import**

Rimuovi righe 92-203, 330-357, 421-1306, 1309-1353. Aggiungi:
```ts
import { STUDIO_TECNICO_TOOLS, executeStudioTecnico } from './tools/studio-tecnico'
```
Lascia INVARIATI `...STUDIO_TECNICO_TOOLS` in `ALL_TOOLS` ed `executeStudioTecnico` in `EXECUTORS`.

- [ ] **Step 3: Aggiorna l'import nel test di caratterizzazione**

In `studio-tecnico.characterization.test.ts` cambia `import { executeStudioTecnico } from '../tools'` in `from './studio-tecnico'`. Aggiorna il path del mock supabase se necessario (resta `'../supabase'`).

- [ ] **Step 4: Verifica caratterizzazione (prova di zero regressioni)**

Run: `npm run test:unit -- src/lib/tools/studio-tecnico.characterization.test.ts`
Expected: **PASS con lo STESSO snapshot** (nessun `-`/`+` nel diff). Se lo snapshot cambia → il move NON è stato verbatim: ripristina e correggi. NON aggiornare lo snapshot.

- [ ] **Step 5: Typecheck + suite**

Run: `npx tsc --noEmit` → nessun errore nuovo.
Run: `npm run test:unit -- src/lib/tools/` → PASS.

- [ ] **Step 6: Commit + deploy**

```bash
git add src/lib/tools/studio-tecnico.ts src/lib/tools.ts src/lib/tools/studio-tecnico.characterization.test.ts
git commit -m "refactor(tools): estrai studio-tecnico (prezziario/preventivo) in tools/studio-tecnico.ts — caratterizzazione verde"
git push origin main
```

---

### Task 6: Audit finale — nessun tool perso, registry integro

**Files:**
- Test: `src/lib/tools.registry.test.ts`

**Interfaces:**
- Consumes: `getToolDefinitions` da `./tools`.

- [ ] **Step 1: Test che fissa il set di tool esposti**

```ts
import { describe, it, expect } from 'vitest'
import { getToolDefinitions } from './tools'

describe('registry tool', () => {
  it('espone un set di nomi non vuoto e senza duplicati', () => {
    const defs = getToolDefinitions() as { name: string }[]
    const names = defs.map(d => d.name)
    expect(names.length).toBeGreaterThan(30)
    expect(new Set(names).size).toBe(names.length) // nessun duplicato
    // tool chiave presenti dopo il refactor
    for (const n of ['cerca_prezziario', 'genera_preventivo_completo', 'cervellone_info', 'sal_calcola']) {
      expect(names).toContain(n)
    }
  })
})
```

- [ ] **Step 2: Esegui**

Run: `npm run test:unit -- src/lib/tools.registry.test.ts`
Expected: PASS.

- [ ] **Step 3: Misura la riduzione**

Run: `wc -l src/lib/tools.ts`
Expected: da ~2563 a ~800-1000 righe.

- [ ] **Step 4: Audit con subagente** — verifica che `getToolDefinitions()` esponga lo STESSO set di `name` del pre-refactor (confronta con `main` di partenza) e che ogni executor spostato sia in `EXECUTORS`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.registry.test.ts
git commit -m "test(tools): registry — set tool integro dopo refactor"
git push origin main
```

---

## Self-Review

**Spec coverage:**
- ① caratterizzazione-first → Task 4 (baseline) + Task 5 step 4 (prova). ✓
- ② tre moduli (mail/self/studio-tecnico) → Task 2, 3, 5. ✓
- ③ tools.ts registro sottile → risultato di Task 2/3/5 + Task 6 step 3 (misura). ✓
- ④ verifica per tappa (typecheck + test + smoke) → in ogni task. ✓
- ⑤ ordine mail→self→studio-tecnico → Task 2,3,5. ✓
- ⑥ subagenti → estrazione meccanica delegabile; audit Task 6 step 4. ✓
- `ToolDefinition` shared + rischio ciclo Self/ALL_TOOLS → Task 1 + Task 3 (getAllToolNames). ✓

**Placeholder scan:** i "sposta VERBATIM" NON sono placeholder: sono istruzioni di move con righe esatte + gli import completi da ricreare sono forniti. Riprodurre ~1000 righe di corpo invariato aggiungerebbe rischio di divergenza; la correttezza è garantita dal test di caratterizzazione (Task 5 step 4). ✓

**Type consistency:** `ToolDefinition` unica sorgente (`tools/types.ts`); contratto executor uniforme; `getAllToolNames(): string[]` coerente tra definizione (Task 3 step 1) e uso (Task 3 step 2). ✓

**Nota:** confermare i numeri di riga a runtime prima di ogni move (potrebbero shiftare dopo le tappe precedenti: es. dopo Task 2 le righe di Self/Studio cambiano). Ogni task rilegge le righe correnti prima di tagliare.
