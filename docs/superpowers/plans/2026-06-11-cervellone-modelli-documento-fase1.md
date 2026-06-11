# Modelli documento — Fase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dare al bot Telegram/web un motore generico, data-driven, per riprodurre documenti a impaginazione fedele (output PDF in Fase 1), in cui ogni modello è un *dato* (riga `document_templates`) e non codice; il CIGO è il primo modello e si sblocca subito riusando il builder Allegato 10 già esistente e testato.

**Architecture:** Una tabella `document_templates` + 4 tool generici (`insegna_modello`, `compila_modello`, `lista_modelli`, `ritrova_modello`) registrati nel tool-registry esistente (`ALL_TOOLS`/`EXECUTORS` in `src/lib/tools.ts`). `compila_modello` dispatcha sul campo `metodo`: `B_html` (riempi template HTML → PDF via Puppeteer esistente) oppure `builtin_cigo` (delega al pipeline `generaAllegato10Cigo` esistente → ZIP). Tutti gli output vanno su Drive via `uploadBinaryToDrive`; nessun invio mail.

**Tech Stack:** Next.js (App Router) + TypeScript, Supabase (`getSupabaseServer`), Puppeteer + `@sparticuz/chromium` (`generatePdfFromHtml` esistente), libreria `docx` (via builder CIGO esistente), Vitest. **Nessuna nuova dipendenza in Fase 1.**

---

## File Structure

- **Create** `supabase/migrations/2026-06-11-document-templates.sql` — tabella + RLS + seed CIGO.
- **Create** `src/lib/document-templates.ts` — tipi + CRUD (`createTemplate`, `getTemplate`, `listTemplates`, `normalizeSlug`).
- **Create** `src/lib/document-templates.test.ts` — test data layer (normalizeSlug; CRUD con supabase mockato).
- **Create** `src/lib/template-fill-html.ts` — Motore B puro (`validateValues`, `applyDefaults`, `escapeHtml`, `riempiHtml`).
- **Create** `src/lib/template-fill-html.test.ts` — test motore B.
- **Create** `src/lib/document-template-tools.ts` — `DOCUMENT_TEMPLATE_TOOLS` (4 ToolDefinition) + `executeDocumentTemplateTool`.
- **Create** `src/lib/document-template-tools.test.ts` — test executor (drive + cigo mockati).
- **Modify** `src/lib/tools.ts` — import + `...DOCUMENT_TEMPLATE_TOOLS` in `ALL_TOOLS` + `executeDocumentTemplateTool` in `EXECUTORS`.
- **Modify** `src/lib/prompts.ts` — sezione "REGOLA MODELLI DOCUMENTO".

Vincoli noti dal codice esistente:
- `getSupabaseServer()` da `@/lib/supabase-server` (vedi `src/lib/memoria-tools.ts:2`).
- `uploadBinaryToDrive(buffer, fileName, mimeType, folderId?) → { id, webViewLink }` (`src/lib/drive.ts:775`); chiama già `assertWriteAllowed` internamente; se `folderId` assente usa la cartella Bozze.
- `generatePdfFromHtml(html, title) → Buffer` (`src/lib/pdf-generator.ts:115`).
- `generaAllegato10Cigo(input, opts) → { zipBuffer, files, warnings? }` (`src/v19/tools/cigo/index.ts:32`); `Allegato10Input` in `src/v19/tools/cigo/types.ts`.
- `ToolDefinition { name, description, input_schema }` (`src/lib/tools.ts:80`).
- Pattern executor: `async (name, input, conversationId?) => Promise<string | null>`; ritorna `null` se non gestisce il tool (`src/lib/tools.ts:2401`).
- Test runner: Vitest (`npx vitest run <file>`).

---

### Task 1: Migration — tabella `document_templates` + RLS + seed CIGO

**Files:**
- Create: `supabase/migrations/2026-06-11-document-templates.sql`

- [ ] **Step 1: Scrivere la migration**

