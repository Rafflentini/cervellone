# Archiviazione foto cantiere/progetto — Implementation Plan

> **For agentic workers:** questo piano è eseguito da **Codex** (un task `.loop/queue/NNN-*.md` per unità), con review/merge/deploy da parte di Claude (orchestratore). La sandbox Codex è **offline**: niente build/test locali. Verifica di ogni task = review diff di Claude + `next build` su Vercel (READY) + smoke mirato. I passi usano checkbox `- [ ]`.

**Goal:** caricare foto da Telegram o web app e farle archiviare nella sottocartella foto del cantiere (Impresa Edile) o progetto (Studio Tecnico) corretto, creando la struttura via Registro+macro se manca, senza perdere mai le foto.

**Architecture:** un helper condiviso `ingestPhotoUpload` (parità Telegram/web) salva subito le foto nella Inbox Drive e crea un record persistente `cervellone_foto_pending`. Un modulo di tool (`foto-archive-tools.ts`) consente a Claude di trovare la cartella, individuare dinamicamente la sottocartella Foto (apprendendo dal manuale PDF + memoria), creare la sottocartella `data / lavorazione` e spostare le foto; oppure, se la cartella manca, compilare la riga del Registro (colonne lette dall'intestazione) e farsi premere il pulsante della macro. Tutte le scritture passano dalla recinzione (`assertWriteAllowed`).

**Tech Stack:** Next.js (App Router, Turbopack), TypeScript, Supabase (Postgres+RLS), googleapis (Drive/Sheets), Anthropic SDK. Riusa `drive.ts` (uploadBinaryToDrive, getTelegramInboxFolderId, findFoldersByName, getOrCreatePathFolders, moveFile, listFiles, readSheet/appendSheet, assertWriteAllowed), `memoria-tools` (ricorda/richiama_memoria), `tools.ts` (registry).

---

## File structure

- **Create** `supabase/migrations/2026-05-26-cervellone-foto-pending.sql` — tabella `cervellone_foto_pending` + RLS deny-all. *(Applicata da Claude via Supabase MCP, non da Codex.)*
- **Create** `src/lib/foto-ingest.ts` — `ingestPhotoUpload(...)`: upload Inbox + insert record. Unica responsabilità: persistere e tracciare le foto in arrivo.
- **Modify** `src/lib/drive.ts` — aggiungere `listSubfolders(folderId)` (ritorno strutturato) usato per individuare la sottocartella Foto.
- **Create** `src/lib/foto-archive-tools.ts` — tool `archivia_foto`, `prepara_cartella`, `lista_foto_da_archiviare` + definizioni + executor.
- **Modify** `src/lib/tools.ts` — registra i nuovi tool + executor.
- **Modify** `src/app/api/telegram/route.ts` — sostituire l'auto-archive foto inline con `ingestPhotoUpload` (parità).
- **Modify** `src/app/api/chat/route.ts` — chiamare `ingestPhotoUpload` sui blocchi immagine/documento (parità web).
- **Modify** `src/lib/prompts.ts` — regola di flusso nella sezione Segreteria.
- **Pre-flight (ops, non codice):** autorizzare la cartella padre **IMPRESA EDILE** nella recinzione.

Mappatura ai task Codex: T1=040, T2=041, T3=042, T4=043, T5=044, T6=045, T7=046. Ordine: migration → 040 → 041 → 042 → 043 → 044 → 045 → 046.

---

## Pre-flight P0 (Claude / utente)

- [ ] **Migration `cervellone_foto_pending`** (Claude, Supabase MCP):

```sql
create table if not exists public.cervellone_foto_pending (
  id uuid primary key default gen_random_uuid(),
  chat_id text,
  canale text not null check (canale in ('telegram','web')),
  drive_file_id text not null,
  drive_url text,
  filename text,
  ambito text check (ambito in ('cantiere','progetto')),
  soggetto text,
  lavorazione text,
  data_lavorazione date,
  target_folder_id text,
  stato text not null default 'in_attesa' check (stato in ('in_attesa','da_archiviare','archiviata','errore')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.cervellone_foto_pending enable row level security;
create policy "deny_all_anon_auth" on public.cervellone_foto_pending
  for all to anon, authenticated using (false) with check (false);
create index if not exists idx_foto_pending_chat_stato on public.cervellone_foto_pending (chat_id, stato);
```

- [ ] **Autorizzare IMPRESA EDILE (padre)** nella recinzione: aggiungere a `cervellone_drive_policy` la cartella padre (folder_id da fornire/risolvere) così cantieri + doc + tutto sono coperti. Verificare prima che `CANTIERI_ATTIVI` (`1V3_yo…`) discenda da quella cartella.

---

## Task 040 (T1): helper condiviso `ingestPhotoUpload`

**Files:**
- Create: `src/lib/foto-ingest.ts`

- [ ] **Step 1: implementazione completa**

```ts
// src/lib/foto-ingest.ts
// Helper CONDIVISO (parità Telegram/web): salva subito le foto su Drive (Telegram Inbox)
// e crea un record persistente cervellone_foto_pending. Da qui le foto NON si perdono.
import { uploadBinaryToDrive, getTelegramInboxFolderId } from './drive'
import { supabase } from './supabase'

export type FotoIngestItem = { buffer: Buffer; mimeType: string; filename: string }
export interface FotoIngestInput {
  canale: 'telegram' | 'web'
  chatId?: string | null
  items: FotoIngestItem[]
}
export interface FotoIngestRecord {
  id: string
  driveFileId: string
  driveUrl: string | null
  filename: string
}

const IMAGE_MIME = /^image\//

export async function ingestPhotoUpload(input: FotoIngestInput): Promise<FotoIngestRecord[]> {
  const out: FotoIngestRecord[] = []
  if (!input.items.length) return out
  let inbox: string
  try {
    inbox = await getTelegramInboxFolderId()
  } catch (err) {
    console.error('[FOTO-INGEST] inbox non disponibile:', err instanceof Error ? err.message : err)
    return out
  }
  for (const it of input.items) {
    if (!IMAGE_MIME.test(it.mimeType)) continue // solo foto/immagini in questa iterazione
    try {
      const { id: driveFileId, webViewLink } = await uploadBinaryToDrive(it.buffer, it.filename, it.mimeType, inbox)
      const { data, error } = await supabase
        .from('cervellone_foto_pending')
        .insert({
          chat_id: input.chatId ?? null,
          canale: input.canale,
          drive_file_id: driveFileId,
          drive_url: webViewLink,
          filename: it.filename,
          stato: 'in_attesa',
        })
        .select('id')
        .single()
      if (error) { console.error('[FOTO-INGEST] insert fallita:', error.message); continue }
      out.push({ id: data.id, driveFileId, driveUrl: webViewLink, filename: it.filename })
      console.log(`[FOTO-INGEST] canale=${input.canale} file=${it.filename} id=${driveFileId}`)
    } catch (err) {
      console.error('[FOTO-INGEST] upload fallito:', err instanceof Error ? err.message : err)
    }
  }
  return out
}
```

- [ ] **Step 2: commit** — `feat(foto): ingestPhotoUpload condiviso (Inbox + foto_pending)`
- [ ] **Verifica:** review Claude (firma + uso di drive/supabase corretti) + build Vercel.

---

## Task 041 (T2): `listSubfolders` in drive.ts

**Files:**
- Modify: `src/lib/drive.ts` (aggiunta una funzione esportata, niente altro)

- [ ] **Step 1: aggiungere accanto a `findFoldersByName`**

```ts
// Elenca SOLO le sottocartelle dirette di una cartella (ritorno strutturato).
export async function listSubfolders(folderId: string): Promise<Array<{ id: string; name: string }>> {
  const drive = await getDrive()
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    orderBy: 'name',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  return (res.data.files || [])
    .filter((f): f is { id: string; name: string } => Boolean(f.id && f.name))
    .map(f => ({ id: f.id, name: f.name }))
}
```

- [ ] **Step 2: commit** — `feat(drive): listSubfolders strutturato`
- [ ] **Verifica:** review + build Vercel.

---

## Task 042 (T3): modulo tool `foto-archive-tools.ts`

**Files:**
- Create: `src/lib/foto-archive-tools.ts`

**Dipendenze:** migration applicata, Task 040 + 041 mergiati.

**Comportamento dei tool (Claude li compone in conversazione):**

- **`lista_foto_da_archiviare`** — query `cervellone_foto_pending` con `chat_id = <conversation>` e `stato in ('in_attesa','da_archiviare','errore')`, ordinata per `created_at`. Ritorna conteggio + elenco (filename, soggetto, lavorazione, stato).

- **`archivia_foto`** — input `{ ambito?: 'cantiere'|'progetto', nome: string, lavorazione?: string, data?: string }`:
  1. `rootId = ambito === 'cantiere' ? DRIVE_FOLDERS.CANTIERI_ATTIVI : DRIVE_FOLDERS.STUDIO_ATTIVI`. Se `ambito` mancante → ritorna `{ ok:false, need:'ambito' }` (Claude chiede).
  2. `subs = await listSubfolders(rootId)`; trova la cartella cantiere/progetto con match nome (case-insensitive: `name.includes(nome)` o `nome.includes(primoToken(name))`). 0 match → `{ ok:false, stato:'non_trovata', ambito, nome }` (Claude passa al ramo creazione). >1 → `{ ok:false, need:'disambigua', candidati:[{id,name}] }`.
  3. Trova la **sottocartella Foto**: `fsubs = await listSubfolders(cantiereId)`; match con regex `/foto|fotograf/i`. 0 match → `{ ok:false, need:'cartella_foto', candidati: fsubs }` (Claude chiede / legge il PDF). 1 match → usala. >1 → chiedi.
  4. Costruisci nome sottocartella: `const giorno = (data && /^\d{4}-\d{2}-\d{2}$/.test(data)) ? data : new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Rome'})`; `const seg = lavorazione?.trim() ? \`${giorno} - ${lavorazione.replace(/[\\/:*?"<>|]/g,' ').replace(/\s+/g,' ').trim()}\` : giorno`.
  5. `const targetId = await getOrCreatePathFolders(fotoSubfolderId, [seg])` (rispetta recinzione; può lanciare DrivePolicyError → cattura e ritorna `{ ok:false, stato:'bloccata', message }`).
  6. Sposta le foto aperte di questa chat: `pending = select * from cervellone_foto_pending where chat_id=<conv> and stato in ('in_attesa','da_archiviare','errore')`. Per ognuna: `moveFile(driveFileId, targetId)`; se ok → `update stato='archiviata', target_folder_id=targetId, ambito, soggetto=nomeCartella, lavorazione, data_lavorazione=giorno`; se fallisce → `update stato='errore'` e prosegui (foto resta in Inbox).
  7. Ritorna `{ ok:true, archiviate:N, errori:M, path:'<cartella>/<Foto>/<seg>' }`.

- **`prepara_cartella`** — input `{ ambito:'cantiere'|'progetto', valori: Record<string,string> }`:
  1. `sheetId = ambito==='cantiere' ? SHEETS.REGISTRO_CANTIERI : SHEETS.REGISTRO_PROGETTI`.
  2. Leggi intestazione: `readSheet(sheetId, 'A1:Z3')` → ricava i nomi colonna (riga header). Ritorna a Claude le colonne se `valori` non le copre tutte (così chiede i mancanti).
  3. Costruisci la riga ordinata secondo le colonne, `appendSheet(sheetId, 'A:Z', [riga])`.
  4. Ritorna `{ ok:true, foglio_url:'https://docs.google.com/spreadsheets/d/<id>', message:'Riga aggiunta. Premi il pulsante sul foglio per creare le cartelle, poi scrivimi "fatto".' }`.

- [ ] **Step 1:** implementare il modulo con `FOTO_ARCHIVE_TOOLS: ToolDefinition[]` (3 tool, input_schema come sopra) ed `executeFotoArchiveTool(name, input, conversationId?)` che ritorna `string | null` (JSON-stringified), `null` se il name non è gestito. Usare `import { DRIVE_FOLDERS, SHEETS, listSubfolders, getOrCreatePathFolders, moveFile, readSheet, appendSheet, DrivePolicyError } from './drive'` e `import { supabase } from './supabase'`. Il `conversationId` è la chiave `chat_id` dei record.
- [ ] **Step 2: commit** — `feat(foto): tool archivia_foto / prepara_cartella / lista_foto_da_archiviare`
- [ ] **Verifica:** review Claude (logica match, recinzione catturata, idempotenza move) + build Vercel.

---

## Task 043 (T4): registrazione tool in `tools.ts`

**Files:**
- Modify: `src/lib/tools.ts`

- [ ] **Step 1:** import `import { FOTO_ARCHIVE_TOOLS, executeFotoArchiveTool } from './foto-archive-tools'`.
- [ ] **Step 2:** in `ALL_TOOLS` aggiungere `...FOTO_ARCHIVE_TOOLS, // 2026-05-26 foto cantiere/progetto`.
- [ ] **Step 3:** in `EXECUTORS` aggiungere `executeFotoArchiveTool`. Verificare che l'executor riceva `conversationId` (firma `(name, input, conversationId?)`); se il dispatch in `executeTool` non passa il 3° arg a tutti gli executor, adeguare il wrapper come per gli altri.
- [ ] **Step 4: commit** — `feat(foto): registra i tool nel registry`
- [ ] **Verifica:** review + build Vercel.

---

## Task 044 (T5): parità — wiring Telegram

**Files:**
- Modify: `src/app/api/telegram/route.ts` (SOLO il blocco auto-archive foto)

- [ ] **Step 1:** nel blocco `if (message.photo?.length > 0)`, sostituire l'attuale upload diretto su Inbox con una chiamata a `ingestPhotoUpload({ canale:'telegram', chatId: String(chatId), items:[{ buffer: Buffer.from(fileData.buffer), mimeType: fileData.mimeType, filename: fileData.fileName }] })` e usare il `driveUrl` ritornato per `fileDescription` (mantenendo il comportamento attuale: foto comunque passata al LLM). NON toccare il mutex né il blocco `recent_uploads`.
- [ ] **Step 2: commit** — `feat(foto): Telegram usa ingestPhotoUpload (parità + foto_pending)`
- [ ] **Verifica:** review approfondita (è prod) + build Vercel + smoke: invio foto da Telegram → record `foto_pending` creato.

---

## Task 045 (T6): parità — wiring web

**Files:**
- Modify: `src/app/api/chat/route.ts` (subito dopo `resolveFileUrls(messages)` / calcolo `hasFiles`)

- [ ] **Step 1:** dopo che i blocchi file dell'ultimo messaggio utente sono risolti a `image`/`document` base64, estrarre i blocchi `type==='image'` e, per ciascuno, chiamare `ingestPhotoUpload({ canale:'web', chatId: conversationId ?? null, items:[{ buffer: Buffer.from(block.source.data,'base64'), mimeType: block.source.media_type, filename: \`web-${Date.now()}.jpg\` }] })`. Best-effort (try/catch, non bloccare la chat). Importare `ingestPhotoUpload`.
- [ ] **Step 2: commit** — `feat(foto): web app usa ingestPhotoUpload (parità con Telegram)`
- [ ] **Verifica:** review + build Vercel + smoke: caricamento foto da web → record `foto_pending` creato (come Telegram).

---

## Task 046 (T7): regola prompt (skill Segreteria)

**Files:**
- Modify: `src/lib/prompts.ts` (sezione Segreteria/archiviazione)

- [ ] **Step 1:** aggiungere una "REGOLA ARCHIVIAZIONE FOTO CANTIERE/PROGETTO" che istruisce Claude: quando l'utente carica foto dicendo a quale cantiere/progetto (o, se non lo dice, CHIEDERE: impresa edile o studio tecnico?), usare `archivia_foto`. Se torna `stato:'non_trovata'`, raccogliere i dati e usare `prepara_cartella`, poi dire all'utente di **premere il pulsante** sul foglio e attendere il suo "fatto", quindi richiamare `archivia_foto`. Se torna `need:'cartella_foto'`, leggere il manuale PDF in Doc Impresa Edile (`drive_read_pdf`) per capire la sottocartella foto e **memorizzarlo** (`ricorda`). Mai dire "fatto" se le foto non risultano spostate; in dubbio usare `lista_foto_da_archiviare`. NIENTE backtick markdown nel template literal (lezione e61f3b9).
- [ ] **Step 2: commit** — `feat(foto): regola prompt archiviazione foto cantiere/progetto`
- [ ] **Verifica:** review + build Vercel + smoke conversazionale end-to-end (cantiere esistente + cantiere nuovo).

---

## Self-review (coverage spec → task)

- Garanzia salva-foto → Task 040 (Inbox+record) + 042 (move idempotente, stato 'errore' su fallimento) ✓
- Parità Telegram/web → 040 (helper) + 044 + 045 ✓
- Trova cartella esistente / ramo creazione → 042 (`archivia_foto` + `prepara_cartella`) + 046 (orchestrazione) ✓
- Premi pulsante macro poi 'fatto' → 042 (`prepara_cartella` message) + 046 ✓
- Sottocartella Foto dinamica + PDF + memoria → 041 (listSubfolders) + 042 (match) + 046 (lettura PDF + ricorda) ✓
- Sottocartella `data / lavorazione` → 042 step 4 ✓
- Colonne Registro dinamiche → 042 `prepara_cartella` (legge intestazione) ✓
- Recinzione → pre-flight (autorizza IMPRESA EDILE) + 042 (cattura DrivePolicyError) ✓
- Non-goal (no macro via API, no video, no OCR) → rispettati ✓
