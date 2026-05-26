# Design — Archiviazione foto cantiere/progetto (skill Segreteria e archiviazione documentale)

**Data:** 2026-05-26
**Ambito:** nuova capacità della skill "Segreteria e archiviazione documentale" di Cervellone.
**Origine:** richiesta utente — caricare da Telegram/web le foto di una lavorazione e farle archiviare nella cartella del cantiere (impresa edile) o progetto (studio tecnico) corretto, creando la struttura se manca, con garanzia assoluta di non perdere le foto.

---

## 1. Obiettivo

Da Telegram **o** web app carico una o più foto di una lavorazione. Indico (o Cervellone mi chiede) se sono di **impresa edile** (cantiere) o **studio tecnico** (progetto) e a quale cantiere/progetto appartengono. Cervellone:

1. Salva **subito** le foto su Drive (Telegram Inbox) — al sicuro da quel momento.
2. Trova la cartella del cantiere/progetto.
3. Se non esiste: raccoglie i dati (chiedendoli), **appende la riga** al Registro Cantieri/Progetti, mi dice di **premere il pulsante** sul foglio per lanciare la macro che crea la struttura, poi ritrova la cartella creata.
4. Individua la sottocartella **Foto** del cantiere/progetto, crea una sottocartella **`data / lavorazione`** e ci sposta le foto.
5. Non perde **mai** le foto, anche con interruzioni, attese lunghe o riavvii.

## 2. Requisito #1: garanzia "foto al sicuro" (3 reti)

1. **Persistenza immediata.** Alla ricezione, le foto sono caricate subito nella `📥 Telegram Inbox` su Drive (comportamento già esistente lato Telegram). Da lì non si perdono.
2. **Record persistente `cervellone_foto_pending`.** Tiene il legame foto↔destinazione finché non archiviate. Sopravvive ad attese (anche giorni), riavvii, sessioni diverse. **Niente finestra a tempo.**
3. **Spostamento verificato e idempotente.** "Archiviata" solo dopo move confermato nella sottocartella finale. In caso di errore, la foto resta nella Inbox e il record resta aperto → ritenta. Solo move, mai delete/copia.

## 3. Requisito #2: parità Telegram ⇄ web app (vincolante)

L'auto-archivio su Drive Inbox + la creazione del record `foto_pending` oggi vivono nella route Telegram. Vanno **estratti in un helper condiviso** (`ingestPhotoUpload`) usato sia da `/api/telegram` sia da `/api/chat`. Una foto caricata da web è salvata e tracciata **identica** a una da Telegram. Nessuna logica duplicata o divergente.

## 4. Flusso end-to-end

```
Carico foto (+ "sono del cantiere Rossi" / "progetto Bianchi"; se non lo dico, me lo chiede: impresa edile o studio tecnico?)
   │
   ├─ ingestPhotoUpload → foto in 📥 Telegram Inbox (già su Drive) + record foto_pending(stato=in_attesa)
   │
   ├─ Cerco la cartella: cantiere in IMPRESA EDILE/CANTIERI/ATTIVI, progetto in STUDIO TECNICO/01_PROGETTAZIONE/ATTIVI
   │
   ├─ ESISTE ──► individuo sottocartella Foto ──► creo "data / lavorazione" ──► sposto foto ──► chiudo record ✅
   │
   └─ NON ESISTE ──► raccolgo i dati riga (leggo intestazione Registro per sapere le colonne, chiedo i valori mancanti)
                  ──► appendo la riga al Registro Cantieri/Progetti
                  ──► "✅ Riga aggiunta. Premi il pulsante sul foglio per creare le cartelle, poi scrivimi 'fatto'."
                       (record resta APERTO, foto al sicuro)
                  ──► a 'fatto' (o ricontrollo): ritrovo la cartella creata ──► Foto ──► "data / lavorazione" ──► sposto ──► chiudo ✅
```

Comando di servizio: *"quali foto ho da archiviare?"* → `lista_foto_da_archiviare` elenca i record aperti.

## 5. Componenti

### A. `ingestPhotoUpload` (helper condiviso — parità)
Chiamato da entrambe le route all'arrivo di foto: upload in Inbox Drive + insert in `cervellone_foto_pending`. Sostituisce/riusa l'attuale auto-archive Telegram, portando la web app alla pari.