```sql
-- Modelli documento (binario A) — Fase 1
create table if not exists document_templates (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,
  titolo          text not null,
  parole_chiave   jsonb not null default '[]'::jsonb,
  tipo_sorgente   text not null,                 -- 'docx' | 'pdf_form' | 'pdf_flat' | 'html' | 'builtin'
  metodo          text not null,                 -- 'B_html' | 'builtin_cigo'
  master_drive_id text,
  html_template   text,
  campi           jsonb not null default '[]'::jsonb,
  formati_output  jsonb not null default '["pdf"]'::jsonb,
  dove_salvare    text,
  mai_inviare     boolean not null default true,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      text default 'cervellone:insegna_modello'
);

create index if not exists idx_document_templates_keywords
  on document_templates using gin (parole_chiave);

alter table document_templates enable row level security;

-- Coerente con l'hardening RLS: solo service_role (nessun accesso ANON).
drop policy if exists "service_role_all_document_templates" on document_templates;
create policy "service_role_all_document_templates"
  on document_templates for all
  to service_role
  using (true) with check (true);

-- Seed: CIGO Allegato 10 come primo modello (metodo builtin_cigo).
-- I default coprono i dati fissi (azienda + 3 operai abituali); l'utente passa solo i campi variabili.
insert into document_templates (slug, titolo, parole_chiave, tipo_sorgente, metodo, formati_output, dove_salvare, mai_inviare, campi)
values (
  'cigo_allegato10',
  'CIGO — Allegato 10 (relazione tecnica eventi meteo)',
  '["cigo","allegato 10","allegato10","eventi meteo","cig","integrazione salariale","maltempo"]'::jsonb,
  'builtin',
  'builtin_cigo',
  '["pdf"]'::jsonb,
  null,
  true,
  '[
    {"nome":"cantiere_comune","label":"Cantiere — Comune","tipo":"testo","obbligatorio":true,"descrizione":"Comune del cantiere"},
    {"nome":"cantiere_indirizzo","label":"Cantiere — indirizzo","tipo":"testo","obbligatorio":true},
    {"nome":"cantiere_data_apertura","label":"Data apertura cantiere (YYYY-MM-DD)","tipo":"data","obbligatorio":false},
    {"nome":"periodo_dal","label":"Periodo — dal (YYYY-MM-DD)","tipo":"data","obbligatorio":true},
    {"nome":"periodo_al","label":"Periodo — al (YYYY-MM-DD)","tipo":"data","obbligatorio":true},
    {"nome":"giornate_stop","label":"Giornate di sospensione (date)","tipo":"testo","obbligatorio":true,"descrizione":"Elenco date di stop, es. 04/06, 09/06"},
    {"nome":"lavorazioni","label":"Lavorazioni in corso","tipo":"testo","obbligatorio":true},
    {"nome":"evento_meteo","label":"Motivazione meteorologica","tipo":"testo","obbligatorio":true},
    {"nome":"conseguenze","label":"Conseguenze sull''attivita''","tipo":"testo","obbligatorio":true},
    {"nome":"beneficiari","label":"Operai coinvolti","tipo":"tabella","obbligatorio":false,
      "colonne":[{"nome":"cognome","tipo":"testo"},{"nome":"nome","tipo":"testo"},{"nome":"codice_fiscale","tipo":"testo"},{"nome":"qualifica","tipo":"testo"},{"nome":"ore","tipo":"numero"}],
      "default":[
        {"cognome":"PACILLI","nome":"MARTIN","codice_fiscale":"PCLMTN94C04E977G","qualifica":"Muratore Edile","ore":0},
        {"cognome":"PIRRONE","nome":"MICHELE","codice_fiscale":"PRRMHL83H08E977T","qualifica":"Manovale Edile","ore":0},
        {"cognome":"GURU","nome":"KULWANT RAY","codice_fiscale":"GRUKWN88E01Z222K","qualifica":"Manovale Edile","ore":0}
      ]
    },
    {"nome":"pagamento_diretto","label":"Pagamento diretto (SR41)","tipo":"scelta","obbligatorio":false,"default":false}
  ]'::jsonb
)
on conflict (slug) do nothing;
```

> NOTA: i CF/qualifiche degli operai sono i 3 abituali registrati in memoria; l'esecutore deve verificarli col file CIGO reale prima del primo uso in produzione (sono `default`, sempre sovrascrivibili dall'utente).

- [ ] **Step 2: Applicare la migration**

Applicazione via MCP Supabase (Cowork) o `supabase db push`. In ambiente di test/CI non si applica; i test del data layer usano il client mockato.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-06-11-document-templates.sql
git commit -m "feat(modelli): migration document_templates + RLS + seed CIGO"
```

---

### Task 2: Data layer — tipi + CRUD `document-templates.ts`

**Files:**
- Create: `src/lib/document-templates.ts`
- Test: `src/lib/document-templates.test.ts`

- [ ] **Step 1: Scrivere i test (normalizeSlug puro)**

```ts
import { describe, it, expect } from 'vitest'
import { normalizeSlug } from './document-templates'

describe('normalizeSlug', () => {
  it('minuscola, alfanumerico+underscore, niente accenti/spazi', () => {
    expect(normalizeSlug('CIGO Allegato 10')).toBe('cigo_allegato_10')
    expect(normalizeSlug('  Contratto d’appalto! ')).toBe('contratto_d_appalto')
    expect(normalizeSlug('perizia—2026')).toBe('perizia_2026')
  })
  it('collassa underscore multipli e taglia ai bordi', () => {
    expect(normalizeSlug('a   b')).toBe('a_b')
    expect(normalizeSlug('__x__')).toBe('x')
  })
})
```

- [ ] **Step 2: Eseguire i test (devono fallire)**

Run: `npx vitest run src/lib/document-templates.test.ts`
Expected: FAIL — `normalizeSlug is not a function` / modulo inesistente.

- [ ] **Step 3: Implementare `document-templates.ts`**

```ts
// src/lib/document-templates.ts — Modelli documento (binario A): tipi + CRUD
import { getSupabaseServer } from '@/lib/supabase-server'

export type CampoTipo = 'testo' | 'data' | 'numero' | 'tabella' | 'scelta'

export interface CampoColonna { nome: string; tipo: CampoTipo }

export interface CampoModello {
  nome: string
  label: string
  tipo: CampoTipo
  obbligatorio: boolean
  default?: unknown
  descrizione?: string
  colonne?: CampoColonna[] // solo tipo 'tabella'
}

export type MetodoModello = 'B_html' | 'builtin_cigo'

