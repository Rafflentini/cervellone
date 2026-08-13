# SAL da computo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generare un SAL (Stato Avanzamento Lavori) da un computo di commessa: raggruppamento voci coerente proposto dal bot, % per gruppo, calcoli deterministici, economia dal Contratto d'Appalto, output XLSX+PDF salvato in `05_Contabilita Lavori` dopo doppia conferma.

**Architecture:** Nuovo modulo `src/lib/sal-calc.ts` (matematica pura, unit-testata) + `src/lib/sal-tools.ts` (definizioni tool, dispatcher `executeSalTool`, pending a doppia conferma sul modello FIC, render XLSX/PDF, upload Drive). Wiring in `src/lib/tools.ts` (ALL_TOOLS + EXECUTORS) e intercept comandi in `src/app/api/telegram/route.ts`. Tabella `cervellone_sal_pending`. Il dialogo (proposta gruppi, raccolta %) è guidato dal prompt usando i tool drive esistenti; **tutti i numeri li produce `calcolaSal` in codice**.

**Tech Stack:** TypeScript, Next.js (App Router — vedi AGENTS.md: breaking changes, consulta `node_modules/next/dist/docs/`), Supabase, ExcelJS + Puppeteer (via `pdf-generator.ts`), Vitest (`npm run test:unit`).

## Global Constraints

- Zero aritmetica dell'LLM sui numeri del SAL: importi solo da `calcolaSal`. (dalla spec)
- Gate di riconciliazione: `Σ importo_gruppi ≈ totale_computo` (tolleranza ±1 €), altrimenti errore esplicito. (spec §1/§2)
- Ogni scrittura Drive passa da `assertWriteAllowed` (già in `uploadBinaryToDrive`/`getOrCreatePathFolders`).
- Doppia conferma sul modello FIC: `/sal_ok_<uuid>` (step1) → `/sal_ok2_<uuid>` (step2, salva) → `/sal_no_<uuid>` (annulla). UUID = `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`.
- Contratto d'Appalto come fonte dei parametri economici (IVA, ritenuta garanzia, anticipazione). Se mancano → il bot li chiede (regola prompt).
- Arrotondamento a 2 decimali su ogni importo (`Math.round(n*100)/100`).
- Salvataggio in sottocartella `05_Contabilita Lavori` (senza apostrofo) della commessa.

---

### Task 1: Migrazione tabella `cervellone_sal_pending`

**Files:**
- Create: `supabase/migrations/2026-08-13-sal-pending.sql`

**Interfaces:**
- Produces: tabella `cervellone_sal_pending(id uuid pk, payload jsonb, descrizione text, stato text, conferme int, created_at timestamptz, updated_at timestamptz)`.

- [ ] **Step 1: Scrivi la migration** (modello `cervellone_fic_pending`)

```sql
-- 2026-08-13 SAL pending (doppia conferma, modello cervellone_fic_pending)
create table if not exists public.cervellone_sal_pending (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null,
  descrizione text not null,
  stato text not null default 'in_attesa',   -- in_attesa | creato | annullato
  conferme int not null default 0,            -- 0 -> 1 (step1) -> 2 (step2)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.cervellone_sal_pending enable row level security;
-- Nessuna policy pubblica: accesso solo via service role (come cervellone_fic_pending).
```

- [ ] **Step 2: Applica la migration** (via Supabase MCP o CLI)

