# Tool `calcola_preventivo` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `calcola_preventivo` tool that Claude calls to generate preventivi with code-precise calculations, prezziario comparison, and professional HTML output.

**Architecture:** Claude collects project info and calls the tool with structured data. The tool does all math in code, compares prices against the regional prezziario (cached in Supabase), generates a complete HTML document with Restruktura branding, and returns it for Claude to wrap in a `~~~document` block.

**Tech Stack:** TypeScript, Supabase (prezziario cache table), Anthropic tool_use API (existing pattern in `src/lib/tools.ts`)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/lib/tools/format.ts` | Number formatting (Italian style), date formatting |
| `src/lib/tools/prezziario.ts` | Search prezziario in Supabase cache, fallback web search, store results |
| `src/lib/tools/preventivo-html.ts` | Generate the complete HTML document from calculated data |
| `src/lib/tools/preventivo.ts` | Main tool: validate input, calculate amounts, call prezziario, call HTML generator |
| `src/lib/tools.ts` | Register the new tool in CUSTOM_TOOLS, route in executeTool() |

---

### Task 1: Number and date formatting utilities

**Files:**
- Create: `src/lib/tools/format.ts`

- [ ] **Step 1: Create the format utilities**

```typescript
// src/lib/tools/format.ts

/**
 * Format a number Italian-style: 12500.50 → "12.500,50"
 */