export interface DocumentTemplate {
  slug: string
  titolo: string
  parole_chiave: string[]
  tipo_sorgente: string
  metodo: MetodoModello
  master_drive_id?: string | null
  html_template?: string | null
  campi: CampoModello[]
  formati_output: string[]
  dove_salvare?: string | null
  mai_inviare: boolean
}

export interface CreateTemplateInput {
  slug: string
  titolo: string
  parole_chiave?: string[]
  tipo_sorgente: string
  metodo: MetodoModello
  master_drive_id?: string | null
  html_template?: string | null
  campi: CampoModello[]
  formati_output?: string[]
  dove_salvare?: string | null
  mai_inviare?: boolean
}

export function normalizeSlug(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accenti
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')     // non-alfanumerico -> underscore
    .replace(/_+/g, '_')             // collassa underscore
    .replace(/^_|_$/g, '')           // taglia ai bordi
}

const SELECT_COLS =
  'slug, titolo, parole_chiave, tipo_sorgente, metodo, master_drive_id, html_template, campi, formati_output, dove_salvare, mai_inviare'

function rowToTemplate(row: Record<string, unknown>): DocumentTemplate {
  return {
    slug: row.slug as string,
    titolo: row.titolo as string,
    parole_chiave: (row.parole_chiave as string[]) ?? [],
    tipo_sorgente: row.tipo_sorgente as string,
    metodo: row.metodo as MetodoModello,
    master_drive_id: (row.master_drive_id as string | null) ?? null,
    html_template: (row.html_template as string | null) ?? null,
    campi: (row.campi as CampoModello[]) ?? [],
    formati_output: (row.formati_output as string[]) ?? ['pdf'],
    dove_salvare: (row.dove_salvare as string | null) ?? null,
    mai_inviare: (row.mai_inviare as boolean) ?? true,
  }
}

export async function createTemplate(
  input: CreateTemplateInput,
): Promise<{ ok: boolean; slug?: string; error?: string }> {
  const slug = normalizeSlug(input.slug)
  if (!slug) return { ok: false, error: 'slug non valido' }
  if (!input.titolo?.trim()) return { ok: false, error: 'titolo obbligatorio' }
  if (!Array.isArray(input.campi)) return { ok: false, error: 'campi deve essere un array' }

  const supabase = getSupabaseServer()
  const { error } = await supabase
    .from('document_templates')
    .upsert(
      {
        slug,
        titolo: input.titolo.trim(),
        parole_chiave: input.parole_chiave ?? [],
        tipo_sorgente: input.tipo_sorgente,
        metodo: input.metodo,
        master_drive_id: input.master_drive_id ?? null,
        html_template: input.html_template ?? null,
        campi: input.campi,
        formati_output: input.formati_output ?? ['pdf'],
        dove_salvare: input.dove_salvare ?? null,
        mai_inviare: input.mai_inviare ?? true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'slug' },
    )

  if (error) return { ok: false, error: error.message }
  return { ok: true, slug }
}

export async function getTemplate(slug: string): Promise<DocumentTemplate | null> {
  const supabase = getSupabaseServer()
  const { data, error } = await supabase
    .from('document_templates')
    .select(SELECT_COLS)
    .eq('slug', normalizeSlug(slug))
    .maybeSingle()
  if (error || !data) return null
  return rowToTemplate(data as Record<string, unknown>)
}

export async function listTemplates(): Promise<
  Array<{ slug: string; titolo: string; parole_chiave: string[] }>
