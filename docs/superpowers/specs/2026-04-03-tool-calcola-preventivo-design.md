# Tool `calcola_preventivo` — Design Spec

## Goal

Aggiungere un tool che Claude chiama per generare preventivi estimativi con calcoli precisi (codice, non LLM), confronto prezziario regionale, e output HTML professionale pronto per il pannello anteprima.

## Principio

Claude ragiona e decide (quali voci servono, quantita, contesto). Il tool calcola e impagina (moltiplicazioni, coefficienti, totali, HTML). I numeri li fa il codice — zero errori di calcolo.

## Input Schema

```typescript
interface PreventivoInput {
  // Dati documento
  titolo?: string           // default "Preventivo Estimativo"
  numero?: string           // default auto-generato PREV-YYYY-NNN
  data?: string             // default oggi

  // Committente
  committente: {
    nome: string
    indirizzo?: string
    cf_piva?: string
    telefono?: string
    email?: string
  }

  // Cantiere
  cantiere: {
    indirizzo: string
    comune: string
    descrizione: string
  }

  // Voci di lavoro
  voci: Array<{
    descrizione: string
    um: string              // "mq", "mc", "kg", "ml", "cad", "a corpo"
    quantita: number
    prezzo_unitario: number
    categoria?: string      // per raggruppamento (es. "Demolizioni", "Strutture")
  }>

  // Coefficienti (opzionali — default se omessi)
  coefficienti?: {
    spese_generali?: number    // default 0.15 (15%)
    utile_impresa?: number     // default 0.10 (10%)
    oneri_sicurezza?: number   // default 0.025 (2.5%)
    iva?: number               // default 0.10 (10%)
  }

  // Regione per prezziario
  regione?: string             // default "basilicata"

  // Note, esclusioni, condizioni
  note?: string[]
  esclusioni?: string[]
  condizioni_pagamento?: string
  validita_offerta?: string    // default "60 giorni"
}
```

## Logica interna del tool

### 1. Confronto prezziario

Per ogni voce:
1. Cercare nella cache locale (Supabase tabella `prezziario`) una voce simile per la regione specificata
2. Se non trovata in cache: cercare online il prezziario LL.PP. regionale dell'anno corrente tramite web search
3. Se non trovato anno corrente: cercare anno precedente
4. Memorizzare il risultato in Supabase per usi futuri (con anno e regione)
5. Confrontare: prezzo fornito da Claude vs prezzo prezziario
6. Usare il MAGGIORE dei due
7. Segnalare lo scostamento nel documento se > 15%

I prezzi validati da Restruktura (Skill 4) vengono trattati come prezzi forniti da Claude — il tool li confronta comunque col prezziario e usa il maggiore.

### 2. Calcoli (tutti in codice)

```
Per ogni voce:
  importo = quantita * prezzo_unitario_finale

subtotale_lavori = somma(importi)
spese_generali = subtotale_lavori * coeff_sg
utile_impresa = subtotale_lavori * coeff_ui
oneri_sicurezza = subtotale_lavori * coeff_os
totale_imponibile = subtotale_lavori + spese_generali + utile_impresa + oneri_sicurezza
iva = totale_imponibile * coeff_iva
totale_complessivo = totale_imponibile + iva
```

Tutti i numeri formattati all'italiana: separatore migliaia punto, decimali virgola (es. 12.500,00).

### 3. Output HTML

Il tool genera un documento HTML completo e autocontenuto con:
- Header gradient con branding Restruktura (nome, P.IVA, sede, ing. Lentini)
- Barra titolo documento con numero e data
- Sezione dati committente (griglia info)
- Sezione dati cantiere (griglia info)
- Tabella voci: N. | Descrizione | U.M. | Quantita | P.U. | Importo
  - Righe alternate
  - Se ci sono categorie: raggruppamento con subtotali per categoria
  - Riga subtotale lavori
  - Righe coefficienti (SG, UI, OS)
  - Riga totale imponibile
  - Riga IVA
  - Riga TOTALE COMPLESSIVO (evidenziata forte)
- Tabella confronto prezziario: Voce | P.U. Nostro | P.U. Prezziario | Scostamento
  - Solo per voci con scostamento significativo
- Sezione note/condizioni
- Sezione esclusioni
- Area firme (Restruktura + Committente)
- Footer con "Restruktura S.r.l." e data

Il CSS segue le linee guida brand: palette blu (#0f172a, #1e3a5f, #1e40af), gradient header, tabelle professionali, tipografia curata. Il tool genera il CSS — non lo delega a Claude.

### 4. Return value

Il tool restituisce una stringa con l'HTML completo. Claude lo inserisce in un blocco `~~~document`.

## File da creare

- `src/lib/tools/preventivo.ts` — funzione `executeCalcolaPreventivo(input)`: calcoli + generazione HTML
- `src/lib/tools/prezziario.ts` — funzione `cercaPrezziario(descrizione, regione, anno)`: cerca in cache Supabase, fallback web search, memorizza risultati
- `src/lib/tools/format.ts` — utility formattazione numeri italiani, date

## File da modificare

- `src/lib/tools.ts` — aggiungere `calcola_preventivo` alla lista CUSTOM_TOOLS con input_schema, aggiornare `executeTool()` per instradare al nuovo tool

## Supabase

Nuova tabella `prezziario`:
- `id` (uuid, auto)
- `regione` (text) — es. "basilicata"
- `anno` (integer) — es. 2025
- `codice_voce` (text, nullable) — codice dal prezziario se disponibile
- `descrizione` (text) — descrizione della voce
- `unita_misura` (text)
- `prezzo` (numeric)
- `fonte` (text) — "DGR 208/2025", "web search", ecc.
- `created_at` (timestamptz)

Query RPC `search_prezziario(query_text, regione, anno)` — full text search sulla descrizione.

## Cosa NON fa il tool

- Non decide quali voci servono (Claude)
- Non stima le quantita (Claude)
- Non interpreta documenti caricati (Claude)
- Non genera Word/Excel/PDF — genera HTML, il pannello anteprima fa il resto

## Flusso completo

1. Utente: "Fammi il preventivo per la ristrutturazione di un appartamento 80mq"
2. Claude ragiona: determina le voci necessarie, stima quantita, sceglie prezzi dalla memoria/skill
3. Claude chiama: `calcola_preventivo({ committente: {...}, cantiere: {...}, voci: [...] })`
4. Tool esegue: confronta prezziario, calcola tutto, genera HTML
5. Tool restituisce: stringa HTML completa
6. Claude mette l'HTML nel blocco `~~~document` + aggiunge 1-2 righe di commento
7. Frontend: mostra card "Documento generato" → pannello anteprima → PDF
8. Telegram: mostra card sintetica con link diretto al documento
