# Contabilità Sub-progetto B (ingest estratti conto) — Implementation Plan

> **For agentic workers:** eseguito da Codex (un task `.loop/queue/NNN-*.md` per unità) con review/merge/deploy di Claude. Sandbox offline: verifica = review + `next build` Vercel + smoke. Riferimento completo: `docs/superpowers/specs/2026-05-26-cervellone-contabilita-B-ingest-estratti-design.md`.

**Goal:** leggere i PDF dei rendiconti (banca/carte/PayPal) dalla cartella Drive Contabilità e salvarli come movimenti strutturati su DB (input per la riconciliazione C).

**Architecture:** un helper Drive che ritorna il base64 di un file, un modulo di estrazione (Claude Haiku document) che produce movimenti JSON, due tool (estrai_movimenti, lista_movimenti) su tabella `cervellone_movimenti` con dedup via hash. Sola lettura PDF + insert su tabella propria.

**Tech Stack:** TypeScript, googleapis (Drive), Anthropic Haiku (document), Supabase.

---

## File structure
- **Migration** `supabase/migrations/2026-05-26-cervellone-movimenti.sql` — tabella + RLS (applicata da Claude via MCP).
- **Modify** `src/lib/drive.ts` — export `downloadFileBase64(fileId)`.
- **Create** `src/lib/movimenti-extract.ts` — estrazione + tool.
- **Modify** `src/lib/tools.ts` — registra i tool.
- **Modify** `src/lib/prompts.ts` — nota flusso.

Mappa task Codex: 051 (drive helper), 052 (modulo+tool), 053 (registrazione+prompt).

---

## Pre-flight (Claude, Supabase MCP)
- [ ] Applicare migration `cervellone_movimenti`:
```sql
create table if not exists public.cervellone_movimenti (
  id uuid primary key default gen_random_uuid(),
  data date,
  importo numeric,
  direzione text check (direzione in ('entrata','uscita')),
  descrizione text,
  controparte text,
  fonte text check (fonte in ('banca','carta','paypal','altro')),
  conto text,
  periodo text,
  drive_file_id text,
  drive_url text,
  hash text unique,
  confidenza numeric,
  stato text not null default 'attivo',
  created_at timestamptz not null default now()
);
alter table public.cervellone_movimenti enable row level security;
create policy "deny_all_anon_auth" on public.cervellone_movimenti
  for all to anon, authenticated using (false) with check (false);
create index if not exists idx_movimenti_periodo_fonte on public.cervellone_movimenti (periodo, fonte);
```

## Task 051: drive helper `downloadFileBase64`
**Files:** Modify `src/lib/drive.ts`
- [ ] **Step 1:** aggiungere funzione esportata che riusa la `downloadFile` privata già presente:
```ts
export async function downloadFileBase64(fileId: string): Promise<{ base64: string; mimeType: string; name: string }> {
  const f = await downloadFile(fileId) // funzione privata esistente: { buffer, mimeType, name }, cap 20MB
  return { base64: f.buffer.toString('base64'), mimeType: f.mimeType, name: f.name }
}
```
- [ ] **Step 2: commit** — `feat(drive): downloadFileBase64 per estrazione movimenti`
- [ ] Verifica: review + build.

## Task 052: modulo `movimenti-extract.ts`
**Files:** Create `src/lib/movimenti-extract.ts`
Leggi la spec sez. 3. Implementa:
- `estraiMovimentiDaPdf(base64, mimeType, filename)`: client Anthropic singleton (`new Anthropic()` a livello modulo), modello `claude-haiku-4-5`, content = `[{type:'document', source:{type:'base64', media_type:'application/pdf', data:base64}}, {type:'text', text: PROMPT}]` (se mimeType immagine usa blocco image). PROMPT: estrai TUTTI i movimenti come array JSON `[{data:'YYYY-MM-DD', importo:number positivo, direzione:'entrata'|'uscita', descrizione, controparte, fonte:'banca'|'carta'|'paypal'|'altro', conto}]`, una riga per movimento, niente testo attorno. Regole: numeri in formato IT (1.234,56) convertili a number; salta righe senza data o importo; se non distingui la fonte lasciala null. `max_tokens` 4000; se `stop_reason==='max_tokens'` → `{ ok:false, error:'estratto troppo lungo, dividilo' }`. Parsing JSON difensivo (fence ```json, primo `[`/ultimo `]`). Ritorna `{ ok:true, movimenti } | { ok:false, error }`.
- Tool **`estrai_movimenti`** `{ folder_id, fonte?, periodo? }`: `listFiles(folder_id)` (da drive.ts) → per ogni file PDF: `downloadFileBase64` + `estraiMovimentiDaPdf`; per ogni movimento calcola `hash = sha256(data|importo|descrizione|fonte|conto)` (usa `crypto`), `insert ... on conflict(hash) do nothing` in cervellone_movimenti (con drive_file_id/url, periodo, fonte override se passata). Conta nuovi vs duplicati. Ritorna riepilogo JSON: per file {nome, estratti, nuovi}, + totali entrate/uscite/saldo dei nuovi.
- Tool **`lista_movimenti`** `{ periodo?, fonte? }`: query cervellone_movimenti, ritorna elenco (max 100) + somme entrate/uscite/saldo.
- Export `MOVIMENTI_TOOLS: ToolDefinition[]` + `executeMovimentiTool(name, input): Promise<string|null>` (null se non `estrai_movimenti`/`lista_movimenti`).
- [ ] **Step commit** — `feat(contabilita): estrazione movimenti da estratti conto PDF + tool`
- [ ] Verifica: review (parsing numeri IT, dedup hash, no scrittura esterna) + build.

## Task 053: registrazione + prompt
**Files:** Modify `src/lib/tools.ts`, `src/lib/prompts.ts`
- [ ] tools.ts: import `{ MOVIMENTI_TOOLS, executeMovimentiTool } from './movimenti-extract'`; `...MOVIMENTI_TOOLS` in ALL_TOOLS; `executeMovimentiTool` in EXECUTORS.
- [ ] prompts.ts: nota nella sezione Amministrazione Contabile — per elaborare i rendiconti di un mese, trova la sottocartella indicata dall'utente sotto "Contabilità" (drive_search/listSubfolders), poi `estrai_movimenti(folder_id, periodo)`; i movimenti sono la base per la riconciliazione; in questa fase non si scrive su FIC. NIENTE backtick markdown nel template literal.
- [ ] **commit** — `feat(contabilita): registra tool movimenti + regola prompt`
- [ ] Verifica: review + build + smoke (estratto conto reale → movimenti coerenti, re-run dedup).

---

## Self-review (coverage spec → task)
- Tabella movimenti + RLS → pre-flight ✓
- downloadFileBase64 → 051 ✓
- Estrazione Haiku + tool estrai_movimenti/lista_movimenti + dedup hash + troncamento → 052 ✓
- Registrazione + prompt (cartella indicata a runtime) → 053 ✓
- "Diretto, controllo a valle" (no gate) → rispettato ✓
- Non-goal (no riconciliazione/FIC/cancellazioni) → rispettati ✓
