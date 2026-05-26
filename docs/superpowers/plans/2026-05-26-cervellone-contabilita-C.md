# Contabilità Sub-progetto C (riconciliazione) — Implementation Plan

> **For agentic workers:** eseguito da **Codex** (manovalanza sempre a Codex, regola fissa). Claude: migration + review/merge/deploy + audit. Sandbox offline: verifica = review + `next build` Vercel + smoke. Spec: `docs/superpowers/specs/2026-05-26-cervellone-contabilita-C-riconciliazione-design.md`.

**Goal:** abbinare movimenti↔fatture (incassi↔fatture emesse) con motore ibrido (deterministico + ragionamento Claude + conferma utente), output = proposte di riconciliazione read-only.

**Architecture:** tabella `cervellone_riconciliazioni` (M:N), modulo `riconciliazione-tools.ts` con 5 tool (riconcilia_automatico, proponi_riconciliazione, lista_riconciliazioni, conferma_riconciliazione, scarta_riconciliazione). Read-only su FIC (riusa client A).

**Tech Stack:** TypeScript, Supabase, client Fatture in Cloud (read-only), tool Anthropic.

---

## File structure
- **Migration** `supabase/migrations/2026-05-26-cervellone-riconciliazioni.sql` (Claude via MCP).
- **Create** `src/lib/riconciliazione-tools.ts` (Codex 054).
- **Modify** `src/lib/tools.ts` + `src/lib/prompts.ts` (Codex 055).

Mappa task Codex: 054 (modulo), 055 (registrazione+prompt).

## Pre-flight (Claude, Supabase MCP)
- [ ] Migration `cervellone_riconciliazioni`:
```sql
create table if not exists public.cervellone_riconciliazioni (
  id uuid primary key default gen_random_uuid(),
  movimento_id uuid references public.cervellone_movimenti(id),
  fattura_id text,
  fattura_numero text,
  fattura_tipo text check (fattura_tipo in ('emessa','ricevuta')),
  importo_abbinato numeric,
  tipo_match text check (tipo_match in ('deterministico','ragionato','manuale')),
  confidenza numeric,
  stato text not null default 'proposta' check (stato in ('proposta','confermata','scartata')),
  note text,
  periodo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (movimento_id, fattura_id)
);
alter table public.cervellone_riconciliazioni enable row level security;
create policy "deny_all_anon_auth" on public.cervellone_riconciliazioni
  for all to anon, authenticated using (false) with check (false);
create index if not exists idx_ric_periodo_stato on public.cervellone_riconciliazioni (periodo, stato);
create index if not exists idx_ric_movimento on public.cervellone_riconciliazioni (movimento_id);
```

## Task 054 (Codex): modulo `riconciliazione-tools.ts`
**Files:** Create `src/lib/riconciliazione-tools.ts`
Leggi la spec (sez. 2). Implementa i 5 tool con `RICONCILIAZIONE_TOOLS: ToolDefinition[]` + `executeRiconciliazioneTool(name, input): Promise<string|null>` (null se name non gestito). Dettagli:
- Import: `{ supabase } from './supabase'`, `{ ficGet, getCompanyId } from './fatture-in-cloud'`.
- `riconcilia_automatico({periodo})`: 
  - entrate = `cervellone_movimenti` where direzione='entrata' (+ periodo se passato) NON già in `cervellone_riconciliazioni` con stato in ('proposta','confermata').
  - fatture aperte = `ficGet('/c/{cid}/issued_documents', {type:'invoice', q: "...", per_page:100})` filtrando le non pagate (campo pagato come in mapDoc di fatture-in-cloud: is_marked/payments_list).
  - per ogni entrata: match deterministico se `Math.abs(importo - totaleFattura) <= 0.01` E (numero fattura incluso in descrizione normalizzata OPPURE controparte/cliente combaciano per token). Se match unico → insert riconciliazione (stato 'proposta', tipo 'deterministico', confidenza 0.95, importo_abbinato=importo, periodo). 
  - Ritorna { abbinati_auto:n, residui: { movimenti:[{id,data,importo,descrizione,controparte}], fatture_aperte:[{id,numero,cliente,totale,residuo}] } } per il ragionamento di Claude.
- `proponi_riconciliazione({movimento_id, fattura_id, fattura_numero, importo_abbinato, confidenza, note})`: valida che il movimento esista; upsert su (movimento_id,fattura_id) stato 'proposta' tipo 'ragionato'. Se importo_abbinato mancante usa l'importo del movimento.
- `lista_riconciliazioni({periodo?, stato?})`: join leggibile (movimento data/importo/controparte + fattura_numero + importo_abbinato + tipo_match + confidenza + stato), max 100, + totali.
- `conferma_riconciliazione({id})` / `scarta_riconciliazione({id})`: update guarded `.eq('stato','proposta').select('id')`; se 0 righe → "già elaborata". conferma → 'confermata' (NESSUNA scrittura su FIC), scarta → 'scartata'.
- Normalizzazione confronto: minuscole, collassa spazi, rimuovi punteggiatura per il match numero/cliente.

**Vincoli:** read-only su FIC (solo ficGet); nessuna scrittura su FIC; idempotenza unique(movimento_id,fattura_id). `next build` verde.
Done: `054 | codex/054-riconciliazione-tools | <sommario> | files: riconciliazione-tools.ts`

## Task 055 (Codex): registrazione + prompt
**Files:** Modify `src/lib/tools.ts`, `src/lib/prompts.ts`
- tools.ts: import `{ RICONCILIAZIONE_TOOLS, executeRiconciliazioneTool } from './riconciliazione-tools'`; `...RICONCILIAZIONE_TOOLS` in ALL_TOOLS; `executeRiconciliazioneTool` in EXECUTORS.
- prompts.ts (sezione Amministrazione Contabile): aggiungi il flusso riconciliazione — `riconcilia_automatico(periodo)` per gli abbinamenti sicuri, poi ragiona i residui (rate/parziali/somme/mittente) con `proponi_riconciliazione` spiegando SEMPRE il perché nelle note, mostra con `lista_riconciliazioni`, l'utente conferma/scarta con conferma_riconciliazione/scarta_riconciliazione. Read-only su FIC: niente "segna pagato" sul gestionale; nulla è riconciliato senza conferma sui casi non ad alta confidenza. NIENTE backtick markdown nel template literal.
Done: `055 | codex/055-riconciliazione-registry | <sommario> | files: tools.ts, prompts.ts`

---
## Self-review (coverage spec → task)
- Tabella riconciliazioni M:N → migration ✓
- Deterministico + ragionato + lista + conferma/scarta → 054 ✓
- Read-only FIC, proposta finché non confermi → 054 (no FIC write, stato) ✓
- Registrazione + prompt flusso ibrido → 055 ✓
- Non-goal (no Prima Nota, no scrittura FIC, uscite fuori scope) → rispettati ✓