Applica lo SQL sul progetto `vpmcqzaqiozpanaekxgj`. Verifica con: `select count(*) from cervellone_sal_pending;` → deve tornare `0` senza errori.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-08-13-sal-pending.sql
git commit -m "feat(sal): migrazione tabella cervellone_sal_pending"
```

---

### Task 2: Modulo di calcolo puro `sal-calc.ts` (TDD)

**Files:**
- Create: `src/lib/sal-calc.ts`
- Test: `src/lib/sal-calc.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SalGruppoInput { nome: string; importo_contrattuale: number; percentuale: number } // percentuale 0..100
  export interface SalParams { iva_perc: number; ritenuta_garanzia_perc: number; anticipazione: number; is_ultimo_sal: boolean }
  export interface SalCalcInput { numero_sal: number; totale_computo: number; gruppi: SalGruppoInput[]; sal_precedente: number; params: SalParams }
  export interface SalGruppoCalcolato { nome: string; importo_contrattuale: number; percentuale: number; maturato_a_oggi: number }
  export interface SalResult { numero_sal: number; gruppi: SalGruppoCalcolato[]; totale_maturato_a_oggi: number; sal_precedente: number; maturato_nel_periodo: number; ritenuta_periodo: number; ritenuta_cumulata: number; recupero_anticipazione: number; imponibile_certificato: number; iva: number; totale_certificato: number }
  export class SalReconcileError extends Error {}
  export function calcolaSal(input: SalCalcInput): SalResult
  ```

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
import { describe, it, expect } from 'vitest'
import { calcolaSal, SalReconcileError, type SalCalcInput } from './sal-calc'

const base: SalCalcInput = {
  numero_sal: 1,
  totale_computo: 1000,
  gruppi: [
    { nome: 'A', importo_contrattuale: 600, percentuale: 50 },
    { nome: 'B', importo_contrattuale: 400, percentuale: 25 },
  ],
  sal_precedente: 0,
  params: { iva_perc: 10, ritenuta_garanzia_perc: 0, anticipazione: 0, is_ultimo_sal: false },
}

describe('calcolaSal', () => {
  it('calcola il maturato per gruppo e i totali (primo SAL, no ritenuta/anticipo)', () => {
    const r = calcolaSal(base)
    expect(r.gruppi[0].maturato_a_oggi).toBe(300)   // 600*50%
    expect(r.gruppi[1].maturato_a_oggi).toBe(100)   // 400*25%
    expect(r.totale_maturato_a_oggi).toBe(400)
    expect(r.maturato_nel_periodo).toBe(400)        // sal_precedente 0
    expect(r.imponibile_certificato).toBe(400)
    expect(r.iva).toBe(40)                           // 10%
    expect(r.totale_certificato).toBe(440)
  })

  it('detrae il SAL precedente per ottenere il maturato del periodo', () => {
    const r = calcolaSal({ ...base, numero_sal: 2, sal_precedente: 250 })
    expect(r.totale_maturato_a_oggi).toBe(400)
    expect(r.maturato_nel_periodo).toBe(150)
    expect(r.imponibile_certificato).toBe(150)
    expect(r.iva).toBe(15)
  })

  it('applica la ritenuta di garanzia sul maturato del periodo e riporta la cumulata', () => {
    const r = calcolaSal({ ...base, params: { ...base.params, ritenuta_garanzia_perc: 0.5 } })
    expect(r.ritenuta_periodo).toBe(2)      // 400*0.5%
    expect(r.ritenuta_cumulata).toBe(2)     // 400*0.5% (uguale al primo SAL)
    expect(r.imponibile_certificato).toBe(398)
    expect(r.iva).toBe(39.8)
  })

  it('recupera l\'anticipazione solo se is_ultimo_sal', () => {
    const noUltimo = calcolaSal({ ...base, params: { ...base.params, anticipazione: 100, is_ultimo_sal: false } })
    expect(noUltimo.recupero_anticipazione).toBe(0)
    const ultimo = calcolaSal({ ...base, params: { ...base.params, anticipazione: 100, is_ultimo_sal: true } })
    expect(ultimo.recupero_anticipazione).toBe(100)
    expect(ultimo.imponibile_certificato).toBe(300) // 400 - 0 ritenuta - 100 anticipo
  })

  it('lancia SalReconcileError se Σ gruppi != totale_computo (oltre ±1€)', () => {
    expect(() => calcolaSal({ ...base, totale_computo: 1500 })).toThrow(SalReconcileError)
  })

  it('accetta scarti di arrotondamento entro ±1€', () => {
    expect(() => calcolaSal({ ...base, totale_computo: 1000.4 })).not.toThrow()
  })
})
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npm run test:unit -- src/lib/sal-calc.test.ts`
Expected: FAIL (`calcolaSal` non definita / modulo mancante).

- [ ] **Step 3: Implementa `sal-calc.ts`**

