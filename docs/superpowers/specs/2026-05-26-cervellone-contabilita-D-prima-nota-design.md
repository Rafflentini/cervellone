# Design — Sub-progetto D: Prima Nota (foglio Google)

**Data:** 2026-05-26 · **Feature madre:** Amministrazione Contabile (roadmap A→F).

## Obiettivo
Generare la **Prima Nota** di un mese come **Google Sheet** nella cartella Drive "Contabilità": registro cronologico di tutti i movimenti (entrate/uscite) con saldo progressivo e, dove riconciliato (C), il riferimento alla fattura. È una **bozza** che l'utente rivede (read-only su FIC/banca).

## Scelta utente
Output = **Foglio Google** nella cartella Contabilità (sottocartella indicata a runtime).

## Componenti

### 1. Helper Drive `createSpreadsheetInFolder(name, folderId, rows)` (in `src/lib/drive.ts`)
- `assertWriteAllowed(folderId)` (recinzione — Contabilità è autorizzata).
- Crea un Google Sheet: `drive.files.create({ requestBody: { name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folderId] }, fields: 'id, webViewLink' })`.
- Scrive le righe: `sheets.spreadsheets.values.update({ spreadsheetId, range: 'A1', valueInputOption: 'USER_ENTERED', requestBody: { values: rows } })`.
- Ritorna `{ id, webViewLink }`. `rows` = array di array (riga 1 = header).

### 2. Modulo `src/lib/prima-nota-tools.ts`
- Tool **`genera_prima_nota({ periodo, folder_id, saldo_iniziale? })`**:
  1. Carica `cervellone_movimenti` del periodo (stato='attivo'), ordinati per `data` asc (poi created_at).
  2. Carica le riconciliazioni `stato='confermata'` che coinvolgono quei movimenti → mappa movimento_id → lista `fattura_numero` (+ importo_abbinato).
  3. Costruisce le righe: header + una riga per movimento con `[data, descrizione, controparte, entrata, uscita, saldo_progressivo, conto/fonte, rif_fattura, note]`. `entrata`/`uscita` da direzione+importo; `saldo_progressivo` = saldo_iniziale + somma(entrate) − somma(uscite) fino a quella riga; `rif_fattura` = numeri fattura confermati (o vuoto). Riga finale di totali (Entrate, Uscite, Saldo finale).
  4. `createSpreadsheetInFolder('Prima Nota ' + periodo, folder_id, rows)`.
  5. Ritorna `{ ok, url, periodo, movimenti: n, entrate, uscite, saldo_finale }`.
- Export `PRIMA_NOTA_TOOLS` + `executePrimaNotaTool(name, input): Promise<string|null>`.

### 3. Registrazione + prompt
- Registrare in `tools.ts`.
- Nota prompt (sezione Amministrazione Contabile): per generare la Prima Nota di un mese, trova la sottocartella Contabilità indicata dall'utente (drive_search/listSubfolders), poi `genera_prima_nota(periodo, folder_id)`. Suggerisci di lanciare prima `riconcilia_automatico`/riconciliazione così i riferimenti fattura sono popolati. È una bozza: l'utente la rivede sul foglio.

## Sicurezza
- Read-only su FIC/banca; l'unica scrittura è creare il foglio in Contabilità (autorizzata, via assertWriteAllowed).
- Nessuna cancellazione; ri-eseguire crea un nuovo foglio (l'utente elimina i vecchi). Nome include il periodo.
- Saldo iniziale è un parametro esplicito (default 0): se non noto, il saldo progressivo è relativo — segnalalo nelle note del foglio.

## Error handling
- Nessun movimento per il periodo → ritorna messaggio (niente foglio vuoto inutile) o foglio con solo header + nota.
- folder_id mancante/non autorizzato (🔒) → messaggio chiaro (autorizza Contabilità).
- Errore Sheets API → messaggio, nessun dato perso (i movimenti restano su DB).

## Test / verifica
- review + build + smoke (dopo B/C su dati reali): "genera la prima nota di maggio nella cartella Contabilità/2026-05" → foglio creato con righe corrette, saldo progressivo coerente, rif. fattura sui movimenti riconciliati.

## Non-goal di D
Nessuna scrittura su FIC; nessun cron (è E); la Prima Nota è una bozza, non una registrazione ufficiale.
