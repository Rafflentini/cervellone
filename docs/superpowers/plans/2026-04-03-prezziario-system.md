# Sistema Prezziario Regionale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettere al Cervellone di scaricare autonomamente i prezziari regionali lavori pubblici da internet, memorizzarli nella tabella `prezziario` su Supabase, e usarli per generare preventivi con prezzi reali.

**Architecture:** Nuovo tool `scarica_prezziario` che Claude chiama per cercare online il PDF/Excel del prezziario regionale, scaricarlo, parsare le voci (codice, descrizione, u.m., prezzo), e salvare tutto nella tabella `prezziario` esistente. Il tool `calcola_preventivo` già cerca nella tabella — basta popolarla. Il system prompt viene aggiornato per istruire Claude a verificare la disponibilità del prezziario prima di fare preventivi.

**Tech Stack:** Anthropic SDK (web_search), fetch per download, pdf-parse per PDF, Supabase per storage.

---

## File Structure

| File | Responsabilità |
|------|---------------|
| `src/lib/tools/scarica-prezziario.ts` | **NUOVO** — logica di download, parsing e salvataggio prezziario |
| `src/lib/tools/prezziario.ts` | **MODIFICA** — aggiungere `countPrezziario()` e `listRegioniDisponibili()` |
| `src/lib/tools.ts` | **MODIFICA** — registrare il nuovo tool `scarica_prezziario` e `verifica_prezziario` |
| `src/app/api/chat/route.ts` | **MODIFICA** — aggiornare system prompt con istruzioni prezziario |
| `src/app/api/telegram/route.ts` | **MODIFICA** — stesso aggiornamento system prompt |

---

### Task 1: Aggiungere funzioni di query prezziario

**Files:**
- Modify: `src/lib/tools/prezziario.ts`

- [ ] **Step 1: Aggiungere `countPrezziario` per verificare disponibilità**

```typescript
// Aggiungere alla fine di src/lib/tools/prezziario.ts

/**
 * Check if prezziario data exists for a given region/year.
 */
export async function countPrezziario(
  regione: string,
  anno?: number,
): Promise<{ count: number; regione: string; anno: number }> {
  const targetAnno = anno || new Date().getFullYear()

  for (const y of [targetAnno, targetAnno - 1, targetAnno - 2]) {
    const { count, error } = await supabase
      .from('prezziario')
      .select('*', { count: 'exact', head: true })
      .eq('regione', regione.toLowerCase())
      .eq('anno', y)

    if (!error && count && count > 0) {
      return { count, regione: regione.toLowerCase(), anno: y }
    }
  }

  return { count: 0, regione: regione.toLowerCase(), anno: targetAnno }
}

/**
 * List all regions with prezziario data.
 */
export async function listRegioniDisponibili(): Promise<Array<{ regione: string; anno: number; count: number }>> {
  const { data, error } = await supabase
    .from('prezziario')
    .select('regione, anno')

  if (error || !data) return []

  const grouped = new Map<string, { anno: number; count: number }>()
  for (const row of data) {
    const key = `${row.regione}_${row.anno}`
    const existing = grouped.get(key)
    if (existing) {
      existing.count++
    } else {
      grouped.set(key, { anno: row.anno, count: 1 })
    }
  }

  return Array.from(grouped.entries()).map(([key, val]) => ({
    regione: key.split('_')[0],
    anno: val.anno,
    count: val.count,
  }))
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/tools/prezziario.ts
git commit -m "feat: add countPrezziario and listRegioniDisponibili queries"
```

---

### Task 2: Creare il modulo scarica-prezziario

**Files:**
- Create: `src/lib/tools/scarica-prezziario.ts`

- [ ] **Step 1: Creare il file con la logica di download e parsing**