export function formatEuro(value: number): string {
  return value.toLocaleString('it-IT', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

/**
 * Format a date Italian-style: "2026-04-03" → "03/04/2026"
 */
export function formatDate(dateStr?: string): string {
  const d = dateStr ? new Date(dateStr) : new Date()
  return d.toLocaleDateString('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

/**
 * Generate a preventivo number: PREV-2026-001
 */
export function generateNumeroPreventivo(): string {
  const now = new Date()
  const year = now.getFullYear()
  const rand = Math.floor(Math.random() * 900) + 100
  return `PREV-${year}-${rand}`
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/tools/format.ts
git commit -m "feat: add Italian number/date formatting utilities"
```

---

### Task 2: Prezziario search and cache

**Files:**
- Create: `src/lib/tools/prezziario.ts`

- [ ] **Step 1: Create Supabase table for prezziario cache**

Run this SQL in the Supabase dashboard:

```sql
CREATE TABLE IF NOT EXISTS prezziario (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  regione TEXT NOT NULL,
  anno INTEGER NOT NULL,
  codice_voce TEXT,
  descrizione TEXT NOT NULL,
  unita_misura TEXT,
  prezzo NUMERIC NOT NULL,
  fonte TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_prezziario_regione_anno ON prezziario(regione, anno);
CREATE INDEX idx_prezziario_descrizione ON prezziario USING gin(to_tsvector('italian', descrizione));
```

- [ ] **Step 2: Create the prezziario module**

```typescript
// src/lib/tools/prezziario.ts

import { supabase } from '@/lib/supabase'

export interface PrezziarioResult {
  found: boolean
  prezzo: number | null
  fonte: string
  codice_voce: string | null
  descrizione_prezziario: string | null
}

/**
 * Search for a price in the prezziario cache.
 * If not found, returns { found: false }.
 * The caller (preventivo.ts) will handle web search fallback.
 */
export async function cercaPrezziario(
  descrizione: string,
  regione: string = 'basilicata',
  anno?: number,
): Promise<PrezziarioResult> {
  const targetAnno = anno || new Date().getFullYear()

  // Search current year first, then previous year
  for (const y of [targetAnno, targetAnno - 1]) {
    const { data, error } = await supabase
      .from('prezziario')
      .select('*')
      .eq('regione', regione.toLowerCase())
      .eq('anno', y)
      .textSearch('descrizione', descrizione.split(' ').slice(0, 4).join(' & '), {
        type: 'plain',
        config: 'italian',
      })
      .limit(1)

    if (!error && data && data.length > 0) {
      const match = data[0]
      return {
        found: true,
        prezzo: Number(match.prezzo),
        fonte: match.fonte || `Prezziario ${regione} ${y}`,
        codice_voce: match.codice_voce,
        descrizione_prezziario: match.descrizione,
      }
    }
  }

  return { found: false, prezzo: null, fonte: '', codice_voce: null, descrizione_prezziario: null }
}

/**
 * Save a prezziario entry to cache for future lookups.
 */
export async function salvaPrezziario(entry: {
  regione: string
  anno: number
  descrizione: string
  unita_misura: string
  prezzo: number
  codice_voce?: string
  fonte?: string
}): Promise<void> {
  await supabase.from('prezziario').insert({
    regione: entry.regione.toLowerCase(),
    anno: entry.anno,
    descrizione: entry.descrizione,
    unita_misura: entry.unita_misura,
    prezzo: entry.prezzo,
    codice_voce: entry.codice_voce || null,
    fonte: entry.fonte || `Prezziario ${entry.regione} ${entry.anno}`,
  })
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/tools/prezziario.ts
git commit -m "feat: add prezziario search and cache module"
```

---

### Task 3: HTML document generator

**Files:**
- Create: `src/lib/tools/preventivo-html.ts`

- [ ] **Step 1: Create the HTML generator**

```typescript
// src/lib/tools/preventivo-html.ts

import { formatEuro, formatDate } from './format'

export interface VoceCalcolata {
  numero: number
  descrizione: string
  um: string
  quantita: number
  prezzo_unitario: number
  importo: number
  categoria?: string
  prezzo_prezziario?: number | null
  scostamento_percentuale?: number | null
}

export interface PreventivoCalcolato {
  titolo: string
  numero: string
  data: string
  committente: { nome: string; indirizzo?: string; cf_piva?: string; telefono?: string; email?: string }
  cantiere: { indirizzo: string; comune: string; descrizione: string }
  voci: VoceCalcolata[]
  subtotale_lavori: number
  spese_generali: number
  spese_generali_perc: number
  utile_impresa: number
  utile_impresa_perc: number
  oneri_sicurezza: number
  oneri_sicurezza_perc: number
  totale_imponibile: number
  iva: number
  iva_perc: number
  totale_complessivo: number
  note: string[]
  esclusioni: string[]
  condizioni_pagamento: string
  validita_offerta: string
}

export function generaHtmlPreventivo(p: PreventivoCalcolato): string {
  // Group voci by categoria if present
  const hasCategorie = p.voci.some(v => v.categoria)

  // Build table rows
  let tableRows = ''
  if (hasCategorie) {
    const categorie = [...new Set(p.voci.map(v => v.categoria || 'Altro'))]
    for (const cat of categorie) {
      const vociCat = p.voci.filter(v => (v.categoria || 'Altro') === cat)
      tableRows += `<tr class="categoria"><td colspan="6">${cat}</td></tr>\n`
      for (const v of vociCat) {
        tableRows += voceRow(v)
      }
      const subtotaleCat = vociCat.reduce((s, v) => s + v.importo, 0)
      tableRows += `<tr class="subtotal"><td colspan="5">Subtotale ${cat}</td><td class="amount">${formatEuro(subtotaleCat)}</td></tr>\n`
    }
  } else {
    for (const v of p.voci) {
      tableRows += voceRow(v)
    }
  }

  // Scostamenti significativi
  const scostamenti = p.voci.filter(v => v.prezzo_prezziario && v.scostamento_percentuale && Math.abs(v.scostamento_percentuale) > 15)
  let confrontoSection = ''
  if (scostamenti.length > 0) {
    const confrontoRows = scostamenti.map(v =>
      `<tr><td>${v.descrizione}</td><td class="amount">${formatEuro(v.prezzo_unitario)}</td><td class="amount">${formatEuro(v.prezzo_prezziario!)}</td><td class="amount ${v.scostamento_percentuale! > 0 ? 'positive' : 'negative'}">${v.scostamento_percentuale! > 0 ? '+' : ''}${v.scostamento_percentuale!.toFixed(1)}%</td></tr>`
    ).join('\n')
    confrontoSection = `
    <h2 class="section-title">Confronto Prezziario Regionale</h2>
    <table>
      <thead><tr><th>Voce</th><th>P.U. Applicato</th><th>P.U. Prezziario</th><th>Scostamento</th></tr></thead>
      <tbody>${confrontoRows}</tbody>
    </table>`
  }

  // Note
  const noteHtml = p.note.length > 0 ? `
    <div class="notes">
      <div class="notes-title">Note e Condizioni</div>
      <ul>${p.note.map(n => `<li>${n}</li>`).join('')}</ul>
      <p><strong>Condizioni di pagamento:</strong> ${p.condizioni_pagamento}</p>
      <p><strong>Validita offerta:</strong> ${p.validita_offerta}</p>
    </div>` : ''

  // Esclusioni
  const esclusioniHtml = p.esclusioni.length > 0 ? `
    <div class="notes exclusions">
      <div class="notes-title">Esclusioni</div>
      <ul>${p.esclusioni.map(e => `<li>${e}</li>`).join('')}</ul>
    </div>` : ''

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4; margin: 15mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, Arial, sans-serif; color: #1a1a2e; background: #fff; line-height: 1.6; max-width: 210mm; margin: 0 auto; }
  .header { background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #1e40af 100%); color: white; padding: 32px 40px; position: relative; overflow: hidden; }
  .header::after { content: ''; position: absolute; top: -50%; right: -20%; width: 300px; height: 300px; background: radial-gradient(circle, rgba(59,130,246,0.15) 0%, transparent 70%); border-radius: 50%; }
  .header-content { position: relative; z-index: 1; }
  .company-name { font-size: 26px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; }
  .company-subtitle { font-size: 11px; color: #93c5fd; letter-spacing: 2px; text-transform: uppercase; margin-top: 2px; }
  .company-details { font-size: 11px; color: #bfdbfe; margin-top: 10px; line-height: 1.8; }
  .doc-title-bar { background: #f0f4ff; border-bottom: 3px solid #1e40af; padding: 14px 40px; display: flex; justify-content: space-between; align-items: center; }
  .doc-title { font-size: 17px; font-weight: 700; color: #1e3a5f; text-transform: uppercase; letter-spacing: 0.5px; }
  .doc-meta { font-size: 11px; color: #64748b; text-align: right; line-height: 1.8; }
  .doc-meta strong { color: #1e3a5f; }
  .content { padding: 24px 40px; }
  .section-title { font-size: 13px; font-weight: 700; color: #1e40af; text-transform: uppercase; letter-spacing: 0.5px; padding-bottom: 5px; border-bottom: 2px solid #e2e8f0; margin: 20px 0 10px 0; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 20px; background: #f8fafc; border-radius: 8px; padding: 14px; margin-bottom: 14px; }
  .info-label { color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .info-value { color: #1a1a2e; font-weight: 600; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 11px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border-radius: 8px; overflow: hidden; }
  thead th { background: linear-gradient(135deg, #1e3a5f, #1e40af); color: white; padding: 9px 10px; text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; }
  thead th:nth-child(n+3) { text-align: right; }
  tbody td { padding: 8px 10px; border-bottom: 1px solid #e8ecf1; }
  tbody td:nth-child(n+3) { text-align: right; }
  tbody tr:nth-child(even) { background: #f8fafc; }
  tbody tr.categoria { background: #eef2ff; font-weight: 700; font-size: 11px; color: #1e40af; }
  tbody tr.subtotal { background: #f0f4ff; font-weight: 700; border-top: 2px solid #cbd5e1; }
  tbody tr.coeff td { color: #475569; font-style: italic; }
  tbody tr.total { background: linear-gradient(135deg, #0f172a, #1e3a5f); color: white; font-weight: 800; font-size: 12px; }
  tbody tr.total td { padding: 11px 10px; border: none; }
  .amount { font-variant-numeric: tabular-nums; font-weight: 600; }
  .positive { color: #16a34a; }
  .negative { color: #dc2626; }
  .notes { background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 14px 0; border-radius: 0 8px 8px 0; font-size: 11px; }
  .notes.exclusions { background: #fef2f2; border-left-color: #ef4444; }
  .notes-title { font-weight: 700; color: #92400e; margin-bottom: 4px; font-size: 10px; text-transform: uppercase; }
  .notes.exclusions .notes-title { color: #991b1b; }
  .notes ul { padding-left: 16px; margin: 4px 0; }
  .notes li { margin-bottom: 3px; }
  .signature-area { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin: 28px 0 14px; }
  .signature-box { text-align: center; font-size: 11px; color: #64748b; }
  .signature-line { border-top: 1px solid #cbd5e1; padding-top: 8px; margin-top: 48px; }
  .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 40px; display: flex; justify-content: space-between; font-size: 9px; color: #94a3b8; margin-top: 20px; }
</style>
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="company-name">Restruktura S.r.l.</div>
      <div class="company-subtitle">Ingegneria &bull; Costruzioni &bull; Ponteggi</div>
      <div class="company-details">P.IVA 02087420762 &bull; Villa d'Agri &ndash; Marsicovetere (PZ)<br>Ing. Raffaele Lentini &bull; Legale Rappresentante</div>
    </div>
  </div>
  <div class="doc-title-bar">
    <div class="doc-title">${p.titolo}</div>
    <div class="doc-meta"><strong>N.:</strong> ${p.numero}<br><strong>Data:</strong> ${formatDate(p.data)}</div>
  </div>
  <div class="content">
    <h2 class="section-title">Committente</h2>
    <div class="info-grid">
      <div><div class="info-label">Nome</div><div class="info-value">${p.committente.nome}</div></div>
      ${p.committente.indirizzo ? `<div><div class="info-label">Indirizzo</div><div class="info-value">${p.committente.indirizzo}</div></div>` : ''}
      ${p.committente.cf_piva ? `<div><div class="info-label">C.F. / P.IVA</div><div class="info-value">${p.committente.cf_piva}</div></div>` : ''}
      ${p.committente.telefono ? `<div><div class="info-label">Telefono</div><div class="info-value">${p.committente.telefono}</div></div>` : ''}
      ${p.committente.email ? `<div><div class="info-label">Email</div><div class="info-value">${p.committente.email}</div></div>` : ''}
    </div>

    <h2 class="section-title">Cantiere</h2>
    <div class="info-grid">
      <div><div class="info-label">Indirizzo</div><div class="info-value">${p.cantiere.indirizzo}</div></div>
      <div><div class="info-label">Comune</div><div class="info-value">${p.cantiere.comune}</div></div>
      <div style="grid-column: 1 / -1;"><div class="info-label">Descrizione lavori</div><div class="info-value">${p.cantiere.descrizione}</div></div>
    </div>

    <h2 class="section-title">Voci di Preventivo</h2>
    <table>
      <thead><tr><th>N.</th><th>Descrizione</th><th>U.M.</th><th>Qt.</th><th>P.U. (&euro;)</th><th>Importo (&euro;)</th></tr></thead>
      <tbody>
        ${tableRows}
        <tr class="subtotal"><td colspan="5">Importo Lavori</td><td class="amount">${formatEuro(p.subtotale_lavori)}</td></tr>
        <tr class="coeff"><td colspan="5">Spese generali (${(p.spese_generali_perc * 100).toFixed(0)}%)</td><td class="amount">${formatEuro(p.spese_generali)}</td></tr>
        <tr class="coeff"><td colspan="5">Utile d'impresa (${(p.utile_impresa_perc * 100).toFixed(0)}%)</td><td class="amount">${formatEuro(p.utile_impresa)}</td></tr>
        <tr class="coeff"><td colspan="5">Oneri sicurezza (${(p.oneri_sicurezza_perc * 100).toFixed(1)}%)</td><td class="amount">${formatEuro(p.oneri_sicurezza)}</td></tr>
        <tr class="subtotal"><td colspan="5">Totale Imponibile</td><td class="amount">${formatEuro(p.totale_imponibile)}</td></tr>
        <tr class="coeff"><td colspan="5">IVA (${(p.iva_perc * 100).toFixed(0)}%)</td><td class="amount">${formatEuro(p.iva)}</td></tr>
        <tr class="total"><td colspan="5">TOTALE COMPLESSIVO</td><td class="amount">${formatEuro(p.totale_complessivo)}</td></tr>
      </tbody>
    </table>

    ${confrontoSection}
    ${noteHtml}
    ${esclusioniHtml}

    <div class="signature-area">
      <div class="signature-box"><div class="signature-line">Restruktura S.r.l.<br>Ing. Raffaele Lentini</div></div>
      <div class="signature-box"><div class="signature-line">Il Committente<br>${p.committente.nome}</div></div>
    </div>
  </div>
  <div class="footer">
    <span>Restruktura S.r.l. &bull; Documento generato dal Cervellone</span>
    <span>${formatDate(p.data)}</span>
  </div>
</body>
</html>`
}

function voceRow(v: VoceCalcolata): string {
  return `<tr><td>${v.numero}</td><td>${v.descrizione}</td><td>${v.um}</td><td class="amount">${v.um === 'a corpo' ? '' : formatEuro(v.quantita)}</td><td class="amount">${formatEuro(v.prezzo_unitario)}</td><td class="amount">${formatEuro(v.importo)}</td></tr>\n`
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/tools/preventivo-html.ts
git commit -m "feat: add professional HTML generator for preventivi"
```

---

### Task 4: Main preventivo tool logic

**Files:**
- Create: `src/lib/tools/preventivo.ts`

- [ ] **Step 1: Create the main tool**

```typescript
// src/lib/tools/preventivo.ts

import { formatEuro, generateNumeroPreventivo } from './format'
import { cercaPrezziario } from './prezziario'
import { generaHtmlPreventivo, VoceCalcolata, PreventivoCalcolato } from './preventivo-html'

interface PreventivoInput {
  titolo?: string
  numero?: string
  data?: string
  committente: { nome: string; indirizzo?: string; cf_piva?: string; telefono?: string; email?: string }
  cantiere: { indirizzo: string; comune: string; descrizione: string }
  voci: Array<{
    descrizione: string
    um: string
    quantita: number
    prezzo_unitario: number
    categoria?: string
  }>
  coefficienti?: {
    spese_generali?: number
    utile_impresa?: number
    oneri_sicurezza?: number
    iva?: number
  }
  regione?: string
  note?: string[]
  esclusioni?: string[]
  condizioni_pagamento?: string
  validita_offerta?: string
}

export async function executeCalcolaPreventivo(input: PreventivoInput): Promise<string> {
  const sg = input.coefficienti?.spese_generali ?? 0.15
  const ui = input.coefficienti?.utile_impresa ?? 0.10
  const os = input.coefficienti?.oneri_sicurezza ?? 0.025
  const iva = input.coefficienti?.iva ?? 0.10
  const regione = input.regione || 'basilicata'

  // Calculate each voce and compare with prezziario
  const vociCalcolate: VoceCalcolata[] = []
  let numero = 1

  for (const voce of input.voci) {
    // Search prezziario for comparison
    const prezziarioResult = await cercaPrezziario(voce.descrizione, regione)

    // Use the GREATER of our price vs prezziario
    let prezzoFinale = voce.prezzo_unitario
    let prezzoPrezziario: number | null = null
    let scostamento: number | null = null

    if (prezziarioResult.found && prezziarioResult.prezzo !== null) {
      prezzoPrezziario = prezziarioResult.prezzo
      if (prezzoPrezziario > prezzoFinale) {
        prezzoFinale = prezzoPrezziario
      }
      scostamento = ((prezzoFinale - prezzoPrezziario) / prezzoPrezziario) * 100
    }

    const importo = voce.quantita * prezzoFinale

    vociCalcolate.push({
      numero,
      descrizione: voce.descrizione,
      um: voce.um,
      quantita: voce.quantita,
      prezzo_unitario: prezzoFinale,
      importo: Math.round(importo * 100) / 100,
      categoria: voce.categoria,
      prezzo_prezziario: prezzoPrezziario,
      scostamento_percentuale: scostamento,
    })

    numero++
  }

  // Calculate totals — all in code, zero LLM math
  const subtotale = vociCalcolate.reduce((sum, v) => sum + v.importo, 0)
  const speseGen = Math.round(subtotale * sg * 100) / 100
  const utileImp = Math.round(subtotale * ui * 100) / 100
  const oneriSic = Math.round(subtotale * os * 100) / 100
  const totaleImponibile = Math.round((subtotale + speseGen + utileImp + oneriSic) * 100) / 100
  const ivaImporto = Math.round(totaleImponibile * iva * 100) / 100
  const totaleComplessivo = Math.round((totaleImponibile + ivaImporto) * 100) / 100

  const preventivo: PreventivoCalcolato = {
    titolo: input.titolo || 'Preventivo Estimativo',
    numero: input.numero || generateNumeroPreventivo(),
    data: input.data || new Date().toISOString().slice(0, 10),
    committente: input.committente,
    cantiere: input.cantiere,
    voci: vociCalcolate,
    subtotale_lavori: subtotale,
    spese_generali: speseGen,
    spese_generali_perc: sg,
    utile_impresa: utileImp,
    utile_impresa_perc: ui,
    oneri_sicurezza: oneriSic,
    oneri_sicurezza_perc: os,
    totale_imponibile: totaleImponibile,
    iva: ivaImporto,
    iva_perc: iva,
    totale_complessivo: totaleComplessivo,
    note: input.note || [],
    esclusioni: input.esclusioni || [],
    condizioni_pagamento: input.condizioni_pagamento || '30% alla firma, 40% al SAL, 30% al collaudo',
    validita_offerta: input.validita_offerta || '60 giorni',
  }

  // Log for debugging
  console.log(`PREVENTIVO: ${vociCalcolate.length} voci, subtotale ${formatEuro(subtotale)}, totale ${formatEuro(totaleComplessivo)}`)

  return generaHtmlPreventivo(preventivo)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/tools/preventivo.ts
git commit -m "feat: add calcola_preventivo main logic with prezziario comparison"
```

---

### Task 5: Register tool in CUSTOM_TOOLS

**Files:**
- Modify: `src/lib/tools.ts`

- [ ] **Step 1: Add the tool definition and routing**

Replace the entire content of `src/lib/tools.ts`:

```typescript
// Tool custom per il Cervellone

import { executeCalcolaPreventivo } from './tools/preventivo'

export const CUSTOM_TOOLS = [
  {
    name: 'read_webpage',
    description: 'Leggi il contenuto di una pagina web specifica. Usa questo strumento quando hai un URL e vuoi leggerne il contenuto completo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'URL completo della pagina da leggere',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'calcola_preventivo',
    description: 'Genera un preventivo estimativo professionale con calcoli precisi, confronto prezziario regionale e output HTML. Usa SEMPRE questo tool quando devi generare un preventivo — non calcolare a mente. Il tool restituisce HTML completo da mettere in un blocco ~~~document.',
    input_schema: {
      type: 'object' as const,
      properties: {
        titolo: { type: 'string', description: 'Titolo del documento (default: Preventivo Estimativo)' },
        numero: { type: 'string', description: 'Numero preventivo (default: auto-generato)' },
        data: { type: 'string', description: 'Data in formato YYYY-MM-DD (default: oggi)' },
        committente: {
          type: 'object',
          properties: {
            nome: { type: 'string' },
            indirizzo: { type: 'string' },
            cf_piva: { type: 'string' },
            telefono: { type: 'string' },
            email: { type: 'string' },
          },
          required: ['nome'],
        },
        cantiere: {
          type: 'object',
          properties: {
            indirizzo: { type: 'string' },
            comune: { type: 'string' },
            descrizione: { type: 'string' },
          },
          required: ['indirizzo', 'comune', 'descrizione'],
        },
        voci: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              descrizione: { type: 'string' },
              um: { type: 'string', description: 'Unita di misura: mq, mc, kg, ml, cad, a corpo' },
              quantita: { type: 'number' },
              prezzo_unitario: { type: 'number', description: 'Prezzo unitario in euro' },
              categoria: { type: 'string', description: 'Categoria per raggruppamento (es. Demolizioni, Strutture)' },
            },
            required: ['descrizione', 'um', 'quantita', 'prezzo_unitario'],
          },
        },
        coefficienti: {
          type: 'object',
          properties: {
            spese_generali: { type: 'number', description: 'Default 0.15 (15%)' },
            utile_impresa: { type: 'number', description: 'Default 0.10 (10%)' },
            oneri_sicurezza: { type: 'number', description: 'Default 0.025 (2.5%)' },
            iva: { type: 'number', description: 'Default 0.10 (10%)' },
          },
        },
        regione: { type: 'string', description: 'Regione per prezziario (default: basilicata)' },
        note: { type: 'array', items: { type: 'string' } },
        esclusioni: { type: 'array', items: { type: 'string' } },
        condizioni_pagamento: { type: 'string' },
        validita_offerta: { type: 'string' },
      },
      required: ['committente', 'cantiere', 'voci'],
    },
  },
]

// Leggi contenuto di una pagina web
async function executeReadWebpage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(20000),
    })

    if (!res.ok) return `Errore: ${res.status} ${res.statusText}`

    const html = await res.text()

    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()

    const trimmed = text.length > 25000 ? text.slice(0, 25000) + '\n\n[...contenuto troncato]' : text
    return `Contenuto di ${url}:\n\n${trimmed}`
  } catch (err) {
    return `Errore lettura pagina: ${err}`
  }
}

// Esegui un tool custom
export async function executeTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'read_webpage':
      return executeReadWebpage(input.url as string)
    case 'calcola_preventivo':
      return executeCalcolaPreventivo(input as Parameters<typeof executeCalcolaPreventivo>[0])
    default:
      return `Tool "${name}" non riconosciuto.`
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/tools.ts
git commit -m "feat: register calcola_preventivo in CUSTOM_TOOLS"
```

---

### Task 6: Create Supabase table and deploy

- [ ] **Step 1: Create prezziario table in Supabase**

User must run this SQL in the Supabase dashboard (https://supabase.com/dashboard):

```sql
CREATE TABLE IF NOT EXISTS prezziario (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  regione TEXT NOT NULL,
  anno INTEGER NOT NULL,
  codice_voce TEXT,
  descrizione TEXT NOT NULL,
  unita_misura TEXT,
  prezzo NUMERIC NOT NULL,
  fonte TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_prezziario_regione_anno ON prezziario(regione, anno);
```

- [ ] **Step 2: Final commit and push**

```bash
git add -A
git commit -m "feat: calcola_preventivo tool complete — code-precise calculations + HTML output"
git push
```

- [ ] **Step 3: Test on Vercel**

1. Open https://cervellone-5poc.vercel.app
2. Ask: "Fammi un preventivo per la sig.ra Giano, opere murarie per ascensore a Villa d'Agri, 3 voci: allestimento cantiere 500 euro, scavi 500 euro, ponteggio 750 euro"
3. Verify: Claude calls `calcola_preventivo` tool (visible in logs)
4. Verify: Document preview panel opens with professional HTML
5. Verify: All amounts are calculated correctly by code
6. Verify: PDF button works (browser print dialog)