```ts
export interface SalGruppoInput { nome: string; importo_contrattuale: number; percentuale: number }
export interface SalParams { iva_perc: number; ritenuta_garanzia_perc: number; anticipazione: number; is_ultimo_sal: boolean }
export interface SalCalcInput { numero_sal: number; totale_computo: number; gruppi: SalGruppoInput[]; sal_precedente: number; params: SalParams }
export interface SalGruppoCalcolato { nome: string; importo_contrattuale: number; percentuale: number; maturato_a_oggi: number }
export interface SalResult {
  numero_sal: number
  gruppi: SalGruppoCalcolato[]
  totale_maturato_a_oggi: number
  sal_precedente: number
  maturato_nel_periodo: number
  ritenuta_periodo: number
  ritenuta_cumulata: number
  recupero_anticipazione: number
  imponibile_certificato: number
  iva: number
  totale_certificato: number
}

export class SalReconcileError extends Error {
  constructor(message: string) { super(message); this.name = 'SalReconcileError' }
}

const r2 = (n: number): number => Math.round(n * 100) / 100

export function calcolaSal(input: SalCalcInput): SalResult {
  const { gruppi, totale_computo, sal_precedente, params } = input

  for (const g of gruppi) {
    if (g.percentuale < 0 || g.percentuale > 100) {
      throw new SalReconcileError(`Percentuale non valida per "${g.nome}": ${g.percentuale} (attesa 0..100)`)
    }
  }

  const sommaGruppi = r2(gruppi.reduce((s, g) => s + g.importo_contrattuale, 0))
  if (Math.abs(sommaGruppi - totale_computo) > 1) {
    throw new SalReconcileError(
      `Riconciliazione fallita: Σ gruppi = ${sommaGruppi} € ≠ totale computo = ${totale_computo} €. ` +
      `Controlla il raggruppamento delle voci.`,
    )
  }

  const gruppiCalcolati: SalGruppoCalcolato[] = gruppi.map(g => ({
    nome: g.nome,
    importo_contrattuale: r2(g.importo_contrattuale),
    percentuale: g.percentuale,
    maturato_a_oggi: r2(g.importo_contrattuale * g.percentuale / 100),
  }))

  const totale_maturato_a_oggi = r2(gruppiCalcolati.reduce((s, g) => s + g.maturato_a_oggi, 0))
  const maturato_nel_periodo = r2(totale_maturato_a_oggi - sal_precedente)
  const ritenuta_periodo = r2(maturato_nel_periodo * params.ritenuta_garanzia_perc / 100)
  const ritenuta_cumulata = r2(totale_maturato_a_oggi * params.ritenuta_garanzia_perc / 100)
  const recupero_anticipazione = params.is_ultimo_sal ? r2(params.anticipazione) : 0
  const imponibile_certificato = r2(maturato_nel_periodo - ritenuta_periodo - recupero_anticipazione)
  const iva = r2(imponibile_certificato * params.iva_perc / 100)
  const totale_certificato = r2(imponibile_certificato + iva)

  return {
    numero_sal: input.numero_sal,
    gruppi: gruppiCalcolati,
    totale_maturato_a_oggi,
    sal_precedente: r2(sal_precedente),
    maturato_nel_periodo,
    ritenuta_periodo,
    ritenuta_cumulata,
    recupero_anticipazione,
    imponibile_certificato,
    iva,
    totale_certificato,
  }
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npm run test:unit -- src/lib/sal-calc.test.ts`
Expected: PASS (6 test).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sal-calc.ts src/lib/sal-calc.test.ts
git commit -m "feat(sal): modulo calcolo SAL deterministico + test"
```

---

### Task 3: Render SAL → XLSX + HTML (TDD)

**Files:**
- Create: `src/lib/sal-render.ts`
- Test: `src/lib/sal-render.test.ts`

**Interfaces:**
- Consumes: `SalResult` (Task 2), `XlsxSheet` da `./pdf-generator`.
- Produces:
  ```ts
  export interface SalMeta { commessa: string; oggetto: string; data: string; numero_sal: number }
  export function buildSalSheets(result: SalResult, meta: SalMeta): XlsxSheet[]
  export function buildSalHtml(result: SalResult, meta: SalMeta): string
  ```

- [ ] **Step 1: Scrivi i test che falliscono**

```ts
import { describe, it, expect } from 'vitest'
import { buildSalSheets, buildSalHtml } from './sal-render'
import { calcolaSal, type SalCalcInput } from './sal-calc'

const input: SalCalcInput = {
  numero_sal: 1, totale_computo: 1000,
  gruppi: [{ nome: 'Ponteggio', importo_contrattuale: 600, percentuale: 50 }, { nome: 'Facciata', importo_contrattuale: 400, percentuale: 25 }],
  sal_precedente: 0,
  params: { iva_perc: 10, ritenuta_garanzia_perc: 0.5, anticipazione: 0, is_ultimo_sal: false },
}
const meta = { commessa: 'C2026-008 Cond. E. Fermi', oggetto: 'Ripristino facciate', data: '2026-08-13', numero_sal: 1 }

describe('buildSalSheets', () => {
  it('produce un foglio con header e una riga per gruppo', () => {
    const sheets = buildSalSheets(calcolaSal(input), meta)
    expect(sheets).toHaveLength(1)
    expect(sheets[0].rows[0]).toEqual(['Gruppo di lavorazione', 'Importo contrattuale', '% avanz.', 'Maturato a oggi'])
    expect(sheets[0].rows[1]).toEqual(['Ponteggio', 600, 50, 300])
    // include una riga totale con l'imponibile del certificato da qualche parte
    const flat = JSON.stringify(sheets[0].rows)
    expect(flat).toContain('Imponibile certificato')
  })
})

describe('buildSalHtml', () => {
  it('include numero SAL, commessa e totale certificato', () => {
    const html = buildSalHtml(calcolaSal(input), meta)
    expect(html).toContain('SAL n° 1')
    expect(html).toContain('C2026-008')
    expect(html).toContain('Totale certificato')
  })
})
```

- [ ] **Step 2: Esegui i test e verifica che falliscano**

Run: `npm run test:unit -- src/lib/sal-render.test.ts`
Expected: FAIL (modulo mancante).

- [ ] **Step 3: Implementa `sal-render.ts`**

```ts
import type { SalResult } from './sal-calc'
import type { XlsxSheet } from './pdf-generator'

export interface SalMeta { commessa: string; oggetto: string; data: string; numero_sal: number }

const eur = (n: number) => n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function buildSalSheets(result: SalResult, meta: SalMeta): XlsxSheet[] {
  const rows: (string | number | null)[][] = []
  rows.push(['Gruppo di lavorazione', 'Importo contrattuale', '% avanz.', 'Maturato a oggi'])
  for (const g of result.gruppi) rows.push([g.nome, g.importo_contrattuale, g.percentuale, g.maturato_a_oggi])
  rows.push([])
  rows.push(['Totale maturato a oggi', null, null, result.totale_maturato_a_oggi])
  rows.push(['SAL precedente', null, null, result.sal_precedente])
  rows.push(['Maturato nel periodo', null, null, result.maturato_nel_periodo])
  if (result.ritenuta_periodo) rows.push(['Ritenuta di garanzia (periodo)', null, null, result.ritenuta_periodo])
  if (result.recupero_anticipazione) rows.push(['Recupero anticipazione', null, null, result.recupero_anticipazione])
  rows.push(['Imponibile certificato', null, null, result.imponibile_certificato])
  rows.push(['IVA', null, null, result.iva])
  rows.push(['Totale certificato', null, null, result.totale_certificato])
  return [{ name: `SAL n${result.numero_sal}`, rows }]
}

