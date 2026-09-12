# La lista di controllo tarata sui difetti veri

**Regola di metodo, dettata da Raffaele il 12 settembre 2026:**

> *«fix, poi imparo e prossima volta calibro gli audit per scovare il problema in fase di creazione».*

**Ogni voce di questa lista è nata da un difetto reale, e lo cita.** Una voce senza un difetto alle
spalle è un sospetto, non un controllo — e non entra.

**Come si usa:** quando si dispiega un audit avversariale, gli si passa **questa lista**, non solo il
diff. Quando si chiude un fix, la lista si aggiorna **nello stesso commit**; se non si aggiunge
niente, si scrive perché.

**Perché serve:** il 12 settembre 2026, in un giorno, Raffaele ha trovato **usando il bot** tre
difetti che **sei audit avversariali e 2.255 test verdi** non avevano visto. Uno viveva in produzione
da **tre mesi e una settimana**. Gli audit non erano fatti male: **cercavano le cose sbagliate.**

---

## A — I controlli meccanici (un `grep`, nessuna memoria richiesta)

Sono i migliori: non dipendono da chi guarda.

### A1. 🚨 Un errore che diventa un'assenza

> **Nato da:** `pending.ts:109` contava le bozze mail su una colonna inesistente e faceva
> `if (error) return 0`. Il bot rispondeva *«non ho una mail pronta»* con **sette bozze in attesa**.
> Vivo dal **4 giugno 2026** — tre mesi. (E dal 10 set: `SUPABASE_SERVICE_ROLE_KEY` mancante → RLS
> nega → lettura vuota → *«non c'è niente»*.)

```bash
grep -rn "if (error[^)]*) return \(\[\]\|0\|null\|false\)" src/ --include=*.ts | grep -v test
```

**Esito del 12 set 2026: 10 casi ancora aperti.**
`scadenze-tools.ts:913` ⚠️ *(lo scadenzario, dove i promemoria non arrivano)* ·
`circuit-breaker.ts:205` · `document-templates.ts:152,165,193` · `regole-proposte.ts:69` ·
`share-proposte.ts:27,35` · `v19/memory/storage.ts:36,46`
*(Esclusi i due `error.code === '23505'`: sono controlli legittimi di chiave duplicata.)*

**La regola:** un errore **non diventa mai** un'assenza. Chi legge deve poter dire *«non riesco a
controllare»* in modo distinguibile da *«non c'è niente»* — con un tipo a due varianti, così il
compilatore obbliga ogni chiamante a decidere.

### A2. Un nome di colonna scritto a mano

> **Nato da:** lo stesso difetto. `.select('id')` su una tabella la cui chiave è `uuid`.

```bash
grep -rn "\.select('[a-z_, ]*'" src/ --include=*.ts | grep -v test
```

Per ogni `.select()` con nomi letterali: **quelle colonne esistono?** Si verifica in un colpo con
`information_schema.columns`. È l'unico modo: TypeScript non sa niente dei nomi delle colonne.

### A3. Variabili d'ambiente usate e assenti in produzione

> **Nato da:** `GOOGLE_SERVICE_ACCOUNT_KEY` assente → `JSON.parse('{}')` → *«client_email
> mancante»* → il modello l'ha tradotto in *«token Google scaduto»* e ha mandato Raffaele a
> rigenerare una cosa che non c'entrava.

```bash
grep -rhoE "process\.env\.[A-Z][A-Z0-9_]{3,}" src/ --include=*.ts | sed 's/process\.env\.//' | sort -u > usate.txt
npx vercel env ls production | awk '{print $1}' | grep -E "^[A-Z][A-Z0-9_]+$" | sort -u > vercel.txt
comm -23 usate.txt vercel.txt
```

⚠️ **Non basta l'elenco: ogni assenza va classificata.** Esito del 12 set: 16 assenti, e **15 sono
sane** — fornite dalla piattaforma (`NODE_ENV`, `VERCEL`, `AWS_LAMBDA_FUNCTION_NAME`), spente di
proposito (`TOOL_DEFER`), di codice morto (`E2B_*`), o con un ripiego vero (`SUPABASE_URL` dietro
`NEXT_PUBLIC_*`, `FIC_COMPANY_ID*` che interroga l'API e **si ferma dichiarandolo** se l'account ha
più aziende). **Una sola era un guasto**, ed è A4.
⚠️ Attenzione ai letti in modo dinamico (`process.env[nome]`): il `grep` non li vede.

### A4. 🚨 Un ripiego che non è configurato

> **Nato da:** `document-saver.ts:98-105` e `drive.ts:34`. Prova OAuth; se fallisce **ripiega sul
> service account** — che non è configurato. Risultato: un problema **momentaneo** di OAuth (tre
> minuti dopo funzionava) è diventato un errore di credenziali permanente, e l'errore vero è finito
> in un `console.error` che nessuno legge.

**La regola:** **un ripiego non configurato è peggio di nessun ripiego**, perché sostituisce un errore
diagnosticabile con uno che non lo è. Per ogni `catch → fallback`: il ripiego è **realmente**
configurato in produzione? Se no, si toglie, così l'errore vero arriva a chi deve leggerlo.

### A5. Codice morto che sembra vivo

> **Nato da:** `src/v19/agent/` — 955 righe di «sotto-agenti specialisti» mai collegate, che hanno
> fatto credere (anche a me) che esistesse una funzionalità che non c'era.

```bash
grep -rln "nome-modulo" src/ --include=*.ts | grep -v test   # zero importatori = morto
```

---

### A6. 🚨 La risposta di una scrittura usata come prova

> **Nato da:** il 12 settembre 2026, scrivendo `segna_fatture_ricevute_pagate` (pagamento su una
> fattura RICEVUTA). L'unica cosa che l'API di Fatture in Cloud garantisce con un `200` è di aver
> **ricevuto** la richiesta — non che il campo sia finito sul documento. E la semantica del `PUT`
> non è nemmeno documentata: non si sa se sostituisca il documento intero o accetti un payload
> parziale. Un «fatto» dedotto dal `200` sarebbe stato indistinguibile da un pagamento mai scritto.

```bash
grep -rn "method: '\(PUT\|POST\|DELETE\|PATCH\)'" src/ --include=*.ts | grep -v test
```

Per ogni scrittura verso un sistema esterno: **dopo, si rilegge?** E l'esito riferito viene dalla
rilettura o dalla risposta? Due controlli, non uno:

1. **il fatto c'è** — il campo scritto si ritrova rileggendo;
2. **il resto non è cambiato** — fornitore, numero, data, importi. Serve proprio quando la semantica
   della scrittura è ignota: se fosse una sostituzione integrale e avessimo rispedito meno campi di
   quanti servono, il danno comparirebbe solo qui.

**La regola:** su un dato che conta, `ok` lo può dire **solo** una rilettura. E quando la rilettura
non conferma, il messaggio deve dirlo con parole che non si possono confondere con un successo —
*«l'API ha risposto ok ma rileggendo non risulta»*.

---

## B — I controlli sul comportamento verso l'Ingegnere

### B1. 🚨 Un messaggio che il codice scrive al posto del modello deve dire la verità

> **Nato da:** dopo **17 operazioni eseguite** e un'archiviazione riuscita, il bot diceva *«Non sono
> riuscito a sintetizzare una risposta. **Riformuli la richiesta**»*. Su un archivio, rifare una cosa
> già fatta crea **doppioni**.

Per ogni messaggio emesso dal codice e non dal modello: **dipende da cosa è realmente successo?**
Se c'è stato del lavoro, lo dice — e chiede di **verificare**, mai di ripetere.

### B2. Una costrizione negativa senza istruzione positiva

> **Nato da:** la sintesi forzata rifaceva la chiamata con `tool_choice: none` e **gli stessi
> messaggi**: gli si toglievano gli strumenti senza dirgli cosa fare. Il silenzio era **legittimo**,
> e succedeva due volte su tre.

Dove si vieta qualcosa al modello, **c'è una riga che gli dice cosa fare invece?**

### B3. Il bot suggerisce una parola che il sistema non accetta

> **Nato da:** *«Mi dica "invia" e parto»* — e la regola di conferma pretendeva la parola «mail»
> dopo il verbo. Quattro bozze identiche create, nessuna inviata.

Ogni istruzione che nomina una parola magica o un comando **va testata contro la regola che poi
decide**. Il legame deve essere un test, non la buona volontà.

### B4. Un codice che l'Ingegnere deve ricopiare a mano

> **Nato da:** `/invia_<uuid>` con i trattini. Telegram rende cliccabile un comando solo se contiene
> `[A-Za-z0-9_]`: si ferma al primo `-` e toccandolo dà `/invia_d8f8ad16`, troncato. Lui lavora dal
> telefono, spesso in giro.

Ogni identificativo mostrato all'utente: **è azionabile con un tocco?** Su Telegram, comandi **senza
trattini**; e comunque **tocca-per-copiare** su entrambi i canali. Un codice nudo nel testo non si usa.

### B5. Controllo di flusso basato sul testo di un messaggio

> **Nato da:** l'esito del turno si classificava con `fullResponse.startsWith(FALLBACK_PREFIX)`.
> Appena i messaggi sono diventati due, quel confronto si sarebbe rotto **in silenzio**: turni
> falliti registrati come riusciti.

Nessuna decisione si prende confrontando una stringa mostrata all'utente. Il segnale si mette **nel
punto esatto in cui il fatto accade**, con un flag o un tipo.

### B6. Una soglia tarata su un lavoro che non esiste più

> **Nato da:** `NO_TEXT_LIMIT = 5`. Archiviare un documento del personale richiede **13-18** strumenti
> di fila e nessuna ragione di parlare prima della fine. Portata a 8.

Per ogni costante che limita il lavoro: **misurata contro il carico di oggi**, o su quello di quando
è stata scritta?

---

### B7. 🚨 Un esito di GRUPPO che nasconde i singoli

> **Nato da:** il 12 settembre 2026, dal massivo di `segna_fatture_ricevute_pagate`. L'Ingegnere ha
> chiesto **una conferma sola per N fatture**. Un'operazione che tocca 5 documenti può riuscirne 3:
> un «fatto» sul gruppo lascerebbe due fatture non pagate che lui crede pagate, e la contabilità
> divergerebbe in silenzio. Nessuno se ne accorgerebbe fino al bilancio.

Per ogni operazione che tocca **più di un elemento** in un colpo:

1. **l'esito è per elemento**, con il motivo di ogni fallimento — non un conteggio e non un «ok»;
2. **il conteggio delle riuscite si costruisce contando le verifiche**, non i tentativi;
3. **gli esclusi si dichiarano**: chi è stato saltato, e perché. Una regola di prudenza che vale su
   un elemento vale su tutti — il massivo non la annulla;
4. **l'anteprima elenca tutto** quello su cui si sta chiedendo il sì; se si taglia, si dichiara
   quante righe non sono mostrate. Un elenco troncato che sembra intero fa dire sì a cose mai viste;
5. **un tetto**, perché una scrittura di massa non deve poter scappare;
6. **se si interrompe a metà**, si dice quali sono già scritte. Nessun rollback improvvisato: su un
   gestionale fiscale peggiorerebbe.

### B8. 🚨 Un «annulla» che agisce sul documento sbagliato

> **Nato da:** il 12 settembre 2026. La tabella `cervellone_fic_pending` ha una colonna
> `fic_document_id`, e `elimina_bozza_fic` la usa per **cancellare** il documento da Fatture in
> Cloud. Legittimo finché il pending è una BOZZA NOSTRA; ma il nuovo tipo `pagamento_ricevuta` ci
> mette l'id della fattura **del fornitore**, che esiste indipendentemente da noi. Senza una guardia
> sul `tipo`, un «annulla» avrebbe **distrutto un documento fiscale altrui**. È la stessa forma del
> difetto del 10 settembre, quando *«ok annulla»* **creava** il documento.

Quando si aggiunge un tipo a una tabella di pending condivisa: **ogni ramo che legge quella riga va
riletto col nuovo tipo in mano** — la conferma, l'annullo, l'elenco, la conferma a voce. Un `if` sul
tipo che manca in uno solo di quei rami è un'azione applicata al documento sbagliato. E ogni guardia
così vuole accanto il **controllo positivo** che prova che sul tipo giusto l'azione avviene ancora
davvero (altrimenti il test è verde anche se la cancellazione è stata rimossa del tutto).

---

## C — I controlli sugli audit e sulle misure

### C1. ⭐ Il test non deve fingere via la cosa che copre

> **Nato da:** l'unico riferimento a `countValidPendingSends` nei test era
> `countValidPendingSends: vi.fn()`. **Il test aveva finto via proprio la funzione rotta**, e per
> tre mesi nessuno l'ha saputo.

Per ogni area con un difetto: **esiste un test che mocka la funzione che dichiara di coprire?**
Il mock va messo **un gradino più in basso** — si finge il database, non la funzione. E lo si finge
**severo**: se il database vero rifiuta una colonna inesistente, anche il finto deve rifiutarla.

### C2. ⭐ Lo strumento di misura va tarato prima di credergli

> **Nato da:** il censimento delle capacità diceva **«67 perse su 119»**. Era rotto **tre volte**:
> mancava il braccio di controllo (47 erano già irraggiungibili *prima*), il prompt non diceva al
> modello che i tool erano cercabili, e `max_tokens: 500` **troncava la risposta** prima dei
> risultati. Il numero vero era **cinque**.
> E il divisore 4 byte/token sottostimava il contesto del **46%**: quello vero è 2,72.

Prima di portare un numero come verdetto, tre domande:
1. **Controllo negativo** — lo strumento sa dire **no**? (Con gli strumenti vietati: 12 su 12 non
   raggiunti. **È l'unica ragione per cui gli altri numeri valgono qualcosa.**)
2. **Braccio di controllo** — quel valore c'era **anche prima** della modifica? Senza, non è
   attribuibile.
3. **Riproduce un risultato noto?** Se no, è lo strumento a essere rotto, non il mondo.

### C3. Un «controllo positivo» dichiarato e non vero

> **Nato da:** un commento scritto da me dichiarava «CONTROLLO POSITIVO» un test che provava solo
> che una funzione ritornava `undefined`. Il cavo che contava non era testato da niente.

Ogni commento che dichiara un controllo positivo va **verificato eseguendo la mutazione**. Se la
mutazione non uccide il test, il commento è una bugia nel codice.

### C4. L'audit non deve confrontare col piano

> **Nato da:** **quattro difetti su quattro**, l'11-12 settembre, stavano nel **piano**, non
> nell'esecuzione. Il codice combaciava col brief: era il brief a sbagliare.

L'audit avversariale va a chi **non ha scritto il codice** e **non confronta col piano**. La domanda
non è «fa quello che c'è scritto», è **«cosa si rompe il giorno che si accende»**.

### C5. Chi sorveglia i sorveglianti

> **Nato da:** l'autodiagnosi girava da **sei settimane**, trovava 2-4 anomalie a settimana,
> scriveva un rapporto **già impaginato per Telegram** — e faceva `console.log`. Dentro c'era la
> revisione scaduta del Ducato, vista dal **17 agosto**.

Per ogni automazione: **chi riceve il suo esito?** E soprattutto: **il silenzio vuol dire «tutto
bene» o «sono morto»?** Se sono indistinguibili, non è una rete di sicurezza. Il battito deve essere
**positivo**: si manda anche quando non c'è niente da dire.

---

## Il filo che lega tutto

Le voci sono **19** (`grep -c '^### '` — il 12 set 2026 questa riga diceva «diciotto» quando le
intestazioni erano **sedici**: un indice non aggiornato mente come un test vacuo, e il conto ora si
misura invece di ricordarlo). Di quelle, la maggior parte sono la stessa cosa detta in posti diversi:

> **Un guasto non deve poter passare per un'assenza, per un successo, o per una colpa
> dell'Ingegnere.**

È la classe di difetto che questo progetto paga di più — e l'unica difesa che funziona non è un test
in più: è **rendere impossibile la confusione**, con un tipo che il compilatore controlla o un
segnale messo dove il fatto accade.