> {
  const supabase = getSupabaseServer()
  const { data, error } = await supabase
    .from('document_templates')
    .select('slug, titolo, parole_chiave')
    .order('updated_at', { ascending: false })
    .limit(50)
  if (error || !data) return []
  return (data as Array<Record<string, unknown>>).map((r) => ({
    slug: r.slug as string,
    titolo: r.titolo as string,
    parole_chiave: (r.parole_chiave as string[]) ?? [],
  }))
}
```

- [ ] **Step 4: Eseguire i test (devono passare)**

Run: `npx vitest run src/lib/document-templates.test.ts`
Expected: PASS (2 test normalizeSlug).

- [ ] **Step 5: Commit**

```bash
git add src/lib/document-templates.ts src/lib/document-templates.test.ts
git commit -m "feat(modelli): data layer document_templates (tipi + CRUD)"
```

---

### Task 3: Motore B — funzioni pure `template-fill-html.ts`

**Files:**
- Create: `src/lib/template-fill-html.ts`
- Test: `src/lib/template-fill-html.test.ts`

Convenzione template HTML:
- Segnaposto scalare: `{{nome_campo}}`.
- Blocco tabella ripetuto: `{{#nome_tabella}} ...html riga con {{colonna}}... {{/nome_tabella}}`.

- [ ] **Step 1: Scrivere i test**

```ts
import { describe, it, expect } from 'vitest'
import { validateValues, applyDefaults, escapeHtml, riempiHtml } from './template-fill-html'
import type { CampoModello } from './document-templates'

const campi: CampoModello[] = [
  { nome: 'titolo', label: 'Titolo', tipo: 'testo', obbligatorio: true },
  { nome: 'nota', label: 'Nota', tipo: 'testo', obbligatorio: false, default: 'n/d' },
  { nome: 'righe', label: 'Righe', tipo: 'tabella', obbligatorio: false,
    colonne: [{ nome: 'voce', tipo: 'testo' }, { nome: 'ore', tipo: 'numero' }] },
]

describe('validateValues', () => {
  it('segnala i campi obbligatori mancanti', () => {
    expect(validateValues(campi, {}).missing).toEqual(['titolo'])
    expect(validateValues(campi, { titolo: 'X' }).ok).toBe(true)
  })
  it('vuoto/whitespace conta come mancante', () => {
    expect(validateValues(campi, { titolo: '   ' }).missing).toEqual(['titolo'])
  })
})

describe('applyDefaults', () => {
  it('applica i default ai campi non forniti', () => {
    const out = applyDefaults(campi, { titolo: 'X' })
    expect(out.nota).toBe('n/d')
    expect(out.titolo).toBe('X')
  })
  it('non sovrascrive un valore fornito', () => {
    expect(applyDefaults(campi, { titolo: 'X', nota: 'mia' }).nota).toBe('mia')
  })
})

describe('escapeHtml', () => {
  it('neutralizza i caratteri pericolosi', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;')
  })
})

describe('riempiHtml', () => {
  it('sostituisce gli scalari con escape', () => {
    expect(riempiHtml('<p>{{titolo}}</p>', { titolo: '<x>' })).toBe('<p>&lt;x&gt;</p>')
  })
  it('espande i blocchi tabella', () => {
    const tpl = '<table>{{#righe}}<tr><td>{{voce}}</td><td>{{ore}}</td></tr>{{/righe}}</table>'
    const html = riempiHtml(tpl, { righe: [ { voce: 'a', ore: 2 }, { voce: 'b', ore: 3 } ] })
    expect(html).toBe('<table><tr><td>a</td><td>2</td></tr><tr><td>b</td><td>3</td></tr></table>')
  })
  it('blocco tabella senza dati -> vuoto', () => {
    expect(riempiHtml('<x>{{#righe}}r{{/righe}}</x>', {})).toBe('<x></x>')
  })
  it('scalare mancante -> stringa vuota', () => {
    expect(riempiHtml('<p>{{assente}}</p>', {})).toBe('<p></p>')
  })
})
```

- [ ] **Step 2: Eseguire i test (devono fallire)**

Run: `npx vitest run src/lib/template-fill-html.test.ts`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Implementare `template-fill-html.ts`**

```ts
// src/lib/template-fill-html.ts — Motore B: riempimento template HTML (puro, testabile)
import type { CampoModello } from './document-templates'

export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function validateValues(
  campi: CampoModello[],
  valori: Record<string, unknown>,
): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  for (const c of campi) {
    if (!c.obbligatorio) continue
    const v = valori[c.nome]
    const vuoto =
      v === undefined || v === null ||
      (typeof v === 'string' && v.trim() === '') ||
      (Array.isArray(v) && v.length === 0)
    if (vuoto) missing.push(c.nome)
  }
  return { ok: missing.length === 0, missing }
}

export function applyDefaults(
  campi: CampoModello[],
  valori: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...valori }
  for (const c of campi) {
    const v = out[c.nome]
    const vuoto = v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
    if (vuoto && c.default !== undefined) out[c.nome] = c.default
  }
  return out
}

// Espande i blocchi {{#nome}}...{{/nome}} per ogni riga dell'array `valori[nome]`,
// poi sostituisce gli scalari {{campo}} con escape HTML. Scalari mancanti -> ''.
export function riempiHtml(template: string, valori: Record<string, unknown>): string {
  // 1. blocchi tabella
  const blockRe = /\{\{#([a-zA-Z0-9_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g
  let html = template.replace(blockRe, (_m, nome: string, inner: string) => {
    const rows = valori[nome]
    if (!Array.isArray(rows) || rows.length === 0) return ''
    return rows
      .map((row) =>
        inner.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_mm, col: string) =>
          escapeHtml((row as Record<string, unknown>)[col]),
        ),
      )
      .join('')
  })

  // 2. scalari
  html = html.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_m, nome: string) => {
    const v = valori[nome]
    if (v === undefined || v === null || typeof v === 'object') return ''
    return escapeHtml(v)
  })

  return html
}
```

- [ ] **Step 4: Eseguire i test (devono passare)**

Run: `npx vitest run src/lib/template-fill-html.test.ts`
Expected: PASS (tutti i blocchi).

- [ ] **Step 5: Commit**

```bash
git add src/lib/template-fill-html.ts src/lib/template-fill-html.test.ts
git commit -m "feat(modelli): Motore B riempimento HTML (puro + test)"
```

---

### Task 4: Tool generici + executor `document-template-tools.ts`

**Files:**
- Create: `src/lib/document-template-tools.ts`
- Test: `src/lib/document-template-tools.test.ts`

- [ ] **Step 1: Scrivere i test (executor con dipendenze mockate)**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./document-templates', () => ({
  getTemplate: vi.fn(),
  listTemplates: vi.fn(),
  createTemplate: vi.fn(),
  normalizeSlug: (s: string) => s.toLowerCase(),
}))
vi.mock('./drive', () => ({ uploadBinaryToDrive: vi.fn() }))
vi.mock('./pdf-generator', () => ({ generatePdfFromHtml: vi.fn() }))
vi.mock('@/v19/tools/cigo', () => ({ generaAllegato10Cigo: vi.fn() }))