```typescript
import { supabase } from '@/lib/supabase'

interface VocePrezziario {
  codice_voce: string
  descrizione: string
  unita_misura: string
  prezzo: number
}

interface ScaricaPrezziarioInput {
  regione: string
  anno?: number
  url?: string // URL diretto al PDF/Excel se già noto
}

interface ScaricaPrezziarioResult {
  success: boolean
  regione: string
  anno: number
  voci_salvate: number
  fonte: string
  errore?: string
}

/**
 * Parse prezziario rows from text content.
 * Looks for patterns like:
 *   CODE  DESCRIPTION  U.M.  PRICE
 * Handles both tab-separated and space-separated formats.
 */
function parseVociFromText(text: string): VocePrezziario[] {
  const voci: VocePrezziario[] = []
  const lines = text.split('\n')

  // Pattern: codice (es. "01.A01.001" o "A.01.001.a"), descrizione, u.m., prezzo
  const pricePattern = /^([A-Z0-9][A-Z0-9.]+[a-z0-9.]*)\s+(.+?)\s+(mq|mc|ml|kg|q\.?li?|t|cad|nr|a corpo|m|m²|m³|h|gg|%|lt|dm³)\s+([\d.,]+)\s*$/i

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.length < 10) continue

    const match = trimmed.match(pricePattern)
    if (match) {
      const prezzo = parseFloat(match[4].replace(/\./g, '').replace(',', '.'))
      if (!isNaN(prezzo) && prezzo > 0 && prezzo < 100000) {
        voci.push({
          codice_voce: match[1].trim(),
          descrizione: match[2].trim(),
          unita_misura: match[3].trim(),
          prezzo,
        })
      }
    }
  }

  return voci
}

/**
 * Download a PDF and extract text using pdf-parse (already installed).
 */
async function downloadAndParsePdf(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/pdf,*/*',
    },
    signal: AbortSignal.timeout(60000),
  })

  if (!res.ok) throw new Error(`Download fallito: ${res.status} ${res.statusText}`)

  const buffer = Buffer.from(await res.arrayBuffer())
  const pdfParse = (await import('pdf-parse')).default
  const data = await pdfParse(buffer)
  return data.text
}

/**
 * Download a CSV/text file and return its content.
 */
async function downloadTextFile(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    signal: AbortSignal.timeout(30000),
  })

  if (!res.ok) throw new Error(`Download fallito: ${res.status} ${res.statusText}`)
  return res.text()
}

/**
 * Save parsed voci to the prezziario table in batches.
 */
async function salvaVociInBatch(
  voci: VocePrezziario[],
  regione: string,
  anno: number,
  fonte: string,
): Promise<number> {
  const BATCH_SIZE = 500
  let totalSaved = 0

  for (let i = 0; i < voci.length; i += BATCH_SIZE) {
    const batch = voci.slice(i, i + BATCH_SIZE).map(v => ({
      regione: regione.toLowerCase(),
      anno,
      codice_voce: v.codice_voce,
      descrizione: v.descrizione,
      unita_misura: v.unita_misura,
      prezzo: v.prezzo,
      fonte,
    }))

    const { error } = await supabase.from('prezziario').insert(batch)
    if (error) {
      console.error(`PREZZIARIO: errore batch ${i}-${i + BATCH_SIZE}:`, error.message)
    } else {
      totalSaved += batch.length
    }
  }

  return totalSaved
}

/**
 * Main function: download, parse, and save a regional prezziario.
 * Called by Claude as a tool when it finds the prezziario URL via web search.
 */
export async function executeScaricaPrezziario(
  input: ScaricaPrezziarioInput,
): Promise<ScaricaPrezziarioResult> {
  const regione = input.regione.toLowerCase()
  const anno = input.anno || new Date().getFullYear()
  const url = input.url

  if (!url) {
    return {
      success: false,
      regione,
      anno,
      voci_salvate: 0,
      fonte: '',
      errore: 'Nessun URL fornito. Usa web_search per trovare il prezziario regionale, poi richiama questo tool con il URL del PDF o CSV.',
    }
  }

  try {
    console.log(`PREZZIARIO: scaricamento ${url} per ${regione} ${anno}`)

    // Determine file type from URL
    const isCSV = url.match(/\.(csv|txt|tsv)(\?|$)/i)
    const text = isCSV
      ? await downloadTextFile(url)
      : await downloadAndParsePdf(url)

    console.log(`PREZZIARIO: estratti ${text.length} caratteri di testo`)

    // Parse voci
    const voci = parseVociFromText(text)
    console.log(`PREZZIARIO: trovate ${voci.length} voci con prezzo`)

    if (voci.length === 0) {
      return {
        success: false,
        regione,
        anno,
        voci_salvate: 0,
        fonte: url,
        errore: `Nessuna voce di prezzo trovata nel file. Il formato potrebbe non essere supportato. L'Ingegnere potrebbe caricare il prezziario in chat per un'analisi manuale delle voci.`,
      }
    }

    // Save to database
    const fonte = `Prezziario ${regione.charAt(0).toUpperCase() + regione.slice(1)} ${anno}`
    const saved = await salvaVociInBatch(voci, regione, anno, fonte)

    return {
      success: true,
      regione,
      anno,
      voci_salvate: saved,
      fonte,
    }
  } catch (err) {
    return {
      success: false,
      regione,
      anno,
      voci_salvate: 0,
      fonte: url,
      errore: `Errore durante il download/parsing: ${err}`,
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/tools/scarica-prezziario.ts
git commit -m "feat: add scarica-prezziario module — download, parse, save regional price lists"
```