export function buildSalHtml(result: SalResult, meta: SalMeta): string {
  const righe = result.gruppi.map(g =>
    `<tr><td>${g.nome}</td><td style="text-align:right">€ ${eur(g.importo_contrattuale)}</td>` +
    `<td style="text-align:right">${g.percentuale}%</td><td style="text-align:right">€ ${eur(g.maturato_a_oggi)}</td></tr>`,
  ).join('')
  const rigaEcon = (label: string, val: number) =>
    `<tr><td colspan="3" style="text-align:right"><strong>${label}</strong></td><td style="text-align:right">€ ${eur(val)}</td></tr>`
  return `
    <h1>SAL n° ${result.numero_sal}</h1>
    <p><strong>Commessa:</strong> ${meta.commessa}<br/>
       <strong>Oggetto:</strong> ${meta.oggetto}<br/>
       <strong>Data:</strong> ${meta.data}</p>
    <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%">
      <thead><tr><th>Gruppo di lavorazione</th><th>Importo contrattuale</th><th>% avanz.</th><th>Maturato a oggi</th></tr></thead>
      <tbody>${righe}</tbody>
      <tfoot>
        ${rigaEcon('Totale maturato a oggi', result.totale_maturato_a_oggi)}
        ${rigaEcon('SAL precedente', result.sal_precedente)}
        ${rigaEcon('Maturato nel periodo', result.maturato_nel_periodo)}
        ${result.ritenuta_periodo ? rigaEcon('Ritenuta di garanzia (periodo)', result.ritenuta_periodo) : ''}
        ${result.recupero_anticipazione ? rigaEcon('Recupero anticipazione', result.recupero_anticipazione) : ''}
        ${rigaEcon('Imponibile certificato', result.imponibile_certificato)}
        ${rigaEcon('IVA', result.iva)}
        ${rigaEcon('Totale certificato', result.totale_certificato)}
      </tfoot>
    </table>`
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npm run test:unit -- src/lib/sal-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sal-render.ts src/lib/sal-render.test.ts
git commit -m "feat(sal): render SAL in XLSX + HTML"
```

---

### Task 4: `sal-tools.ts` — definizioni tool + `sal_calcola` (pending + preview) + `sal_estrai_computo`

**Files:**
- Create: `src/lib/sal-tools.ts`
- Test: `src/lib/sal-tools.test.ts`

**Interfaces:**
- Consumes: `calcolaSal`, `SalReconcileError`, `SalCalcInput` (Task 2); `buildSalHtml`, `buildSalSheets`, `SalMeta` (Task 3); da `./drive`: `getOrCreatePathFolders`, `searchFilesFullText`, `readPdfFromDrive`, `uploadBinaryToDrive`; da `./pdf-generator`: `generatePdfFromHtml`, `generateXlsxFromData`; da `./supabase-server`: `getSupabaseServer`.
- Produces:
  ```ts
  export const SAL_TOOLS: { name: string; description: string; input_schema: Record<string, unknown> }[]
  export async function executeSalTool(name: string, input: Record<string, unknown>, conversationId?: string): Promise<string | null>
  export async function confirmSalStep1(id: string): Promise<string>
  export async function confirmSalStep2(id: string): Promise<string>
  export async function cancelSal(id: string): Promise<string>
  ```
- Nota concorrenza (dal modello `fic-write-tools.ts`): ogni transizione è un `update ... .eq('stato',X).eq('conferme',Y).select()` con claim ottimistico (controlla `data.length`).

- [ ] **Step 1: Scrivi il test del gate di riconciliazione in `sal_calcola`**

```ts
import { describe, it, expect, vi } from 'vitest'

// Mock Supabase e drive/pdf per isolare la logica del dispatcher
vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: { id: '00000000-0000-4000-8000-000000000000' }, error: null }) }) }) }),
  }),
}))
import { executeSalTool } from './sal-tools'

describe('sal_calcola', () => {
  it('ritorna un errore leggibile se la riconciliazione fallisce (niente pending)', async () => {
    const out = await executeSalTool('sal_calcola', {
      commessa: 'X', commessa_folder_id: 'f', oggetto: 'o', data: '2026-08-13',
      numero_sal: 1, totale_computo: 1000, sal_precedente: 0,
      gruppi: [{ nome: 'A', importo_contrattuale: 700, percentuale: 50 }], // Σ=700 ≠ 1000
      params: { iva_perc: 10, ritenuta_garanzia_perc: 0, anticipazione: 0, is_ultimo_sal: false },
    })
    expect(out).toContain('Riconciliazione fallita')
  })

  it('ritorna null per un tool non suo', async () => {
    expect(await executeSalTool('altro_tool', {})).toBeNull()
  })
})
```

- [ ] **Step 2: Esegui e verifica il fallimento**

Run: `npm run test:unit -- src/lib/sal-tools.test.ts`
Expected: FAIL (modulo mancante).

- [ ] **Step 3: Implementa `sal-tools.ts`** (parte definizioni + `sal_estrai_computo` + `sal_calcola`)

```ts
import { calcolaSal, SalReconcileError, type SalCalcInput } from './sal-calc'
import { buildSalHtml, buildSalSheets, type SalMeta } from './sal-render'
import { getOrCreatePathFolders, searchFilesFullText, readPdfFromDrive, uploadBinaryToDrive } from './drive'
import { generatePdfFromHtml, generateXlsxFromData } from './pdf-generator'
import { getSupabaseServer } from './supabase-server'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const PDF_MIME = 'application/pdf'
const CONTAB_FOLDER = '05_Contabilita Lavori'