### B. Tool per Claude (skill Segreteria)
- **`archivia_foto`** — input: `ambito` ('cantiere' | 'progetto' | vuoto→chiede), `nome` (es. "Rossi"), `lavorazione?`, `data?` (default oggi). Trova la cartella, individua la sottocartella Foto, crea `data / lavorazione`, sposta le foto in attesa di quel contesto, chiude i record. Se la cartella non esiste → ritorna stato "non_trovata" (Claude passa al ramo creazione).
- **`prepara_cartella_cantiere`** / **`prepara_cartella_progetto`** — legge l'intestazione del Registro per conoscere le colonne, riceve i valori (raccolti da Claude in conversazione), **appende la riga**, ritorna il link al foglio + istruzione "premi il pulsante, poi scrivi fatto".
- **`lista_foto_da_archiviare`** — elenca i record `foto_pending` aperti (per soggetto/lavorazione).

### C. Individuazione cartella Foto (dinamica, no hardcode)
Cervellone elenca le sottocartelle del cantiere/progetto e individua quella foto per nome (es. "Foto", "Documentazione fotografica", "06_FOTO"). Per imparare nomenclatura e struttura legge **una volta** il manuale PDF in Doc Impresa Edile (`drive_read_pdf`) e **salva l'appreso in memoria permanente** (`ricorda`), riusandolo poi. Se resta ambiguo, chiede all'utente.

### D. Compilazione riga Registro (dinamica)
Cervellone **legge l'intestazione** del Registro (righe 1-3) per conoscere le colonne reali, poi chiede all'utente i valori mancanti campo per campo, e scrive una riga completa e coerente (così la macro la consuma correttamente). Niente schema hardcodato.

### E. Nomenclatura sottocartella lavorazione
`data / lavorazione`: se l'utente descrive la lavorazione → `YYYY-MM-DD - <lavorazione>` (es. `2026-05-26 - Getto fondazioni`); se non la descrive → solo `YYYY-MM-DD`. Se carico altre foto stessa data+lavorazione, riusa la sottocartella esistente (no doppioni).

## 6. Dati: tabella `cervellone_foto_pending`
```
id uuid pk, chat_id text|null, canale text ('telegram'|'web'),
drive_file_id text,            -- foto già nella Inbox
drive_url text,
ambito text|null,              -- 'cantiere'|'progetto'|null (da decidere)
soggetto text|null,            -- nome cantiere/progetto indicato
lavorazione text|null, data_lavorazione date|null,
stato text ('in_attesa'|'da_archiviare'|'archiviata'|'errore'),
target_folder_id text|null,    -- risolto a destinazione
created_at, updated_at
```
RLS deny-all anon/authenticated (come le altre tabelle Cervellone).

## 7. Recinzione scritture (governance)
Tutte le scritture passano da `assertWriteAllowed`. **Pre-flight obbligatorio:** autorizzare la cartella **padre "IMPRESA EDILE"** (che contiene `DOC. IMPRESA EDILE` + `CANTIERI`), perché oggi è autorizzata solo "Doc. Impresa Edile" (sorella di CANTIERI, non padre) → i cantieri sarebbero bloccati. Studio Tecnico ATTIVI è già autorizzato (progetti ok). L'autorizzazione si fa via seed diretto (con folder_id fornito) o dal bot con doppia conferma. In implementazione: il bot verifica l'albero reale (parent di CANTIERI_ATTIVI) per conferma.

## 8. Error handling
- Cartella cantiere/progetto non trovata → ramo creazione (non si perde nulla).
- Macro non ancora lanciata (cartella non comparsa) → record resta aperto, messaggio "non vedo ancora le cartelle, hai premuto il pulsante?".
- Scrittura bloccata dalla recinzione (🔒) → spiega e propone `gestisci_accesso_cartelle(consenti)`.
- Move fallito → foto resta in Inbox, record stato='errore', ritenta.
- Più match di cartella cantiere → elenca e chiede quale.

## 9. Non-goal (YAGNI)
- NON lanciare la macro via API (scelta utente: pulsante premuto a mano).
- NON modificare l'Apps Script lato Google.
- NON gestire video/altri media in questa iterazione (solo foto/immagini).
- NON estrazione automatica del contenuto delle foto (no OCR/scadenze qui: è la skill scadenzario, separata).

## 10. Test
- ingestPhotoUpload: foto da web e da Telegram producono lo stesso stato (Inbox + record).
- archivia_foto: cantiere esistente → move corretto + record chiuso; idempotenza su ricarica stessa data/lavorazione.
- ramo nuovo cantiere: append riga + record resta aperto + ritrovo cartella dopo "fatto".
- recinzione: write fuori da IMPRESA EDILE/STUDIO TECNICO bloccato con 🔒.
- non-perdita: simulazione errore move → foto ancora in Inbox + record riprovabile.
