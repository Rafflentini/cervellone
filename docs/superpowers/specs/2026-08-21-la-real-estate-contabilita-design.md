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
