# Stress test notturno — Cervellone (lavoro del 25-26 mag 2026)

**Avviato:** 2026-05-26 (notte) · **Metodo:** audit avversariale multi-agente (read-only) + suite test Codex
**Ambito:** tutto ciò implementato il 25-26 mag — toolkit scadenzario, multi-foto, sentinella documenti personale (SP-1/2/3), hardening 001-017.

## Componenti sotto test
1. Sentinella cron + escalation/auto-memoria — `src/app/api/cron/mail-sentinella/route.ts`
2. Conferma/ignora proposte + dispatcher (Telegram+web) — `src/lib/doc-proposte-actions.ts`, `telegram/route.ts`, `chat/route.ts`
3. Estrazione allegati (SP-1) — `src/lib/scadenza-extract.ts`
4. Scadenzario tools + cron reminder — `src/lib/scadenze-tools.ts`, `src/app/api/cron/scadenze/route.ts`
5. Multi-foto + archiviazione Drive — `telegram/route.ts` (recent_uploads), `src/lib/drive.ts`

## Legenda severità
- **P0** = bug critico (perdita dati / sicurezza / crash / spam) — fix subito
- **P1** = bug serio (comportamento errato in scenari plausibili)
- **P2** = edge case / robustezza / miglioria

---

## Findings (in compilazione dai subagenti)

### 2. Conferma/ignora proposte + dispatcher (Telegram+web) — audit completato
_(severità ri-calibrate da Claude per contesto single-tenant: i "P0 sicurezza multi-utente" del subagente NON si applicano — Cervellone ha un solo utente.)_

- **P1 — statusMessage non copre `auto_memorizzata`**: una proposta auto-memorizzata, se ri-confermata, risponde "Proposta non gestibile" invece di "già auto-memorizzata". Fix: aggiungere il caso in `doc-proposte-actions.ts` statusMessage.
- **P1 — UPDATE conferma non verifica righe colpite**: se la proposta è già stata gestita (race conferma Telegram+web simultanea), l'UPDATE `.eq('stato','in_attesa')` colpisce 0 righe ma il codice ritorna comunque `ok:true`. Fix: `.select('id')` + controllo count → "già elaborata".
- **P1 — regex UUID troppo larga** (`[0-9a-fA-F-]{36}`): accetta stringhe non-UUID. Fix: regex UUID stretta `[0-9a-f]{8}-...`. (Anche per evitare di "consumare" messaggi utente che contengono un finto /conferma_.)
- **P2 — ensureScadenza dedup non atomico**: SELECT-then-INSERT senza unique constraint → in conferme concorrenti può duplicare la scadenza. Fix: unique constraint su `cervellone_scadenze(drive_url,soggetto,data_scadenza,tipo_documento)` + insert con gestione 23505.
- **P2 — mail spostata/cancellata tra proposta e conferma**: `getEmailBody` non trova l'UID → "allegato non trovato". Messaggio poco chiaro; la sentinella NON sposta mail, quindi è solo se l'utente la sposta a mano. Fix: messaggio migliore + eventuale ricerca cross-folder.
- **P2 — atomicità 2 tabelle**: upload Drive + insert scadenza + update stato non transazionali; crash a metà lascia stato incoerente (mitigato da idempotenza al retry). Fix: ordine già corretto (update stato per ultimo); con unique constraint il retry è safe.
- **P2 — risposta web vs Telegram**: web ritorna text/plain, Telegram markdown; minime differenze di formato. Allineabile.
- **P2 (note) — AUTH_SECRET fallback 'cervellone'**: debolezza nota (web auth). Hardening backlog, non critico per single-tenant.

### 3. Estrazione SP-1 (scadenza-extract.ts) — audit completato
**VERI da fixare:**
- **P1 — prompt typo**: r.38 dice "convertile in AAAA-MM-GG" (confuso/errato). Deve dire **YYYY-MM-DD**. Rischio: date in formato sbagliato → insert scadenza fallisce.
- **P1 — confidenza/campi non coercibili**: `parseJsonLoose` se Claude ritorna `confidenza:"0.7"` (stringa) → default 0 → documento valido SCARTATO silenziosamente. Fix: `Number(o.confidenza)` + clamp 0..1.
- **P1 — max_tokens 500**: su PDF lunghi il JSON può troncarsi → estrazione fallisce senza segnalare troncamento. Fix: alza a ~900 + controlla `stop_reason==='max_tokens'`.
- **P2** — `new Anthropic()` per-call (usa singleton); validazione `account` enum + `uid` intero in leggi_allegato_mail; modello hardcoded senza fallback; logging assente; prompt-injection dal documento (mitigabile usando `system`).

### 4. Scadenzario tools + cron reminder — audit completato
**VERI da fixare:**
- **P1 — reminder marcato anche se invio fallito**: `sendReminder` aggiorna `reminders_sent` sempre; se l'invio è pending/fallito il promemoria si perde. Fix: marcare solo se almeno un invio è andato. (Mitigato: i 2 indirizzi sono interni → invio auto, di solito ok.)
- **P2 — sameSubject**: "Mario Rossi" vs "Mario  Rossi" (doppio spazio) non combaciano → scadenze duplicate. Fix: collassa spazi + normalize.
- **P2** — manca unique constraint su cervellone_scadenze (dedup non atomico); validazione email recipients; entro_giorni negativo; `chiudiScadenza` non verifica stato. (Timezone e daysUntil: analizzati, **non** off-by-one reale perché entrambi i lati usano la stessa conversione.)

