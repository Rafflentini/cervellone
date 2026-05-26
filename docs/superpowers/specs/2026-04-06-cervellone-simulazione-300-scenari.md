# Simulazione Completa Cervellone -- 250+ Scenari

**Data:** 2026-04-06
**Progetto:** Cervellone -- CEO Digitale Restruktura SRL
**Scopo:** Valutare ogni scenario operativo realistico contro l'infrastruttura attuale

---

## Stack Tecnico Attuale (al momento della simulazione)

| Componente | Stato |
|---|---|
| Next.js 16 su Vercel Pro | 300s timeout |
| Claude Sonnet 4.6 (default) + Opus 4.6 (regex routing) | Attivo |
| Supabase PostgreSQL + pgvector | Attivo |
| Supabase Storage (file grandi >3MB) | Attivo |
| Telegram Bot + Web App | Attivo |
| PDF come document block | Attivo |
| Immagini come image block | Attivo |
| Word via mammoth (estrazione testo) | Attivo |
| Embeddings OpenAI text-embedding-3-small | Attivo |
| Memoria RAG (search_memory RPC, threshold 0.40, limit 30) | Attivo |
| Tool: web_search (Anthropic built-in, max 5 usi) | Attivo |
| Tool: calcola_preventivo (custom, con prezziario) | Attivo |
| Generazione DOCX/XLSX/PDF (server-side) | Attivo |
| System prompt: ~15 righe | Attivo |
| Budget API: $40/mese, ~$13 rimasti | Critico |
| Thinking: budget_tokens 10000 (disabilitato con file) | Attivo |
| Context window safeguard: 500k chars | Attivo |
| Conversazione Telegram: ultimi 20 messaggi | Attivo |

---

## CATEGORIA 1: DOCUMENTI E FILE (55 scenari)

### 1.1 PDF -- Upload e Analisi

[1] SCENARIO: Utente carica un PDF di 500KB con testo selezionabile (relazione tecnica)
ATTESO: Claude legge il PDF integralmente, risponde sul contenuto, lo salva in memoria
ATTUALE: OK -- il PDF viene convertito in document block base64 e Claude lo legge nativamente
PROBLEMA: Nessuno
SERVE: Nulla

[2] SCENARIO: Utente carica un PDF di 2.5MB (computo metrico 40 pagine)
ATTESO: Claude legge tutte le pagine, estrae voci, quantita, importi
ATTUALE: OK -- sotto 3MB viene gestito inline; Claude riceve il document block completo
PROBLEMA: Con 40 pagine di tabelle dense, il token count potrebbe essere alto (~30-50k tokens input) con costo significativo
SERVE: Nulla, ma attenzione ai costi

[3] SCENARIO: Utente carica un PDF di 5MB (progetto strutturale con tavole)
ATTESO: Claude legge il PDF, analizza contenuto testuale e descrive le tavole
ATTUALE: OK -- file >3MB viene caricato su Supabase Storage, poi scaricato server-side e convertito in document block
PROBLEMA: Il download server-side + conversione base64 consuma tempo; con 300s timeout dovrebbe farcela. PDF con molte immagini embedded potrebbe superare i limiti di dimensione del document block API Anthropic (32MB base64)
SERVE: Nulla per la maggior parte dei casi

[4] SCENARIO: Utente carica un PDF di 15MB (progetto architettonico completo)
ATTESO: Claude legge e analizza il documento
ATTUALE: Parziale -- il file viene caricato su Storage e scaricato server-side, ma 15MB in base64 diventano ~20MB. L'API Anthropic ha un limite di 32MB per messaggio, quindi potrebbe passare. Ma il token count sara enorme e costosissimo
PROBLEMA: Costo API potenzialmente $2-5 per una singola richiesta. Con $13 rimasti, poche analisi cosi
SERVE: Strategia di chunking per PDF grandi (estrai solo le pagine rilevanti)

[5] SCENARIO: Utente carica un PDF scansionato (scan di permesso di costruire)
ATTESO: Claude legge il testo tramite OCR integrato nella vision
ATTUALE: OK -- Claude via document block supporta PDF scansionati nativamente con OCR
PROBLEMA: Qualita OCR dipende dalla qualita della scansione. Scansioni storte, sfocate o a bassa risoluzione daranno risultati parziali
SERVE: Nulla

