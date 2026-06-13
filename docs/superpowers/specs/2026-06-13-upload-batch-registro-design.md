# Upload lifecycle + registro media + anti-bugia archiviazione — Design

**Data:** 2026-06-13
**Stato:** approvato (direzione rivista "Alternativa A semplificata" dopo critica adversarial 2 agenti).
**Regola immutabile:** ciò che funziona da Telegram deve funzionare da webchat e viceversa.

## Problema (incidente live 12-13 giu, caso Celano/Marsicovetere)
1. **Bulk bloccato**: 20-30 foto da galleria → "task lunga in corso" per 30 min; i file sono già su Drive ma l'elaborazione è rifiutata.
2. **Contaminazione cross-commessa**: `archivia_foto` rastrella TUTTO il pool `cervellone_foto_pending` (in_attesa) della chat → foto/video di una commessa finiscono nella cartella di un'altra. Pool indistinto, nessun batch/intento. I video (via `archivia_documento`) vengono mescolati dall'aggancio "ultimi 10 min".
3. **Allucinazione archiviazione**: il bot dice "✅ 12 archiviate" senza chiamare il tool. Il rilevatore becca solo promesse al futuro; "ho archiviato" è perfino nella lista che SOPPRIME il force-action; il check finale si accontenta di qualsiasi tool (anche una lettura).