import { executeDocumentTemplateTool } from './document-template-tools'
import * as dt from './document-templates'
import * as drive from './drive'
import * as pdf from './pdf-generator'
import * as cigo from '@/v19/tools/cigo'

beforeEach(() => vi.clearAllMocks())

describe('executeDocumentTemplateTool', () => {
  it('ritorna null per tool non gestiti', async () => {
    expect(await executeDocumentTemplateTool('altro_tool', {})).toBeNull()
  })

  it('compila_modello: modello assente -> errore chiaro', async () => {
    ;(dt.getTemplate as any).mockResolvedValue(null)
    const out = await executeDocumentTemplateTool('compila_modello', { slug: 'xxx', valori: {} })
    expect(out).toMatch(/non.*trovat/i)
  })

  it('compila_modello: campi obbligatori mancanti -> li chiede, non genera', async () => {
    ;(dt.getTemplate as any).mockResolvedValue({
      slug: 'm', titolo: 'M', metodo: 'B_html', html_template: '<p>{{x}}</p>',
      campi: [{ nome: 'x', label: 'X', tipo: 'testo', obbligatorio: true }],
      formati_output: ['pdf'], mai_inviare: true,
    })
    const out = await executeDocumentTemplateTool('compila_modello', { slug: 'm', valori: {} })
    expect(out).toMatch(/mancano|servono/i)
    expect(out).toContain('X')
    expect(pdf.generatePdfFromHtml).not.toHaveBeenCalled()
    expect(drive.uploadBinaryToDrive).not.toHaveBeenCalled()
  })

  it('compila_modello B_html: happy path -> PDF su Drive + link reale', async () => {
    ;(dt.getTemplate as any).mockResolvedValue({
      slug: 'm', titolo: 'M', metodo: 'B_html', html_template: '<p>{{x}}</p>',
      campi: [{ nome: 'x', label: 'X', tipo: 'testo', obbligatorio: true }],
      formati_output: ['pdf'], mai_inviare: true,
    })
    ;(pdf.generatePdfFromHtml as any).mockResolvedValue(Buffer.from('PDF'))
    ;(drive.uploadBinaryToDrive as any).mockResolvedValue({ id: 'fid', webViewLink: 'https://drive/x' })
    const out = await executeDocumentTemplateTool('compila_modello', { slug: 'm', valori: { x: 'ciao' } })
    expect(pdf.generatePdfFromHtml).toHaveBeenCalledOnce()
    expect(drive.uploadBinaryToDrive).toHaveBeenCalledOnce()
    expect(out).toContain('https://drive/x')
  })

  it('compila_modello builtin_cigo: delega a generaAllegato10Cigo + carica ZIP', async () => {
    ;(dt.getTemplate as any).mockResolvedValue({
      slug: 'cigo_allegato10', titolo: 'CIGO', metodo: 'builtin_cigo',
      campi: [
        { nome: 'periodo_dal', label: 'dal', tipo: 'data', obbligatorio: true },
        { nome: 'periodo_al', label: 'al', tipo: 'data', obbligatorio: true },
      ],
      formati_output: ['pdf'], mai_inviare: true,
    })
    ;(cigo.generaAllegato10Cigo as any).mockResolvedValue({ zipBuffer: Buffer.from('ZIP'), warnings: [] })
    ;(drive.uploadBinaryToDrive as any).mockResolvedValue({ id: 'z', webViewLink: 'https://drive/zip' })
    const out = await executeDocumentTemplateTool('compila_modello', {
      slug: 'cigo_allegato10',
      valori: { periodo_dal: '2026-06-01', periodo_al: '2026-06-11' },
    })
    expect(cigo.generaAllegato10Cigo).toHaveBeenCalledOnce()
    expect(drive.uploadBinaryToDrive).toHaveBeenCalledWith(expect.any(Buffer), expect.stringContaining('.zip'), 'application/zip', undefined)
    expect(out).toContain('https://drive/zip')
  })

  it('lista_modelli: elenca gli slug', async () => {
    ;(dt.listTemplates as any).mockResolvedValue([{ slug: 'cigo_allegato10', titolo: 'CIGO', parole_chiave: [] }])
    const out = await executeDocumentTemplateTool('lista_modelli', {})
    expect(out).toContain('cigo_allegato10')
  })
})
```

- [ ] **Step 2: Eseguire i test (devono fallire)**

Run: `npx vitest run src/lib/document-template-tools.test.ts`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Implementare `document-template-tools.ts`**

```ts
// src/lib/document-template-tools.ts — Tool generici "Modelli documento" (binario A, Fase 1)
import {
  createTemplate,
  getTemplate,
  listTemplates,
  normalizeSlug,
  type CampoModello,
  type DocumentTemplate,
} from './document-templates'
import { validateValues, applyDefaults, riempiHtml } from './template-fill-html'
import { generatePdfFromHtml } from './pdf-generator'
import { uploadBinaryToDrive } from './drive'
import { generaAllegato10Cigo } from '@/v19/tools/cigo'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export const DOCUMENT_TEMPLATE_TOOLS: ToolDefinition[] = [
  {
    name: 'lista_modelli',
    description:
      'Elenca i modelli di documento che hai imparato (riutilizzabili). Usalo quando l’utente chiede "quali modelli conosci" o per verificare se un documento richiesto esiste già come modello.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'ritrova_modello',
    description:
      'Restituisce la scheda di un modello (campi richiesti compresi). Usalo PRIMA di compilare, per sapere quali dati chiedere all’utente.',
    input_schema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'identificativo del modello' } },
      required: ['slug'],
    },
  },
  {
    name: 'insegna_modello',
    description:
      'Salva (o aggiorna) un modello di documento riutilizzabile, come DATO. Chiamalo quando l’utente dice "questo è un modello / ricordatelo / da ora riproducimelo". Per i modelli HTML (metodo B_html) fornisci html_template con segnaposto {{campo}} e blocchi {{#tabella}}...{{/tabella}}. Identifica i campi variabili e CONFERMALI con l’utente prima di salvare.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        titolo: { type: 'string' },
        parole_chiave: { type: 'array', items: { type: 'string' } },
        tipo_sorgente: { type: 'string', enum: ['docx', 'pdf_form', 'pdf_flat', 'html', 'builtin'] },
        metodo: { type: 'string', enum: ['B_html', 'builtin_cigo'] },
        master_drive_id: { type: 'string' },
        html_template: { type: 'string' },
        campi: { type: 'array', items: { type: 'object' } },
        formati_output: { type: 'array', items: { type: 'string', enum: ['pdf', 'docx'] } },
        dove_salvare: { type: 'string', description: 'ID cartella Drive dove salvare i documenti generati' },
        mai_inviare: { type: 'boolean' },
      },
      required: ['slug', 'titolo', 'tipo_sorgente', 'metodo', 'campi'],
    },
  },
  {
    name: 'compila_modello',
    description:
      'Genera un documento da un modello insegnato, riempiendo i campi variabili e mantenendo l’impaginazione. Salva il file su Drive e RITORNA IL LINK REALE. NON invia mai nulla. Se mancano campi obbligatori, te li dice: chiedili all’utente, non inventarli.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        valori: { type: 'object', description: 'mappa campo->valore secondo la scheda del modello' },
        formato: { type: 'string', enum: ['pdf', 'docx'] },
        dove_salvare: { type: 'string', description: 'ID cartella Drive (opzionale)' },
      },
      required: ['slug', 'valori'],
    },
  },
]