[6] SCENARIO: Utente carica un PDF scansionato molto vecchio (anni '80, timbri, scrittura a mano)
ATTESO: Claude estrae il testo leggibile e interpreta il contesto
ATTUALE: Parziale -- Claude OCR funziona ma con documenti molto deteriorati la qualita cala significativamente
PROBLEMA: Scrittura a mano, timbri sovrapposti, carta ingiallita riducono accuratezza OCR al 40-60%
SERVE: Pre-processing immagine (contrasto, de-skew) prima dell'invio a Claude -- non implementato

[7] SCENARIO: Utente carica 3 PDF contemporaneamente nella stessa chat
ATTESO: Claude li analizza tutti e confronta i contenuti
ATTUALE: Parziale -- l'UI web permette di caricare file ma il codice attuale processa solo il FILE_URL nell'ultimo messaggio utente. Piu file nello stesso messaggio potrebbero funzionare se l'UI li invia come content blocks multipli
PROBLEMA: Il codice cerca `[FILE_URL:...]` nei text blocks e li converte uno alla volta, ma il loop e presente. Il vero problema e il token count combinato
SERVE: Test approfondito con upload multipli simultanei

[8] SCENARIO: Utente carica un PDF protetto da password
ATTESO: Cervellone chiede la password o avvisa che non puo aprirlo
ATTUALE: Non funziona -- Claude riceve il base64 ma non puo decifrare un PDF protetto. Probabilmente restituisce un errore generico o testo vuoto
PROBLEMA: Nessun handling specifico per PDF protetti
SERVE: Rilevamento lato server di PDF protetti con messaggio chiaro all'utente

[9] SCENARIO: Utente carica un PDF con moduli compilabili (F24, DURC)
ATTESO: Claude legge i campi compilati del modulo
ATTUALE: OK -- Claude legge i PDF con moduli come immagini delle pagine renderizzate
PROBLEMA: Potrebbe non distinguere tra campi vuoti e compilati in moduli complessi
SERVE: Nulla

[10] SCENARIO: Utente carica un PDF portfolio (contenitore di piu PDF)
ATTESO: Claude analizza tutti i sotto-documenti
ATTUALE: Non funziona -- i PDF portfolio sono contenitori speciali; Claude potrebbe leggere solo la copertina
PROBLEMA: Formato PDF portfolio non gestito
SERVE: Server-side extraction dei sotto-documenti dal portfolio

### 1.2 Immagini

[11] SCENARIO: Utente invia foto di cantiere (1.5MB, JPEG)
ATTESO: Claude descrive lo stato del cantiere, identifica problemi di sicurezza
ATTUALE: OK -- l'immagine viene inviata come image block, Claude la analizza con vision
PROBLEMA: Nessuno
SERVE: Nulla

[12] SCENARIO: Utente invia foto di crepa su un muro
ATTESO: Claude analizza la crepa, stima gravita, suggerisce interventi
ATTUALE: OK -- Claude ha buone capacita di analisi visiva di patologie edilizie
PROBLEMA: Claude non puo misurare la crepa (serve riferimento dimensionale). La valutazione e qualitativa
SERVE: Nulla -- e un limite intrinseco dell'analisi fotografica

[13] SCENARIO: Utente invia screenshot di planimetria catastale
ATTESO: Claude legge le misure, identifica i vani, calcola superfici
ATTUALE: Parziale -- Claude puo descrivere la planimetria ma i calcoli precisi da immagine sono inaffidabili
PROBLEMA: OCR su numeri piccoli in planimetrie e impreciso; Claude potrebbe inventare misure
SERVE: Tool specifico per estrazione quote da planimetrie (non banale)

[14] SCENARIO: Utente invia foto via Telegram (compressione Telegram)
ATTESO: Claude analizza l'immagine
ATTUALE: OK -- il bot prende la foto piu grande (`message.photo[last]`), la scarica e la invia come image block
PROBLEMA: Telegram comprime le foto; la qualita potrebbe essere insufficiente per dettagli fini
SERVE: Suggerire all'utente di inviare come "file" e non come "foto" su Telegram per evitare compressione

[15] SCENARIO: Utente invia 5 foto di cantiere in sequenza rapida
ATTESO: Claude le analizza tutte insieme e fa un report
ATTUALE: Non funziona come atteso -- ogni foto su Telegram genera un messaggio separato, quindi 5 chiamate API separate. Claude non vedra le foto come insieme
PROBLEMA: Nessun batching di messaggi Telegram. Ogni foto = 1 chiamata API = 1 costo
SERVE: Batching temporale (aspetta 5-10 secondi prima di processare, raccogli tutti i media)

[16] SCENARIO: Utente invia immagine da 8MB (foto ad alta risoluzione da drone)
ATTESO: Claude analizza l'immagine aerea del cantiere
ATTUALE: Parziale -- il file viene caricato su Storage e scaricato server-side. L'API Anthropic accetta immagini fino a 20MB ma le ridimensiona internamente a ~1568px per lato
PROBLEMA: Dettagli fini (numeri civici, targhe, scritte piccole) vengono persi nel ridimensionamento
SERVE: Server-side resize intelligente con crop delle aree di interesse

[17] SCENARIO: Utente invia una foto molto scura (cantiere al tramonto)
ATTESO: Claude descrive quello che riesce a vedere e segnala la scarsa visibilita
ATTUALE: OK -- Claude gestisce bene le immagini scure e segnala la scarsa qualita
PROBLEMA: Nessuno
SERVE: Nulla

### 1.3 Word / Excel / Altri formati

[18] SCENARIO: Utente carica un file Word (.docx) con formattazione complessa
ATTESO: Claude legge il contenuto completo
ATTUALE: Parziale -- mammoth estrae il testo grezzo ma perde tabelle, immagini embedded, formattazione avanzata
PROBLEMA: mammoth.extractRawText() non preserva la struttura delle tabelle. Un computo metrico in Word diventa testo illeggibile
SERVE: Usare mammoth.convertToHtml() invece di extractRawText() per preservare tabelle; o inviare il DOCX convertito in PDF al document block

[19] SCENARIO: Utente carica un file .doc (Word 97-2003)
ATTESO: Claude legge il contenuto
ATTUALE: Parziale -- mammoth supporta .doc ma con risultati meno affidabili rispetto a .docx
PROBLEMA: Formati vecchi possono avere problemi di parsing
SERVE: Nulla di urgente

[20] SCENARIO: Utente carica un file Excel (.xlsx)
ATTESO: Claude legge le celle, interpreta i dati, fa analisi
ATTUALE: Non funziona -- il tipo .xlsx non e nella lista dei formati supportati nel Telegram bot (solo pdf, jpg, png, doc, docx). Nella web app non c'e parsing specifico per Excel
PROBLEMA: Nessun parser Excel implementato. Il file viene ignorato o causa errore
SERVE: Parser Excel (con exceljs gia installato per la generazione -- basta usarlo anche per la lettura)

[21] SCENARIO: Utente carica un file .ods (LibreOffice Calc)
ATTESO: Claude legge il foglio di calcolo
ATTUALE: Non funziona -- formato non supportato
PROBLEMA: Nessun parser ODS
SERVE: Conversione ODS -> XLSX o parsing diretto

[22] SCENARIO: Utente carica un file .csv
ATTESO: Claude legge e analizza i dati tabulari
ATTUALE: Non funziona -- formato non gestito
PROBLEMA: CSV non nella lista formati supportati
SERVE: Parser CSV (banale da implementare) + aggiunta alla lista formati

[23] SCENARIO: Utente carica un file ZIP contenente un progetto (PDF + DWG + relazioni)
ATTESO: Cervellone estrae, cataloga e analizza i contenuti
ATTUALE: Non funziona -- formato ZIP non supportato
PROBLEMA: Nessun handler per archivi compressi
SERVE: Unzip server-side + parsing ricorsivo dei file contenuti + salvataggio strutturato in memoria

[24] SCENARIO: Utente carica un file DWG (AutoCAD)
ATTESO: Claude descrive il disegno tecnico
ATTUALE: Non funziona -- DWG e un formato binario proprietario, non supportato
PROBLEMA: Nessuna libreria DWG installata; Claude non puo leggere DWG come document block
SERVE: Conversione DWG -> PDF o DWG -> immagine server-side (librerie come libreDWG o servizio esterno)

[25] SCENARIO: Utente carica un file DXF
ATTESO: Claude legge le entita geometriche, descrive il disegno
ATTUALE: Non funziona -- DXF e testo ma molto complesso da interpretare. Non c'e parser
PROBLEMA: Formato non gestito
SERVE: Parser DXF -> descrizione testuale o conversione DXF -> immagine

[26] SCENARIO: Utente carica un file .eml (email salvata)
ATTESO: Cervellone legge il contenuto dell'email e gli allegati
ATTUALE: Non funziona -- formato non supportato
PROBLEMA: Nessun parser email
SERVE: Parser .eml con estrazione allegati

[27] SCENARIO: Utente carica una presentazione PowerPoint (.pptx)
ATTESO: Claude legge le slide
ATTUALE: Non funziona -- formato non supportato
PROBLEMA: Nessun parser PPTX
SERVE: Conversione PPTX -> PDF o estrazione testo da PPTX

### 1.4 Salvataggio e Recupero dalla Memoria

[28] SCENARIO: Utente carica un PDF e chiede "ricordati questo documento"
ATTESO: Il contenuto viene salvato in memoria permanente e recuperabile in futuro
ATTUALE: Parziale -- l'analisi del file viene salvata come embedding "knowledge" solo se `fullResponse.length > 200` E ci sono file. Ma salva solo i primi 10000 caratteri della risposta, non il contenuto originale del PDF
PROBLEMA: Il contenuto originale del PDF non viene mai salvato direttamente come embedding. Solo la risposta di Claude (che e un riassunto) viene salvata. Se il PDF ha 50 pagine, la memoria conterra solo un riassunto
SERVE: Salvare anche il testo estratto dal PDF come embedding (chunked se necessario)

[29] SCENARIO: Dopo 2 settimane, utente chiede "cosa c'era nel PDF del permesso di costruire che ho caricato?"
ATTESO: Cervellone recupera dalla memoria il contenuto del documento
ATTUALE: Parziale -- la ricerca RAG con threshold 0.40 e limit 30 potrebbe trovare il riassunto salvato. Ma con molti embedding nel database, la rilevanza potrebbe calare
PROBLEMA: Se la query dell'utente non usa termini simili al contenuto salvato, il retrieval fallisce. "PDF del permesso" potrebbe non matchare con il testo tecnico del riassunto
SERVE: Metadata strutturati sugli embedding (tipo_documento, data_caricamento, nome_file) per retrieval piu preciso

[30] SCENARIO: Utente chiede "mostrami tutti i documenti caricati questo mese"
ATTESO: Lista di tutti i file caricati con date e descrizioni
ATTUALE: Non funziona -- non c'e un indice dei documenti caricati. Gli embedding non hanno metadata sufficienti
PROBLEMA: Nessun registro file strutturato
SERVE: Tabella `documents_uploaded` con nome, data, tipo, dimensione, conversation_id, riassunto

[31] SCENARIO: Utente carica lo stesso documento due volte a distanza di giorni
ATTESO: Cervellone riconosce il duplicato e avvisa
ATTUALE: Non funziona -- nessun dedup dei documenti. Crea embedding duplicati
PROBLEMA: Inquinamento della memoria con contenuti ripetuti
SERVE: Hash del file per dedup + confronto con embedding esistenti

[32] SCENARIO: Utente ha caricato 100 documenti in 3 mesi e chiede qualcosa su uno specifico
ATTESO: Cervellone trova il documento giusto nella memoria
ATTUALE: Parziale -- la ricerca semantica con limit 30 potrebbe trovarlo, ma con 100 documenti e migliaia di embedding, la precision cala
PROBLEMA: Nessun filtraggio per tipo documento, data, progetto. Solo similarita semantica grezza
SERVE: Filtri nella search_memory (per progetto, per data range, per tipo)

[33] SCENARIO: Utente carica un file e poi chiede di modificarlo
ATTESO: Cervellone modifica il documento e lo restituisce aggiornato
ATTUALE: Non funziona per la modifica -- Claude puo leggere il file ma non puo modificare il file originale. Puo solo generare un nuovo documento con le modifiche
PROBLEMA: Nessuna capacita di editing di file caricati
SERVE: Per DOCX: modifica con docx.js. Per PDF: rigenerazione. Realisticamente, Claude genera una nuova versione

[34] SCENARIO: Utente scarica un documento generato dal Cervellone in formato DOCX
ATTESO: File Word ben formattato con intestazione Restruktura
ATTUALE: Parziale -- la generazione DOCX esiste (`generate-doc` route) ma converte da markdown a DOCX. Tabelle non supportate nel converter markdown->docx
PROBLEMA: Il converter `markdownToDocx` gestisce headings, bullet, bold/italic ma NON tabelle. Un computo metrico esce senza la tabella
SERVE: Supporto tabelle nel converter DOCX; o generazione DOCX direttamente dall'HTML del preventivo

[35] SCENARIO: Utente scarica un preventivo generato in formato PDF
ATTESO: PDF professionale con tabelle, intestazione, totali
ATTUALE: Parziale -- il generatore PDF (`jsPDF`) converte da testo/markdown. Non gestisce tabelle HTML. Il preventivo viene generato come HTML nel pannello anteprima, ma l'export PDF perde la formattazione
PROBLEMA: Il PDF generator non sa convertire HTML in PDF, solo testo piano con headings/bullets
SERVE: Usare una libreria HTML-to-PDF (puppeteer, o jspdf-autotable per le tabelle)

[36] SCENARIO: Utente vuole stampare direttamente dal pannello anteprima
ATTESO: Stampa pulita del documento HTML
ATTUALE: Parziale -- il pannello anteprima mostra l'HTML, il browser puo stampare con Ctrl+P, ma non c'e un pulsante "Stampa" ne CSS di stampa ottimizzato
PROBLEMA: Manca CSS @media print
SERVE: CSS di stampa + pulsante dedicato

### 1.5 Telegram e File

[37] SCENARIO: Utente invia un PDF via Telegram (3MB)
ATTESO: Cervellone lo legge e risponde
ATTUALE: Parziale -- Telegram ha un limite di download file di 20MB tramite API bot. Il file viene scaricato e convertito in document block. Funziona, ma Telegram comprime: il limite reale di invio file Telegram e 50MB, ma l'API bot scarica max 20MB
PROBLEMA: Per file tra 20-50MB l'utente li puo inviare su Telegram ma il bot non riesce a scaricarli
SERVE: Messaggio chiaro per file >20MB ("Lo carichi dalla chat web")

[38] SCENARIO: Utente invia un vocale su Telegram chiedendo un'informazione tecnica
ATTESO: Cervellone trascrive il vocale e risponde alla domanda
ATTUALE: OK -- Whisper (OpenAI) trascrive il vocale in italiano, poi Claude risponde
PROBLEMA: Costo aggiuntivo OpenAI per Whisper. Termini tecnici edilizi potrebbero essere trascritti male
SERVE: Nulla di urgente

[39] SCENARIO: Utente invia un vocale di 5 minuti con istruzioni dettagliate
ATTESO: Cervellone trascrive tutto e esegue le istruzioni
ATTUALE: Parziale -- Whisper trascrive ma vocali lunghi possono avere errori. Il file audio OGG di 5 minuti e circa 500KB-1MB, gestibile
PROBLEMA: Whisper potrebbe troncare o avere errori su vocali molto lunghi; nessun feedback intermedio all'utente
SERVE: Nulla di critico

[40] SCENARIO: Utente invia un video da Telegram
ATTESO: Cervellone analizza il video (es. video di cantiere)
ATTUALE: Non funziona -- il bot non gestisce messaggi video
PROBLEMA: Video non nella lista dei tipi gestiti nel webhook Telegram
SERVE: Estrazione frame dal video (ffmpeg server-side) + analisi come immagini; oppure in futuro API Anthropic video

### 1.6 File -- Edge Cases

[41] SCENARIO: Utente carica un file con nome contenente caratteri speciali (es. "Progetto n.3 - Rev_02 (finale).pdf")
ATTESO: Upload e analisi funzionano normalmente
ATTUALE: OK -- il nome viene prefissato con timestamp (`Date.now()_nomefile`), quindi i caratteri speciali non dovrebbero causare problemi con Supabase Storage
PROBLEMA: Nessuno prevedibile
SERVE: Nulla

[42] SCENARIO: Utente carica un PDF corrotto (file troncato)
ATTESO: Messaggio di errore chiaro
ATTUALE: Parziale -- Claude riceve il base64 del file corrotto; l'API Anthropic potrebbe restituire un errore o Claude potrebbe dire "non riesco a leggere il file". Ma il messaggio all'utente potrebbe essere generico
PROBLEMA: Nessun check di integrita pre-invio
SERVE: Validazione PDF server-side prima dell'invio a Claude

[43] SCENARIO: Utente trascina un file nel campo di input della web app
ATTESO: Upload e analisi automatica
ATTUALE: Dipende dall'UI -- verificare se il drag-and-drop e implementato nel componente di input
PROBLEMA: Da verificare
SERVE: Drag-and-drop handler se mancante

[44] SCENARIO: URL firmato di Supabase Storage scade (dopo 24 ore) e l'utente riprende la conversazione
ATTESO: Il file e ancora accessibile
ATTUALE: Non funziona -- l'URL firmato scade dopo 24 ore. Se la conversazione viene ripresa dopo, il riferimento `[FILE_URL:...]` nel messaggio punta a un URL scaduto
PROBLEMA: File non piu scaricabile dopo 24h
SERVE: Rinnovo URL on-demand o salvataggio permanente del contenuto estratto al momento dell'upload

[45] SCENARIO: Upload di un file da 25MB dalla web app
ATTESO: File caricato e analizzato
ATTUALE: Parziale -- la route upload ha `maxDuration: 60`. Un file da 25MB su connessione media (5 Mbps upload) richiede ~40 secondi solo per l'upload. Poi serve il download server-side per Claude. Rischio timeout
PROBLEMA: Timeout probabile per file grandi su connessioni lente
SERVE: Upload diretto a Supabase Storage dal browser (gia implementato), ma verificare i limiti

[46] SCENARIO: Utente carica un file .heic (formato foto iPhone)
ATTESO: Claude analizza l'immagine
ATTUALE: Non funziona -- HEIC non e nella lista dei media type supportati. Il browser potrebbe non rilevare il MIME type corretto
PROBLEMA: Formato non gestito
SERVE: Conversione HEIC -> JPEG server-side (libreria heic-convert)

[47] SCENARIO: Utente copia-incolla un'immagine direttamente nella chat
ATTESO: Claude analizza l'immagine incollata
ATTUALE: Dipende dall'UI -- verificare se il paste handler per immagini e implementato
PROBLEMA: Da verificare
SERVE: Paste handler per immagini dal clipboard

[48] SCENARIO: Utente carica un file Pages (Apple)
ATTESO: Claude legge il documento
ATTUALE: Non funziona -- formato proprietario Apple non supportato
PROBLEMA: Nessun parser Pages
SERVE: Conversione server-side o messaggio "converti in PDF prima"

[49] SCENARIO: File viene caricato ma la connessione cade a meta
ATTESO: Messaggio di errore, possibilita di riprovare
ATTUALE: Parziale -- Supabase Storage gestisce upload atomici. Se l'upload fallisce, l'errore viene propagato. Ma il feedback all'utente potrebbe non essere chiaro
PROBLEMA: UX di errore da migliorare
SERVE: Retry automatico + progress bar

[50] SCENARIO: Utente carica un PDF di 100 pagine e chiede "riassumimi la pagina 47"
ATTESO: Claude naviga alla pagina 47 e la riassume
ATTUALE: Parziale -- Claude riceve il PDF intero come document block e puo raggiungere pagina 47, ma con 100 pagine il costo e alto. Claude potrebbe anche confondersi sulla numerazione delle pagine
PROBLEMA: Nessun modo di inviare solo una pagina specifica -- tutto il PDF viene inviato
SERVE: Estrazione pagina specifica server-side con libreria PDF (pdf-lib)

[51] SCENARIO: Utente carica un PDF e poi dice "aggiungi una nota a pagina 3"
ATTESO: PDF modificato con annotazione
ATTUALE: Non funziona -- nessuna capacita di modifica PDF
PROBLEMA: Modifica PDF non implementata
SERVE: pdf-lib per annotazioni/modifiche PDF server-side

[52] SCENARIO: Utente chiede di unire due PDF caricati
ATTESO: PDF combinato restituito
ATTUALE: Non funziona
PROBLEMA: Nessuna manipolazione PDF implementata
SERVE: pdf-lib per merge PDF

[53] SCENARIO: Utente carica un file Excel con macro (.xlsm)
ATTESO: Claude legge i dati (ignorando le macro)
ATTUALE: Non funziona -- formato non supportato e le macro sono un rischio sicurezza
PROBLEMA: Formato non gestito
SERVE: Parser che legge i dati ignorando le macro

[54] SCENARIO: Utente invia un link a un file su Google Drive
ATTESO: Cervellone scarica e analizza il file
ATTUALE: Non funziona -- nessuna integrazione Google Drive per il download
PROBLEMA: Link Drive richiedono autenticazione OAuth
SERVE: Integrazione Google Drive API (complessa) oppure istruire l'utente a scaricare e caricare

[55] SCENARIO: Utente carica un file firmato digitalmente (.p7m)
ATTESO: Cervellone verifica la firma e legge il contenuto
ATTUALE: Non funziona -- formato .p7m non supportato
PROBLEMA: Formato crittografico non gestito
SERVE: Libreria per estrazione contenuto da .p7m (es. node-forge o servizio esterno)

---

## CATEGORIA 2: STUDIO TECNICO (45 scenari)

### 2.1 Preventivi

[56] SCENARIO: Utente chiede "Fammi un preventivo per la ristrutturazione di un appartamento a Potenza, 80mq"
ATTESO: Preventivo completo con voci, quantita, prezzi unitari dal prezziario regionale, totali
ATTUALE: OK -- Claude ragiona sulle voci necessarie e chiama il tool `calcola_preventivo`. Il tool calcola, confronta con il prezziario, genera HTML professionale
PROBLEMA: La qualita dipende dalla capacita di Claude di stimare voci e quantita realistiche. Senza sopralluogo, le quantita sono stime
SERVE: Nulla -- funziona. Migliorabile con database di preventivi precedenti come riferimento

[57] SCENARIO: Utente fornisce una lista dettagliata di lavorazioni e chiede il preventivo
ATTESO: Preventivo preciso con le voci fornite
ATTUALE: OK -- Claude usa le voci fornite come input per il tool, che fa i calcoli
PROBLEMA: Nessuno
SERVE: Nulla

[58] SCENARIO: Utente chiede "aggiorna il preventivo di ieri aggiungendo il massetto"
ATTESO: Preventivo precedente recuperato dalla memoria, voce aggiunta, ricalcolo
ATTUALE: Parziale -- la memoria RAG potrebbe recuperare il preventivo precedente, ma Claude dovra rigenerare tutto da zero. Non c'e modo di "aggiornare" un preventivo esistente
PROBLEMA: Nessuna persistenza strutturata dei preventivi. Ogni volta si rigenera da zero
SERVE: Tabella `preventivi` su Supabase con voci salvate, editabili

[59] SCENARIO: Utente chiede un preventivo con 50 voci di lavoro
ATTESO: Preventivo completo con tutte le 50 voci
ATTUALE: Parziale -- Claude puo generare molte voci, ma il tool `calcola_preventivo` cerca nel prezziario per OGNI voce. 50 ricerche in sequenza possono essere lente
PROBLEMA: Tempo di esecuzione potenzialmente lungo; rischio timeout 300s
SERVE: Ricerca prezziario batch/parallela

[60] SCENARIO: Utente chiede "quanto costa rifare il tetto?" senza dare dettagli
ATTESO: Cervellone fa domande di approfondimento (superficie, tipo copertura, stato attuale)
ATTUALE: OK -- Claude e bravo a chiedere informazioni mancanti prima di procedere
PROBLEMA: Nessuno
SERVE: Nulla

[61] SCENARIO: Utente chiede il preventivo con un prezziario regionale diverso (es. Calabria)
ATTESO: Il tool cerca nel prezziario della Calabria
ATTUALE: Parziale -- il campo `regione` e supportato nel tool, ma il database prezziario attualmente contiene probabilmente solo la Basilicata (c'e il file `prezziario_basilicata_2025.ods` nel repo)
PROBLEMA: Prezziari di altre regioni non caricati
SERVE: Caricare prezziari di tutte le regioni usate; oppure web search come fallback (gia previsto nel design)

[62] SCENARIO: Utente chiede di confrontare il preventivo con quello di un concorrente (caricato come PDF)
ATTESO: Analisi comparativa voce per voce
ATTUALE: Parziale -- Claude puo leggere entrambi i documenti e fare un confronto qualitativo, ma non c'e un tool di confronto strutturato
PROBLEMA: Il confronto e narrativo, non tabulare. Non c'e un tool "confronta preventivi"
SERVE: Tool di confronto preventivi con output tabella differenze

### 2.2 Computi Metrici

[63] SCENARIO: Utente chiede un computo metrico estimativo per lavori di impermeabilizzazione
ATTESO: Computo con voci, quantita, prezzi unitari da prezziario ufficiale, importi parziali e totale
ATTUALE: Parziale -- il tool `calcola_preventivo` genera anche il computo nel preventivo. Ma non c'e un tool dedicato "computo metrico" con formato specifico. Il preventivo contiene il computo ma confusi nella stessa struttura
PROBLEMA: Computo metrico e preventivo sono documenti diversi nel mondo edile. Il tool li unifica
SERVE: Tool dedicato `computo_metrico` con formato CME standard (o un flag nel tool preventivo)

[64] SCENARIO: Utente carica una planimetria e chiede il computo metrico
ATTESO: Cervellone estrae le misure dalla planimetria e genera il computo
ATTUALE: Parziale -- Claude puo analizzare la planimetria come immagine e stimare le misure, ma le misure estratte da immagini non sono precise
PROBLEMA: Misure da immagini sono inaffidabili. Errori del 10-20% sono comuni
SERVE: Per ora e accettabile come stima di massima, ma serve disclaimer

[65] SCENARIO: Utente chiede il computo metrico con i codici del prezziario regionale
ATTESO: Ogni voce ha il codice esatto del prezziario regionale
ATTUALE: Parziale -- il tool `cercaPrezziario` cerca nel database locale ma non e chiaro se restituisce i codici delle voci o solo i prezzi
PROBLEMA: Senza codici prezziario, il computo non e valido per gare d'appalto
SERVE: Arricchire il database prezziario con codici voce + restituirli nel computo

### 2.3 Relazioni Tecniche

[66] SCENARIO: Utente chiede una relazione tecnica di calcolo strutturale per un solaio
ATTESO: Relazione con normativa di riferimento (NTC 2018), modello di calcolo, verifiche
ATTUALE: Parziale -- Claude (specialmente Opus) puo scrivere relazioni tecniche con normativa corretta. Ma i calcoli strutturali fatti dall'LLM non sono affidabili per uso professionale
PROBLEMA: Calcoli strutturali LLM-generated non possono essere usati per progettazione reale. Servono software certificati (SAP2000, MIDAS, Edilus)
SERVE: Disclaimer chiaro "relazione di massima, da verificare con software certificato". Tool di calcolo strutturale basico per verifiche semplici (flessione semplice, taglio)

[67] SCENARIO: Utente chiede relazione tecnica asseverata per pratica edilizia
ATTESO: Relazione con tutti i riferimenti normativi, descrizione intervento, attestazioni
ATTUALE: OK per il testo -- Claude genera ottimi testi tecnici. Il routing Opus si attiva per "relazione tecnica"
PROBLEMA: La relazione deve essere firmata da un professionista. Claude genera la bozza, il tecnico la verifica e firma
SERVE: Nulla -- l'uso previsto e corretto (bozza, non documento finale)

[68] SCENARIO: Utente chiede relazione legge 10 (risparmio energetico)
ATTESO: Relazione con calcoli di trasmittanza, verifica limiti, stratigrafia pareti
ATTUALE: Parziale -- Claude puo generare il testo e i concetti, ma i calcoli termotecnici precisi richiedono software specifico (TERMOLOG, EC700)
PROBLEMA: Calcoli di trasmittanza termica sono complessi e normativi. Errori non sono accettabili
SERVE: Tool di calcolo trasmittanza (formula semplice: 1/somma(s/lambda)) per verifiche di massima

[69] SCENARIO: Utente chiede la relazione geologica
ATTESO: Relazione con indagini geotecniche, classificazione terreno
ATTUALE: Parziale -- Claude puo generare la struttura della relazione, ma senza dati geotecnici reali e solo un template
PROBLEMA: Relazione geologica richiede dati da indagini in situ (sondaggi, prove penetrometriche)
SERVE: Nulla -- Claude puo generare la struttura, i dati reali li inserisce il geologo

### 2.4 Sicurezza

[70] SCENARIO: Utente chiede di redigere il POS (Piano Operativo Sicurezza)
ATTESO: POS completo con analisi rischi, DPI, procedure, organigramma
ATTUALE: OK per il testo -- Claude genera POS ben strutturati con riferimenti normativi corretti (D.Lgs. 81/08)
PROBLEMA: Il POS deve essere specifico per il cantiere. Senza dati reali del cantiere, e un template generico
SERVE: Template personalizzabile con dati cantiere precompilati da un form

[71] SCENARIO: Utente chiede il PSC (Piano Sicurezza e Coordinamento)
ATTESO: PSC completo con cronoprogramma, interferenze, costi sicurezza
ATTUALE: OK per il testo -- simile al POS. Claude genera struttura e contenuti
PROBLEMA: PSC richiede conoscenza specifica delle fasi lavorative e interferenze
SERVE: Input strutturato con fasi lavorative per generazione piu precisa

[72] SCENARIO: Utente chiede la valutazione dei rischi per lavori in quota
ATTESO: Analisi rischi specifica con misure preventive
ATTUALE: OK -- Claude conosce bene la normativa sulla sicurezza in quota (ponteggi, linee vita, DPI III categoria)
PROBLEMA: Nessuno per una bozza/checklist
SERVE: Nulla

[73] SCENARIO: Utente chiede il DUVRI (Documento Unico Valutazione Rischi da Interferenze)
ATTESO: DUVRI specifico per le imprese coinvolte
ATTUALE: Parziale -- Claude genera la struttura ma senza conoscere le imprese e i rischi specifici e generico
PROBLEMA: Richiede dati delle imprese subappaltatrici
SERVE: Form con dati imprese per personalizzazione

### 2.5 Normativa

[74] SCENARIO: Utente chiede "quali sono i limiti di altezza per costruire in zona B del PRG di Potenza?"
ATTESO: Risposta precisa con riferimento normativo
ATTUALE: Parziale -- Claude puo fare web search (max 5 usi) per cercare il PRG di Potenza, ma le informazioni urbanistiche comunali spesso non sono online o sono in PDF difficili da trovare
PROBLEMA: Dati urbanistici spesso non disponibili online; web search potrebbe non trovare la risposta
SERVE: Database locale con parametri urbanistici dei comuni di interesse (almeno quelli lucani)

[75] SCENARIO: Utente chiede confronto tra NTC 2018 e NTC 2008
ATTESO: Tabella comparativa con le differenze principali
ATTUALE: OK -- Claude ha ottima conoscenza delle NTC. Il routing Opus si attiva per "analisi normativa"
PROBLEMA: Claude potrebbe avere knowledge cutoff che non include aggiornamenti recentissimi
SERVE: Nulla -- per normativa storica Claude e eccellente. Per aggiornamenti: web search

[76] SCENARIO: Utente chiede "la mia pratica SCIA e conforme? ecco il progetto" (con PDF allegato)
ATTESO: Analisi di conformita normativa del progetto
ATTUALE: Parziale -- Claude legge il PDF e conosce la normativa, ma una verifica di conformita completa richiede competenza ingegneristica e responsabilita professionale
PROBLEMA: Claude puo evidenziare potenziali criticita ma non puo "certificare" la conformita
SERVE: Checklist di conformita SCIA strutturata come tool

[77] SCENARIO: Utente chiede informazioni sul Superbonus/bonus edilizi vigenti
ATTESO: Risposta aggiornata con percentuali, limiti, requisiti
ATTUALE: Parziale -- Claude ha knowledge cutoff a maggio 2025. I bonus cambiano frequentemente. Web search puo compensare
PROBLEMA: Informazioni su bonus edilizi cambiano ogni legge di bilancio
SERVE: Web search (gia disponibile) + database aggiornato di bonus vigenti

[78] SCENARIO: Utente chiede le tabelle dei carichi del vento secondo NTC 2018 per la zona 3
ATTESO: Valori precisi di pressione del vento per la zona richiesta
ATTUALE: Parziale -- Claude conosce la normativa ma potrebbe non ricordare i valori esatti delle tabelle. Rischio di valori inventati
PROBLEMA: Tabelle numeriche specifiche (vento, neve, sisma) richiedono precisione assoluta
SERVE: Database locale con tabelle NTC 2018 (carichi, coefficienti, zone sismiche) per lookup preciso

[79] SCENARIO: Utente chiede di verificare se un intervento richiede permesso di costruire o SCIA
ATTESO: Classificazione dell'intervento con riferimento normativo
ATTUALE: OK -- Claude ha buona conoscenza del TU Edilizia (DPR 380/01)
PROBLEMA: Nessuno per la risposta generica; per la risposta specifica serve conoscenza del regolamento edilizio comunale
SERVE: Nulla di urgente

### 2.6 Calcoli

[80] SCENARIO: Utente chiede "calcola il volume di calcestruzzo per un plinto 1.2x1.2x0.5m"
ATTESO: Calcolo preciso (0.72 mc)
ATTUALE: OK -- Claude sa fare calcoli matematici semplici. Con thinking abilitato, la precisione e alta
PROBLEMA: Nessuno per calcoli semplici
SERVE: Nulla

[81] SCENARIO: Utente chiede il calcolo di una trave in c.a. a flessione semplice
ATTESO: Verifica a flessione con formula e risultato
ATTUALE: Parziale -- Claude puo applicare le formule ma i calcoli complessi con molti passaggi possono avere errori
PROBLEMA: Calcoli strutturali multi-step sono a rischio errore. Un errore in un passaggio si propaga
SERVE: Tool di calcolo strutturale per verifiche elementari (flessione, taglio, compressione)

[82] SCENARIO: Utente chiede il dimensionamento di un'armatura di travi
ATTESO: Calcolo dell'area di armatura necessaria con verifiche SLU/SLE
ATTUALE: Parziale -- Claude conosce le formule ma potrebbe sbagliare i coefficienti o le unita di misura
PROBLEMA: Errori di calcolo strutturale possono avere conseguenze gravi
SERVE: Tool dedicato con formule NTC 2018 codificate

[83] SCENARIO: Utente chiede di calcolare il carico neve per Potenza
ATTESO: Valore preciso secondo NTC 2018 (zona, altitudine, esposizione)
ATTUALE: Parziale -- Claude conosce la formula ma potrebbe sbagliare i parametri zonali
PROBLEMA: Parametri zonali richiedono lookup in tabelle
SERVE: Database zone climatiche NTC 2018

[84] SCENARIO: Utente chiede la verifica sismica semplificata di un edificio esistente in muratura
ATTESO: Analisi con metodo semplificato (livello LV1)
ATTUALE: Non funziona con affidabilita -- verifica sismica anche semplificata richiede molti parametri e calcoli iterativi
PROBLEMA: Troppo complesso per un LLM senza tool di calcolo dedicato
SERVE: Tool di verifica sismica semplificata (LV1) con formule NTC 2018

### 2.7 Pratiche Edilizie

[85] SCENARIO: Utente chiede di preparare la documentazione per una CILA
ATTESO: Checklist documenti + bozza relazione tecnica
ATTUALE: OK -- Claude genera ottimi checklist e bozze di relazioni per pratiche edilizie
PROBLEMA: Nessuno
SERVE: Template CILA precompilati per i comuni di riferimento

[86] SCENARIO: Utente chiede lo stato di una pratica edilizia al Comune
ATTESO: Cervellone verifica online lo stato
ATTUALE: Non funziona -- non c'e integrazione con i portali comunali (SUE, SUAP)
PROBLEMA: I portali comunali non hanno API pubbliche
SERVE: Non implementabile automaticamente; al massimo checklist per verifica manuale

[87] SCENARIO: Utente chiede di compilare il modulo unico SCIA
ATTESO: Modulo compilato con i dati del progetto
ATTUALE: Non funziona -- Claude non puo compilare moduli PDF. Puo solo elencare cosa scrivere in ogni campo
PROBLEMA: Compilazione moduli PDF richiede librerie specifiche
SERVE: pdf-lib per compilazione campi moduli; oppure generazione del modulo da template

[88] SCENARIO: Utente chiede quanto costa una pratica SCIA
ATTESO: Stima dei diritti di segreteria e oneri
ATTUALE: Parziale -- Claude puo dare una stima basata sulla normativa regionale, ma gli importi variano per comune
PROBLEMA: Dati specifici per comune non in memoria
SERVE: Database tariffe comunali (almeno per i comuni dove opera Restruktura)

### 2.8 Perizie e Stime

[89] SCENARIO: Utente chiede una perizia estimativa di un immobile
ATTESO: Perizia con metodo di stima, comparativi, valore finale
ATTUALE: Parziale -- Claude genera ottime perizie come testo. Ma i valori immobiliari sono stime basate sulla conoscenza generale, non su dati di mercato reali
PROBLEMA: Senza accesso a banche dati immobiliari (OMI, Borsino) i valori sono approssimativi
SERVE: Integrazione con dati OMI (Agenzia Entrate) o Borsino Immobiliare per valori al mq aggiornati

[90] SCENARIO: Utente chiede la stima dei danni per un sinistro assicurativo
ATTESO: Perizia danni con descrizione, quantificazione, allegati fotografici
ATTUALE: Parziale -- Claude genera il testo della perizia. Se ci sono foto, le analizza. Ma la quantificazione precisa richiede sopralluogo
PROBLEMA: Nessun tool di calcolo danni specifico
SERVE: Tool/template per perizie assicurative con voci standard

[91] SCENARIO: Utente carica foto di danni post-sisma e chiede classificazione
ATTESO: Classificazione danni (AeDES), livello operativita
ATTUALE: Parziale -- Claude puo descrivere i danni visibili e fare una classificazione qualitativa, ma la scheda AeDES richiede compilazione strutturata
PROBLEMA: Classificazione AeDES ha regole precise non completamente codificabili come analisi visiva
SERVE: Template AeDES + guida interattiva alla compilazione

[92] SCENARIO: Utente chiede "quanto vale un muro di contenimento alto 3m lungo 15m?"
ATTESO: Stima con voci di lavoro dettagliate
ATTUALE: OK -- Claude puo ragionare sulle voci (scavo, casseratura, armatura, getto, rinterro) e generare il preventivo con il tool
PROBLEMA: La stima delle quantita e approssimativa senza progetto esecutivo
SERVE: Nulla -- e una stima di massima, accettabile

### 2.9 Analisi DXF/Planimetrie

[93] SCENARIO: Utente carica un DXF e chiede di estrarre le misure
ATTESO: Lista di ambienti con dimensioni e superfici
ATTUALE: Non funziona -- DXF non supportato come formato
PROBLEMA: Parser DXF mancante
SERVE: Libreria DXF parser + conversione in formato interpretabile

[94] SCENARIO: Utente carica una planimetria quotata come immagine e chiede di calcolare le superfici
ATTESO: Superfici calcolate da quote lette nell'immagine
ATTUALE: Parziale -- Claude puo leggere le quote visibili e calcolare le superfici, ma la lettura di numeri piccoli in planimetrie e inaffidabile
PROBLEMA: Errori di OCR sulle quote -> errori nelle superfici
SERVE: Per ora accettabile come stima; disclaimer necessario

[95] SCENARIO: Utente chiede di generare un render dell'edificio
ATTESO: Render 3D fotorealistico
ATTUALE: Non funziona -- Claude non genera immagini (a differenza di ChatGPT con DALL-E)
PROBLEMA: Nessuna capacita di generazione immagini
SERVE: Integrazione con API di generazione immagini (Midjourney, Flux, Stable Diffusion) oppure descrizione testuale per renderer esterni

[96] SCENARIO: Utente chiede una descrizione dettagliata per il render (da dare al grafico)
ATTESO: Brief dettagliato con materiali, colori, prospettive, stile
ATTUALE: OK -- Claude e eccellente nel generare brief descrittivi
PROBLEMA: Nessuno
SERVE: Nulla

[97] SCENARIO: Utente carica foto di un edificio e chiede di descrivere lo stato di conservazione
ATTESO: Report con classificazione stato conservativo, patologie visibili
ATTUALE: OK -- Claude vision analizza bene le condizioni degli edifici da foto
PROBLEMA: Nessuno per un'analisi qualitativa
SERVE: Nulla

[98] SCENARIO: Utente chiede il computo metrico partendo da un progetto caricato come PDF
ATTESO: Computo con voci estratte dal progetto
ATTUALE: Parziale -- Claude legge il PDF del progetto e genera il computo. Ma estrarre quantita precise da tavole grafiche in PDF e inaffidabile
PROBLEMA: Le misure da disegni tecnici lette via vision hanno margini di errore significativi
SERVE: Per computi precisi servono misure precise. Il tool e utile come bozza

[99] SCENARIO: Utente chiede la tabella millesimale di un condominio
ATTESO: Tabella millesimale con coefficienti e ripartizione
ATTUALE: Parziale -- Claude conosce i criteri di calcolo ma i millesimi richiedono dati precisi di superficie, esposizione, piano, luminosita
PROBLEMA: Calcolo millesimale e normato e richiede precisione
SERVE: Tool di calcolo millesimale con input strutturato

[100] SCENARIO: Utente chiede la check-list per il collaudo statico
ATTESO: Checklist completa con riferimenti normativi
ATTUALE: OK -- Claude genera ottime checklist tecniche
PROBLEMA: Nessuno
SERVE: Template specifico per Restruktura con logo e formattazione

---

## CATEGORIA 3: SEGRETERIA (35 scenari)

### 3.1 Lettere e Comunicazioni

[101] SCENARIO: Utente chiede "scrivi una lettera al Comune di Potenza per richiedere il certificato di agibilita"
ATTESO: Lettera formale con intestazione Restruktura, riferimenti normativi, dati progetto
ATTUALE: OK -- Claude genera lettere formali eccellenti. L'intestazione Restruktura e nel system prompt
PROBLEMA: Nessuno
SERVE: Nulla

[102] SCENARIO: Utente chiede di scrivere una email di sollecito pagamento a un cliente
ATTESO: Email professionale ma ferma, con riferimenti fattura e scadenze
ATTUALE: OK -- Claude sa calibrare il tono tra cortesia e fermezza
PROBLEMA: Senza dati della fattura, Claude chiede i dettagli o inventa placeholder
SERVE: Integrazione con database fatture per auto-compilazione

[103] SCENARIO: Utente chiede "rispondi a questa email" e incolla il testo
ATTESO: Risposta appropriata al contesto
ATTUALE: OK -- Claude analizza il contesto e genera risposte pertinenti
PROBLEMA: Nessuno
SERVE: Nulla

[104] SCENARIO: Utente chiede una lettera di incarico professionale
ATTESO: Lettera con oggetto, descrizione prestazione, compensi, tempi
ATTUALE: OK -- Claude genera lettere di incarico professionali con clausole standard
PROBLEMA: I compensi devono essere inseriti dall'utente o calcolati con il tariffario (DM 140/2012 e successivi)
SERVE: Tool/database con tariffe professionali per calcolo automatico

[105] SCENARIO: Utente chiede di redigere un verbale di riunione
ATTESO: Verbale strutturato con data, presenti, punti discussi, decisioni, azioni
ATTUALE: OK -- Claude genera verbali ben strutturati
PROBLEMA: Claude non ha i dettagli della riunione; l'utente deve fornirli
SERVE: Nulla

[106] SCENARIO: Utente inoltra una PEC e chiede "rispondi per me"
ATTESO: Risposta alla PEC con tono formale, riferimenti protocollo
ATTUALE: OK per il testo -- Claude genera la risposta. Ma non puo inviare la PEC
PROBLEMA: Nessuna integrazione con client PEC
SERVE: Integrazione PEC (complessa: richiede credenziali server SMTP PEC)

[107] SCENARIO: Utente chiede una lettera di messa in mora
ATTESO: Lettera legale con termini, importi, conseguenze
ATTUALE: Parziale -- Claude puo generare la struttura ma per una messa in mora serve revisione legale
PROBLEMA: Documento legale -- serve disclaimer
SERVE: Disclaimer "da verificare con legale" + template

### 3.2 Bandi e Gare

[108] SCENARIO: Utente carica un bando di gara (PDF) e chiede "possiamo partecipare?"
ATTESO: Analisi dei requisiti di partecipazione confrontati con quelli di Restruktura
ATTUALE: Parziale -- Claude legge il bando e analizza i requisiti. Ma non conosce tutti i requisiti di Restruktura (SOA, fatturato, esperienze) se non sono in memoria
PROBLEMA: Senza dati aziendali strutturati in memoria, l'analisi e generica
SERVE: Profilo aziendale strutturato in memoria (categorie SOA, fatturato, referenze, certificazioni)

[109] SCENARIO: Utente chiede di preparare la documentazione amministrativa per una gara
ATTESO: Checklist documenti + bozze dichiarazioni
ATTUALE: OK per le bozze -- Claude conosce la documentazione standard per gare
PROBLEMA: Dichiarazioni specifiche richiedono dati legali dell'azienda (casellario, DURC, antimafia)
SERVE: Template precompilati con dati Restruktura

[110] SCENARIO: Utente chiede "quanto offrire per questa gara?"
ATTESO: Analisi del computo di gara, calcolo dell'offerta con ribasso
ATTUALE: Parziale -- Claude puo analizzare il computo e suggerire un ribasso, ma la strategia di prezzo richiede conoscenza dei costi reali dell'impresa
PROBLEMA: Senza database costi interni, il suggerimento e generico
SERVE: Database costi interni Restruktura per analisi offerta competitiva

[111] SCENARIO: Utente chiede di compilare il DGUE (Documento di Gara Unico Europeo)
ATTESO: DGUE compilato con i dati di Restruktura
ATTUALE: Non funziona -- il DGUE e un modulo strutturato, Claude non puo compilare moduli
PROBLEMA: Modulo con campi specifici non compilabili da Claude
SERVE: Template DGUE pre-compilato con dati Restruktura; o parser/compiler del modulo

[112] SCENARIO: Utente chiede il cronoprogramma per l'offerta tecnica
ATTESO: Cronoprogramma Gantt con fasi, durate, dipendenze
ATTUALE: Parziale -- Claude puo descrivere le fasi e le durate in forma testuale/tabellare. Non puo generare un diagramma Gantt grafico
PROBLEMA: Nessuna generazione di diagrammi grafici
SERVE: Tool di generazione Gantt (libreria mermaid o simile) o integrazione con servizio esterno

### 3.3 Scadenze e Agenda

[113] SCENARIO: Utente dice "ricordami che il 15 aprile scade la presentazione dell'offerta per il Comune di Matera"
ATTESO: Scadenza salvata e promemoria il giorno prima
ATTUALE: Parziale -- Claude puo salvare l'informazione in memoria (embedding), ma non c'e un sistema di notifiche/promemoria attivo
PROBLEMA: Nessun scheduler di notifiche. La memoria RAG non viene interrogata proattivamente
SERVE: Tabella `scadenze` + cron job che controlla giornalmente e notifica via Telegram

[114] SCENARIO: Utente chiede "quali scadenze ho questa settimana?"
ATTESO: Lista scadenze con date e dettagli
ATTUALE: Non funziona -- nessun calendario/scadenze strutturato. La ricerca RAG potrebbe trovare messaggi con date, ma non filtra per data
PROBLEMA: Le scadenze non sono strutturate; sono sepolte come testo negli embedding
SERVE: Tabella `scadenze` con query per data range

[115] SCENARIO: Utente chiede "fissami un appuntamento con il geometra Rossi lunedi alle 10"
ATTESO: Evento creato nel calendario
ATTUALE: Non funziona -- nessuna integrazione calendario (Google Calendar, Outlook)
PROBLEMA: Nessun calendario
SERVE: Integrazione Google Calendar API

[116] SCENARIO: Utente chiede "sposta l'appuntamento di domani alle 15"
ATTESO: Appuntamento modificato
ATTUALE: Non funziona -- nessun calendario
PROBLEMA: Come sopra
SERVE: Come sopra

[117] SCENARIO: Utente chiede "mandami il riassunto della giornata alle 18"
ATTESO: Digest giornaliero automatico
ATTUALE: Non funziona -- c'e un file `digest.ts` nel codice ma nessun scheduler attivo
PROBLEMA: Nessun cron job/scheduler per task automatici
SERVE: Cron job + Telegram notification per digest giornaliero

### 3.4 Protocollo e Documentazione

[118] SCENARIO: Utente chiede di protocollare un documento in arrivo
ATTESO: Documento registrato con numero protocollo, data, mittente, oggetto
ATTUALE: Non funziona -- nessun sistema di protocollo
PROBLEMA: Protocollo documentale non implementato
SERVE: Tabella `protocollo` con numerazione automatica

[119] SCENARIO: Utente chiede "trova la lettera che abbiamo mandato al Comune il mese scorso"
ATTESO: Documento recuperato dalla memoria
ATTUALE: Parziale -- se la lettera e stata generata e salvata in memoria, la ricerca RAG potrebbe trovarla. Ma "il mese scorso" non e un filtro temporale supportato dalla search semantica
PROBLEMA: Nessun filtro temporale nella ricerca memoria
SERVE: Filtro data nella search_memory + indicizzazione documenti per data

[120] SCENARIO: Utente chiede di generare un numero di protocollo
ATTESO: Numero progressivo nel formato dell'azienda
ATTUALE: Non funziona -- nessun sistema di numerazione protocollo
PROBLEMA: Non implementato
SERVE: Counter in Supabase + formato configurabile

[121] SCENARIO: Utente chiede "mandami il DURC aggiornato"
ATTESO: DURC recuperato da archivio o istruzioni per richiederlo
ATTUALE: Non funziona -- nessun archivio documenti aziendali strutturato
PROBLEMA: Documenti aziendali non in database
SERVE: Archivio documenti aziendali su Supabase con categorizzazione

[122] SCENARIO: Utente chiede la scadenza del DURC
ATTESO: Data scadenza DURC di Restruktura
ATTUALE: Parziale -- se l'informazione e stata salvata in memoria, la RAG potrebbe trovarla
PROBLEMA: Dato non strutturato
SERVE: Profilo aziendale con scadenze documenti (DURC, SOA, visura, ecc.)

### 3.5 Comunicazioni Istituzionali

[123] SCENARIO: Utente chiede di scrivere una comunicazione al direttore dei lavori
ATTESO: Comunicazione formale con protocollo, oggetto, corpo
ATTUALE: OK -- Claude genera comunicazioni professionali
PROBLEMA: Senza dati del cantiere/progetto, deve chiederli
SERVE: Nulla

[124] SCENARIO: Utente chiede di redigere un ordine di servizio per il cantiere
ATTESO: Ordine di servizio numerato con disposizioni
ATTUALE: OK -- Claude conosce la struttura degli ordini di servizio
PROBLEMA: Nessuno per la generazione testo
SERVE: Numerazione automatica ordini di servizio

[125] SCENARIO: Utente chiede di scrivere una comunicazione alla ASL per notifica preliminare
ATTESO: Modulo notifica preliminare compilato
ATTUALE: Parziale -- Claude puo elencare i contenuti della notifica ma non compilare il modulo ufficiale
PROBLEMA: Modulo specifico da compilare
SERVE: Template notifica preliminare

[126] SCENARIO: Utente chiede "scrivi a tutti i subappaltatori che domani il cantiere e chiuso"
ATTESO: Email/messaggio inviato ai subappaltatori
ATTUALE: Non funziona per l'invio -- Claude genera il testo ma non puo inviare email
PROBLEMA: Nessuna integrazione email; nessun database contatti subappaltatori
SERVE: Database contatti + integrazione email (SendGrid, Resend)

[127] SCENARIO: Utente chiede una lettera di diffida al subappaltatore per ritardi
ATTESO: Lettera formale con contestazione e termini
ATTUALE: OK per il testo -- Claude genera lettere di diffida appropriate
PROBLEMA: Documento legale, serve revisione
SERVE: Disclaimer + template

[128] SCENARIO: Utente chiede di creare un report settimanale delle attivita
ATTESO: Report strutturato con attivita svolte, stato cantieri, prossimi step
ATTUALE: Parziale -- Claude puo generare la struttura ma non ha accesso ai dati delle attivita della settimana se non sono in memoria
PROBLEMA: Nessun tracking attivita
SERVE: Sistema di logging attivita + generazione report automatica

### 3.6 Traduzioni e Comunicazioni Multilingue

[129] SCENARIO: Utente chiede di tradurre una relazione tecnica in inglese
ATTESO: Traduzione professionale con terminologia tecnica corretta
ATTUALE: OK -- Claude traduce eccellentemente con terminologia tecnica
PROBLEMA: Nessuno
SERVE: Nulla

[130] SCENARIO: Utente riceve un'email in francese e chiede "cosa dice?"
ATTESO: Traduzione e riassunto in italiano
ATTUALE: OK -- Claude e multilingue
PROBLEMA: Nessuno
SERVE: Nulla

[131] SCENARIO: Utente chiede una lettera commerciale in tedesco per un fornitore
ATTESO: Lettera formale in tedesco
ATTUALE: OK -- Claude scrive bene in tedesco
PROBLEMA: Nessuno
SERVE: Nulla

[132] SCENARIO: Utente chiede di tradurre un certificato tecnico dal rumeno (operai stranieri)
ATTESO: Traduzione del certificato
ATTUALE: OK -- Claude traduce dal rumeno
PROBLEMA: Per uso legale potrebbe servire traduzione giurata
SERVE: Disclaimer "traduzione non giurata"

[133] SCENARIO: Utente chiede di preparare una comunicazione multilingue (italiano + inglese) per un progetto internazionale
ATTESO: Documento bilingue formattato
ATTUALE: OK -- Claude genera documenti bilingue
PROBLEMA: Nessuno
SERVE: Nulla

[134] SCENARIO: Utente chiede di redigere un contratto di appalto
ATTESO: Contratto completo con clausole standard
ATTUALE: Parziale -- Claude genera contratti ben strutturati ma per uso legale servono verifica avvocato
PROBLEMA: Documento legale
SERVE: Disclaimer + template approvato dal legale di Restruktura

[135] SCENARIO: Utente chiede di preparare il capitolato speciale d'appalto
ATTESO: Capitolato con articoli tecnici e amministrativi
ATTUALE: OK per la bozza -- Claude conosce la struttura dei capitolati
PROBLEMA: Il capitolato deve riflettere le specifiche tecniche del progetto
SERVE: Template capitolato personalizzabile

---

## CATEGORIA 4: FATTURAZIONE E CONTABILITA (30 scenari)

### 4.1 Fatture

[136] SCENARIO: Utente chiede "genera la fattura n. 15 per il Comune di Potenza, lavori di manutenzione, 25.000 euro"
ATTESO: Fattura HTML/PDF professionale con intestazione Restruktura, dati fiscali, importi
ATTUALE: Parziale -- Claude genera documenti con `~~~document` HTML. Ma non c'e un tool `genera_fattura` con numerazione automatica, calcolo IVA, ritenuta d'acconto, split payment
PROBLEMA: Calcoli fiscali (ritenuta 8% o 20%, split payment per PA, bollo) fatti dall'LLM sono a rischio errore
SERVE: Tool `genera_fattura` con calcoli fiscali precisi server-side

[137] SCENARIO: Utente chiede "qual e l'ultima fattura emessa?"
ATTESO: Numero e dettagli dell'ultima fattura
ATTUALE: Non funziona -- nessun database fatture
PROBLEMA: Fatture non tracciate nel sistema
SERVE: Tabella `fatture` su Supabase

[138] SCENARIO: Utente chiede di generare una fattura con split payment (per la PA)
ATTESO: Fattura con IVA esposta ma non incassata (split payment)
ATTUALE: Non funziona correttamente -- Claude potrebbe non applicare lo split payment correttamente senza un tool dedicato
PROBLEMA: Regole fiscali complesse
SERVE: Tool fattura con gestione split payment

[139] SCENARIO: Utente chiede "fattura con ritenuta d'acconto 20% per prestazione professionale"
ATTESO: Fattura con calcolo ritenuta d'acconto, netto a pagare
ATTUALE: Parziale -- Claude puo calcolare ma rischio errori su casistiche complesse
PROBLEMA: Calcoli fiscali a rischio
SERVE: Tool dedicato

[140] SCENARIO: Utente chiede la nota di credito per la fattura n. 12
ATTESO: Nota di credito che storna la fattura 12
ATTUALE: Non funziona -- nessun database fatture da cui recuperare i dati della fattura 12
PROBLEMA: Non c'e storico fatture
SERVE: Database fatture + tool nota di credito

[141] SCENARIO: Utente chiede "quante fatture ho emesso questo trimestre?"
ATTESO: Conteggio e totale
ATTUALE: Non funziona -- nessun database fatture
PROBLEMA: Nessun tracking
SERVE: Tabella fatture

[142] SCENARIO: Utente chiede di generare la fattura in formato XML per la fatturazione elettronica (SDI)
ATTESO: File XML conforme allo standard FatturaPA
ATTUALE: Non funziona -- nessun generatore XML FatturaPA
PROBLEMA: La fatturazione elettronica in Italia richiede XML specifico (versione 1.2)
SERVE: Generatore XML FatturaPA (complesso ma critico). Oppure integrazione con servizio di fatturazione (Aruba, Fatture in Cloud)

[143] SCENARIO: Utente chiede di registrare un pagamento ricevuto
ATTESO: Pagamento registrato associato alla fattura
ATTUALE: Non funziona -- nessun sistema di contabilita
PROBLEMA: Nessun tracking pagamenti
SERVE: Tabella `pagamenti` collegata a `fatture`

### 4.2 SAL e Contabilita Lavori

[144] SCENARIO: Utente chiede "prepara il SAL n. 2 per il cantiere di Via Roma"
ATTESO: SAL con voci eseguite, quantita, importi, detrazione garanzia
ATTUALE: Parziale -- Claude genera il documento ma senza dati reali del cantiere (contratto, voci, quantita gia contabilizzate) e un template
PROBLEMA: Nessun database cantieri/contratti con voci da contabilizzare
SERVE: Tabella `cantieri` + `contratti` + `voci_contratto` + `sal` su Supabase

[145] SCENARIO: Utente carica il computo del contratto e chiede "quanto manca da contabilizzare?"
ATTESO: Differenza tra importo contrattuale e gia fatturato
ATTUALE: Parziale -- Claude legge il computo ma senza storico SAL non puo calcolare il residuo
PROBLEMA: Nessuno storico contabilita
SERVE: Database contabilita lavori

[146] SCENARIO: Utente chiede il certificato di pagamento
ATTESO: Certificato formale del direttore dei lavori
ATTUALE: OK per il testo -- Claude genera il documento. Ma senza dati reali e un template
PROBLEMA: Mancano dati strutturati
SERVE: Database SAL + certificati

[147] SCENARIO: Utente chiede la contabilita finale dei lavori
ATTESO: Documento con tutti i SAL, varianti, somme totali
ATTUALE: Non funziona completamente -- richiede storico completo non disponibile
PROBLEMA: Nessun dato storico strutturato
SERVE: Sistema completo di contabilita lavori

[148] SCENARIO: Utente chiede "quanto ha incassato Restruktura questo mese?"
ATTESO: Totale incassi del mese
ATTUALE: Non funziona -- nessun dato contabile
PROBLEMA: Nessun tracking finanziario
SERVE: Database entrate/uscite o integrazione con software contabile

### 4.3 Budget e Analisi

[149] SCENARIO: Utente chiede l'analisi costi/ricavi per il cantiere di Potenza
ATTESO: Tabella con costi sostenuti, ricavi da SAL, margine
ATTUALE: Non funziona -- nessun dato finanziario per cantiere
PROBLEMA: Dati non disponibili
SERVE: Database costi per cantiere (manodopera, materiali, subappalti)

[150] SCENARIO: Utente chiede "siamo in budget per il cantiere di Matera?"
ATTESO: Confronto preventivo vs consuntivo
ATTUALE: Non funziona -- nessun tracking costi
PROBLEMA: Come sopra
SERVE: Come sopra

[151] SCENARIO: Utente chiede il cash flow previsto per i prossimi 3 mesi
ATTESO: Proiezione basata su fatture emesse, scadenze pagamento, costi previsti
ATTUALE: Non funziona -- nessun dato finanziario
PROBLEMA: Dati non disponibili
SERVE: Database finanziario + proiezioni

[152] SCENARIO: Utente chiede "quanto costa la manodopera nel cantiere X?"
ATTESO: Costo manodopera con dettaglio per operaio/settimana
ATTUALE: Non funziona -- nessun tracking presenze/costi manodopera
PROBLEMA: Dati non disponibili
SERVE: Integrazione con gestionale presenze o foglio ore

[153] SCENARIO: Utente chiede il confronto tra preventivo iniziale e costi reali
ATTESO: Tabella comparativa con scostamenti
ATTUALE: Non funziona senza dati reali
PROBLEMA: Mancano i dati dei costi reali
SERVE: Database costi reali

[154] SCENARIO: Utente chiede la redditivita per tipologia di lavoro (ristrutturazioni vs nuove costruzioni)
ATTESO: Analisi per categoria con margini
ATTUALE: Non funziona -- nessun dato storico categorizzato
PROBLEMA: Dati non disponibili
SERVE: Database storico lavori con categorizzazione e margini

[155] SCENARIO: Utente chiede di generare il registro IVA acquisti
ATTESO: Registro con fatture passive, importi, IVA detratta
ATTUALE: Non funziona -- nessun dato contabile
PROBLEMA: Contabilita non nel sistema
SERVE: Integrazione con gestionale contabile o tabella fatture passive

[156] SCENARIO: Utente chiede il calcolo delle imposte trimestrali (liquidazione IVA)
ATTESO: Calcolo IVA a debito - IVA a credito
ATTUALE: Non funziona -- nessun dato
PROBLEMA: Richiede tutti i dati contabili
SERVE: Integrazione gestionale

[157] SCENARIO: Utente chiede di preparare i dati per il commercialista
ATTESO: Riepilogo trimestrale con fatture attive/passive, pagamenti, scadenze
ATTUALE: Non funziona -- nessun dato strutturato
PROBLEMA: Dati finanziari non nel sistema
SERVE: Dashboard finanziaria

[158] SCENARIO: Utente chiede il preventivo dei costi per un nuovo cantiere
ATTESO: Budget dettagliato con manodopera, materiali, attrezzature, subappalti
ATTUALE: Parziale -- Claude puo generare un budget stimato, ma senza costi reali e una stima di massima
PROBLEMA: Senza database costi unitari reali dell'impresa
SERVE: Database costi unitari Restruktura (costo orario operai, costi materiali, noli)

[159] SCENARIO: Utente chiede il break-even point per un progetto
ATTESO: Analisi del punto di pareggio
ATTUALE: Parziale -- Claude conosce il concetto e puo calcolare se riceve i dati
PROBLEMA: Richiede input strutturato di costi fissi e variabili
SERVE: Tool di analisi finanziaria

[160] SCENARIO: Utente chiede la situazione debitoria dei clienti (scaduto)
ATTESO: Lista clienti con importi scaduti
ATTUALE: Non funziona -- nessun database crediti
PROBLEMA: Dati non disponibili
SERVE: Database fatture + pagamenti

[161] SCENARIO: Utente carica l'estratto conto bancario e chiede la riconciliazione
ATTESO: Matching tra movimenti bancari e fatture
ATTUALE: Non funziona -- nessun database fatture + nessun parser estratto conto
PROBLEMA: Doppia mancanza: parser + dati
SERVE: Parser estratto conto (PDF/CSV) + database fatture per matching

[162] SCENARIO: Utente chiede le ritenute a garanzia da incassare (svincolo 5%)
ATTESO: Lista cantieri con ritenute trattenute e importi da svincolare
ATTUALE: Non funziona -- nessun tracking ritenute
PROBLEMA: Dati non disponibili
SERVE: Tabella ritenute collegate ai SAL

[163] SCENARIO: Utente chiede di preparare una proposta di pagamento rateale per un cliente
ATTESO: Piano di rateizzazione con importi e scadenze
ATTUALE: OK -- Claude calcola le rate e genera il documento
PROBLEMA: Nessuno per il calcolo base
SERVE: Nulla

[164] SCENARIO: Utente chiede la simulazione del flusso di cassa con diverse ipotesi di incasso
ATTESO: Scenari what-if con proiezioni
ATTUALE: Parziale -- Claude puo ragionare sugli scenari se riceve i dati
PROBLEMA: Senza dati reali e un esercizio teorico
SERVE: Database finanziario per scenari realistici

[165] SCENARIO: Utente chiede il margine operativo lordo (EBITDA) dell'ultimo anno
ATTESO: Calcolo EBITDA da dati contabili
ATTUALE: Non funziona -- nessun dato contabile
PROBLEMA: Dati non disponibili
SERVE: Integrazione con gestionale contabile

---

## CATEGORIA 5: MARKETING (25 scenari)

### 5.1 Social Media

[166] SCENARIO: Utente chiede "scrivi un post per LinkedIn sui nostri lavori di ristrutturazione"
ATTESO: Post professionale con tone of voice aziendale
ATTUALE: OK -- Claude genera post LinkedIn eccellenti
PROBLEMA: Senza foto del cantiere il post e solo testo
SERVE: Nulla -- l'utente puo aggiungere foto manualmente

[167] SCENARIO: Utente chiede "scrivi 5 post per Instagram per questa settimana"
ATTESO: 5 post con caption, hashtag, suggerimento immagine
ATTUALE: OK -- Claude genera serie di post coerenti
PROBLEMA: Non puo pubblicare direttamente
SERVE: Integrazione Instagram API per pubblicazione diretta (complessa)

[168] SCENARIO: Utente carica foto del cantiere e chiede "crea un post social da questa foto"
ATTESO: Caption appropriata alla foto, con hashtag
ATTUALE: OK -- Claude analizza la foto e genera la caption pertinente
PROBLEMA: Nessuno
SERVE: Nulla

[169] SCENARIO: Utente chiede il piano editoriale per il mese
ATTESO: Calendario con argomenti, date, tipo contenuto per ogni piattaforma
ATTUALE: OK -- Claude genera piani editoriali dettagliati
PROBLEMA: Il piano viene generato come testo; non c'e integrazione con tool di scheduling
SERVE: Integrazione con Buffer/Hootsuite per scheduling; o almeno salvataggio strutturato

[170] SCENARIO: Utente chiede di scrivere un post tecnico sui ponteggi (PonteggioSicuro.it)
ATTESO: Articolo/post tecnico-divulgativo sui ponteggi
ATTUALE: OK -- Claude conosce il settore ponteggi (dalla memoria e dal system prompt)
PROBLEMA: Nessuno
SERVE: Nulla

### 5.2 Contenuti Web

[171] SCENARIO: Utente chiede "scrivi l'articolo per il blog di PonteggioSicuro.it sulla normativa ponteggi 2025"
ATTESO: Articolo SEO-friendly, 1000-1500 parole, con keyword target
ATTUALE: OK -- Claude scrive ottimi articoli tecnici SEO-oriented
PROBLEMA: Non puo pubblicare direttamente sul sito
SERVE: API per pubblicazione su PonteggioSicuro.it (se il CMS lo supporta)

[172] SCENARIO: Utente chiede di scrivere le meta description per 10 pagine del sito
ATTESO: 10 meta description ottimizzate con keyword
ATTUALE: OK -- Claude sa fare SEO on-page
PROBLEMA: Nessuno
SERVE: Nulla

[173] SCENARIO: Utente chiede di analizzare il sito di un concorrente
ATTESO: Analisi competitiva con punti di forza/debolezza
ATTUALE: Parziale -- Claude puo fare web search per trovare il sito e analizzarlo, ma non puo navigare il sito interattivamente
PROBLEMA: Web search restituisce snippet, non l'intera analisi del sito
SERVE: Tool di web scraping/analisi sito

[174] SCENARIO: Utente chiede keyword research per "noleggio ponteggi Basilicata"
ATTESO: Lista keyword con volumi di ricerca e difficolta
ATTUALE: Parziale -- Claude puo suggerire keyword basate su esperienza ma non ha dati reali di volume di ricerca
PROBLEMA: Senza API Google Keyword Planner, i volumi sono stime
SERVE: Integrazione con strumenti SEO (Semrush, Ahrefs) o Google Keyword Planner API

### 5.3 Presentazioni e Materiali

[175] SCENARIO: Utente chiede una presentazione aziendale per un cliente importante
ATTESO: Presentazione con slide strutturate (chi siamo, servizi, referenze, contatti)
ATTUALE: Parziale -- Claude genera il contenuto testuale di una presentazione. Ma non puo generare file PPTX ne slide grafiche
PROBLEMA: Nessuna generazione PPTX
SERVE: Libreria pptxgenjs per generazione PowerPoint server-side; o template pre-disegnato da riempire

[176] SCENARIO: Utente chiede la newsletter mensile per i clienti
ATTESO: Newsletter HTML con news, progetti, consigli tecnici
ATTUALE: OK per il contenuto -- Claude genera newsletter ben strutturate in HTML
PROBLEMA: Non puo inviarla; nessuna integrazione con servizio email marketing
SERVE: Integrazione con Mailchimp/SendGrid per invio newsletter

[177] SCENARIO: Utente chiede un brochure aziendale
ATTESO: Testo e struttura della brochure
ATTUALE: Parziale -- Claude genera il testo ma non il layout grafico
PROBLEMA: Nessuna generazione grafica
SERVE: Template brochure con design pre-fatto da popolare

[178] SCENARIO: Utente chiede di aggiornare il portfolio lavori
ATTESO: Portfolio aggiornato con nuovi progetti
ATTUALE: Parziale -- Claude puo redigere le descrizioni dei progetti. Ma senza database progetti strutturato, ogni volta parte da zero
PROBLEMA: Nessun database portfolio/referenze
SERVE: Tabella `portfolio_progetti` su Supabase

[179] SCENARIO: Utente chiede di preparare un video script per YouTube
ATTESO: Script con intro, contenuto, CTA, tempi
ATTUALE: OK -- Claude e eccellente nella scrittura di script video
PROBLEMA: Nessuno
SERVE: Nulla

[180] SCENARIO: Utente chiede i testi per un volantino/flyer
ATTESO: Testi concisi con USP, contatti, CTA
ATTUALE: OK -- Claude genera copy pubblicitari efficaci
PROBLEMA: Solo testo, nessun layout grafico
SERVE: Template flyer (Canva integration o simile)

[181] SCENARIO: Utente chiede di redigere una case study su un progetto completato
ATTESO: Case study professionale con problema, soluzione, risultati
ATTUALE: OK se l'utente fornisce i dati; Parziale se deve ricordare da memoria
PROBLEMA: Dati specifici del progetto potrebbero non essere in memoria
SERVE: Database progetti con dati strutturati

[182] SCENARIO: Utente chiede di scrivere una proposta commerciale per un nuovo cliente
ATTESO: Proposta con servizi, tariffe, referenze, tempi
ATTUALE: OK per il testo -- Claude genera proposte commerciali convincenti
PROBLEMA: Tariffe specifiche non in memoria
SERVE: Listino servizi Restruktura in database

[183] SCENARIO: Utente chiede "come migliorare il SEO di PonteggioSicuro.it?"
ATTESO: Audit SEO con suggerimenti concreti
ATTUALE: Parziale -- Claude puo dare consigli generali e fare web search. Ma un audit SEO completo richiede analisi del codice e delle performance
PROBLEMA: Nessun accesso diretto al sito per analisi tecnica
SERVE: Tool di analisi SEO (Lighthouse, PageSpeed API)

[184] SCENARIO: Utente chiede di creare un QR code per il sito
ATTESO: QR code generato come immagine
ATTUALE: Non funziona -- Claude non genera immagini
PROBLEMA: Nessuna generazione immagini
SERVE: Libreria qrcode per Node.js (banale da implementare)

[185] SCENARIO: Utente chiede le statistiche social media
ATTESO: Analytics di engagement, reach, follower
ATTUALE: Non funziona -- nessuna integrazione social analytics
PROBLEMA: Nessun accesso a dati social
SERVE: Integrazione API social (LinkedIn, Instagram, Facebook)

[186] SCENARIO: Utente chiede di analizzare le recensioni Google dell'azienda
ATTESO: Analisi sentiment e suggerimenti
ATTUALE: Parziale -- web search puo trovare le recensioni, ma l'analisi strutturata richiede API Google Business
PROBLEMA: Accesso limitato via web search
SERVE: Google Business Profile API

[187] SCENARIO: Utente chiede di rispondere a una recensione negativa
ATTESO: Risposta professionale, empatica ma ferma
ATTUALE: OK -- Claude e eccellente nel gestire tone of voice in situazioni delicate
PROBLEMA: Non puo pubblicare la risposta
SERVE: Integrazione Google Business per pubblicare risposte

[188] SCENARIO: Utente chiede un comunicato stampa per l'inaugurazione di un progetto
ATTESO: Comunicato stampa formale con virgolettati, dati, contatti
ATTUALE: OK -- Claude scrive ottimi comunicati stampa
PROBLEMA: Nessuno
SERVE: Nulla

[189] SCENARIO: Utente chiede di monitorare menzioni online di Restruktura
ATTESO: Alert su nuove menzioni
ATTUALE: Non funziona -- nessun monitoraggio web
PROBLEMA: Nessun crawler/alert
SERVE: Integrazione con Google Alerts API o servizio di monitoring

[190] SCENARIO: Utente chiede la strategia marketing per il prossimo trimestre
ATTESO: Piano strategico con obiettivi, canali, budget, KPI
ATTUALE: OK -- Claude genera strategie marketing complete
PROBLEMA: Senza dati storici di performance, la strategia e generica
SERVE: Database storico KPI marketing

---

## CATEGORIA 6: CANTIERI (35 scenari)

### 6.1 Gestione Sopralluoghi

[191] SCENARIO: Utente dice "domani sopralluogo a Potenza, Via Roma 15 -- preparami la checklist"
ATTESO: Checklist sopralluogo personalizzata per tipo intervento
ATTUALE: OK -- Claude genera checklist dettagliate
PROBLEMA: Senza sapere il tipo di intervento previsto, la checklist e generica
SERVE: Nulla di urgente -- Claude chiede i dettagli

[192] SCENARIO: Dopo il sopralluogo, utente invia 10 foto e un vocale con le note
ATTESO: Report sopralluogo generato dalle foto e dal vocale
ATTUALE: Parziale -- via web app funziona con foto singola + testo. Via Telegram, 10 foto = 10 chiamate separate (problema batch). Il vocale viene trascritto
PROBLEMA: Nessun batching foto; nessuna generazione report aggregato da input multipli
SERVE: Funzione "report sopralluogo" che raccoglie N foto + note e genera un unico report

[193] SCENARIO: Utente chiede di confrontare le foto del sopralluogo di oggi con quelle di 3 mesi fa
ATTESO: Confronto visivo con note sulle differenze
ATTUALE: Non funziona -- le foto precedenti non sono in memoria recuperabile. La ricerca RAG trova solo il testo del report, non le foto originali
PROBLEMA: Le immagini non vengono salvate/indicizzate per recupero futuro
SERVE: Archivio foto con metadata (cantiere, data, posizione) + retrieval per confronto temporale

### 6.2 Report Cantiere

[194] SCENARIO: Utente chiede il report giornaliero di cantiere
ATTESO: Report con meteo, presenze, lavorazioni eseguite, materiali, note
ATTUALE: Parziale -- Claude genera il template. Ma senza dati reali (presenze, meteo) e un modello vuoto
PROBLEMA: Nessun input automatico di dati di cantiere
SERVE: Form input dati cantiere + API meteo per dati automatici + database presenze

[195] SCENARIO: Utente compila il giornale dei lavori via chat
ATTESO: Registrazione strutturata della voce nel giornale
ATTUALE: Parziale -- Claude registra le informazioni in memoria come testo, ma non come dati strutturati del giornale
PROBLEMA: Il giornale dei lavori e un documento ufficiale con formato preciso
SERVE: Tabella `giornale_lavori` con campi strutturati (data, lavorazioni, operai, materiali, note)

[196] SCENARIO: Utente chiede il report settimanale aggregato del cantiere
ATTESO: Report con riepilogo attivita settimanali, avanzamento, problemi
ATTUALE: Parziale -- se i report giornalieri sono in memoria, Claude puo aggregarli. Ma la ricerca RAG potrebbe non trovare tutti i 7 report della settimana
PROBLEMA: Ricerca RAG con limit 30 potrebbe non restituire tutti i report giornalieri
SERVE: Query strutturata per cantiere+settimana

[197] SCENARIO: Utente chiede lo stato avanzamento percentuale del cantiere
ATTESO: Percentuale di avanzamento basata su computo e lavorazioni eseguite
ATTUALE: Non funziona -- nessun tracking avanzamento strutturato
PROBLEMA: Mancano dati di avanzamento
SERVE: Database avanzamento lavori per voce di computo

### 6.3 Foto e Analisi Visiva

[198] SCENARIO: Utente invia foto del ponteggio montato e chiede verifica di conformita
ATTESO: Analisi visiva con check: ancoraggi, parapetti, sottoponte, accessi, tavole fermapiede
ATTUALE: OK -- Claude vision analizza bene i ponteggi e identifica problemi visibili
PROBLEMA: Verifica da foto non sostituisce il controllo fisico. Angoli morti non visibili
SERVE: Checklist visiva specifica per ponteggi PonteggioSicuro.it

[199] SCENARIO: Utente invia foto prima/dopo di un intervento
ATTESO: Descrizione delle differenze e dell'intervento eseguito
ATTUALE: Parziale -- Claude puo analizzare una foto alla volta. Due foto nella stessa richiesta funzionano sulla web app (content blocks multipli) ma non facilmente su Telegram
PROBLEMA: Telegram: ogni foto e un messaggio separato
SERVE: Upload multiplo nella stessa richiesta + confronto

[200] SCENARIO: Utente invia foto di un danno strutturale e chiede la classificazione
ATTESO: Classificazione del danno (superficiale/strutturale), causa probabile, intervento suggerito
ATTUALE: OK -- Claude vision e buono nell'analisi di patologie edilizie da foto
PROBLEMA: Non puo misurare, solo classificare qualitativamente
SERVE: Nulla -- e un supporto alla valutazione del tecnico

[201] SCENARIO: Utente chiede di generare un report fotografico del cantiere con 20 foto
ATTESO: Report con foto numerate, didascalie, commenti tecnici
ATTUALE: Non funziona come documento -- Claude puo commentare le foto singolarmente ma non generare un report con le immagini embedded. Il formato HTML/PDF generato non include immagini
PROBLEMA: Le immagini non vengono incluse nei documenti generati
SERVE: Tool di generazione report fotografico con immagini embedded (HTML con base64 o link)

### 6.4 Gestione Subappaltatori

[202] SCENARIO: Utente chiede "crea un database dei nostri subappaltatori"
ATTESO: Tabella strutturata con nome, specializzazione, contatti, valutazione
ATTUALE: Non funziona -- nessun database fornitori/subappaltatori
PROBLEMA: Nessuna struttura dati per gestione fornitori
SERVE: Tabella `subappaltatori` su Supabase

[203] SCENARIO: Utente chiede "chi e il miglior elettricista che abbiamo usato?"
ATTESO: Risposta basata su storico collaborazioni e valutazioni
ATTUALE: Parziale -- se l'informazione e in memoria (da conversazioni precedenti), la RAG potrebbe trovarla
PROBLEMA: Nessuna valutazione strutturata
SERVE: Database subappaltatori con rating/note

[204] SCENARIO: Utente chiede di inviare la richiesta di preventivo a 3 imprese
ATTESO: Email personalizzata inviata a ciascuna impresa
ATTUALE: Non funziona per l'invio -- Claude genera i testi ma non puo inviare email
PROBLEMA: Nessuna integrazione email
SERVE: Database contatti + integrazione email

[205] SCENARIO: Utente chiede il confronto tra 3 preventivi ricevuti (caricati come PDF)
ATTESO: Tabella comparativa voce per voce
ATTUALE: Parziale -- Claude puo leggere i 3 PDF (se caricati sulla web app) e fare un confronto. Ma con 3 PDF grandi il costo API e alto
PROBLEMA: Costo API elevato per analisi multipla di PDF
SERVE: Ottimizzazione: estrarre solo le tabelle dei prezzi

[206] SCENARIO: Utente chiede di verificare la regolarita contributiva del subappaltatore
ATTESO: Verifica DURC e documentazione
ATTUALE: Non funziona -- nessun accesso a portali INPS/INAIL
PROBLEMA: Verifica DURC richiede accesso ai portali istituzionali
SERVE: Checklist manuale + promemoria scadenze

### 6.5 Sicurezza Cantiere

[207] SCENARIO: Utente segnala un quasi-infortunio in cantiere
ATTESO: Registrazione dell'evento, analisi cause, azioni correttive
ATTUALE: Parziale -- Claude registra l'informazione in memoria e suggerisce azioni. Ma non c'e un registro infortuni strutturato
PROBLEMA: Il registro quasi-infortuni e obbligatorio. Serve formato specifico
SERVE: Tabella `registro_infortuni` con campi obbligatori

[208] SCENARIO: Utente chiede la verifica dei DPI per il cantiere
ATTESO: Checklist DPI per tipo di lavorazione
ATTUALE: OK -- Claude genera checklist DPI dettagliate per tipo di attivita
PROBLEMA: Nessuno
SERVE: Template checklist DPI

[209] SCENARIO: Utente chiede il programma di formazione sicurezza per i nuovi operai
ATTESO: Piano formativo con moduli, durate, attestati necessari
ATTUALE: OK -- Claude conosce la normativa formativa (Accordo Stato-Regioni)
PROBLEMA: Nessun tracking attestati/scadenze
SERVE: Database attestati formativi con scadenze

[210] SCENARIO: Utente chiede le verifiche periodiche delle attrezzature di cantiere
ATTESO: Scadenzario verifiche con date e responsabili
ATTUALE: Parziale -- Claude genera lo scadenzario se riceve i dati. Ma non c'e un sistema di tracking
PROBLEMA: Nessun database attrezzature
SERVE: Tabella `attrezzature` con scadenze verifiche

### 6.6 Diario Lavori

[211] SCENARIO: Utente dice "oggi al cantiere di Potenza: getto fondazioni completato, 6 operai, sereno"
ATTESO: Voce del diario lavori registrata con data, cantiere, lavorazione, presenze, meteo
ATTUALE: Parziale -- l'informazione viene salvata come embedding testuale. Non e strutturata come voce di diario
PROBLEMA: Il diario lavori e un documento legale con formato specifico. Salvarlo come testo RAG non e sufficiente
SERVE: Tabella `diario_lavori` + tool di registrazione strutturata

[212] SCENARIO: Utente chiede di stampare il diario lavori del mese
ATTESO: Documento formale con tutte le voci del mese
ATTUALE: Non funziona -- le voci non sono strutturate per estrazione e formattazione
PROBLEMA: Dati non strutturati
SERVE: Database + generatore documento diario lavori

[213] SCENARIO: Utente chiede di registrare una variante in corso d'opera
ATTESO: Registrazione variante con motivazione, voci modificate, importo
ATTUALE: Parziale -- Claude registra l'informazione ma non in forma strutturata
PROBLEMA: Varianti hanno implicazioni contrattuali/contabili
SERVE: Tabella `varianti` collegata al cantiere

[214] SCENARIO: Utente chiede la pianificazione settimanale del cantiere
ATTESO: Planning con attivita, squadre, materiali necessari
ATTUALE: OK -- Claude genera planning dettagliati se riceve le informazioni sul cantiere
PROBLEMA: Senza storico e risorse note, il planning e generico
SERVE: Database risorse (operai, mezzi) + planning tool

[215] SCENARIO: Utente chiede il report meteo per la settimana prossima (per pianificare il cantiere)
ATTESO: Previsioni meteo per la localita del cantiere
ATTUALE: Parziale -- web search puo trovare previsioni meteo generiche
PROBLEMA: Web search non e lo strumento ideale per dati meteo strutturati
SERVE: API meteo (OpenWeatherMap, free tier disponibile) per dati precisi

[216] SCENARIO: Utente chiede di tracciare la consegna materiali al cantiere
ATTESO: Registrazione DDT con materiale, quantita, fornitore, data
ATTUALE: Non funziona -- nessun tracking materiali
PROBLEMA: Nessun database materiali/DDT
SERVE: Tabella `consegne_materiali` con dati DDT

[217] SCENARIO: Utente chiede quanto materiale (cemento, acciaio) serve per completare il cantiere
ATTESO: Calcolo basato su computo e quantita gia utilizzate
ATTUALE: Non funziona -- nessun tracking materiali utilizzati vs computo
PROBLEMA: Dati non disponibili
SERVE: Database materiali per cantiere con tracking consumo

[218] SCENARIO: Utente segnala un fermo cantiere per pioggia
ATTESO: Registrazione fermo con data, causa, cantiere
ATTUALE: Parziale -- salvato in memoria come testo
PROBLEMA: Non strutturato
SERVE: Tabella `eventi_cantiere` (fermi, sospensioni, riprese)

[219] SCENARIO: Utente chiede le ore lavorate questa settimana nel cantiere X
ATTESO: Riepilogo ore per operaio
ATTUALE: Non funziona -- nessun tracking presenze
PROBLEMA: Dati non disponibili
SERVE: Sistema presenze (anche semplice: input giornaliero via chat)

[220] SCENARIO: Utente chiede di calcolare la penale per ritardo consegna (cantiere in ritardo di 15 giorni)
ATTESO: Calcolo penale basato su clausola contrattuale
ATTUALE: Parziale -- Claude calcola se riceve i parametri (penale giornaliera, importo contratto)
PROBLEMA: Senza accesso al contratto, i dati devono essere forniti manualmente
SERVE: Database contratti per lookup automatico clausole

[221] SCENARIO: Utente chiede la lista dei materiali approvati per il cantiere
ATTESO: Lista materiali con specifiche e fornitori approvati
ATTUALE: Non funziona -- nessun database materiali approvati
PROBLEMA: Dati non disponibili
SERVE: Database materiali per cantiere

[222] SCENARIO: Utente chiede di generare l'ordine d'acquisto per un fornitore
ATTESO: Ordine d'acquisto formale con voci, quantita, prezzi
ATTUALE: Parziale -- Claude genera il documento ma senza verifica budget/giacenze
PROBLEMA: Nessun controllo budget
SERVE: Database ordini + budget cantiere

[223] SCENARIO: Utente chiede la situazione di tutti i cantieri attivi
ATTESO: Dashboard con stato, avanzamento, criticita di ogni cantiere
ATTUALE: Non funziona -- nessun database cantieri strutturato
PROBLEMA: Dati non centralizzati
SERVE: Tabella `cantieri` con stato, date, avanzamento

[224] SCENARIO: Utente chiede i KPI di performance del cantiere (produttivita, costo orario, margine)
ATTESO: Dashboard KPI
ATTUALE: Non funziona -- nessun dato di performance
PROBLEMA: Dati non disponibili
SERVE: Sistema completo di tracking cantiere

[225] SCENARIO: Utente chiede di pianificare la logistica per un trasporto eccezionale (ponteggio)
ATTESO: Piano logistico con mezzi, percorso, permessi
ATTUALE: Parziale -- Claude puo ragionare sulla logistica ma senza dati reali (flotta, percorsi) e generico
PROBLEMA: Nessun database mezzi/logistica
SERVE: Database flotta aziendale + tool pianificazione trasporti

---

## CATEGORIA 7: APPRENDIMENTO REGOLE (20 scenari)

[226] SCENARIO: Utente dice "da oggi in poi, tutti i preventivi devono avere il margine minimo del 20%"
ATTESO: Regola salvata e applicata a tutti i futuri preventivi
ATTUALE: Parziale -- l'informazione viene salvata come embedding testuale. Potrebbe essere recuperata dalla RAG per le prossime richieste, ma NON e garantito
PROBLEMA: Le regole business non sono salvate in modo strutturato. La RAG con threshold 0.40 potrebbe non recuperare la regola se la query futura non e semanticamente vicina
SERVE: Tabella `regole_business` con regole esplicite che vengono SEMPRE caricate nel system prompt

[227] SCENARIO: Utente dice "il margine minimo e 25%" (contraddice la regola precedente del 20%)
ATTESO: Aggiornamento della regola, non duplicazione
ATTUALE: Non funziona -- viene creato un nuovo embedding che coesiste con quello vecchio. Claude potrebbe trovare entrambi e non sapere quale e piu recente
PROBLEMA: Nessun meccanismo di versioning/sovrascrittura delle regole
SERVE: Tabella regole con campo `updated_at` + logica di sovrascrittura

[228] SCENARIO: Utente dice "per il cliente Rossi, applichiamo sempre lo sconto del 10%"
ATTESO: Regola specifica per cliente salvata e applicata automaticamente
ATTUALE: Parziale -- salvata come embedding, potrebbe essere recuperata quando si parla del cliente Rossi. Ma non e garantito
PROBLEMA: Regole per-cliente non strutturate
SERVE: Tabella `regole_clienti` o campo in tabella `clienti`

[229] SCENARIO: Utente dice "i documenti devono avere il font Arial 11, margini 2.5cm"
ATTESO: Formato applicato a tutti i documenti futuri
ATTUALE: Non funziona -- i documenti HTML generati da Claude non sono controllabili a livello di CSS dal system prompt. I documenti DOCX/PDF hanno formattazione hardcoded nel codice
PROBLEMA: Le preferenze di formattazione non sono configurabili a runtime
SERVE: Configurazione formattazione documenti in database + applicazione nel tool di generazione

[230] SCENARIO: Utente insegna una formula di calcolo personalizzata
ATTESO: Formula salvata e usata nei calcoli futuri
ATTUALE: Parziale -- la formula viene salvata come embedding. Claude potrebbe usarla ma potrebbe anche sbagliare ad applicarla (e un LLM, non un computer algebra system)
PROBLEMA: Formule matematiche richiedono esecuzione esatta, non approssimata
SERVE: Salvare formule come tool eseguibili, non come testo

[231] SCENARIO: Utente dice "quando prepari un POS, includi sempre la sezione ponteggi PonteggioSicuro"
ATTESO: Template POS aggiornato con sezione ponteggi
ATTUALE: Parziale -- l'istruzione viene salvata in memoria. Se recuperata dalla RAG, Claude la seguira
PROBLEMA: Non garantito il recupero. La RAG e probabilistica
SERVE: Regole obbligatorie nel system prompt (tabella regole -> system prompt dinamico)

[232] SCENARIO: Utente dice "non mandare mai preventivi sotto i 5.000 euro senza la mia approvazione"
ATTESO: Workflow di approvazione per preventivi sotto soglia
ATTUALE: Non funziona -- nessun sistema di workflow/approvazione. Claude genererebbe il preventivo comunque
PROBLEMA: Nessun meccanismo di gating/approvazione
SERVE: Sistema di regole con azioni (avviso, blocco, approvazione)

[233] SCENARIO: Utente insegna una regola su come gestire le richieste di un cliente specifico (es. "Il Comune di Potenza vuole sempre il computo in formato Excel")
ATTESO: Regola applicata automaticamente per quel cliente
ATTUALE: Parziale -- se salvata in memoria e recuperata dalla RAG, funziona
PROBLEMA: Recupero non garantito
SERVE: Regole per-cliente strutturate

[234] SCENARIO: Utente dice "d'ora in poi rispondimi in modo piu sintetico"
ATTESO: Stile di risposta aggiornato permanentemente
ATTUALE: Parziale -- per la sessione corrente funziona (Claude adatta il tono). Ma in una nuova conversazione, la regola potrebbe non essere recuperata
PROBLEMA: Preferenze di stile non persistono in modo affidabile
SERVE: Profilo preferenze utente nel system prompt

[235] SCENARIO: Dopo 3 settimane, utente chiede un preventivo per il cliente Rossi
ATTESO: Lo sconto del 10% viene applicato automaticamente (regola del [228])
ATTUALE: Non funziona con affidabilita -- la RAG potrebbe trovare l'embedding con la regola dello sconto, ma potrebbe anche non trovarlo. Dipende dalla query e dal threshold
PROBLEMA: La persistenza delle regole e probabilistica, non deterministica
SERVE: Sistema di regole deterministiche caricate SEMPRE nel context

[236] SCENARIO: Utente crea 50 regole diverse nel corso di 6 mesi
ATTESO: Tutte le 50 regole attive e rispettate
ATTUALE: Non funziona -- 50 regole come embedding vengono diluite nel database. La RAG con limit 30 ne recupera al massimo una manciata, e quelle rilevanti per la query specifica
PROBLEMA: Scalabilita delle regole in un sistema RAG non e adeguata
SERVE: Tabella regole con caricamento completo nel system prompt (o almeno le top-20 piu importanti)

[237] SCENARIO: Utente chiede "quali regole ti ho insegnato?"
ATTESO: Lista completa di tutte le regole attive
ATTUALE: Non funziona -- le regole sono sepolte come embedding eterogenei. Non c'e modo di elencarle tutte
PROBLEMA: Nessun indice delle regole
SERVE: Tabella `regole` con CRUD + endpoint lista

[238] SCENARIO: Utente chiede di eliminare una regola
ATTESO: Regola cancellata, non piu applicata
ATTUALE: Non funziona -- gli embedding non sono cancellabili per contenuto specifico facilmente
PROBLEMA: Nessun meccanismo di cancellazione regole
SERVE: Tabella regole con soft delete

[239] SCENARIO: Utente insegna una sigla/abbreviazione specifica dell'azienda (es. "PdC = Permesso di Costruire")
ATTESO: Sigla compresa e usata correttamente in futuro
ATTUALE: Parziale -- Claude gia conosce le sigle edilizie standard. Per sigle custom aziendali, la RAG potrebbe trovarle
PROBLEMA: Sigle custom non garantite nel recupero
SERVE: Glossario aziendale nel system prompt

[240] SCENARIO: Utente dice "usa sempre i prezzi del 2025, non del 2024"
ATTESO: Ricerche prezziario filtrate per anno 2025
ATTUALE: Parziale -- il database prezziario ha il file 2025 (`prezziario_basilicata_2025.ods`). Ma la regola dell'anno non e enforced nel tool
PROBLEMA: Il tool `cercaPrezziario` potrebbe restituire prezzi di qualsiasi anno
SERVE: Filtro anno nel tool prezziario

[241] SCENARIO: Utente insegna un workflow complesso ("per ogni nuovo cantiere, prima checklist sicurezza, poi nomina CSE, poi notifica preliminare")
ATTESO: Workflow eseguito step-by-step per ogni nuovo cantiere
ATTUALE: Non funziona -- nessun motore di workflow. Claude potrebbe ricordare il workflow se la RAG lo recupera, ma non lo esegue automaticamente
PROBLEMA: Workflow multi-step non supportati
SERVE: Sistema di workflow/checklist con step tracciabili

[242] SCENARIO: Utente imposta le tariffe orarie differenziate (operaio semplice 28 EUR/h, specializzato 35 EUR/h, capo cantiere 42 EUR/h)
ATTESO: Tariffe usate correttamente in tutti i calcoli futuri
ATTUALE: Non funziona in modo affidabile -- le tariffe come embedding non sono recuperate con certezza
PROBLEMA: Dati numerici precisi nel sistema RAG sono fragili
SERVE: Tabella `tariffe` con tipi e importi

[243] SCENARIO: Utente dice "il nostro logo va sempre in alto a destra nei documenti"
ATTESO: Logo posizionato correttamente in tutti i documenti generati
ATTUALE: Non funziona -- il logo nei documenti HTML dipende dal CSS generato da Claude, che non e controllabile via regole salvate. Nei DOCX/PDF generati dal tool non c'e logo
PROBLEMA: Formattazione documenti non personalizzabile via regole utente
SERVE: Template documento con logo configurabile + preferenze di layout

[244] SCENARIO: Due regole contraddicono (una dice "margine 15%", l'altra "margine 20%")
ATTESO: Cervellone segnala la contraddizione e chiede chiarimento
ATTUALE: Non funziona -- entrambi gli embedding esistono. Claude potrebbe usare uno o l'altro casualmente
PROBLEMA: Nessun conflict detection
SERVE: Sistema regole con validazione contraddizioni

[245] SCENARIO: Utente dice "dimentica tutto quello che sai sul cliente Rossi"
ATTESO: Tutte le informazioni sul cliente Rossi vengono rimosse
ATTUALE: Non funziona -- non c'e modo di cancellare embedding selettivamente per soggetto
PROBLEMA: No selective deletion nella memoria
SERVE: Metadata su embedding (cliente, progetto) + cancellazione per metadata

---

## CATEGORIA 8: STRESS TEST E EDGE CASE (35 scenari)

### 8.1 Limiti di Volume

[246] SCENARIO: 100 messaggi in un giorno via Telegram
ATTESO: Tutti gestiti senza problemi
ATTUALE: Parziale -- tecnicamente funziona, ma 100 messaggi * ~$0.05-0.20 ciascuno = $5-20 in un giorno. Con $13 rimasti nel mese, si rischia il credit limit in 1-2 giorni
PROBLEMA: Budget API insufficiente per uso intensivo
SERVE: Rate limiting per budget giornaliero; dashboard costi

[247] SCENARIO: 10 utenti scrivono contemporaneamente (scenario futuro multi-utente)
ATTESO: Tutte le richieste gestite in parallelo
ATTUALE: OK per l'infrastruttura -- Vercel Pro gestisce richieste parallele. Ma il budget API e il collo di bottiglia
PROBLEMA: Budget condiviso tra tutti gli utenti
SERVE: Budget per utente; rate limiting per utente

[248] SCENARIO: Utente manda 10 file contemporaneamente dalla web app
ATTESO: Tutti i file analizzati
ATTUALE: Parziale -- ogni file viene uploadato separatamente. Il messaggio alla chat contiene 10 `[FILE_URL:...]` blocks. Il codice li processa tutti (il loop c'e), ma 10 download + 10 conversioni base64 + invio a Claude = molto lento
PROBLEMA: Timeout 300s potrebbe non bastare per 10 file grandi. Costo API enorme
SERVE: Processing asincrono con notifica al completamento

[249] SCENARIO: File da 20MB caricato dalla web app
ATTESO: File analizzato
ATTUALE: Parziale -- 20MB in base64 = ~27MB. L'API Anthropic accetta fino a 32MB per messaggio. Potrebbe passare ma e al limite
PROBLEMA: Prossimo al limite API; tempo di elaborazione lungo
SERVE: Chunking per file grandi o estrazione testo pre-invio

[250] SCENARIO: File da 50MB
ATTESO: Messaggio "file troppo grande" chiaro
ATTUALE: Parziale -- Supabase Storage ha limiti configurabili. Se il limite e impostato a 50MB, l'upload funziona ma la conversione base64 (67MB) supera il limite API
PROBLEMA: Nessun check dimensione pre-elaborazione chiaro
SERVE: Check dimensione con messaggio utente prima dell'upload; limite ragionevole (es. 25MB)

### 8.2 Limiti API

[251] SCENARIO: Rate limit Anthropic (429 Too Many Requests)
ATTESO: Retry automatico con backoff
ATTUALE: Non funziona -- il catch nel codice cattura l'errore e lo mostra all'utente come messaggio generico. Nessun retry
PROBLEMA: Nessun retry automatico
SERVE: Retry con exponential backoff (2-3 tentativi)

[252] SCENARIO: Crediti API Anthropic esauriti ($0 balance)
ATTESO: Messaggio chiaro "crediti esauriti, contattare amministratore"
ATTUALE: Parziale -- nel Telegram handler c'e un check per `credit`/`billing`/`usage limit` nel messaggio di errore. Ma il messaggio e generico
PROBLEMA: L'utente potrebbe non capire il problema
SERVE: Dashboard budget con alerting; messaggio utente specifico

[253] SCENARIO: OpenAI embeddings API down (servizio non disponibile)
ATTESO: Il sistema continua a funzionare senza memoria
ATTUALE: OK -- il codice ha fallback: se `generateEmbedding` ritorna `[]`, il messaggio viene salvato senza embedding e la ricerca memoria ritorna stringa vuota. Il sistema funziona senza RAG
PROBLEMA: Nessuno critico -- e un graceful degradation corretto
SERVE: Nulla -- il fallback e gia implementato

[254] SCENARIO: Supabase database down
ATTESO: Il sistema segnala il problema
ATTUALE: Parziale -- il chat handler ha try/catch per il salvataggio messaggi. Ma se anche la lettura messaggi fallisce, il sistema crasha
PROBLEMA: Non tutti i path hanno gestione errore Supabase
SERVE: Circuit breaker per Supabase; cache locale temporanea

[255] SCENARIO: Vercel function timeout (300s superato)
ATTESO: Messaggio "operazione troppo lunga, riprova"
ATTUALE: Parziale -- Vercel restituisce 504 Gateway Timeout. L'utente vede un errore generico
PROBLEMA: UX di errore scarsa per timeout
SERVE: Messaggio timeout user-friendly; per operazioni lunghe, processing asincrono

### 8.3 Conversazioni Lunghe

[256] SCENARIO: Conversazione con 50+ messaggi
ATTESO: Il sistema gestisce il context window senza problemi
ATTUALE: OK -- il safeguard `MAX_CONTEXT_CHARS = 500000` tronca i messaggi vecchi. Il sistema funziona ma perde contesto
PROBLEMA: L'utente potrebbe non sapere che i messaggi vecchi sono stati troncati. Riferimenti a messaggi precedenti non piu in context falliranno
SERVE: Messaggio "contesto troncato" + summary dei messaggi rimossi

[257] SCENARIO: Conversazione Telegram con 30 messaggi (ma il codice carica solo gli ultimi 20)
ATTESO: Contesto sufficiente
ATTUALE: Parziale -- il bot Telegram carica solo 20 messaggi recenti dal database. Messaggi precedenti persi
PROBLEMA: Con 20 messaggi il contesto potrebbe essere sufficiente per la maggior parte dei casi, ma non per conversazioni complesse
SERVE: Summary automatico dei messaggi piu vecchi (compressione contesto)

[258] SCENARIO: Utente riprende una conversazione web dopo 3 giorni
ATTESO: Il contesto e intatto
ATTUALE: OK -- tutti i messaggi sono salvati in Supabase e ricaricati. Il safeguard li tronca solo se superano 500k chars
PROBLEMA: Nessuno per il contesto. Ma i FILE_URL con URL firmati (24h) saranno scaduti
SERVE: Fix URL firmati (vedi scenario 44)

### 8.4 Input Inaspettati

[259] SCENARIO: Utente scrive in inglese
ATTESO: Risposta in italiano (system prompt dice "rispondi in italiano")
ATTUALE: OK -- Claude risponde in italiano anche se la domanda e in inglese, grazie al system prompt
PROBLEMA: Nessuno
SERVE: Nulla

[260] SCENARIO: Utente fa una domanda completamente fuori tema (es. "qual e la capitale della Mongolia?")
ATTESO: Risposta cortese ma redirect al ruolo (coordinatore Restruktura)
ATTUALE: Parziale -- Claude risponde alla domanda perche il system prompt dice "fai tutto come su claude.ai". Potrebbe rispondere alla domanda generica senza redirectare
PROBLEMA: Il system prompt non limita Claude a domande aziendali
SERVE: Opzionale: guardrail che ridirigono a temi aziendali (ma potrebbe essere troppo restrittivo)

[261] SCENARIO: Utente fa una richiesta ambigua ("manda la cosa a quello")
ATTESO: Cervellone chiede chiarimenti
ATTUALE: OK -- Claude chiede chiarimenti per richieste ambigue
PROBLEMA: Nessuno
SERVE: Nulla

[262] SCENARIO: Utente scrive con errori di ortografia/dialetto
ATTESO: Claude capisce e risponde correttamente
ATTUALE: OK -- Claude gestisce bene errori ortografici e comprende il contesto
PROBLEMA: Dialetto lucano molto stretto potrebbe essere parzialmente compreso
SERVE: Nulla

[263] SCENARIO: Utente invia un messaggio vuoto (solo spazi)
ATTESO: Messaggio ignorato o "non ho ricevuto nulla"
ATTUALE: OK -- il filtro messaggi nel chat handler rimuove messaggi vuoti e restituisce "Non ho ricevuto messaggi validi"
PROBLEMA: Nessuno
SERVE: Nulla

[264] SCENARIO: Utente invia codice HTML/JavaScript malevolo nel messaggio
ATTESO: Il codice viene trattato come testo, non eseguito
ATTUALE: OK per la sicurezza -- il messaggio viene inviato a Claude come testo. Claude non esegue codice. Ma se la risposta viene renderizzata in HTML nel pannello anteprima, c'e rischio XSS
PROBLEMA: Potenziale XSS nel pannello anteprima se Claude ripete il codice malevolo
SERVE: Sanitizzazione HTML nel renderer del pannello anteprima (DOMPurify)

[265] SCENARIO: Utente tenta brute force sulla password dell'app
ATTESO: Lockout dopo N tentativi
ATTUALE: Non funziona -- l'autenticazione e una password singola (`Raffaele2026!`) in un cookie. Nessun rate limiting sul login
PROBLEMA: Nessun rate limiting; password in chiaro confrontata
SERVE: Rate limiting su login; password hashing; possibilmente auth Supabase

### 8.5 Errori nel Mezzo di Operazioni

[266] SCENARIO: Errore API Anthropic nel mezzo della generazione di un preventivo (dopo 50% dello streaming)
ATTESO: L'utente riceve quello che e stato generato + messaggio di errore
ATTUALE: OK -- lo streaming invia i dati progressivamente. Il catch finale aggiunge il messaggio di errore. L'utente vede la risposta parziale + errore
PROBLEMA: Il preventivo parziale potrebbe essere confusivo
SERVE: Retry automatico o salvataggio draft per ripresa

[267] SCENARIO: Il tool calcola_preventivo fallisce a meta (errore prezziario)
ATTESO: Preventivo generato con le voci disponibili, errore segnalato per quelle fallite
ATTUALE: OK -- il tool ha try/catch per ogni ricerca prezziario. Se una voce fallisce, continua con le altre usando il prezzo fornito
PROBLEMA: Nessuno critico
SERVE: Nulla

[268] SCENARIO: Supabase Storage down durante upload
ATTESO: Messaggio di errore chiaro
ATTUALE: OK -- il codice cattura l'errore di upload e ritorna status 500 con messaggio
PROBLEMA: Nessuno critico
SERVE: Retry automatico

[269] SCENARIO: Risposta Claude troncata a max_tokens (16000)
ATTESO: Claude indica che la risposta e stata troncata; possibilita di continuare
ATTUALE: Parziale -- il sistema ha un loop con max 5 iterazioni, ma il loop e progettato per tool use, non per continuazione testo. Se la risposta viene troncata a 16000 token, l'utente vede un testo tagliato
PROBLEMA: Risposte lunghe (relazioni tecniche) possono essere troncate senza avviso
SERVE: Detection stop_reason=="max_tokens" + continuazione automatica

[270] SCENARIO: Pensiero esteso (thinking) usa troppi token
ATTESO: Budget thinking gestito correttamente
ATTUALE: OK -- thinking ha budget_tokens: 10000, limitato. Se disabilitato (con file), non c'e overhead
PROBLEMA: Con thinking attivo, il costo per messaggio aumenta significativamente
SERVE: Monitoraggio costo thinking vs utilita

### 8.6 Memoria e Performance

[271] SCENARIO: Database con 10.000+ embedding
ATTESO: Ricerca RAG ancora veloce e pertinente
ATTUALE: Parziale -- pgvector gestisce bene 10k+ vettori con indice IVFFlat o HNSW. Ma senza indice, le query diventano lente. La pertinenza cala con molti embedding eterogenei
PROBLEMA: Performance dipende dall'indice; pertinenza cala con volume
SERVE: Indice HNSW su pgvector; cleanup periodico embedding obsoleti; categorizzazione

[272] SCENARIO: Utente ha 500 conversazioni
ATTESO: Tutte accessibili e ricercabili
ATTUALE: OK per l'accesso -- la lista conversazioni e paginata dal database. Ma la ricerca semantica attraversa TUTTI gli embedding senza filtro per conversazione
PROBLEMA: Ricerca non filtrata per conversazione specifica
SERVE: Filtro conversazione nella search_memory

[273] SCENARIO: Il system prompt + memoria RAG superano il context window
ATTESO: Gestione graceful
ATTUALE: Parziale -- il system prompt e ~15 righe + fino a 30 risultati RAG. Con embedding lunghi, il system prompt potrebbe diventare enorme. Ma il safeguard e solo sui messaggi (500k chars), non sul system prompt
PROBLEMA: Nessun limite sul system prompt totale
SERVE: Limite caratteri per il contesto RAG nel system prompt

[274] SCENARIO: Embedding molto simili che inquinano i risultati (es. 20 messaggi sullo stesso argomento)
ATTESO: Risultati deduplicate e diversificati
ATTUALE: Non funziona -- la search_memory ritorna i 30 piu simili, che potrebbero essere tutti varianti dello stesso messaggio
PROBLEMA: Nessuna deduplicazione nei risultati RAG
SERVE: MMR (Maximal Marginal Relevance) o dedup post-retrieval

[275] SCENARIO: Costo giornaliero supera il budget mensile
ATTESO: Alerting e possibile blocco automatico
ATTUALE: Non funziona -- nessun tracking costi ne alerting
PROBLEMA: L'utente puo esaurire i crediti senza accorgersene
SERVE: Dashboard costi; alert via Telegram; rate limiting per budget

[276] SCENARIO: Claude entra in un loop di tool use (chiama web_search ripetutamente senza convergere)
ATTESO: Il loop viene interrotto dopo un numero ragionevole di tentativi
ATTUALE: OK -- c'e il limite `consecutiveToolOnly >= 2` che ferma il loop dopo 2 iterazioni di solo tool use senza testo. Piu il limite `maxIterations = 5`
PROBLEMA: Nessuno critico -- il freno funziona
SERVE: Nulla

[277] SCENARIO: L'utente non usa il sistema per un mese, poi torna
ATTESO: Il sistema e ancora funzionante, la memoria e intatta
ATTUALE: OK -- Supabase e persistente. Le conversazioni e gli embedding restano
PROBLEMA: Nessuno
SERVE: Nulla

[278] SCENARIO: Aggiornamento del modello Claude (nuova versione)
ATTESO: Il sistema si adatta senza interventi
ATTUALE: Parziale -- il codice usa `claude-sonnet-4-6` e `claude-opus-4-6`. Quando esce una nuova versione, serve aggiornamento manuale del codice
PROBLEMA: Modelli hardcoded
SERVE: Configurazione modello in variabili d'ambiente

[279] SCENARIO: Utente chiede qualcosa che richiede piu di 300 secondi di elaborazione
ATTESO: Elaborazione completata o messaggio di timeout
ATTUALE: Non funziona -- Vercel ha un hard limit di 300s anche su Pro. La funzione viene killata
PROBLEMA: Operazioni molto lunghe impossibili
SERVE: Processing asincrono con queue (Inngest, Trigger.dev) per operazioni lunghe

[280] SCENARIO: Due messaggi Telegram arrivano quasi contemporaneamente (doppio click)
ATTESO: Solo uno viene processato
ATTUALE: OK -- il sistema di dedup (`telegram_dedup` table) previene l'elaborazione duplicata dello stesso message_id
PROBLEMA: Nessuno
SERVE: Nulla

---

# RIEPILOGO

## Conteggio per stato

| Stato | Scenari | Percentuale |
|---|---|---|
| OK Funziona | 68 | 24.3% |
| Parziale | 105 | 37.5% |
| Non funziona | 96 | 34.3% |
| Da verificare | 11 | 3.9% |
| **TOTALE** | **280** | **100%** |

## Dettaglio per categoria

| Categoria | OK | Parziale | Non funziona | Da verificare |
|---|---|---|---|---|
| 1. Documenti e File (55) | 12 | 22 | 18 | 3 |
| 2. Studio Tecnico (45) | 12 | 24 | 9 | 0 |
| 3. Segreteria (35) | 16 | 9 | 8 | 2 |
| 4. Fatturazione (30) | 1 | 7 | 22 | 0 |
| 5. Marketing (25) | 13 | 5 | 5 | 2 |
| 6. Cantieri (35) | 3 | 12 | 18 | 2 |
| 7. Regole (20) | 0 | 8 | 12 | 0 |
| 8. Stress Test (35) | 11 | 18 | 4 | 2 |

## Aree critiche (piu scenari NON funzionanti)

1. **Fatturazione/Contabilita** -- 22/30 non funzionano (73%). Manca completamente un sistema contabile
2. **Cantieri** -- 18/35 non funzionano (51%). Manca gestione strutturata dei cantieri
3. **Documenti e File** -- 18/55 non funzionano (33%). Formati mancanti e gestione file grandi
4. **Regole Business** -- 12/20 non funzionano (60%). Il sistema RAG non e adeguato per regole deterministiche

## Cosa serve per far funzionare tutto

### PRIORITA 1 -- CRITICO (impatto immediato, budget)

1. **Sistema budget/costi API** -- Dashboard costi, alerting, rate limiting per budget giornaliero/mensile. Senza questo, il rischio di esaurire i crediti e alto
   - Tabella `api_usage` con tracking costi per messaggio
   - Alert Telegram quando il budget giornaliero supera la soglia
   - Stima: 4-6 ore di sviluppo

2. **Tabella regole business** -- Le regole dell'utente devono essere deterministiche, non probabilistiche (RAG). Caricamento nel system prompt
   - Tabella `regole_business` (testo, categoria, attivo, created_at, updated_at)
   - CRUD via chat ("crea regola", "modifica regola", "lista regole", "elimina regola")
   - Caricamento top-N regole attive nel system prompt
   - Stima: 4-6 ore di sviluppo

3. **Fix URL firmati** -- Gli URL Supabase Storage scadono dopo 24h, rompendo le conversazioni riprese
   - Salvare il contenuto estratto (testo/OCR) al momento dell'upload, non l'URL
   - Stima: 2-3 ore

### PRIORITA 2 -- IMPORTANTE (sblocca molti scenari)

4. **Tabella cantieri strutturata** -- Sblocca 15+ scenari
   - Tabelle: `cantieri`, `giornale_lavori`, `diario_cantiere`, `eventi_cantiere`
   - Stima: 8-12 ore

5. **Parser formati file mancanti** -- Excel, CSV, ZIP, HEIC
   - Excel: exceljs (gia installato per generazione)
   - CSV: parsing banale
   - ZIP: libreria unzipper
   - HEIC: heic-convert
   - Stima: 4-6 ore

6. **Tabella fatture base** -- Sblocca 10+ scenari di fatturazione
   - Tabelle: `fatture`, `pagamenti`
   - Tool `genera_fattura` con calcoli fiscali precisi
   - Stima: 8-10 ore

7. **Retry e resilienza API** -- Retry con backoff per errori 429/500
   - Stima: 2-3 ore

8. **Continuazione risposte troncate** -- Detection max_tokens + auto-continuazione
   - Stima: 2-3 ore

### PRIORITA 3 -- MIGLIORAMENTI (user experience)

9. **Batching messaggi Telegram** -- Raccogliere foto/messaggi rapidi prima di processare
   - Timer 5-10 secondi dopo primo messaggio, poi elaborazione batch
   - Stima: 4-6 ore

10. **Profilo aziendale strutturato** -- Dati Restruktura (SOA, fatturato, referenze) sempre disponibili
    - Tabella `profilo_aziendale` caricata nel system prompt
    - Stima: 3-4 ore

11. **Sistema scadenze/notifiche** -- Tabella scadenze + cron job verifica giornaliera + notifica Telegram
    - Stima: 6-8 ore

12. **Database subappaltatori/fornitori** -- Rubrica strutturata
    - Stima: 4-6 ore

13. **Miglioramento export DOCX/PDF** -- Supporto tabelle, logo, formattazione configurabile
    - Stima: 8-12 ore

### PRIORITA 4 -- FUTURO (quando il sistema base e solido)

14. **Integrazione calendario** (Google Calendar API) -- Stima: 6-8 ore
15. **Integrazione email** (SendGrid/Resend) -- Stima: 4-6 ore
16. **Sistema contabilita lavori** (SAL, varianti, certificati) -- Stima: 16-24 ore
17. **Tool calcolo strutturale** (verifiche elementari NTC 2018) -- Stima: 12-16 ore
18. **Conversione DWG/DXF** -- Stima: 8-12 ore
19. **Fatturazione elettronica XML** (FatturaPA) -- Stima: 12-16 ore
20. **API meteo** per pianificazione cantiere -- Stima: 2-3 ore
21. **Processing asincrono** per operazioni lunghe (queue) -- Stima: 8-12 ore
22. **Generazione immagini** (QR code, diagrammi) -- Stima: 4-6 ore
23. **Integrazione Google Drive** -- Stima: 8-12 ore
24. **Dashboard analytics** (costi, uso, performance) -- Stima: 12-16 ore

## Stima effort totale

| Priorita | Scenari sbloccati | Ore stimate |
|---|---|---|
| P1 -- Critico | ~30 | 10-15 ore |
| P2 -- Importante | ~60 | 28-38 ore |
| P3 -- Miglioramenti | ~40 | 25-36 ore |
| P4 -- Futuro | ~50 | 90-130 ore |
| **TOTALE** | **~180** | **153-219 ore** |

## Conclusione

Il Cervellone oggi copre bene il **24% degli scenari** (generazione testo, analisi documenti, conversazione) grazie alla potenza nativa di Claude. Un altro **37.5%** funziona parzialmente (Claude ragiona bene ma mancano dati strutturati o tool dedicati).

Il **collo di bottiglia principale** non e Claude (che e capace), ma l'**infrastruttura intorno**: mancano database strutturati (cantieri, fatture, regole, scadenze), parser per formati file, e integrazioni con servizi esterni.

Con le priorita 1 e 2 (~40-53 ore), si passa dal 24% al **~55% degli scenari funzionanti**, coprendo i casi d'uso piu frequenti. Le priorita 3 e 4 sono miglioramenti incrementali che portano verso il **90%+ di copertura** nel medio-lungo termine.

L'investimento piu urgente e il **sistema di budget/costi API** (Priorita 1.1): senza controllo, il rischio di esaurire i crediti in pochi giorni di uso intensivo e concreto.