export const SAL_TOOLS = [
  {
    name: 'sal_estrai_computo',
    description: 'Trova e legge il computo metrico nella cartella 05_Contabilita Lavori di una commessa, per poi generare un SAL. Ritorna il testo del computo (da cui estrarre le voci e il totale). Passa commessa_folder_id (l\'ID Drive della cartella della commessa, ottenuto cercando la commessa).',
    input_schema: {
      type: 'object' as const,
      properties: {
        commessa_folder_id: { type: 'string', description: 'ID Drive della cartella della commessa' },
      },
      required: ['commessa_folder_id'],
    },
  },
  {
    name: 'sal_calcola',
    description: 'Calcola un SAL (Stato Avanzamento Lavori) in modo deterministico e prepara i documenti (anteprima + doppia conferma). Prima raggruppa le voci del computo in gruppi coerenti insieme all\'utente, leggi il Contratto d\'Appalto per i parametri economici (IVA, ritenuta di garanzia, anticipazione), chiedi la % di avanzamento per ogni gruppo e l\'importo del SAL precedente. NON calcolare tu i totali: li calcola questo tool. Se Σ importi gruppi non torna col totale del computo, il tool restituisce un errore.',
    input_schema: {
      type: 'object' as const,
      properties: {
        commessa: { type: 'string', description: 'Codice/nome commessa (es. "C2026-008 Cond. E. Fermi")' },
        commessa_folder_id: { type: 'string', description: 'ID Drive cartella commessa (per salvare il SAL)' },
        oggetto: { type: 'string', description: 'Oggetto dei lavori' },
        data: { type: 'string', description: 'Data del SAL (YYYY-MM-DD)' },
        numero_sal: { type: 'number', description: 'Numero progressivo del SAL' },
        totale_computo: { type: 'number', description: 'Importo totale del computo (imponibile), per la riconciliazione' },
        sal_precedente: { type: 'number', description: 'Importo maturato nei SAL precedenti (0 se è il primo)' },
        gruppi: {
          type: 'array',
          description: 'Gruppi di lavorazione con importo contrattuale (somma delle voci del gruppo) e % di avanzamento',
          items: {
            type: 'object',
            properties: {
              nome: { type: 'string' },
              importo_contrattuale: { type: 'number' },
              percentuale: { type: 'number', description: '0..100' },
            },
            required: ['nome', 'importo_contrattuale', 'percentuale'],
          },
        },
        params: {
          type: 'object',
          description: 'Parametri economici letti dal Contratto d\'Appalto',
          properties: {
            iva_perc: { type: 'number', description: 'Aliquota IVA (es. 10)' },
            ritenuta_garanzia_perc: { type: 'number', description: 'Ritenuta di garanzia % (0 se non prevista)' },
            anticipazione: { type: 'number', description: 'Importo anticipazione da recuperare (0 se assente)' },
            is_ultimo_sal: { type: 'boolean', description: 'true se è il SAL finale (recupera l\'anticipazione)' },
          },
          required: ['iva_perc', 'ritenuta_garanzia_perc', 'anticipazione', 'is_ultimo_sal'],
        },
      },
      required: ['commessa', 'commessa_folder_id', 'oggetto', 'data', 'numero_sal', 'totale_computo', 'sal_precedente', 'gruppi', 'params'],
    },
  },
]