function labelOf(campi: CampoModello[], nome: string): string {
  return campi.find((c) => c.nome === nome)?.label ?? nome
}

// Mappa i valori "piatti" del modello CIGO sull'Allegato10Input del builder esistente.
function mapCigoInput(valori: Record<string, unknown>): Record<string, unknown> {
  const beneficiari = Array.isArray(valori.beneficiari) ? valori.beneficiari : []
  return {
    azienda: {
      denominazione: 'RESTRUKTURA S.R.L.',
      codice_fiscale: '02087420762',
      matricola_inps: '6405924990',
      unita_produttiva: "Villa d'Agri – Via Enrico Mattei 5",
    },
    legale_rappresentante: { nome_cognome: 'Lentini Raffaele', qualifica: 'legale_rappresentante' },
    periodo: { data_inizio: String(valori.periodo_dal ?? ''), data_fine: String(valori.periodo_al ?? '') },
    attivita_svolta: String(valori.lavorazioni ?? ''),
    evento_meteo: String(valori.evento_meteo ?? ''),
    conseguenze: String(valori.conseguenze ?? ''),
    ulteriori_annotazioni:
      valori.giornate_stop ? `Giornate di sospensione: ${String(valori.giornate_stop)}.` : undefined,
    beneficiari: beneficiari.map((b) => {
      const row = b as Record<string, unknown>
      return {
        cognome: String(row.cognome ?? ''),
        nome: String(row.nome ?? ''),
        codice_fiscale: String(row.codice_fiscale ?? ''),
        qualifica: row.qualifica ? String(row.qualifica) : undefined,
      }
    }),
    pagamento_diretto: Boolean(valori.pagamento_diretto ?? false),
  }
}

function todayTag(): string {
  return new Date().toISOString().slice(0, 10)
}

async function compila(input: Record<string, unknown>): Promise<string> {
  const slug = normalizeSlug(String(input.slug ?? ''))
  const valoriRaw = (input.valori as Record<string, unknown>) ?? {}
  const tpl: DocumentTemplate | null = await getTemplate(slug)
  if (!tpl) return `❌ Modello "${slug}" non trovato. Usa lista_modelli per vedere quelli disponibili, oppure insegnamelo con insegna_modello.`

  const validation = validateValues(tpl.campi, valoriRaw)
  if (!validation.ok) {
    const etichette = validation.missing.map((n) => `• ${labelOf(tpl.campi, n)}`).join('\n')
    return `Per generare "${tpl.titolo}" mi servono questi dati:\n${etichette}\n\nDammeli e procedo. (Non li invento.)`
  }

  const valori = applyDefaults(tpl.campi, valoriRaw)
  const folderId = (input.dove_salvare as string) || tpl.dove_salvare || undefined

  if (tpl.metodo === 'builtin_cigo') {
    const out = await generaAllegato10Cigo(mapCigoInput(valori) as never, {} as never)
    const zip = (out as { zipBuffer?: Buffer }).zipBuffer
    if (!zip) return '❌ Non sono riuscito a generare il pacchetto CIGO (ZIP mancante).'
    const fileName = `CIGO_Allegato10_${todayTag()}.zip`
    const { webViewLink } = await uploadBinaryToDrive(zip, fileName, 'application/zip', folderId)
    const warnings = (out as { warnings?: string[] }).warnings ?? []
    let msg = `✅ Pacchetto CIGO generato: **${fileName}**\n📁 ${webViewLink}\n(Relazione Allegato 10 + CSV beneficiari + bollettino, dove disponibile. Non ho inviato nulla.)`
    if (warnings.length) msg += `\n\n⚠️ ${warnings.join('\n')}`
    return msg
  }

  // metodo B_html
  if (!tpl.html_template) return `❌ Il modello "${slug}" non ha un template HTML configurato.`
  const html = riempiHtml(tpl.html_template, valori)
  const pdf = await generatePdfFromHtml(html, tpl.titolo)
  const fileName = `${slug}_${todayTag()}.pdf`
  const { webViewLink } = await uploadBinaryToDrive(pdf, fileName, 'application/pdf', folderId)
  return `✅ Documento generato: **${fileName}**\n📁 ${webViewLink}\n(Impaginazione del modello "${tpl.titolo}". Non ho inviato nulla.)`
}

