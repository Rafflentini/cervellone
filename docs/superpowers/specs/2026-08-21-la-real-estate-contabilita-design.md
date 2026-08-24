# La Real Estate SRLS — contabilità e fatturazione · design

**21 agosto 2026.** Estensione di Cervellone alla seconda società: prima nota, riconciliazione, fatture settimanali agli ospiti, autofattura delle commissioni Booking.

Fonte primaria dei dati di contesto: *Briefing tecnico — Sistema check-in e fatturazione, LA REAL ESTATE S.R.L.S., Rev.01 del 17/08/2026*. Dove questo documento e il briefing divergono, vale questo: il briefing è stato scritto prima dell'acquisto del piano Fatture in Cloud.

---

## 1. La società

| Voce | Valore |
|---|---|
| Denominazione | LA REAL ESTATE S.R.L.S. |
| P.IVA | 02232730768 (IT, iscritta VIES dal 22/07/2026) |
| Codice SDI | M5UXCR1 (canale Fatture in Cloud / TS Digital) |
| ATECO | 55.20.42 — servizi di alloggio in case e appartamenti per vacanze |
| Casella amministrativa | `larealestate.amministrazione@gmail.com` |
| Comune di riferimento | Maratea (PZ) — imposta di soggiorno |

**Natura ricettiva, non locazione pura.** Conseguenza: alloggio **imponibile IVA 10%**, IVA sugli acquisti detraibile, reverse charge sulle commissioni dei portali neutro.

⚠️ **Il regime IVA non è ancora confermato dal commercialista.** L'aliquota è quindi un **parametro** (`Config.aliquota_iva` nel foglio, oggi `10`), mai una costante nel codice. Se cambia, si cambia un valore.

---

## 2. Le decisioni prese, con il perché

**D1 — Cervellone prepara e si ferma.** Compila le bozze su Fatture in Cloud e avvisa; la **trasmissione allo SdI resta un gesto umano**. Motivo: una fattura trasmessa non si annulla, si corregge con nota di credito. È una delle pochissime azioni irreversibili del sistema, e conferma la regola già in vigore per Restruktura.

**D2 — Il ponte coi dati degli ospiti è il foglio Google del check-in**, non una tabella nuova e non un'API. Motivo: esiste già, lo vede e lo capisce chi fa il check-in, e un foglio si controlla a occhio.

**D3 — Cervellone scrive su Fatture in Cloud via API, non via CSV.** Il CSV previsto dal briefing resta come ripiego manuale se l'API è irraggiungibile.

**D4 — Il flag `Fattura emessa` ha UN SOLO proprietario: Cervellone.** Motivo: due scrittori sullo stesso flag di stato producono fatture doppie o mancate, ognuno credendo che l'altro abbia fatto. È il difetto rimosso il 20 agosto dal path web, e non va reintrodotto qui.

**D5 — Società attiva esplicita, e nome stampato in ogni conferma contabile.** Motivo: una prima nota nella società sbagliata o una fattura emessa dall'azienda sbagliata non danno errore. Si scoprono dal commercialista, mesi dopo.

---

## 3. Perimetro

**Dentro:** prima nota, riconciliazione, preparazione fatture agli ospiti, autofattura TD17 delle commissioni Booking, promemoria delle scadenze fiscali collegate.

**Fuori:** il form di check-in, il calcolo del codice fiscale, l'export Alloggiati Web, la dichiarazione dell'imposta di soggiorno sul portale del Comune. Restano al foglio e alla persona.

Il confine è anche il confine dei dati: **Cervellone legge il foglio, non lo compila** — con l'unica eccezione della colonna `Fattura emessa`, che è sua.

---

## 4. Le quattro parti

### Parte 1 — Fondamenta a due società *(prerequisito di tutto)*

Oggi il sistema conosce **una** società e **una** casella Google, entrambe implicite.

- `FIC_COMPANY_ID` è una variabile d'ambiente unica (`fatture-in-cloud.ts:49`), usata da ogni chiamata.
- Le credenziali Google si leggono prendendo **l'ultima autorizzata** (`google-oauth.ts:207-210`, `order updated_at desc limit 1`), benché la tabella abbia già la colonna `account_email`. Autorizzare la casella de La Real Estate farebbe **smettere di leggere** quella di Restruktura, senza alcun errore.

Va costruito:

