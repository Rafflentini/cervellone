# Design — Sub-progetto F: Compilazione documenti su FIC (WRITE, bozza + doppia conferma)

**Data:** 2026-05-26 · **Feature madre:** Amministrazione Contabile (roadmap A→F). **È il primo pezzo WRITE.**

## Obiettivo
Cervellone COMPILA e crea su Fatture in Cloud **bozze** di documenti — fatture emesse e rapporti di intervento — sempre **non trasmesse allo SdI**, con **doppia conferma** dell'utente, ed **eliminabili**. L'emissione/invio fiscale resta SEMPRE all'utente.

## Scoperte API (da ricerca) che vincolano il design
- Crea fattura: `POST /c/{cid}/issued_documents` con `e_invoice:false` + **numero omesso** → documento creato ma NON trasmesso; eliminabile senza bruciare numerazione fiscale.
- Tipi creabili: `invoice`, `work_report` (rapporto di intervento), ecc.
- **Trasmette allo SdI SOLO** `POST /c/{cid}/issued_documents/{id}/e_invoice/send` → **denylist assoluta** (mai implementato).
- Elimina: `DELETE /c/{cid}/issued_documents/{id}` (ok se non trasmesso).
- **Fatture RICEVUTE: NON creabili via API** (arrivano da SdI o inserite a mano) → FUORI da F. Cervellone può solo prepararne i dati; l'inserimento lo fa l'utente.

## Sicurezza (write fiscale — massima cautela)
1. **Nessuna trasmissione possibile per costruzione**: nel codice NON esiste alcuna funzione che chiami `e_invoice/send`. Esistono solo `creaDocumentoFIC` (POST, **forza `e_invoice:false`**, omette `number`) ed `eliminaDocumentoFIC` (DELETE). Nessun `ficWrite` generico.
2. **Doppia conferma** prima di ogni creazione: compila → anteprima → `/fic_ok_<id>` → `/fic_ok2_<id>` → creazione. `/fic_no_<id>` annulla.
3. **Solo bozze**: `e_invoice:false`, numero auto (non fiscale finché non trasmessa). Eliminabili da Cervellone (`elimina_bozza_fic`) o da FIC.
4. **Audit**: ogni richiesta in `cervellone_fic_pending` con payload + stato + id FIC.

## Componenti

### 1. Tabella `cervellone_fic_pending` (Supabase, RLS deny-all)
```
id uuid pk, tipo text ('fattura_emessa'|'rapporto_intervento'),
payload jsonb,            -- body issued_document (senza number, e_invoice:false)
descrizione text,         -- anteprima leggibile mostrata all'utente
conferme int default 0, stato text default 'in_attesa' check in ('in_attesa','creata','annullata'),
fic_document_id text, fic_url text,
created_at, updated_at
```

### 2. `src/lib/fatture-in-cloud.ts` (+ write minimale)
- `creaDocumentoFIC(payload)`: `getCompanyId` → `POST /c/{cid}/issued_documents` con body `{ data: { ...payload, e_invoice: false } }` (forza e_invoice false; se payload contiene `number` lo rimuove). Ritorna `{ ok, id, url }`. **Denylist**: la funzione costruisce essa stessa il path issued_documents; non accetta path arbitrari.
- `eliminaDocumentoFIC(id)`: `DELETE /c/{cid}/issued_documents/{id}`.
- Header del file aggiornato: "read + create/delete bozze; NESSUNA trasmissione SdI (e_invoice/send non implementato)". `ficGet` resta per le letture.

### 3. `src/lib/fic-write-tools.ts`
- `compila_fattura_emessa({ cliente, righe, data?, note? })`: risolve l'entity cliente (cerca anagrafica FIC per nome o usa id), costruisce `items_list` dalle righe (`{ name, qty, net_price, vat: { value: aliquota } }`), payload `{ type:'invoice', entity, items_list, date, e_invoice:false }`. Salva pending (tipo fattura_emessa) + descrizione anteprima. Ritorna anteprima + comandi conferma.
- `compila_rapporto_intervento({ cliente, righe/descrizione, data? })`: come sopra con `type:'work_report'`.
- `lista_bozze_fic({ stato? })`: elenco pending.
- `elimina_bozza_fic({ id })`: se la pending è 'creata' → `eliminaDocumentoFIC(fic_document_id)` + stato 'annullata'; se 'in_attesa' → stato 'annullata'.
- Conferme (chiamate dai dispatcher): `confirmStep1(id)` (conferme 0→1), `confirmStep2(id)` (crea su FIC via creaDocumentoFIC, stato 'creata', salva id/url), `cancel(id)`.

### 4. Registrazione + dispatcher + prompt
- tools.ts: registra i tool.
- Dispatcher slash command in `telegram/route.ts` e `chat/route.ts` (parità): `/fic_ok2_<uuid>` (prima di /fic_ok_), `/fic_ok_<uuid>`, `/fic_no_<uuid>` → confirmStep2/confirmStep1/cancel. Regex UUID stretta.
- prompts.ts: regola — per creare una fattura/rapporto, Cervellone COMPILA con compila_*, mostra l'anteprima ESATTA del tool (con i comandi /fic_ok_<id> poi /fic_ok2_<id>), spiega che sarà una BOZZA non trasmessa che l'utente potrà rivedere/eliminare; l'emissione/invio la fa l'utente da FIC. Le fatture RICEVUTE non si creano via API: prepara i dati e di' all'utente di inserirle a mano.

## Error handling
- Cliente non risolto → chiedi/anagrafica.
- creaDocumentoFIC errore FIC → stato resta 'in_attesa', messaggio chiaro, niente doc creato.
- doppia conferma: guard righe colpite (stato/conferme) come per /accesso_.

## Test / verifica
- review a fondo + build + **audit multi-subagente** (write fiscale). Smoke (dopo token FIC): "compila una fattura per cliente X di €Y" → anteprima → /fic_ok_ → /fic_ok2_ → bozza creata su FIC (verifica su FIC che NON sia trasmessa) → elimina_bozza_fic.

## Non-goal di F
Nessuna trasmissione SdI; nessuna creazione di fatture ricevute (limite API); emissione/invio sempre manuale dell'utente.
