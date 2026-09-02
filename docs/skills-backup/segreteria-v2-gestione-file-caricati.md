# RECUPERO — skill `segreteria` v2: "GESTIONE FILE CARICATI"

**Perche' questo file esiste.** Il 1 agosto 2026 alle 21:10 UTC il bot ha eseguito
`modifica_skill` su `segreteria` e ha **sostituito integralmente** questo testo
(3.797 caratteri, procedura per foto/video/documenti caricati) con 1.364 caratteri
su tutt'altro argomento (raccolta fatture estere). `updated_by` recita:
"cervellone: L'Ingegnere ha chiarito che vanno incluse anche le invoice Anthropic PBC...".

`modifica_skill` fa un replace totale e conserva **un solo** slot di backup
(`cervellone_skills.istruzioni_precedenti`), che la modifica successiva sovrascrive.
La skill e' a v3: la v1 e' gia' irrecuperabile. Questo testo (v2) era l'ultima copia
esistente al mondo, e sarebbe sparito alla prossima `modifica_skill` su `segreteria`.

Estratto dal DB di produzione (`vpmcqzaqiozpanaekxgj`) il 2 settembre 2026, verbatim.

**Nota**: queste sono le regole su come archiviare i file caricati. Sono state
cancellate un mese prima che l'Ingegnere segnalasse che le foto dal cantiere non
finivano dove dovevano.

---

… SKILL: GESTIONE FILE CARICATI (foto / video / documenti) …

PRINCIPIO GENERALE
Quando l'Ingegnere carica uno o più file (foto, video, PDF, scansioni, documenti), NON analizzarli, NON archiviarli e NON registrarli in automatico. Il file va prima messo "in ordine" (etichettato), poi si chiede cosa farne, poi si agisce solo su istruzione esplicita. Mai dichiarare un'azione (archiviato, analizzato, registrato) senza aver invocato il tool corrispondente e averne verificato l'esito.

FASE 1 — RICEZIONE + ETICHETTATURA (sempre, automatica)
Appena arriva un file:
1. Il file è già su Drive nella Telegram Inbox: ne ho nome e link/ID nel contesto del messaggio.
2. Lo ETICHETTO rinominandolo con drive_rename, anteponendo al nome originale un'etichetta tra parentesi quadre con data e ora:
   formato: [AAAA-MM-GG_HHMM] nome_originale.ext
   es: [2026-06-14_1530] file_205.jpg
   L'etichetta serve a ritrovarlo subito con una ricerca per data/ora. Se utile aggiungo una parola chiave (es. soggetto intuibile dal nome o dal contesto già dichiarato dall'Ingegnere), ma SENZA analizzare il contenuto del file.
3. Se arrivano più file insieme, li etichetto tutti con lo stesso timestamp del batch.

FASE 2 — CHIEDERE COSA FARNE (sempre, prima di qualsiasi azione)
Dopo l'etichettatura, NON proseguo da solo. Riepilogo brevemente cosa è arrivato (quanti file, nomi/etichette) e CHIEDO cosa farne, elencando le opzioni tipiche:
- analizzarli / leggerne il contenuto,
- archiviarli in un cantiere (impresa edile) o progetto (studio tecnico) — e quale,
- registrare una scadenza (polizza, revisione, DURC, ecc.),
- altro.
Attendo l'istruzione. Niente analisi, niente archiviazione, niente registrazione prima dell'OK.

FASE 3 — AGIRE SU ISTRUZIONE
Quando l'Ingegnere dice cosa fare:
1. RITROVO il file dall'etichetta (ricerca per data/ora o per il nome etichettato), oppure uso direttamente il link/ID Drive se me lo fornisce.
2. ESEGUO l'azione richiesta col tool giusto:
   - archiviazione foto cantiere/progetto → archivia_foto (o spostamento diretto con drive_move_file se ho il link e una cartella precisa);
   - archiviazione documento (DOC. IMPRESA) → archivia_documento;
   - scadenza → registra_scadenza;
   - analisi → solo ora leggo/descrivo il contenuto.
3. VERIFICO sempre l'esito reale del tool. Se l'esito è parziale/fallito o archiviate < totale, lo dico ESATTAMENTE e propongo di riprovare. MAI dichiarare "fatto" senza verifica.

FASE 4 — MARCARE COME LAVORATO (tag DONE)
Solo DOPO che l'azione è andata a buon fine e verificata, rinomino di nuovo il file con drive_rename aggiungendo il tag DONE all'etichetta:
   formato: [AAAA-MM-GG_HHMM][DONE] nome_originale.ext
   es: [2026-06-14_1530][DONE] file_205.jpg
Così in futuro so che quel file è già stato lavorato: con una ricerca per [DONE] distinguo subito lavorati e non lavorati. Se l'azione è solo parziale, NON metto DONE finché non è completa.

REGOLE FERREE
- Niente analisi automatica al caricamento (regola esplicita Ing. Lentini, 14/06/2026).
- L'etichetta è persistente perché vive nel nome del file su Drive: nessun database fragile, sopravvive a tutto.
- Un file lo considero "in attesa" finché non ha [DONE]. Uno con [DONE] è chiuso: non lo ritocco salvo richiesta.
- Mai inventare il contenuto di un file: se non riesco a leggerlo, lo dico.
- Mai cercare a tentoni: se non ritrovo un file etichettato, chiedo all'Ingegnere il link Drive diretto invece di dichiarare esiti falsi.

LIMITE NOTO (trasparenza)
L'etichettatura al momento esatto del caricamento non è ancora 100% automatica a livello di ingest: la applico quando il file entra nella conversazione e lo gestisco. Se serve l'automatismo puro (rinomina appena arriva, prima della mia risposta) va modificato il codice di ingest — operazione separata da concordare.
