# Audit governance Drive + P2 hardening

Ambito: analisi statica delle modifiche post stress-test su governance Drive, dispatcher di conferma, sentinella mail e hardening P2. Metodo: lettura dei file indicati, senza build/test per sandbox offline.

## src/lib/drive.ts

- **P1 - Helper default Drive scrivono prima della recinzione.** `getOrCreateBozzeFolder()` e `getTelegramInboxFolderId()` creano cartelle sotto `DRIVE_FOLDERS.DOC_IMPRESA` senza chiamare `assertWriteAllowed` sul parent prima della `files.create` (`src/lib/drive.ts:551`, `src/lib/drive.ts:587`). `uploadBinaryToDrive()` verifica dopo aver risolto/creato la cartella default (`src/lib/drive.ts:675`), quindi se `DOC_IMPRESA` non fosse in policy la creazione della cartella default bypasserebbe la recinzione. Fix: chiamare `assertWriteAllowed(DRIVE_FOLDERS.DOC_IMPRESA)` all'inizio di entrambi gli helper, o implementare gli helper tramite `getOrCreatePathFolders`.

- **P2 - `findFoldersByName` non applica l'escaping del backslash.** La query Drive scappa solo l'apostrofo (`src/lib/drive.ts:207`), mentre il nuovo hardening lo fa solo in `getOrCreatePathFolders` (`src/lib/drive.ts:634`). Fix: centralizzare un helper `escapeDriveQueryString()` usato da `findFoldersByName`, `searchFilesFullText` e path lookup.

- **OK - Chokepoint principali coperti.** `createFolder`, `moveFile`, `createDocument`, `getOrCreatePathFolders` e `uploadBinaryToDrive` chiamano `assertWriteAllowed` prima della scrittura target (`src/lib/drive.ts:355`, `src/lib/drive.ts:380`, `src/lib/drive.ts:438`, `src/lib/drive.ts:619`, `src/lib/drive.ts:676`). `assertWriteAllowed` e' fail-closed su errori API e limita la risalita a 15 livelli con `seen` anti-ciclo (`src/lib/drive.ts:107`).

## src/lib/drive-policy-actions.ts

- **P2 - Policy applicata prima della chiusura atomica del pending.** `confirmStep2` esegue upsert/delete sulla policy (`src/lib/drive-policy-actions.ts:191`) prima di chiudere la richiesta con guard (`src/lib/drive-policy-actions.ts:209`). La doppia conferma concorrente e' quasi idempotente, ma se l'update del pending fallisce dopo la modifica policy, `invalidateDrivePolicyCache()` non viene chiamata (`src/lib/drive-policy-actions.ts:218`). Fix: chiudere/claimare il pending con stato intermedio o usare RPC transazionale; in alternativa invalidare cache in `finally` dopo ogni upsert/delete riuscito.

- **OK - Doppia conferma e guard presenti.** `confirmStep1` richiede `stato='pending'` e `conferme=0`, `confirmStep2` richiede `conferme >= 1`, `folder_id` non nullo e chiude con controllo righe colpite (`src/lib/drive-policy-actions.ts:153`, `src/lib/drive-policy-actions.ts:183`). `/accesso_ok2_` su id mancante o gia' applicato torna messaggio controllato.

- **OK - Ambiguita' cartelle gestita.** `proposeConsenti` gestisce 0/1/N risultati di `findFoldersByName` e chiede l'ID quando ci sono piu' match (`src/lib/drive-policy-actions.ts:72`).

## src/app/api/telegram/route.ts e src/app/api/chat/route.ts

- **P1 - `telegram_recent_uploads` viene marcato processed prima dell'esito LLM.** Nel flusso Telegram, i pending recenti sono marcati `processed=true` subito dopo l'attach (`src/app/api/telegram/route.ts:494`), prima della chiamata LLM. Inoltre `markIds` include anche il record corrente saltato dal loop (`src/app/api/telegram/route.ts:481`). Se il processing successivo fallisce, upload utili possono non essere ripresi. Fix: accumulare solo gli extra effettivamente allegati e marcare `processed` dopo completamento LLM riuscito.

- **OK - Regex e parita' dispatcher accesso.** Telegram e web usano le stesse regex UUID strette per `/accesso_ok_`, `/accesso_ok2_`, `/accesso_no_` e chiamano le stesse action (`src/app/api/telegram/route.ts:361`, `src/app/api/chat/route.ts:118`). Differisce solo il trasporto della risposta.

- **OK - Hardening recent uploads e log foto.** La finestra e' 10 minuti (`src/app/api/telegram/route.ts:469`) e il fallimento auto-archive foto ha log esplicito `[TG-AUTOARCHIVE]` (`src/app/api/telegram/route.ts:169`).

