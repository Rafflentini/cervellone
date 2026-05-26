# Design — Sub-progetto A: Integrazione Fatture in Cloud (read-only)

**Data:** 2026-05-26
**Feature madre:** Amministrazione Contabile di Cervellone (skill Segreteria e amministrazione).
**Questo documento:** SOLO il sub-progetto A. Roadmap completa (A→F) in fondo.

## Obiettivo
Dare a Cervellone una base **di sola lettura** verso il gestionale **Fatture in Cloud**, così da poter rispondere e ragionare su fatture e anagrafiche ("quali fatture ho emesso a maggio?", "fatture ricevute da registrare", "quanto mi deve il cliente X?"). È la fondazione su cui poggeranno riconciliazione (C), Prima Nota (D) e compilazione (F).

## Vincolo di sicurezza #1 — read-only by construction
Il token FIC ha permessi di scrittura, ma in questa fase Cervellone **non deve poter scrivere**. Garanzia strutturale: il client espone **solo** `ficGet` (HTTP GET). **Nessuna** funzione POST/PUT/DELETE esiste nel modulo. La scrittura è impossibile non per policy ma perché il codice non la implementa.

## Setup / env
- `FIC_ACCESS_TOKEN` — **aggiunto dall'utente su Vercel (Production)**. Segreto, MAI nel repo. Se assente, i tool ritornano `{ ok:false, error:'FIC_ACCESS_TOKEN non configurato' }` (nessun crash).
- `FIC_COMPANY_ID` — opzionale. Se assente, risolto a runtime via `GET /user/companies` e cachato a livello modulo.
- API base: `https://api-v2.fattureincloud.it`. Header: `Authorization: Bearer <token>`, `Accept: application/json`.

## Componente 1 — `src/lib/fatture-in-cloud.ts` (client read-only)
- `ficGet(path: string, query?: Record<string,string|number|undefined>): Promise<{ ok:true; data:any } | { ok:false; error:string }>`
  - Costruisce URL `BASE + path (+ querystring)`, header Bearer.
  - Se manca il token → `{ ok:false, error }` (no throw che spacca il bot).
  - Gestione errori HTTP (401 token revocato/scaduto, 404, 429 rate limit) con messaggi chiari.
  - **Audit:** `console.log('[FIC] GET ' + path)` ad ogni chiamata (path, non token).
- `getCompanyId(): Promise<string>` — usa `FIC_COMPANY_ID` se presente; altrimenti `GET /user/companies`, prende l'azienda RESTRUKTURA, cacha module-level.
- NESSUN altro metodo di rete. Esporta `ficGet`, `getCompanyId`.

## Componente 2 — tool di lettura (`FIC_READ_TOOLS` + `executeFicTool`)
Tutti read-only, ritornano JSON sintetico (no payload enormi: mappare i campi utili).
- `fic_fatture_emesse` — input `{ anno?, mese?, cliente?, stato? ('pagata'|'non_pagata'|'tutte') }`. `GET /c/{id}/issued_documents?type=invoice` con filtri (date range da anno/mese, query su cliente). Ritorna elenco: numero, data, cliente, importo, stato pagamento, scadenza, id.
- `fic_fatture_ricevute` — input `{ anno?, mese?, fornitore? }`. `GET /c/{id}/received_documents`. Per "fatture in arrivo da registrare".
- `fic_dettaglio_documento` — input `{ tipo:'emessa'|'ricevuta', id }`. Dettaglio completo di un documento (righe, totali, pagamenti).
- `fic_cerca_anagrafica` — input `{ tipo:'cliente'|'fornitore', nome }`. `GET /c/{id}/entities/clients|suppliers` con ricerca per nome.

Limiti: paginazione gestita (max ~50 risultati per risposta), importi/date formattati IT.

## Componente 3 — registrazione + prompt
- Registrare `FIC_READ_TOOLS` in `src/lib/tools.ts` (ALL_TOOLS + `executeFicTool` in EXECUTORS).
- Nota in `prompts.ts` (REGOLA AMMINISTRAZIONE CONTABILE): Fatture in Cloud è la fonte ufficiale; in questa fase Cervellone **legge e propone, non scrive** sul gestionale; per importi/scadenze cita sempre numero e data fattura; se il token non è configurato, dillo all'utente.

## Error handling
- Token mancante/non valido → messaggio chiaro ("configura FIC_ACCESS_TOKEN su Vercel" / "token revocato, rigeneralo").
- Rate limit 429 → ritorna errore gentile (niente retry aggressivi che bruciano).
- company_id non risolvibile → errore chiaro.

## Test / verifica
- Nessun test-runner nel loop: verifica = review + `next build` su Vercel + smoke. Smoke (dopo che l'utente ha messo il token): "quali fatture ho emesso questo mese?" → lista reale; "fatture ricevute da registrare" → lista; "cerca cliente X" → anagrafica.
- Verifica negativa: senza token, i tool rispondono l'errore gentile, il bot non crasha.

## Non-goal di A (vengono dopo)
Nessuna scrittura su FIC; nessuna riconciliazione; nessuna Prima Nota; nessun ingest PDF; "rapporti di intervento" e compilazione fatture = sub-progetto F.

## Roadmap feature completa
A (read, QUESTO) → B (ingest estratti conto da Drive "Contabilità") → C (riconciliazione fuzzy incassi↔fatture, bonifici a rate + ragionamento sul mittente) → D (Prima Nota bozza) → E (cron mensile) → **F (compilazione fatture/rapporti/registrazioni — WRITE con bozza + DOPPIA CONFERMA, emissione definitiva sempre all'utente)**. La scrittura su FIC si abilita solo in F.