const eur = (n: number) => n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export async function executeSalTool(name: string, input: Record<string, unknown>, _conversationId?: string): Promise<string | null> {
  if (name === 'sal_estrai_computo') {
    const folderId = input.commessa_folder_id as string
    const contabId = await getOrCreatePathFolders(folderId, [CONTAB_FOLDER])
    const lista = await searchFilesFullText('computo', contabId)
    // lista è testo "📄 nome [ID: ...]"; estrai il primo ID
    const m = lista.match(/\[ID:\s*([^\]]+)\]/)
    if (!m) return `Nessun computo trovato in ${CONTAB_FOLDER}. File presenti:\n${lista}`
    const testo = await readPdfFromDrive(m[1].trim())
    return `Computo trovato. Estrai da qui le voci (codice, descrizione, quantità, prezzo, importo) e il TOTALE, poi raggruppa in gruppi coerenti:\n\n${testo}`
  }

  if (name === 'sal_calcola') {
    const calcInput: SalCalcInput = {
      numero_sal: input.numero_sal as number,
      totale_computo: input.totale_computo as number,
      gruppi: input.gruppi as SalCalcInput['gruppi'],
      sal_precedente: input.sal_precedente as number,
      params: input.params as SalCalcInput['params'],
    }
    let result
    try {
      result = calcolaSal(calcInput)
    } catch (err) {
      if (err instanceof SalReconcileError) return `⚠️ ${err.message}`
      throw err
    }
    const meta: SalMeta = {
      commessa: input.commessa as string,
      oggetto: input.oggetto as string,
      data: input.data as string,
      numero_sal: input.numero_sal as number,
    }
    // Crea pending (payload = tutto il necessario per generare i doc alla conferma)
    const descrizione =
      `SAL n° ${result.numero_sal} — ${meta.commessa}\n` +
      `Maturato nel periodo: € ${eur(result.maturato_nel_periodo)} — Totale certificato: € ${eur(result.totale_certificato)}\n` +
      `Conferma con /sal_ok_<id> (poi /sal_ok2_<id>), annulla con /sal_no_<id>`
    const payload = { result, meta, commessa_folder_id: input.commessa_folder_id }
    const { data, error } = await getSupabaseServer()
      .from('cervellone_sal_pending')
      .insert({ payload, descrizione, stato: 'in_attesa', conferme: 0 })
      .select('id')
      .single()
    if (error || !data) return `Errore salvataggio SAL pending: ${error?.message ?? 'sconosciuto'}`

    const righe = result.gruppi.map(g => `• ${g.nome}: ${g.percentuale}% → € ${eur(g.maturato_a_oggi)}`).join('\n')
    return (
      `📊 *SAL n° ${result.numero_sal}* — ${meta.commessa}\n\n${righe}\n\n` +
      `Totale maturato a oggi: € ${eur(result.totale_maturato_a_oggi)}\n` +
      `− SAL precedente: € ${eur(result.sal_precedente)}\n` +
      `= Maturato nel periodo: € ${eur(result.maturato_nel_periodo)}\n` +
      (result.ritenuta_periodo ? `− Ritenuta garanzia: € ${eur(result.ritenuta_periodo)}\n` : '') +
      (result.recupero_anticipazione ? `− Recupero anticipazione: € ${eur(result.recupero_anticipazione)}\n` : '') +
      `Imponibile: € ${eur(result.imponibile_certificato)} + IVA € ${eur(result.iva)} = *€ ${eur(result.totale_certificato)}*\n\n` +
      `Per salvare in ${CONTAB_FOLDER}: /sal_ok_${data.id}\nPer annullare: /sal_no_${data.id}`
    )
  }

  return null
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npm run test:unit -- src/lib/sal-tools.test.ts`
Expected: PASS (2 test: riconciliazione fallita + null su tool estraneo).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sal-tools.ts src/lib/sal-tools.test.ts
git commit -m "feat(sal): tool sal_calcola (pending+anteprima) e sal_estrai_computo"
```

---

### Task 5: Conferme a due passi + generazione/upload documenti

**Files:**
- Modify: `src/lib/sal-tools.ts` (aggiungi le tre funzioni export in fondo)
- Test: `src/lib/sal-tools.test.ts` (aggiungi un test di annullamento)

**Interfaces:**
- Produces: `confirmSalStep1(id)`, `confirmSalStep2(id)`, `cancelSal(id)` (vedi Task 4 interfaces).
- Consumes: pending `cervellone_sal_pending`, `generatePdfFromHtml`, `generateXlsxFromData`, `buildSalHtml`, `buildSalSheets`, `getOrCreatePathFolders`, `uploadBinaryToDrive`.

- [ ] **Step 1: Scrivi il test di annullamento** (aggiungi al file test)

```ts
describe('cancelSal', () => {
  it('imposta stato annullato con claim ottimistico', async () => {
    // Mock supabase-server per intercettare l'update
    const updateChain = { eq: vi.fn().mockReturnThis(), select: vi.fn(async () => ({ data: [{ id: 'x' }], error: null })) }
    vi.doMock('./supabase-server', () => ({ getSupabaseServer: () => ({ from: () => ({ update: () => updateChain }) }) }))
    const { cancelSal } = await import('./sal-tools')
    const msg = await cancelSal('00000000-0000-4000-8000-000000000000')
    expect(msg.toLowerCase()).toContain('annull')
  })
})
```

- [ ] **Step 2: Esegui e verifica il fallimento**

Run: `npm run test:unit -- src/lib/sal-tools.test.ts -t cancelSal`
Expected: FAIL (`cancelSal` non esportata).

- [ ] **Step 3: Implementa le tre funzioni** (in coda a `sal-tools.ts`)