## Principi di design (dai critici)
- **Riusa, non aggiungere.** `cervellone_foto_pending` è già la tabella-registro giusta (ha `drive_file_id`, `drive_url`, `target_folder_id`, `soggetto`, `data_lavorazione`, `stato`). NIENTE nuova tabella, NIENTE sovraccarico di `documents`.
- **Verità dal DB/tool-result, mai stato in-memory.** Il gate anti-bugia legge l'esito reale, non una Map effimera (che fallisce-aperto nei task durable).
- **L'ack di successo lo scrive il CODICE** dal risultato del tool, non l'LLM in streaming (così non può inventarlo).
- **Niente delete.** `moveFile` sposta atomicamente (toglie il file dall'Inbox). La transizione di stato `in_attesa→archiviata` È la pulizia. Il record SOPRAVVIVE come registro.
- **Chiave deterministica per il batch:** `message.media_group_id` (Telegram), la request (web). NON finestre temporali (causano archiviazioni parziali + race).
- **Conferma esplicita > euristica.** Su ambiguità (pending eterogeneo/orfani vecchi), il bot CHIEDE, non indovina.

## Componenti

### 1. Bare-upload path (no task, no mutex) — `telegram/route.ts`, `chat/route.ts`
Una foto/video/doc **senza istruzione** (no caption/testo significativo) viene salvata su Drive Inbox + record `foto_pending`, e fa **early-return PRIMA del lock mutex** (`telegram_active_jobs`) e PRIMA del guard durable. NON avvia turno LLM. Già oggi l'ingest è pre-mutex; il delta è: non emettere "sto elaborando", non acquisire il lock, ritornare.
- **Ack**: per album Telegram (`media_group_id` presente) → un solo ack best-effort via CAS atomico (`UPDATE … WHERE ack_sent=false RETURNING`) sul record di gruppo; per foto singola → ack inline "📥 ricevuta". Accettato come **best-effort** (in serverless non c'è garanzia di "1 solo ack"); il conteggio esatto lo dà `lista_foto_da_archiviare` all'istruzione.
- **Web**: tutte le foto arrivano nella stessa request → batch = la request, ack = la response sincrona. Nessun media_group_id, nessun debounce.

### 2. Batch labeling — migration + `foto-ingest.ts`
Aggiungi a `cervellone_foto_pending`: `batch_id text` (= `media_group_id` TG / request-id web / null per singole), `kind text` ('foto'|'video'|'doc'). I **video** confluiscono in questa tabella via `ingestPhotoUpload` esteso (oggi vanno solo in `telegram_recent_uploads` + `archivia_documento`). Stato ciclo di vita: `in_attesa → archiviata` (record conservato).

### 3. Caption-su-album — `telegram/route.ts`
Una caption su una foto con `media_group_id` valorizzato è un'istruzione per **l'intero gruppo**, non per la singola foto. NON avviare il turno al primo webhook con caption: registra la caption legata al `media_group_id`; il turno parte quando l'utente conferma (o con tutte le N foto del gruppo come pending). Caption su foto singola (no group) → istruzione immediata.

### 4. Archivia con filtro + conferma — `foto-archive-tools.ts`
`fetchOpenPending`: aggiungi **finestra di rilevanza** (default ultime 48h) per l'auto-inclusione; i pending più vecchi vengono **elencati a parte**, non inclusi ciecamente. `archiviaFoto`:
- Se i pending recenti sono **omogenei** (stesso `batch_id`/`media_group_id`, o un solo gruppo) → procede.
- Se **eterogenei** (più batch, o ci sono orfani vecchi) → ritorna `need:'conferma_batch'` elencando i gruppi ("hai 5 foto delle 10:00 + 3 delle 10:11 — tutte su Celano? o solo le ultime 3?"). L'utente disambigua in linguaggio naturale.
- Foto + video dello stesso batch → **stessa cartella** (flusso unificato).
- MOVE verificato (già fatto, fix 13 giu) → `stato='archiviata'` + `target_folder_id`/`soggetto`/`data_lavorazione` valorizzati. Record conservato.

### 5. Registro = due capability separate — `foto-archive-tools.ts` / nuovo tool
- **Ri-aggancio in-contesto** (`rivedi_immagine`): RESTA conversation-scoped (anti-exfil, invariato).
- **Ricerca metadati cross-commessa** (`cerca_foto_archiviata`, nuovo): query su `foto_pending` (record conservati) → ritorna path Drive + commessa + data + filename, **NON i byte** dell'immagine. "Dov'è la foto del massetto Celano?" → risponde con la posizione. Per rivederla visivamente: ritorna il link Drive (il ri-download dei byte resta gated/scoped).

### 6. Anti-bugia archiviazione — `circuit-breaker.ts` + `claude.ts` + `foto-archive-tools.ts`
Gate **dedicato**, basato sulla VERITÀ del tool-result (non su pattern di promessa né su stato in-memory):
- `archivia_foto`/`archivia_documento` espongono nel loro tool_result un esito strutturato `ok:true/false` + `archiviate/totale` (già fatto per archivia_foto).
- A fine turno, se il testo finale contiene un **claim di archiviazione** (regex lasca: "archiviat\*/spostat\*/messo nella cartella/✅ … foto/file") **E** nel turno NON c'è stato un `archivia_foto`/`archivia_documento` con `ok:true` e `archiviate===totale` → **riscrivi/correggi** il messaggio prima dell'invio finale.
- Eccezione esplicita in `COMPLETED_OR_CONDITIONAL_PATTERNS`: "ho archiviato/spostato su Drive" NON va soppresso se manca il tool-signal corrispondente.
- **L'ack di successo "✅ N foto in <path>" lo genera il CODICE** dal `path`/`message` ritornato da `archiviaFoto`, non il free-text dell'LLM in streaming.

## Bug latente da fixare PRIMA (pre-requisito)
**Mismatch `chat_id`**: `ingestPhotoUpload` salva `chat_id` = `chatIdToUuid(chatId)` (UUID), `fetchOpenPending` filtra `.eq('chat_id', conversationId)`. Verificare che siano IDENTICI su entrambi i path (TG + web) con un test ingest→ripesca. Senza, il registro è popolato ma irraggiungibile.

## Decomposizione & ordine (ognuno deployabile/auditabile)
1. **Anti-bugia** (il più importante e indipendente): gate dedicato + ack da codice. Chiude il falso successo.
2. **Anti-contaminazione**: `batch_id`/`kind` migration + filtro temporale + conferma in `archivia_foto` + video unificati. Chiude la contaminazione e gli orfani.
3. **Bulk no-block**: bare-upload early-return + ack best-effort + caption-su-album.
4. **Registro/ricerca**: `cerca_foto_archiviata` + conservazione record + scope-separation.
(Pre-requisito: fix chat_id mismatch + test.)

## Testing
- Unit (vitest, mock supabase/drive): filtro temporale `fetchOpenPending`; conferma su pending eterogeneo; gate anti-bugia (claim senza tool-ok → corretto; claim con tool-ok → passa); ack-CAS atomico; ingest→ripesca con stessa chiave; video unificato in foto_pending.
- Smoke campo (utente): dump 20-30 foto+video → 1 ack → istruzione → archiviazione corretta + nessuna contaminazione + nessun falso "archiviate"; poi "dov'è la foto X?" → la ritrova.

## Rollout
Incrementale, un componente per deploy, audit prima di ognuno. Flag-gate dove il comportamento cambia il flusso live (es. `upload_batch_enabled`), default OFF fino a collaudo del componente. Migration additiva applicata da Cowork.

## Non-goal (YAGNI)
- NIENTE nuova tabella registro (riuso foto_pending).
- NIENTE coalescing dell'ack con garanzia forte (best-effort via media_group_id).
- NIENTE estrazione LLM eager su bare-upload (registro "povero" = solo metadati; analisi visiva lazy/on-demand).
- NIENTE delete di file o record.
