# Design — Sub-progetto B: Ingest estratti conto → movimenti strutturati

**Data:** 2026-05-26 · **Feature madre:** Amministrazione Contabile (vedi roadmap A→F).
**Questo doc:** solo il sub-progetto B.

## Obiettivo
Cervellone legge i PDF dei rendiconti mensili (estratti conto banca, carte di credito, PayPal, ecc.) che l'utente mette nella cartella Drive **Contabilità** (in sottocartelle indicate a runtime) e li trasforma in **movimenti strutturati** salvati su DB, pronti per la riconciliazione (sub-progetto C).

## Scelte (utente 26 mag)
- **Diretto, controllo a valle**: B estrae e salva i movimenti pronti all'uso; il controllo avviene sulla proposta di riconciliazione (C), non con un gate di conferma in B.
- Sola lettura: legge PDF + scrive SOLO sulla nostra tabella `cervellone_movimenti`. Nessuna scrittura su banca/FIC, nessuna cancellazione.

## Componenti

### 1. Tabella `cervellone_movimenti` (Supabase, RLS deny-all)
```
id uuid pk, data date, importo numeric, direzione text ('entrata'|'uscita'),
descrizione text, controparte text, fonte text ('banca'|'carta'|'paypal'|'altro'),
conto text, periodo text,           -- es. '2026-05'
drive_file_id text, drive_url text,
hash text unique,                    -- dedup: sha di data|importo|descrizione|fonte|conto
confidenza numeric, stato text default 'attivo',
created_at timestamptz default now()
```
Indice su (periodo, fonte). `hash` UNIQUE → re-elaborare lo stesso PDF non duplica.

### 2. Drive helper `downloadFileBase64(fileId)` (in `src/lib/drive.ts`)
Scarica un file Drive e ritorna `{ base64, mimeType, name }` (riusa la logica di `downloadFile` già presente, con cap dimensione ~20MB). Serve per passare il PDF a Claude.

### 3. Modulo `src/lib/movimenti-extract.ts`
- `estraiMovimentiDaPdf(base64, mimeType, filename)` → Claude **Haiku** (`claude-haiku-4-5`, blocco document/vision) con prompt che gestisce layout eterogenei (estratto conto banca, carta, PayPal, anche scansioni) → array JSON di movimenti `{ data (YYYY-MM-DD), importo (number, positivo), direzione, descrizione, controparte, fonte, conto }`. Parsing difensivo (numeri IT con virgola → number; scarta righe senza data/importo). max_tokens alto + check `stop_reason==='max_tokens'` (estratti lunghi → segnala troncamento, non dati parziali silenti). Cap dimensione PDF.
- Tool **`estrai_movimenti`** input `{ folder_id, fonte?, periodo? }`: elenca i PDF nella cartella (listFiles), per ognuno `downloadFileBase64` + `estraiMovimentiDaPdf`, calcola hash, **insert on conflict(hash) do nothing** in `cervellone_movimenti` (con drive_file_id/url, periodo, fonte). Ritorna riepilogo: per file → n. movimenti, nuovi vs già presenti; totali entrate/uscite.
- Tool **`lista_movimenti`** input `{ periodo?, fonte? }`: elenca e somma i movimenti salvati (entrate, uscite, saldo).

### 4. Registrazione + prompt
- Registrare i tool in `src/lib/tools.ts`.
- Nota prompt: quando l'utente chiede di elaborare i rendiconti di un mese, Cervellone trova la sottocartella indicata sotto "Contabilità" (con i tool Drive esistenti: drive_search/listSubfolders), poi chiama `estrai_movimenti(folder_id, periodo)`. I movimenti sono la base per la riconciliazione; in B non si scrive su FIC. La cartella la indica l'utente (no hardcode).

## Error handling
- PDF illeggibile/scansione vuota → 0 movimenti per quel file + nota, non crash.
- Estrazione troncata (max_tokens) → segnala "estratto troppo lungo, dividilo" invece di salvare dati parziali.
- File non-PDF nella cartella → skip.
- Dedup hash → re-run idempotente.

## Test / verifica
- Verifica = review + `next build` Vercel + smoke: utente mette un estratto conto PDF in una sottocartella di Contabilità, chiede "estrai i movimenti di maggio dalla cartella X" → tabella popolata, riepilogo coerente coi totali del PDF. Re-run → 0 nuovi (dedup).

## Non-goal di B
Nessuna riconciliazione con le fatture (è C); nessuna Prima Nota (D); nessuna scrittura su FIC/banca; nessun gate di conferma (scelta "diretto").

## Sicurezza/costo
Haiku per estrazione (economico, coerente con [[cervellone-cost-control]]); cap dimensione PDF; solo insert su tabella propria; hash dedup.