export async function executeDocumentTemplateTool(
  name: string,
  input: Record<string, unknown>,
  _conversationId?: string,
): Promise<string | null> {
  try {
    if (name === 'lista_modelli') {
      const list = await listTemplates()
      if (!list.length) return 'Non ho ancora imparato nessun modello. Insegnamene uno: caricami il documento e dimmi quali parti cambiano.'
      return 'Modelli che conosco:\n' + list.map((m) => `• ${m.titolo} (slug: ${m.slug})`).join('\n')
    }

    if (name === 'ritrova_modello') {
      const tpl = await getTemplate(String(input.slug ?? ''))
      if (!tpl) return `Modello "${input.slug}" non trovato.`
      const campi = tpl.campi
        .map((c) => `• ${c.label}${c.obbligatorio ? ' (obbligatorio)' : ''} [${c.tipo}]`)
        .join('\n')
      return `Modello: ${tpl.titolo} (slug: ${tpl.slug})\nMetodo: ${tpl.metodo}\nCampi:\n${campi}`
    }

    if (name === 'insegna_modello') {
      const res = await createTemplate({
        slug: String(input.slug ?? ''),
        titolo: String(input.titolo ?? ''),
        parole_chiave: (input.parole_chiave as string[]) ?? [],
        tipo_sorgente: String(input.tipo_sorgente ?? 'html'),
        metodo: (input.metodo as DocumentTemplate['metodo']) ?? 'B_html',
        master_drive_id: (input.master_drive_id as string) ?? null,
        html_template: (input.html_template as string) ?? null,
        campi: (input.campi as CampoModello[]) ?? [],
        formati_output: (input.formati_output as string[]) ?? ['pdf'],
        dove_salvare: (input.dove_salvare as string) ?? null,
        mai_inviare: input.mai_inviare === undefined ? true : Boolean(input.mai_inviare),
      })
      if (!res.ok) return `❌ Non sono riuscito a salvare il modello: ${res.error}`
      return `✅ Modello salvato (slug: ${res.slug}). Da ora puoi chiedermi di riprodurlo: ti chiederò solo i dati variabili.`
    }

    if (name === 'compila_modello') {
      return await compila(input)
    }

    return null
  } catch (err) {
    return `❌ Errore nello strumento modelli: ${err instanceof Error ? err.message : String(err)}`
  }
}
```

- [ ] **Step 4: Eseguire i test (devono passare)**

Run: `npx vitest run src/lib/document-template-tools.test.ts`
Expected: PASS (tutti i casi: null, modello assente, campi mancanti, B_html happy, builtin_cigo, lista).

- [ ] **Step 5: Commit**

```bash
git add src/lib/document-template-tools.ts src/lib/document-template-tools.test.ts
git commit -m "feat(modelli): tool generici insegna/compila/lista/ritrova + executor"
```

---

### Task 5: Wiring nel tool-registry `tools.ts`

**Files:**
- Modify: `src/lib/tools.ts` (import in cima; `ALL_TOOLS` ~2389; `EXECUTORS` ~2391)

- [ ] **Step 1: Aggiungere l'import**

Vicino agli altri import di tool-pack (es. dopo l'import di `MAIL_TOOL_DEFINITIONS`), aggiungere:

```ts
import { DOCUMENT_TEMPLATE_TOOLS, executeDocumentTemplateTool } from './document-template-tools'
```

- [ ] **Step 2: Registrare le definizioni in `ALL_TOOLS`**

In `const ALL_TOOLS: ToolDefinition[] = [ ... ]`, aggiungere la riga **prima** di `...(MAIL_TOOL_DEFINITIONS ...)`:

```ts
  ...DOCUMENT_TEMPLATE_TOOLS,
```

- [ ] **Step 3: Registrare l'executor in `EXECUTORS`**

Nell'array `const EXECUTORS = [ ... ]`, aggiungere `executeDocumentTemplateTool` **prima** di `executeMailWrapper` (stessa posizione relativa di `DOCUMENT_TEMPLATE_TOOLS` in `ALL_TOOLS`):

```ts
const EXECUTORS = [/* ...esistenti... */, executeDraftWrapper, executeDocumentTemplateTool, executeMailWrapper]
```

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: nessun errore nuovo introdotto da questi file.

Run: `npm run build`
Expected: build OK (la lezione del 3 giu: typecheck/build SEMPRE prima del deploy).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools.ts
git commit -m "feat(modelli): wiring DOCUMENT_TEMPLATE_TOOLS nel registry"
```