1. Un registro delle società (denominazione, P.IVA, `fic_company_id`, casella Google, regime IVA di default).
2. Una **società attiva**, selezionabile con `/societa`, persistita come il progetto attivo.
3. **Ogni operazione contabile che scrive** dichiara la società nel messaggio di conferma: *"Prima nota — LA REAL ESTATE SRLS — confermi?"*. La difesa non è il codice, è che tu legga il nome sbagliato prima di confermare.
4. Selezione delle credenziali Google **per casella**, non "l'ultima".

**Finché questa parte non è chiusa, le altre non vanno attivate.**

### Parte 2 — Fatture settimanali agli ospiti

Sorgente: foglio *La REAL Estate — Check-in Rev.01*, id `1vaq_fJo3l17Jl0_PcV5aih1q1O9qZisPvU2KrBdTX7I`, tab `Soggiorni`.

Criterio di selezione, ripetibile all'infinito:

> soggiorni con **check-out passato**, **importo lordo valorizzato** e **`Fattura emessa = NO`**

Per ciascuno, bozza su Fatture in Cloud:

- **Cliente**: intestatario fattura, con CF/P.IVA, indirizzo, SDI/PEC dalla riga. Default `0000000` per italiani e `XXXXXXX` per esteri.
- **Riga alloggio**: descrizione `Servizio di alloggio {Unità} dal {check-in} al {check-out} — {n} notti, {n} ospiti`; quantità 1; **importo lordo commissione inclusa**; aliquota da `Config.aliquota_iva`.
- **Riga imposta di soggiorno**: importo separato, **fuori campo IVA**, mai sommato all'imponibile.
- Documento **non trasmesso** (D1).

A esito riuscito, Cervellone scrive nella riga: `Fattura emessa = SI`, più numero e data del documento.

Poi un messaggio: *"7 bozze pronte su Fatture in Cloud per LA REAL ESTATE — controlla e trasmetti"*.

**La fattura è all'ospite sull'importo lordo.** La commissione Booking non si sottrae: è un costo separato della società.

### Parte 3 — Autofattura delle commissioni Booking (TD17)

Booking non ha API per le singole strutture e le sue email di notifica non contengono i dati dell'ospite (accertato nel briefing). L'unico dato utile che arriva via posta è la **fattura PDF delle commissioni**, sulla casella amministrativa.