### 1. Sentinella cron + escalation — audit completato
**VERI da fixare:**
- **P1 — ordine notifica/update nei solleciti**: `remindPendingProposals` invia Telegram PRIMA di `updateReminderAttempt`. Se l'update fallisce → al giro dopo ri-invia (doppia notifica) e attempts resta bloccato (non arriva mai a 3). Fix: update PRIMA, poi notifica (o garantire update).
- **P2 — auto-memo non atomica**: se dopo `confirmProposta` fallisce l'UPDATE→'auto_memorizzata' o `ricorda()`, lo stato resta 'confermata' / memoria mancante ma notifica dice "fatto". Fix: rollback/guard.
- **P2 — scarica il body di TUTTE le mail con allegati** (anche non-candidate) prima di filtrare → spreco. Fix: filtra keyword sul subject prima di getEmailBody.
- **P2** — cap attachment size prima dell'estrazione (costo/DoS); no whitelist mittente (spoof); MIN_CONFIDENCE 0.5 forse basso; tipo/soggetto null → notifica generica.
- ✅ **VERIFICATO OK**: il conteggio "3 tentativi" è corretto (attempts init=1 → 1 notifica iniziale + 2 solleciti = 3, poi auto-memo). Il subagente che diceva "4 notifiche" sbagliava.

### 5. Multi-foto + archiviazione Drive — audit completato
**VERI da fixare:**
- **P1 — `processed` marcato prima della LLM**: nel blocco recent_uploads i pending sono marcati `processed=true` PRIMA di `callClaudeStreamTelegram`. Se l'LLM fallisce (errore API), le foto del turno restano marcate ma non elaborate → perse per quel turno (recuperabili su Drive perché auto-archiviate). Fix: marcare processed SOLO dopo risposta LLM ok, e SOLO i file scaricati con successo (con cap retry per file_id scaduto).
- **P2 — archivia_documento sposta qualsiasi drive_file_id**: nessun controllo che il file sia in Telegram Inbox / appartenga alla chat. Per single-tenant con LLM=Claude (non avversario) il rischio è basso (LLM che allucina un id), ma un guard è economico: verificare che il file sia tra i recent_uploads della chat.
- **P2 — escaping nome cartella Drive incompleto** (escapa `'` ma non `\`) + segmenti "../." non rifiutati. Migliorare escape + validare i segmenti del folder_path.
- **P2 — finestra recent_uploads 2 min stretta**: allargare a ~10 min (costo nullo). + log esplicito se l'auto-archive Drive fallisce.
- ✅ **VERIFICATO NON reale**: race "double attach" (il mutex serializza i turni per chat, l'attach è post-mutex); "insert prima del mutex" è VOLUTO (Approccio 2, così i messaggi scartati restano registrati).

---

## Sintesi e azioni proposte

5 audit avversariali completati (~50 finding grezzi). I subagenti **gonfiano le severità**: NESSUN P0
reale per un'app **single-tenant** (un solo utente fidato, LLM=Claude non avversario). Niente perdita
dati irreversibile, niente crash, niente breach rilevante. Dopo triage, la lista REALE è ~12 item.

### 🔴 Da fixare presto (P1 — possono far fallire silenziosamente una funzione)
1. **Prompt typo** `scadenza-extract.ts` — "AAAA-MM-GG" → **"YYYY-MM-DD"** (rischio data malformata).
2. **Coercizione campi JSON** `scadenza-extract.ts parseJsonLoose` — `confidenza:"0.7"` (stringa) → trattata 0 → documento valido scartato. Usare `Number()` + clamp + validare tipi.
3. **max_tokens 500→~900** `scadenza-extract.ts` + check `stop_reason==='max_tokens'` (JSON troncato su PDF lunghi).
4. **recent_uploads: marca `processed` solo DOPO LLM ok e solo i file scaricati** `telegram/route.ts` (altrimenti foto del turno persa su errore LLM/download).
5. **reminder: marca `reminders_sent` solo se invio riuscito** `cron/scadenze` (altrimenti promemoria perso).
6. **sentinella: aggiorna `attempts` prima/garantito rispetto all'invio Telegram** `cron/mail-sentinella` (evita doppia notifica + attempts bloccato).
7. **statusMessage: gestisci `auto_memorizzata`** `doc-proposte-actions.ts` (oggi dice "non gestibile").

### 🟡 Hardening (P2 — buoni, non urgenti)
- Unique constraint su `cervellone_scadenze` + insert con gestione 23505 (dedup atomico).
- `sameSubject`: collassa spazi multipli + normalize (evita scadenze duplicate per soggetti "uguali").
- Regex UUID stretta nei dispatcher `/conferma_`/`/ignora_`.
- `archivia_documento`: verifica che il file sia nei recent_uploads della chat; escaping `\` nei nomi cartella Drive; rifiuta segmenti "../.".
- Finestra recent_uploads 2min → ~10min; log se auto-archive Drive fallisce.
- Validazione `account` enum + `uid` intero in `leggi_allegato_mail`; client Anthropic singleton; logging in estrazione; cap dimensione allegato prima dell'estrazione; validazione email recipients; auto-memo atomica (rollback se `ricorda` fallisce).

### ✅ Falsi allarmi verificati (NON sono bug)
- "Multi-utente può confermare/spostare" → single-tenant, irrilevante.
- "Race double-attach foto" → il mutex per-chat serializza i turni.
- "Escalation = 4 notifiche" → in realtà 3 (init=1 + 2 solleciti), corretto.
- "daysUntil off-by-one" → date a mezzanotte, diff interi.
- "insert prima del mutex" → voluto (Approccio 2).
- "path traversal Drive" → Drive non naviga per nome, "../" diventa solo una cartella mal-nominata.

### Raccomandazione
Sistema **solido per l'uso reale** (single-tenant). Consiglio: applicare i **7 P1** (sono fix piccoli e sicuri), poi i P2 a piacere. Posso farli fare a Codex (manovalanza) con mia review, al tuo via.

