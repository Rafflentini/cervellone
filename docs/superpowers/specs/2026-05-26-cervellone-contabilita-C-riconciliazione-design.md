# Design — Sub-progetto C: Riconciliazione incassi ↔ fatture (ibrido)

**Data:** 2026-05-26 · **Feature madre:** Amministrazione Contabile (roadmap A→F).

## Obiettivo
Abbinare i **movimenti** bancari (da B, `cervellone_movimenti`) alle **fatture** Fatture in Cloud (da A, read-only): incassi (entrate) ↔ fatture emesse. Gestire bonifici a **rate/frammentati**, importi **parziali**, **somme** di più bonifici, e match per **mittente** quando la causale è incompleta. Output = **proposta** di riconciliazione che l'utente conferma (read-only su FIC, niente è ufficiale).

## Scelta utente: motore IBRIDO
Deterministico per i casi sicuri + ragionamento Claude per gli ambigui + conferma utente sui dubbi.

## Componenti

### 1. Tabella `cervellone_riconciliazioni` (Supabase, RLS deny-all)
Relazione molti-a-molti movimento↔fattura (gestisce rate e somme):
```
id uuid pk,
movimento_id uuid (→ cervellone_movimenti),
fattura_id text,            -- id documento FIC
fattura_numero text,
fattura_tipo text ('emessa'|'ricevuta'),
importo_abbinato numeric,   -- quota del movimento imputata a questa fattura (per parziali/rate)
tipo_match text ('deterministico'|'ragionato'|'manuale'),
confidenza numeric,
stato text ('proposta'|'confermata'|'scartata') default 'proposta',
note text,
periodo text,
created_at timestamptz default now(),
updated_at timestamptz default now(),
unique (movimento_id, fattura_id)   -- evita doppioni stessa coppia
```
Indici su (periodo, stato), (movimento_id).

### 2. Modulo `src/lib/riconciliazione-tools.ts` (tool)
- **`riconcilia_automatico({ periodo })`** — passo deterministico:
  - Carica entrate non riconciliate da `cervellone_movimenti` (direzione='entrata', periodo) escludendo quelle già con una riconciliazione 'proposta'/'confermata'.
  - Carica fatture emesse APERTE da FIC via `ficGet` (read-only, riusa il client di A): non pagate.
  - Match sicuro: importo movimento == totale fattura (tolleranza ±0.01) **E** (numero fattura presente nella descrizione **oppure** controparte ≈ nome cliente). Crea riconciliazione stato='proposta', tipo='deterministico', confidenza alta.
  - Ritorna: abbinati automatici + **residui** (movimenti entrata non abbinati + fatture aperte candidate raggruppate per cliente) → input per il ragionamento di Claude.
- **`proponi_riconciliazione({ movimento_id, fattura_id, fattura_numero, importo_abbinato, confidenza, note })`** — Claude registra un abbinamento RAGIONATO (rate/parziali/somme/mittente). tipo='ragionato'. Valida che movimento e importo esistano; upsert su (movimento_id, fattura_id).
- **`lista_riconciliazioni({ periodo?, stato? })`** — elenco proposte/confermate con importi e residui.
- **`conferma_riconciliazione({ id })`** / **`scarta_riconciliazione({ id })`** — l'utente (via chat) conferma o scarta una proposta. Guard su stato='proposta'. La conferma NON scrive su FIC: marca solo la nostra riga 'confermata' (alimenta D).

### 3. Registrazione + prompt
- Registrare i tool in `tools.ts`.
- Nota prompt (sezione Amministrazione Contabile): flusso = `riconcilia_automatico` → Claude ragiona i residui con `proponi_riconciliazione` (spiega SEMPRE il perché nelle note: importo, mittente, rata X/Y) → mostra all'utente con `lista_riconciliazioni` → l'utente conferma/scarta. MAI dare per riconciliato senza conferma sui casi a confidenza < alta. Read-only su FIC.

## Sicurezza (delicato — soldi)
- Read-only su FIC (nessun "segna pagato" sul gestionale).
- Tutto è **proposta** finché l'utente non conferma; ogni abbinamento ha tipo_match + confidenza + note (spiegabile/auditabile).
- I match a bassa/media confidenza richiedono conferma esplicita; mai auto-confermati.
- Idempotenza: unique (movimento_id, fattura_id); re-run non duplica.

## Error handling
- FIC non raggiungibile/token assente → messaggio chiaro, nessuna proposta inventata.
- Movimento o fattura inesistente in `proponi_riconciliazione` → errore.
- importo_abbinato > importo movimento o > residuo fattura → segnala (possibile errore), non blocca ma annota.

## Test / verifica
- review + build + smoke su dati reali (dopo smoke di A e B): "riconcilia gli incassi di maggio" → proposte deterministiche + Claude ragiona i residui (es. bonifico parziale del cliente X) → confermi → `lista_riconciliazioni` mostra lo stato.
- **Audit multi-subagente** dopo (pezzo delicato): correttezza match, tolleranze, doppioni, somme/rate, confidenze.

## Non-goal di C
Nessuna scrittura su FIC; nessuna Prima Nota (è D); riconciliazione USCITE↔fatture ricevute fuori scope iniziale (focus incassi, come richiesto) — estendibile dopo.
