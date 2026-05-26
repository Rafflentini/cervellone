# Contabilità Sub-progetto D (Prima Nota) — Implementation Plan

> **For agentic workers:** eseguito da Codex (manovalanza). Claude: review/merge/deploy. Verifica = review + `next build` Vercel + smoke. Spec: `docs/superpowers/specs/2026-05-26-cervellone-contabilita-D-prima-nota-design.md`.

**Goal:** generare la Prima Nota di un mese come Google Sheet in Contabilità, dai movimenti (B) annotati con le riconciliazioni confermate (C). Read-only, bozza.

**Architecture:** helper Drive `createSpreadsheetInFolder` + modulo `prima-nota-tools.ts` (tool `genera_prima_nota`). Nessuna tabella DB (la Prima Nota è il foglio).

## File structure
- **Modify** `src/lib/drive.ts` — `createSpreadsheetInFolder(name, folderId, rows)` (Codex 059).
- **Create** `src/lib/prima-nota-tools.ts` (Codex 060).
- **Modify** `src/lib/tools.ts` + `src/lib/prompts.ts` (Codex 061).
Nessuna migration.

## Task 059 (Codex): helper createSpreadsheetInFolder
**Files:** Modify `src/lib/drive.ts`
- [ ] Aggiungere funzione esportata:
```ts
export async function createSpreadsheetInFolder(
  name: string,
  folderId: string,
  rows: (string | number)[][],
): Promise<{ id: string; webViewLink: string }> {
  await assertWriteAllowed(folderId)
  const drive = await getDrive()
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folderId] },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  })
  const id = created.data.id
  if (!id) throw new Error('createSpreadsheetInFolder: id mancante')
  if (rows.length) {
    const sheets = google.sheets({ version: 'v4', auth: await getAuth() })
    await sheets.spreadsheets.values.update({
      spreadsheetId: id,
      range: 'A1',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: rows },
    })
  }
  return { id, webViewLink: created.data.webViewLink || `https://docs.google.com/spreadsheets/d/${id}` }
}
```
(getAuth/getDrive/google/assertWriteAllowed sono già nel file.)
- [ ] commit `feat(drive): createSpreadsheetInFolder`; verifica review+build.
Done: `059 | codex/059-drive-create-spreadsheet | <sommario> | files: drive.ts`

## Task 060 (Codex): modulo prima-nota-tools
**Files:** Create `src/lib/prima-nota-tools.ts`
Leggi spec sez. 2. Implementa `PRIMA_NOTA_TOOLS` + `executePrimaNotaTool(name, input): Promise<string|null>`.
- `genera_prima_nota({ periodo, folder_id, saldo_iniziale? })`:
  - `periodo` e `folder_id` richiesti (folder_id mancante → fail). saldo_iniziale numero (default 0).
  - movimenti = supabase `cervellone_movimenti` where periodo, stato='attivo', order data asc.
  - riconciliazioni = supabase `cervellone_riconciliazioni` where movimento_id in (...) and stato='confermata' → map movimento_id → fattura_numero[] (join con virgola).
  - costruisci `rows`: header `['Data','Causale','Controparte','Entrata','Uscita','Saldo','Conto/Fonte','Rif. fattura','Note']`; per ogni movimento riga con entrata/uscita da direzione, saldo progressivo (accumula da saldo_iniziale), rif_fattura dalla mappa; importi come numeri (non stringhe) per le colonne Entrata/Uscita/Saldo. Riga finale `['','TOTALI','', totEntrate, totUscite, saldoFinale, '','','']`.
  - se 0 movimenti → ritorna `{ ok:false, error:'nessun movimento per il periodo ' + periodo }` (niente foglio vuoto).
  - `createSpreadsheetInFolder('Prima Nota ' + periodo, folder_id, rows)` (import da './drive').
  - ritorna `{ ok:true, url, periodo, movimenti, entrate, uscite, saldo_finale }`.
- Import: `{ supabase } from './supabase'`, `{ createSpreadsheetInFolder } from './drive'`.
Done: `060 | codex/060-prima-nota-tools | <sommario> | files: prima-nota-tools.ts`

## Task 061 (Codex): registrazione + prompt
**Files:** Modify `src/lib/tools.ts`, `src/lib/prompts.ts`
- tools.ts: import `{ PRIMA_NOTA_TOOLS, executePrimaNotaTool } from './prima-nota-tools'`; `...PRIMA_NOTA_TOOLS` in ALL_TOOLS (dopo RICONCILIAZIONE_TOOLS); `executePrimaNotaTool` in EXECUTORS (dopo executeRiconciliazioneTool).
- prompts.ts (sezione Amministrazione Contabile): per generare la Prima Nota di un mese, trova la sottocartella Contabilità indicata dall'utente (drive_search/listSubfolders) e chiama genera_prima_nota(periodo, folder_id); consiglia di riconciliare prima (riconcilia_automatico + conferme) così i riferimenti fattura compaiono; è una bozza che l'utente rivede sul foglio. NIENTE backtick markdown nel template literal.
Done: `061 | codex/061-prima-nota-registry | <sommario> | files: tools.ts, prompts.ts`

## Self-review
- Foglio Google in Contabilità → 059 (helper) + 060 (genera) ✓
- Saldo progressivo + rif fattura da riconciliazioni confermate → 060 ✓
- Recinzione (assertWriteAllowed) → 059 ✓
- Read-only FIC, bozza → rispettato ✓
- Registrazione + prompt → 061 ✓
