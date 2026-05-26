# Contabilità Sub-progetto F (compilazione WRITE) — Implementation Plan

> **For agentic workers:** eseguito da Codex (manovalanza). Claude: migration + review A FONDO + audit (write fiscale) + merge/deploy. Spec: `docs/superpowers/specs/2026-05-26-cervellone-contabilita-F-compilazione-write-design.md`.

**Goal:** Cervellone compila e crea BOZZE su FIC (fatture emesse + rapporti work_report), mai trasmesse allo SdI, doppia conferma, eliminabili.

**Architecture:** write minimale in fatture-in-cloud.ts (crea/elimina, e_invoice forzato false, NESSUN send), modulo fic-write-tools.ts (compila/lista/elimina + conferme su cervellone_fic_pending), dispatcher /fic_ok_/ok2_/no_ in parità, prompt.

## File structure
- **Migration** `supabase/migrations/2026-05-26-cervellone-fic-pending.sql` (Claude via MCP).
- **Modify** `src/lib/fatture-in-cloud.ts` — `creaDocumentoFIC` + `eliminaDocumentoFIC` (Codex 063).
- **Create** `src/lib/fic-write-tools.ts` (Codex 064).
- **Modify** `src/lib/tools.ts` + `src/app/api/telegram/route.ts` + `src/app/api/chat/route.ts` + `src/lib/prompts.ts` (Codex 065).

## Pre-flight (Claude, Supabase MCP)
- [ ] Migration `cervellone_fic_pending`:
```sql
create table if not exists public.cervellone_fic_pending (
  id uuid primary key default gen_random_uuid(),
  tipo text check (tipo in ('fattura_emessa','rapporto_intervento')),
  payload jsonb not null,
  descrizione text,
  conferme int not null default 0,
  stato text not null default 'in_attesa' check (stato in ('in_attesa','creata','annullata')),
  fic_document_id text,
  fic_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.cervellone_fic_pending enable row level security;
create policy "deny_all_anon_auth" on public.cervellone_fic_pending for all to anon, authenticated using (false) with check (false);
```

## Task 063 (Codex): write minimale in fatture-in-cloud.ts
**Files:** Modify `src/lib/fatture-in-cloud.ts`
- Aggiorna il commento header: il modulo ora fa lettura + create/delete BOZZE; NESSUNA trasmissione SdI (e_invoice/send non implementato, per costruzione).
- `creaDocumentoFIC(payload: Record<string,unknown>): Promise<{ok:true;id:string;url:string|null}|{ok:false;error:string}>`: getCompanyId; rimuovi `number` dal payload; forza `e_invoice:false`; `fetch(BASE + '/c/'+cid+'/issued_documents', { method:'POST', headers:{Authorization Bearer, 'Content-Type':'application/json', Accept}, body: JSON.stringify({ data: payload }) })`; gestisci 401/4xx/5xx con messaggi; ritorna id + (eventuale) url dal data. Logga `[FIC] POST issued_documents`.
- `eliminaDocumentoFIC(id: string)`: `fetch(... '/c/'+cid+'/issued_documents/'+id, { method:'DELETE', headers:{Authorization Bearer, Accept} })`; ritorna {ok}|{ok:false,error}. Logga `[FIC] DELETE`.
- NON creare una funzione di scrittura generica né alcuna chiamata a `e_invoice/send`. `ficGet` resta invariato.
Done: `063 | codex/063-fic-write-client | <sommario> | files: fatture-in-cloud.ts`

## Task 064 (Codex): modulo fic-write-tools.ts
**Files:** Create `src/lib/fic-write-tools.ts`
Leggi spec sez. 3. Tool + executor `executeFicWriteTool`:
- `compila_fattura_emessa({ cliente, righe, data?, note? })`: risolve entity (cerca anagrafica cliente FIC via ficGet `/c/{cid}/entities/clients?q=name contains '...'`; se trovato usa `{ id }`, altrimenti `{ name: cliente }`); items_list da righe (`[{ name, qty: quantita||1, net_price: prezzo_unitario, vat: { value: aliquota||22 } }]`); payload `{ type:'invoice', entity, items_list, date: data||oggi, e_invoice:false }`. Inserisci in cervellone_fic_pending (tipo 'fattura_emessa', payload, descrizione anteprima). Ritorna anteprima + `1ª conferma → /fic_ok_<id>` + `annulla → /fic_no_<id>`.
- `compila_rapporto_intervento({ cliente, righe?, descrizione?, data? })`: come sopra ma `type:'work_report'`.
- `lista_bozze_fic({ stato? })`: elenco da cervellone_fic_pending.
- `elimina_bozza_fic({ id })`: se stato 'creata' → eliminaDocumentoFIC(fic_document_id) poi stato 'annullata'; se 'in_attesa' → stato 'annullata'.
- Export per i dispatcher: `confirmFicStep1(id)` (guard stato='in_attesa' conferme=0 → conferme=1, ritorna "conferma definitiva /fic_ok2_<id>"), `confirmFicStep2(id)` (guard conferme>=1 stato='in_attesa'; chiama creaDocumentoFIC(payload); su ok salva fic_document_id/url + stato 'creata'; ritorna esito "BOZZA creata su FIC, NON trasmessa"), `cancelFic(id)` (stato 'annullata').
Import: `{ supabase } from './supabase'`, `{ ficGet, getCompanyId, creaDocumentoFIC, eliminaDocumentoFIC } from './fatture-in-cloud'`.
Done: `064 | codex/064-fic-write-tools | <sommario> | files: fic-write-tools.ts`

## Task 065 (Codex): registrazione + dispatcher + prompt
**Files:** Modify `src/lib/tools.ts`, `src/app/api/telegram/route.ts`, `src/app/api/chat/route.ts`, `src/lib/prompts.ts`
- tools.ts: import `{ FIC_WRITE_TOOLS, executeFicWriteTool } from './fic-write-tools'`; `...FIC_WRITE_TOOLS` in ALL_TOOLS; `executeFicWriteTool` in EXECUTORS.
- telegram/route.ts e chat/route.ts: aggiungi dispatcher (parità, mirroring di /accesso_): match `/fic_ok2_<uuid>` PRIMA di `/fic_ok_<uuid>`, e `/fic_no_<uuid>`, regex UUID stretta `[0-9a-f]{8}-...{12}`; import `confirmFicStep2/confirmFicStep1/cancelFic` da '@/lib/fic-write-tools'; rispondi col messaggio ritornato (telegram via sendTelegramMessage, web via stream come gli altri).
- prompts.ts (sezione Amministrazione Contabile): regola compilazione — per creare una fattura/rapporto usa compila_fattura_emessa/compila_rapporto_intervento, mostra ESATTAMENTE l'anteprima del tool (coi comandi /fic_ok_<id> poi /fic_ok2_<id>); sarà una BOZZA NON trasmessa allo SdI, l'utente la rivede/elimina e l'emissione la fa lui da FIC; le fatture RICEVUTE non si creano via API (prepara i dati, le inserisce l'utente). NIENTE backtick markdown nel template literal.
Done: `065 | codex/065-fic-write-registry | <sommario> | files: tools.ts, telegram/route.ts, chat/route.ts, prompts.ts`

## Self-review
- Tabella pending → migration ✓
- Write minimale (crea/elimina, e_invoice false, no send) → 063 ✓
- Compila emessa/rapporto + lista/elimina + doppia conferma → 064 ✓
- Registrazione + dispatcher parità + prompt → 065 ✓
- Mai trasmissione SdI, bozze eliminabili → 063/064 (no send fn, e_invoice false) ✓
- Ricevute fuori scope → prompt lo dice ✓