---

### Task 3: Registrare i nuovi tool in tools.ts

**Files:**
- Modify: `src/lib/tools.ts`

- [ ] **Step 1: Aggiungere import e tool schema**

Aggiungere in cima al file, dopo l'import esistente:

```typescript
import { executeScaricaPrezziario } from './tools/scarica-prezziario'
import { countPrezziario, listRegioniDisponibili } from './tools/prezziario'
```

Aggiungere nell'array `CUSTOM_TOOLS` dopo il tool `calcola_preventivo`:

```typescript
  {
    name: 'verifica_prezziario',
    description: 'Verifica se hai il prezziario regionale in memoria per una data regione. Usa SEMPRE questo tool PRIMA di fare un preventivo per controllare se hai i prezzi reali. Se il risultato è 0 voci, devi prima scaricare il prezziario con scarica_prezziario.',
    input_schema: {
      type: 'object' as const,
      properties: {
        regione: { type: 'string', description: 'Nome regione (es. basilicata, lazio, campania)' },
        anno: { type: 'number', description: 'Anno del prezziario (default: anno corrente)' },
      },
      required: ['regione'],
    },
  },
  {
    name: 'scarica_prezziario',
    description: 'Scarica e memorizza un prezziario regionale da un URL (PDF o CSV). Prima cerca il prezziario online con web_search, trova il link diretto al file, poi usa questo tool per scaricarlo e salvarlo in memoria permanente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        regione: { type: 'string', description: 'Nome regione (es. basilicata, lazio, campania)' },
        anno: { type: 'number', description: 'Anno del prezziario' },
        url: { type: 'string', description: 'URL diretto al file PDF o CSV del prezziario' },
      },
      required: ['regione', 'url'],
    },
  },
```

- [ ] **Step 2: Aggiungere i case nello switch di executeTool**

Nella funzione `executeTool`, aggiungere prima del `default:`:

```typescript
    case 'verifica_prezziario': {
      const regione = input.regione as string
      const anno = input.anno as number | undefined
      const result = await countPrezziario(regione, anno)
      if (result.count > 0) {
        return `Prezziario ${result.regione} ${result.anno} disponibile: ${result.count} voci in memoria.`
      }
      const disponibili = await listRegioniDisponibili()
      if (disponibili.length === 0) {
        return `Nessun prezziario in memoria. Devi cercarne uno online con web_search e scaricarlo con scarica_prezziario.`
      }
      return `Prezziario ${regione} NON disponibile. Prezziari in memoria: ${disponibili.map(d => `${d.regione} ${d.anno} (${d.count} voci)`).join(', ')}. Cerca il prezziario ${regione} online con web_search.`
    }
    case 'scarica_prezziario':
      return JSON.stringify(await executeScaricaPrezziario(input as unknown as { regione: string; anno?: number; url?: string }))
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/tools.ts
git commit -m "feat: register verifica_prezziario and scarica_prezziario tools"
```

---

### Task 4: Aggiornare il system prompt (chat + telegram)

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/app/api/telegram/route.ts`

- [ ] **Step 1: Aggiungere istruzioni prezziario nel system prompt della chat**

In `src/app/api/chat/route.ts`, nel `SYSTEM_PROMPT`, dopo la riga `- Un database di conoscenza...`, aggiungere:

```
- Un prezziario regionale dei lavori pubblici. PRIMA di generare un preventivo:
  1. Determina la regione dal comune del cantiere
  2. Usa il tool verifica_prezziario per controllare se hai il prezziario di quella regione
  3. Se NON hai il prezziario: cercalo online con web_search (es. "prezziario regionale lavori pubblici basilicata 2025 PDF"), trova il link al file PDF o CSV, e scaricalo con scarica_prezziario
  4. Se non riesci a trovarlo online: proponi all'Ingegnere di (a) caricare il PDF del prezziario in chat, (b) usare un prezziario di una regione vicina, o (c) procedere con i prezzi da te stimati specificando che NON sono da prezziario ufficiale
  5. Solo dopo aver verificato il prezziario, usa il tool calcola_preventivo con i prezzi reali