```ts
export async function confirmSalStep1(id: string): Promise<string> {
  const sb = getSupabaseServer()
  const { data } = await sb.from('cervellone_sal_pending')
    .update({ conferme: 1, updated_at: new Date().toISOString() })
    .eq('id', id).eq('stato', 'in_attesa').eq('conferme', 0)
    .select('id')
  if (!data || data.length === 0) return 'SAL non trovato o già confermato/annullato.'
  return `Confermi il salvataggio del SAL? Conferma definitiva con /sal_ok2_${id} (oppure /sal_no_${id} per annullare).`
}

export async function cancelSal(id: string): Promise<string> {
  const sb = getSupabaseServer()
  const { data } = await sb.from('cervellone_sal_pending')
    .update({ stato: 'annullato', updated_at: new Date().toISOString() })
    .eq('id', id).neq('stato', 'creato')
    .select('id')
  if (!data || data.length === 0) return 'SAL non trovato o già creato.'
  return 'SAL annullato.'
}

export async function confirmSalStep2(id: string): Promise<string> {
  const sb = getSupabaseServer()
  // Claim ottimistico: solo chi porta conferme 1->2 procede
  const { data: claimed } = await sb.from('cervellone_sal_pending')
    .update({ conferme: 2, updated_at: new Date().toISOString() })
    .eq('id', id).eq('stato', 'in_attesa').eq('conferme', 1)
    .select('payload')
  if (!claimed || claimed.length === 0) return 'SAL non pronto (serve prima /sal_ok_...) o già creato/annullato.'

  const payload = claimed[0].payload as { result: import('./sal-calc').SalResult; meta: import('./sal-render').SalMeta; commessa_folder_id: string }
  try {
    const xlsxBuf = await generateXlsxFromData(buildSalSheets(payload.result, payload.meta), `SAL_${payload.result.numero_sal}`)
    const pdfBuf = await generatePdfFromHtml(buildSalHtml(payload.result, payload.meta), `SAL n${payload.result.numero_sal}`)
    const contabId = await getOrCreatePathFolders(payload.commessa_folder_id, [CONTAB_FOLDER])
    const base = `SAL_${payload.result.numero_sal}_${payload.meta.data}`
    const xlsx = await uploadBinaryToDrive(xlsxBuf, `${base}.xlsx`, XLSX_MIME, contabId)
    const pdf = await uploadBinaryToDrive(pdfBuf, `${base}.pdf`, PDF_MIME, contabId)
    await sb.from('cervellone_sal_pending').update({ stato: 'creato', updated_at: new Date().toISOString() }).eq('id', id)
    return `✅ SAL n° ${payload.result.numero_sal} salvato in ${CONTAB_FOLDER}:\n📊 ${xlsx.webViewLink}\n📄 ${pdf.webViewLink}`
  } catch (err) {
    // Rollback stato per permettere un nuovo tentativo
    await sb.from('cervellone_sal_pending').update({ conferme: 1, updated_at: new Date().toISOString() }).eq('id', id)
    return `Errore in generazione/salvataggio SAL: ${err instanceof Error ? err.message : String(err)}. Riprova con /sal_ok2_${id}.`
  }
}
```

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `npm run test:unit -- src/lib/sal-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sal-tools.ts src/lib/sal-tools.test.ts
git commit -m "feat(sal): doppia conferma + generazione/upload XLSX+PDF in Contabilita"
```

---

### Task 6: Wiring in `tools.ts` (registro + executor)

**Files:**
- Modify: `src/lib/tools.ts` (import; `...SAL_TOOLS` in `ALL_TOOLS` ~:2519; `executeSalTool` in `EXECUTORS` ~:2545)

**Interfaces:**
- Consumes: `SAL_TOOLS`, `executeSalTool` (Task 4).

- [ ] **Step 1: Aggiungi l'import** (in cima a `tools.ts`, vicino agli altri import di tool, es. dopo l'import di `fic-write-tools`)

```ts
import { SAL_TOOLS, executeSalTool } from './sal-tools'
```

- [ ] **Step 2: Registra le definizioni** — nell'array `ALL_TOOLS` (~:2519) aggiungi `...SAL_TOOLS` (es. dopo `...STUDIO_TECNICO_TOOLS`)

```ts
const ALL_TOOLS: ToolDefinition[] = [
  ...STUDIO_TECNICO_TOOLS,
  ...SAL_TOOLS,
  // ...resto invariato
]
```

- [ ] **Step 3: Registra l'executor** — nell'array `EXECUTORS` (~:2545) aggiungi `executeSalTool`

```ts
const EXECUTORS = [
  executeStudioTecnico,
  executeSalTool,
  // ...resto invariato
]
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit` (ignora gli errori pre-esistenti in `pdf-generator.test.ts`).
Expected: nessun errore nuovo in `tools.ts` / `sal-tools.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.ts
git commit -m "feat(sal): registra SAL_TOOLS e executeSalTool nel dispatcher"
```

---

### Task 7: Intercept comandi Telegram `/sal_ok_`, `/sal_ok2_`, `/sal_no_`

**Files:**
- Modify: `src/app/api/telegram/route.ts` (blocco intercept comandi, ~:585, accanto ai match `/fic_ok...`)

**Interfaces:**
- Consumes: `confirmSalStep1`, `confirmSalStep2`, `cancelSal` (Task 5); helper esistente `sendTelegramMessage(chatId, msg)`.

- [ ] **Step 1: Aggiungi l'import** (accanto agli altri import in route.ts)

```ts
import { confirmSalStep1, confirmSalStep2, cancelSal } from '@/lib/sal-tools'
```

- [ ] **Step 2: Aggiungi il blocco intercept** (subito dopo il blocco `/fic_ok...`, ~:597)