## src/lib/scadenza-extract.ts

- **OK - Hardening P2 applicato.** Cap base64, logging senza contenuto, singleton Anthropic, `max_tokens=900`, stop `max_tokens` e parsing JSON difensivo risultano presenti (`src/lib/scadenza-extract.ts:12`, `src/lib/scadenza-extract.ts:86`, `src/lib/scadenza-extract.ts:90`).

- **Falso allarme - Logging filename.** Il log include filename e mime type ma non base64 ne' testo documento. In single-tenant e' accettabile.

## src/lib/scadenze-tools.ts

- **OK - Normalizzazione e validazione giorni.** Il soggetto e' normalizzato per scrittura e confronto (`src/lib/scadenze-tools.ts:61`, `src/lib/scadenze-tools.ts:134`, `src/lib/scadenze-tools.ts:161`, `src/lib/scadenze-tools.ts:200`). `reminder_days` e `entro_giorni` negativi sono respinti (`src/lib/scadenze-tools.ts:178`, `src/lib/scadenze-tools.ts:272`).

- **OK - Chiusura idempotente.** `chiudiScadenza` aggiorna solo `stato='attivo'` e distingue gia' chiusa da non trovata (`src/lib/scadenze-tools.ts:319`).

## src/app/api/cron/mail-sentinella/route.ts

- **P2 - Obiettivo riduzione download body solo parzialmente raggiunto.** La route commenta il match subject/mittente, ma chiama comunque `getEmailBody(... include_attachments:true)` per ogni messaggio con allegati prima di filtrare sul filename (`src/app/api/cron/mail-sentinella/route.ts:317`, `src/app/api/cron/mail-sentinella/route.ts:321`, `src/app/api/cron/mail-sentinella/route.ts:325`). Questo preserva i filename-only match, ma non riduce costo/tempo come richiesto dal P2. Fix: estendere `readEmail` per esporre i nomi allegato dalla bodyStructure, oppure introdurre un fetch metadata-only senza contenuto base64.

- **P2 - Auto-memoria non verifica righe colpite nello stato finale.** Dopo `ricorda()` ok, l'update a `auto_memorizzata` controlla solo `error`, non il numero di righe aggiornate (`src/app/api/cron/mail-sentinella/route.ts:263`). In race puo' incrementare `autoMemorizzate` e notificare successo anche se lo stato non e' cambiato. Fix: aggiungere `.select('id')` e contare le righe prima di notifica/count.

- **OK - Memoria prima dello stato successo.** Se `ricorda()` fallisce, lo stato `auto_memorizzata` non viene scritto e non parte la notifica di successo (`src/app/api/cron/mail-sentinella/route.ts:252`).

## src/lib/doc-proposte-actions.ts

- **P1 - `confirmProposta` fa side effect prima del claim finale.** La funzione carica allegato, crea cartella/file Drive e inserisce la scadenza prima dell'update guarded a `confermata` (`src/lib/doc-proposte-actions.ts:139`, `src/lib/doc-proposte-actions.ts:151`, `src/lib/doc-proposte-actions.ts:153`). Due conferme concorrenti possono produrre due upload con URL diversi e quindi due scadenze, poi una delle due torna "gia elaborata". Fix: claim atomico iniziale (`stato='in_attesa' -> 'in_lavorazione'`) con controllo righe, poi side effect, poi `confermata`; gestire recovery dello stato intermedio.

- **OK - Stato `auto_memorizzata` e race sugli update gestiti a livello risposta.** `statusMessage` copre `auto_memorizzata` e gli update finali di conferma/ignora controllano le righe ritornate (`src/lib/doc-proposte-actions.ts:50`, `src/lib/doc-proposte-actions.ts:153`, `src/lib/doc-proposte-actions.ts:182`).

## Sintesi

Finding reali: **0 P0, 3 P1, 4 P2**.

P0 reali da fixare: nessuno.

P1 reali da fixare:
- Drive default folder helpers scrivono senza recinzione preventiva.
- `telegram_recent_uploads` viene marcato processed prima dell'esito LLM.
- `confirmProposta` esegue side effect prima di claimare atomicamente la proposta.

Falsi allarmi / accettati:
- Cache ancestry con TTL 5 minuti: la revoca normale invalida la cache; il rischio residuo e' solo su fallimento parziale di `confirmStep2`, quindi P2, non P0/P1.
- Logging `SCAD-EXTRACT`: non include contenuti documento/base64.
- Dispatcher Telegram/web: parita' logica presente.