Flusso: riconoscimento del messaggio → estrazione di imponibile, data, numero e periodo → bozza su Fatture in Cloud di tipo **`self_supplier_invoice`** (l'emittente figura come cliente, Booking come fornitore) → **creazione della scadenza di trasmissione** entro il **15 del mese successivo**.

La scadenza non è un vezzo: un documento pronto ma non trasmesso è una sanzione che matura in silenzio, ed è esattamente la categoria di guasto che questo sistema deve smettere di produrre.

### Parte 4 — Prima nota e riconciliazione

Nessuna logica nuova: `prima-nota-tools.ts`, `riconciliazione-tools.ts` e `movimenti-extract.ts` **non contengono un riferimento a Restruktura** (verificato). Sono già neutri rispetto alla società.

Serve solo che ogni movimento sappia a chi appartiene — cioè la Parte 1.

---

## 5. Come il sistema si accorge di ciò che non ha fatto

Questa sezione viene prima delle altre nell'implementazione, non dopo.

Tre domande che devono poter essere poste in qualsiasi momento, con risposta esatta:

| Domanda | Fonte | Se la risposta non è vuota |
|---|---|---|
| Quali soggiorni fatturabili non hanno fattura? | tab `Soggiorni` | c'è del fatturato non emesso |
| Quali bozze pronte non sono state trasmesse? | Fatture in Cloud | c'è un adempimento fermo |
| Quali fatture Booking non hanno autofattura? | casella + FIC | c'è un TD17 mancante, con scadenza |

Sono **domande, non eventi**: se una settimana salta, la successiva recupera anche l'arretrato. Un evento perso invece non torna.

Regola di progetto: **niente in questo sottosistema può fallire in silenzio.** Se una bozza non viene creata, se il foglio non è leggibile, se il flag non si scrive — deve comparire in un messaggio o in un'anomalia dell'audit, mai solo in un log.

---

## 6. Dipendenze fuori dal codice

| Cosa | Stato |
|---|---|
| Piano Fatture in Cloud | ✅ acquistato (annuale) |
| **Tipologia soggetto = "Persona fisica"** | ⚠️ **da correggere in soggetto giuridico**: produce XML malformati, e lo scarto arriva a fattura già emessa |
| Regime IVA 10% | ⚠️ da confermare col commercialista |
| Autorizzazione Google della casella amministrativa | da fare **dopo** la Parte 1, altrimenti si perde la casella di Restruktura |
| Inserimento prenotazioni nel foglio | manuale: Booking non espone API né dati ospite nelle email |

---

## 7. Come si prova

- **Parte 1**: test che dimostrino che un'operazione contabile sulla società A non tocca mai la società B, e che autorizzare una seconda casella non fa perdere la prima.
- **Parte 2**: il criterio di selezione va provato sui casi che sbagliano — riga già fatturata, importo mancante, check-out futuro, foglio irraggiungibile.
- **Parte 3**: estrazione provata su una fattura Booking **reale**, non su un esempio inventato. Il 20 agosto un test di sicurezza è passato su un payload che non era un attacco: qui vale lo stesso rischio.
- **Nessun test tocca Fatture in Cloud in produzione.** Le bozze si creano solo su richiesta esplicita, e la prima si controlla a mano prima di fidarsi della seconda.

---

## 8. Ordine di lavoro

1. Parte 1 — fondamenta a due società.
2. Parte 4 — prima nota e riconciliazione sulla nuova società (riuso, poco lavoro, valore subito).
3. Parte 2 — fatture settimanali dal foglio.
4. Parte 3 — autofattura Booking.

Le fondamenta per prime perché rendono sicuro tutto il resto. La prima nota subito dopo perché è quasi gratis e ti serve da subito.

---

# Aggiornamento 24 agosto 2026 — dove vive il check-in

Questa sezione modifica il §3 (Perimetro) e il §4 (Parte 2). Dove diverge da quanto sopra, vale questa.

## 9. Cosa è stato accertato, e non era scritto da nessuna parte

Verificato il 24/08/2026 sul Drive reale, non sui documenti:

| Cosa | Stato accertato |
|---|---|
| Sorgenti `Codice.gs`, `Form.html`, `Esportazioni.gs`, `CodiceFiscale.gs` | Esistono come `.txt` nella cartella *App Check-in Rev.01* |
| Progetto Apps Script | **Mai creato.** Sull'account esistono due soli progetti (`Progetto senza titolo`, `Restruktura Studio Tecnico v2`), entrambi di marzo, nessuno dei due è il check-in |
| Web app pubblicata | Non esiste: non c'è lo script che la pubblichi |
| Schede `Soggiorni`/`Ospiti`/`Config`/`Tabelle` | **Mai create.** Entrambi i fogli candidati hanno solo `Foglio1`, vuoto, fermo all'11 agosto |
| Prima chiamata reale a Fatture in Cloud | ✅ **Riuscita** (Restruktura, 50 fatture lette). Il ripiego "una sola azienda" ha funzionato: `FIC_COMPANY_ID` non serve |
| `FIC_ACCESS_TOKEN_LAREALESTATE`, `FIC_COMPANY_ID_LAREALESTATE` su Vercel | Assenti |

**Non esiste un'app da riparare: esiste del codice mai messo in opera.** L'11 agosto è stato scritto tutto e non è mai stato installato.

## 10. D6 — Il form di check-in entra in Cervellone

Il §3 metteva il form *fuori* dal perimetro: *"restano al foglio e alla persona"*. **Quel confine si sposta.**

**Motivo, e non è una preferenza estetica:** nessuno degli strumenti disponibili a Claude può creare, agganciare o pubblicare un progetto Apps Script. Lasciando il form dove sta, ogni modifica futura finisce con l'Ingegnere che incolla codice dentro un editor. Un sistema che dipende da un gesto manuale a ogni giro è un sistema che, alla prima settimana intensa, smette di essere aggiornato — ed è lo stesso motivo per cui la memoria persistente è rimasta rotta tre mesi senza che nessuno se ne accorgesse.

Dentro Cervellone il ciclo si chiude: codice nel repo, test, CI, deploy a ogni push, nessun passaggio manuale.

**Cosa NON cambia** — ed è la parte che l'Ingegnere ha chiesto esplicitamente:

- Il **foglio Google resta l'archivio**. La web app ci scrive, Cervellone ci legge. Non si sposta niente in Supabase.
- Le **quattro schede e le colonne** restano quelle di `Codice.gs`, carattere per carattere: un'intestazione diversa romperebbe la lettura senza dare errore.
- Il **layout del form resta identico**: stessa palette (`#1f3864`), stessa impaginazione a tre sezioni, stessa barra fissa, stesso calcolo dal vivo dell'imposta. In più il logo (`Logo La Real Bianco`), che nel `Form.html` non c'era mai stato.

**Cosa viene tradotto da Apps Script a TypeScript, con i test che là mancavano:** calcolo del codice fiscale, imposta di soggiorno di Maratea notte per notte, tracciato Alloggiati a 168 caratteri, criterio di selezione delle fatture.

## 11. D7 — L'idempotenza, non il flag, impedisce la fattura doppia

Creare la bozza su Fatture in Cloud e scrivere `Fattura emessa = SI` sul foglio sono **due sistemi senza transazione**. Se la prima riesce e la seconda no, la settimana dopo il soggiorno risulta ancora `NO` e la fattura viene rifatta. Invertendo l'ordine è peggio: un errore su FIC lascia la riga marcata come fatturata quando non lo è, e quello non se ne accorge nessuno.

**Decisione:** l'`ID Soggiorno` (`SOG-20260824-101530`) viene stampato **dentro il documento su Fatture in Cloud**. Prima di creare qualsiasi bozza si cerca se ne esiste già una con quell'ID: se c'è, non si ricrea — si sistema il flag e basta.

Conseguenza da tenere a mente: **la verità è su Fatture in Cloud, il flag sul foglio è una comodità.** Un flag perso costa una ricerca in più, non una fattura doppia a un ospite.

## 12. Il foglio: quale, e chi lo inizializza

I due candidati sono gemelli e vuoti. Si adotta **`La REAL Estate — Gestionale Check-in`**, id `19UeD_Soy_zqTxxg1p6ZkQrOW4_0uct4vftQzy9iLmE4`, perché sta nella cartella operativa accanto ad *Alloggiati* e *Documenti temporanei*.

⚠️ **La spec originale (§4, Parte 2) indicava `1vaq_fJo3l17Jl0_PcV5aih1q1O9qZisPvU2KrBdTX7I`.** Quello è la copia dentro la cartella dei sorgenti. Vale l'id qui sopra.

L'inizializzazione la fa **Cervellone**, non un menu da cliccare: aggiunge le quattro schede al foglio esistente via Sheets API. Così è ripetibile, verificabile e non dipende da nessuno.

`Config` alla messa in opera — unità come segnaposto, da rinominare dopo i test:

| Chiave | Valore |
|---|---|
| `ragione_sociale` | LA REAL ESTATE SRLS |
| `unita` | `Unità 1\|Unità 2\|Unità 3\|Unità 4\|Unità 5` (**cinque**, non quattro) |
| `tassa_importo` | 2.5 |
| `tassa_max_notti` | 5 |
| `tassa_stagione_dal` / `_al` | 01/05 / 31/10 |
| `tassa_in_vigore_dal` | 01/05/2026 |
| `aliquota_iva` | 10 |

## 13. Il form è pubblico e raccoglie documenti d'identità

Questo non c'era nella spec di agosto perché il form stava fuori dal perimetro. Ora ci sta dentro, e va detto prima di scrivere il codice.

Il form raccoglie cognome, nome, data e luogo di nascita, tipo e numero del documento: **dati personali di terzi**, non dell'Ingegnere. Una pagina pubblica che li accetta è una pagina che va protetta prima di essere utile.

Requisiti, non desideri:

- Il link porta un **token**; senza token la pagina non si apre. Il link si può revocare senza toccare il codice.
- La pagina **non legge mai**: accetta scritture, non restituisce soggiorni. Nessuna enumerazione possibile.
- **Limite di frequenza** per token e per IP.
- I dati vanno **solo** sul foglio, che sta in un Drive privato. Niente copia in database, niente log del contenuto.
- Nessun dato personale nei messaggi di errore.

## 14. Ordine di lavoro aggiornato

1. **Il foglio, per davvero** — quattro schede create da Cervellone sul foglio adottato, `Config` popolato. Verifica: rileggere il foglio e trovarcele.
2. **Il form** — pagina Cervellone, layout identico, logo, scrittura su `Soggiorni` + `Ospiti`, codice fiscale e imposta calcolati.
3. **Le fatture** (Parte 2) — lettura del foglio, bozze su FIC con `ID Soggiorno`, flag scritto dopo.
4. **Alloggiati Web** — tracciato a 168 caratteri.

Fuori da questo giro, invariati: trasmissione allo SdI (gesto umano), token FIC de La Real Estate e correzione della tipologia soggetto (credenziali e anagrafiche dell'Ingegnere), caricamento su Alloggiati Web finché non c'è la WebServiceKey.

## 15. L'imposta di soggiorno, dal regolamento e non dal ricordo

Fonte: *Regolamento sull'Imposta di soggiorno del Comune di Maratea*, da ultimo modificato con **D.C.C. n. 03 del 24/02/2026**, letto integralmente il 24/08/2026. Dove il codice di agosto (`Codice.gs`) diverge da questo, vale il regolamento.

**Misura (art. 4 c.1).** L'imposta è determinata *"per persona e per pernottamento"*. **Non è un forfait a soggiorno.** Per case e appartamenti per vacanze e locazioni brevi: **2,50 €**. Ciò che sembra un tetto per soggiorno è in realtà l'esenzione dell'art. 5 lettera a).

**Esenzioni (art. 5).** Sono esenti i pernottamenti di:

| | Caso | In `Codice.gs` |
|---|---|---|
| a | successivi al **quinto giorno consecutivo** nella stessa struttura | ✅ implementato (`tassa_max_notti`) |
| b | campeggi: successivi al quinto giorno anche non consecutivo | non applicabile |
| c | **minori di età non superiore al dodicesimo anno** | ❌ **assente** |
| d | disabili (handicap grave L. 104/92) e invalidi civili ≥ 80% | ❌ assente |
| e | pernottamenti gratuiti a qualunque titolo | ❌ assente |
| f | chi assiste un degente ricoverato (max 1 per paziente) | ❌ assente |
| g | autisti di pullman | ❌ assente |
| h | accompagnatori di gruppi organizzati (1 ogni 25) | ❌ assente |
| i | ospiti a totale carico del Comune di Maratea | ❌ assente |
| j | **residenti nel Comune di Maratea** | ❌ assente |

Agevolazione al **50%** per gruppi di almeno 25 persone, con autocertificazione (art. 5 c.2).

**D8 — L'esenzione dei minori si calcola, non si spunta.** `Codice.gs` conosce solo una casella "Esente" manuale: un bambino di tre anni risulta pagante ogni volta che l'operatore si dimentica di spuntarla, e il totale resta plausibile, quindi nessuno se ne accorge. La data di nascita di ogni ospite è già obbligatoria nel form: **l'esenzione per età si deriva dai dati, non dalla memoria di chi compila.**

⚠️ **Ambiguità dichiarata, non risolta.** *"minori di età non superiore al dodicesimo anno"* ammette due letture: esente fino al compimento dei 12, oppure esente anche a 12 compiuti. Si adotta **esente fino a 12 anni compiuti, pagante da 13**, esposta come parametro `esenzione_eta_max` in `Config`. **Da confermare all'Ufficio Entrate e Tributi del Comune (dr. Giuseppe Giannasio, 0973 874111).** Non è una decisione tecnica: è denaro di terzi.

**D9 — Le esenzioni diverse dall'età vanno motivate per iscritto.** Art. 3 c.4: il gestore è obbligato a conservare *"le dichiarazioni rilasciate dal cliente per l'esenzione"*. Quindi il campo motivo diventa **obbligatorio** quando si spunta l'esenzione manuale. Un'esenzione senza motivo è un ammanco in sede di controllo.

⚠️ **Discordanza sul periodo, da chiarire.** L'art. 2 del regolamento fissa il presupposto nel periodo **1 aprile – 31 ottobre**; la delibera tariffaria 2026 e l'avviso del Comune indicano **1 maggio – 31 ottobre 2026**, ed è quest'ultimo che sta in `Config`. Per un soggiorno di aprile la differenza è denaro. Resta parametro, ma va deciso sapendo.

**D10 — La scadenza mensile la crea Cervellone.** Artt. 6 e 7: entro il **giorno 16 di ogni mese** il gestore inserisce sul portale del Comune (applicativo *Xenia* di SISCOM) la dichiarazione del mese precedente — **anche se negativa, indicando zero** — e versa con PagoPA. Nessuno oggi segue questa scadenza. È la stessa famiglia di guasti dell'autofattura TD17: un adempimento che matura in silenzio. Va creata come scadenza ricorrente, non lasciata alla memoria.

**Nota, fuori perimetro ma da sapere:** art. 3 c.3, i gestori di portali telematici e gli intermediari immobiliari sono **essi stessi responsabili** del pagamento dell'imposta. Se Booking incassa e riversa direttamente, il conteggio va riconciliato e non sommato. Da verificare col commercialista prima della prima dichiarazione.