---

### Task 6: Regole di prompt `prompts.ts`

**Files:**
- Modify: `src/lib/prompts.ts` (dopo la sezione delle regole MAIL / anti-allucinazione, ~riga 184)

- [ ] **Step 1: Aggiungere la sezione regole**

Inserire nel testo del system prompt (stesso stile delle regole esistenti) il blocco:

```
REGOLA MODELLI DOCUMENTO (insegna_modello / compila_modello):
- Quando l'utente ti carica un documento e dice "questo è un modello / ricordatelo / da ora riproducimelo", INDIVIDUA i campi variabili (quelli che cambiano ogni volta: nomi, date, importi, ore, righe di tabella), PROPONILI all'utente e, dopo conferma, chiama insegna_modello per salvarlo come DATO. Non limitarti a descrivere: salva davvero.
- Quando l'utente chiede un documento che conosci come modello (es. "fammi il CIGO di giugno"), usa ritrova_modello per sapere i campi richiesti, poi CHIEDI i dati mancanti e chiama compila_modello. NON scrivere il documento "a mano" come testo: usa SEMPRE compila_modello, che mantiene l'impaginazione.
- Dopo compila_modello, mostra all'utente IL LINK REALE ritornato dal tool. Non dire mai "generato/salvato su Drive" senza quel link. Se mancano campi obbligatori, il tool te li elenca: chiedili all'utente, non inventarli.
- NON inviare MAI il documento (mail/PEC). Consegna solo il file all'utente; lui firma e invia. Un eventuale invio va richiesto esplicitamente in un secondo momento.
```

- [ ] **Step 2: Verifica build prompt**

Run: `npx tsc --noEmit`
Expected: nessun errore (attenzione: niente backtick markdown dentro template literal — lezione 24 mag).

- [ ] **Step 3: Commit**

```bash
git add src/lib/prompts.ts
git commit -m "feat(modelli): regole prompt insegna/compila + mai-inviare"
```

---

### Task 7: Verifica finale (test suite + build) prima dell'audit

**Files:** nessuno (solo verifica)

- [ ] **Step 1: Eseguire i test dei nuovi moduli**

Run: `npx vitest run src/lib/document-templates.test.ts src/lib/template-fill-html.test.ts src/lib/document-template-tools.test.ts`
Expected: tutti PASS.

- [ ] **Step 2: Typecheck completo**

Run: `npx tsc --noEmit`
Expected: nessun errore nuovo (i rossi vitest pre-esistenti d'ambiente non sono regressioni).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: OK.

- [ ] **Step 4: Commit finale (se restano modifiche)**

```bash
git add -A && git commit -m "chore(modelli): Fase 1 completa (test+build verdi)"
```

---

## Note per l'esecuzione (NON sono task di codice)

1. **Verifica dati CIGO reali:** prima del primo uso in prod, confrontare i `default` operai (CF/qualifiche) con il file CIGO reale dell'utente. Sono sovrascrivibili, ma meglio corretti di default.
2. **Audit adversarial PRIMA del deploy** (lezione 10 giu): cercare allucinazione residua ("salvato" senza link), invio non richiesto, race, campi mancanti gestiti male, fedeltà formattazione CIGO.
3. **Deploy** lo fa Claude (MCP Vercel o empty-commit) → verificare READY → smoke reale via Telegram dell'utente ("fammi il CIGO di giugno con dati di prova").
4. **Migration** `2026-06-11-document-templates.sql` applicata da Cowork/MCP Supabase (non in CI).
5. **Fase 2** (piano separato): Motore A (`docxtemplater` + `pizzip` per Word byte-perfect, `pdf-lib` per PDF-modulo) + "templatizza esempio" + SR41 reale + output `.docx` per i modelli B_html. Richiede OK nuove dipendenze.

---

## Self-Review (coverage spec → task)

- Spec §2 (tabella + schema campi) → Task 1, Task 2 ✓
- Spec §3 (3+1 tool generici) → Task 4 ✓ (insegna/compila/lista/ritrova)
- Spec §4 (Motore B Fase 1) → Task 3 + Task 4 ✓ (Motore A = Fase 2, fuori da questo piano)
- Spec §5 (CIGO primo modello + extra) → Task 1 (seed) + Task 4 (`builtin_cigo` → `generaAllegato10Cigo`) ✓
- Spec §6 (anti-allucinazione: link reale, campi chiesti, mai-inviare) → Task 4 (validazione+link reale) + Task 6 (regole prompt) ✓
- Spec §7 (test/audit/typecheck) → Task 2/3/4 (TDD) + Task 7 + Note esecuzione ✓
- Spec §8 (wiring) → Task 5 ✓
- Richiamo deterministico (spec §2.3): in Fase 1 il richiamo passa per parole_chiave del modello + regole prompt; l'iniezione "non-opzionale" nel system prompt via `buildWorkingContext` è un miglioramento previsto ma NON necessario allo sblocco CIGO — annotato come follow-up se l'uso reale mostra che il bot non aggancia il modello da solo.
```