```

- [ ] **Step 2: Applicare la stessa modifica al system prompt Telegram**

In `src/app/api/telegram/route.ts`, nel `SYSTEM_PROMPT`, aggiungere lo stesso testo dopo `- Un database di conoscenza...`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/chat/route.ts src/app/api/telegram/route.ts
git commit -m "feat: instruct Claude to verify prezziario before generating preventivi"
```

---

### Task 5: Aggiungere indice full-text search sulla tabella prezziario

**Files:**
- Migration Supabase (via MCP)

- [ ] **Step 1: Creare indice GIN per full-text search italiano**

Eseguire via `mcp__plugin_supabase_supabase__apply_migration`:

```sql
-- Full-text search index for Italian descriptions
CREATE INDEX IF NOT EXISTS idx_prezziario_descrizione_fts
  ON prezziario
  USING GIN (to_tsvector('italian', descrizione));

-- Composite index for region+year lookups
CREATE INDEX IF NOT EXISTS idx_prezziario_regione_anno
  ON prezziario (regione, anno);

-- Index on codice_voce for exact lookups
CREATE INDEX IF NOT EXISTS idx_prezziario_codice
  ON prezziario (codice_voce)
  WHERE codice_voce IS NOT NULL;
```

- [ ] **Step 2: Verificare che gli indici siano stati creati**

Eseguire via `mcp__plugin_supabase_supabase__execute_sql`:

```sql
SELECT indexname, tablename FROM pg_indexes WHERE tablename = 'prezziario';
```

---

### Task 6: Caricare il prezziario Basilicata

Questa task è manuale/interattiva — Claude deve cercare e scaricare il prezziario.

- [ ] **Step 1: Push di tutto e attendere deploy**

```bash
git push
```

Verificare con `mcp__plugin_vercel_vercel__list_deployments` che il deploy sia READY.

- [ ] **Step 2: Testare da chat web**

Andare su https://cervellone-5poc.vercel.app e scrivere:

> "Fammi un preventivo per la sig.ra Rossi, ristrutturazione appartamento a Potenza, opere murarie"

Claude dovrebbe:
1. Chiamare `verifica_prezziario` con regione "basilicata"
2. Ottenere 0 voci
3. Cercare online con `web_search`
4. Trovare il PDF del prezziario Basilicata
5. Chiamare `scarica_prezziario` con l'URL
6. Generare il preventivo con prezzi reali

- [ ] **Step 3: Verificare i dati in Supabase**

```sql
SELECT regione, anno, COUNT(*) as voci, MIN(prezzo), MAX(prezzo)
FROM prezziario
GROUP BY regione, anno;
```

---

### Task 7: Fallback — se il parsing automatico fallisce

Se il parsing del PDF non funziona bene (prezziari con layout complessi), il system prompt già istruisce Claude a proporre alternative. Ma possiamo anche far analizzare il PDF a Claude stesso.

- [ ] **Step 1: Aggiungere modalità manuale nel system prompt**

Aggiungere dopo le istruzioni prezziario esistenti:

```
- Se scarica_prezziario non riesce a parsare il PDF automaticamente, puoi chiedere all'Ingegnere di caricare il PDF in chat. Quando lo fa, analizza le voci di prezzo pagina per pagina e salvale con il tool scarica_prezziario passando le voci già estratte.
```

Nota: questo non richiede codice aggiuntivo — il tool `scarica_prezziario` salva comunque le voci che trova. Il fallback è che Claude stesso faccia il parsing visuale del PDF caricato in chat.

---

## Summary

| Task | Cosa fa | File |
|------|---------|------|
| 1 | Query functions: count + list regioni | `prezziario.ts` |
| 2 | Download + parse + save module | `scarica-prezziario.ts` (nuovo) |
| 3 | Register tools nello switch | `tools.ts` |
| 4 | System prompt con istruzioni | `route.ts` (chat + telegram) |
| 5 | Indici DB per performance | Migration Supabase |
| 6 | Test end-to-end + caricamento Basilicata | Manuale |
| 7 | Fallback analisi manuale | System prompt |