```ts
const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
const mSalOk2 = userText.match(new RegExp(`^\\/sal_ok2_${UUID}\\b`, 'i'))
const mSalOk  = userText.match(new RegExp(`^\\/sal_ok_${UUID}\\b`, 'i'))
const mSalNo  = userText.match(new RegExp(`^\\/sal_no_${UUID}\\b`, 'i'))
if (mSalOk2 || mSalOk || mSalNo) {
  const uuid = (mSalOk2 ?? mSalOk ?? mSalNo)![1]
  const message = mSalOk2 ? await confirmSalStep2(uuid) : mSalOk ? await confirmSalStep1(uuid) : await cancelSal(uuid)
  await sendTelegramMessage(chatId, message)
  return NextResponse.json({ ok: true })
}
```

Nota: verifica il nome esatto della variabile del testo utente (`userText`) e dell'helper di invio (`sendTelegramMessage`) leggendo il blocco `/fic_ok...` circostante; riusa gli stessi.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: nessun errore nuovo in `route.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/telegram/route.ts
git commit -m "feat(sal): intercept comandi /sal_ok /sal_ok2 /sal_no nel webhook Telegram"
```

---

### Task 8: Regola prompt — procedura SAL

**Files:**
- Modify: `src/lib/prompts.ts` (aggiungi una sezione REGOLA TOOL SAL, vicino alle altre regole tool, es. dopo la sezione contabilità/FIC)

**Interfaces:**
- Consumes: i tool `sal_estrai_computo`, `sal_calcola` e i comandi `/sal_ok_`.

- [ ] **Step 1: Aggiungi la sezione al system prompt** (attenzione: è dentro un template literal — NIENTE backtick nel testo)

```ts
REGOLA TOOL SAL (Stato Avanzamento Lavori da computo):
Quando l'Ingegnere chiede un SAL per una commessa:
1. Trova la cartella della commessa (tool drive) e usa sal_estrai_computo(commessa_folder_id) per leggere il computo.
2. Estrai le voci (codice, descrizione, quantità, prezzo, importo) e il TOTALE del computo.
3. Proponi tu un raggruppamento in GRUPPI DI LAVORAZIONE COERENTI (circa 10-15, non tutte le voci, non solo macro-categorie). Ogni gruppo = somma degli importi delle sue voci. Mostra i gruppi all'Ingegnere e fatteli correggere/approvare.
4. Leggi il Contratto d'Appalto della commessa per i parametri economici: IVA, ritenuta di garanzia (se prevista), anticipazione/acconto (importo e se va recuperata all'ultimo SAL). Se un dato non c'è nel contratto, chiedilo. Conferma i parametri.
5. Chiedi la % di avanzamento per ogni gruppo e l'importo del SAL precedente (0 se è il primo). Chiedi se è il SAL finale.
6. Chiama sal_calcola con gruppi+%+params. NON calcolare tu i numeri: li calcola il tool. Se torna "Riconciliazione fallita", il raggruppamento non quadra col totale: correggi i gruppi, non forzare.
7. Mostra l'anteprima ritornata dal tool. Il salvataggio avviene solo dopo doppia conferma dell'Ingegnere (/sal_ok_<id> poi /sal_ok2_<id>). Non dire mai "salvato" prima del link reale ritornato da /sal_ok2.
```

- [ ] **Step 2: Verifica assenza backtick nell'aggiunta**

Run: `grep -n "REGOLA TOOL SAL" -A 12 src/lib/prompts.ts | grep -c '`'`
Expected: `0`

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: nessun errore nuovo.

- [ ] **Step 4: Commit**

```bash
git add src/lib/prompts.ts
git commit -m "feat(sal): regola prompt procedura SAL (estrai->raggruppa->contratto->calcola->conferma)"
```

---

## Self-Review

**Spec coverage:**
- §① Estrazione computo + riconciliazione → Task 4 (`sal_estrai_computo`) + Task 2 (gate in `calcolaSal`). ✓
- §② Raggruppamento (bot propone, utente corregge) → Task 8 (prompt) + `sal_calcola` accetta i gruppi. ✓
- §③ Parametri dal contratto → Task 8 (prompt legge contratto) + `params` in `sal_calcola`. ✓
- §④ Calcolo deterministico → Task 2. ✓
- §⑤ XLSX+PDF + doppia conferma + salvataggio Contabilità → Task 3, 5, 7. ✓
- Tabella pending → Task 1. ✓
- Test calcoli → Task 2, 3, 4, 5. ✓

**Placeholder scan:** nessun TBD/TODO; codice completo in ogni step. ✓

**Type consistency:** `SalCalcInput`/`SalResult`/`SalMeta` usati coerentemente tra Task 2→3→4→5; `executeSalTool` firma `(name, input, conversationId?) => Promise<string|null>` coerente col contratto EXECUTORS (Task 6). ✓

**Nota implementativa (verifica a runtime):** i nomi esatti `userText` / `sendTelegramMessage` in `route.ts` e la firma di `searchFilesFullText` (ritorna testo con `[ID: ...]`) vanno confermati leggendo il codice circostante durante l'esecuzione del task (indicato negli step).
