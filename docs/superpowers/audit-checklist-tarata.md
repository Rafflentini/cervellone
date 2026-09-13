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

### A7. Una seconda strada per scrivere il contenuto di un documento

> **Nato da:** il 12 settembre 2026, censendo `documents`: **28 punti** la toccavano, **10**
> inserivano, **cinque** scrivevano contenuto di documenti generato da Cervellone — e nessuno
> controllava la partita IVA. Fra questi, il preventivo. La cura è stata un imbuto unico,
> `src/lib/salva-documento.ts`; questo `grep` è la rete che si accorge se domani ne nasce un altro.

```bash
grep -rn "from('documents')" src --include=*.ts --include=*.tsx \
  | grep -v "\.test\." | grep -v "salva-documento.ts" \
  | grep -E "insert|update\(\{ ?content"
```

**Esito del 12 set 2026: 4 righe, 0 difetti.** Sono esattamente le tre esclusioni dichiarate
nel disegno: `src/app/api/projects/route.ts:371,380,437` (il digest di un file **caricato**
dall'Ingegnere — guardarlo bloccherebbe il caso normale, perché il capitolato di un cliente
nomina legittimamente la sua partita IVA) e `src/lib/sent-mail.ts:48` (copia di una mail già
spedita, non un documento compilato). Se questo `grep` un giorno desse una quinta riga fuori da
quell'elenco, è un nono punto di scrittura nato senza passare dall'imbuto.

**La regola:** un contenuto di documento si scrive da **un solo punto**. Ogni riga che questo
comando trova fuori dall'elenco delle esclusioni dichiarate è un imbuto bucato.

### A8. 🚨 Un dato societario scritto a mano fuori dal registro — ⚠️ il comando è TARATO, non cambiarlo a occhio

> **Nato da:** il 12 settembre 2026, undici punti cablavano «Restruktura S.r.l.» o la sua
> partita IVA fuori dal registro; un preventivo de La Real Estate usciva con l'intestazione di
> Restruktura. **La prima versione di questo `grep` cercava `RESTRUKTURA` maiuscolo e mancava
> tre difetti su undici**, perché i piedi di `studio-tecnico.ts` scrivono `Restruktura S.r.l.`
> in minuscolo. Servono `-i` **e** la tolleranza sui punti (`s\.?r\.?l`), perché la stessa
> ragione sociale è scritta `S.r.l.`, `S.R.L.`, `SRL` e `SRLS`.

```bash
grep -rniE "restruktura s\.?r\.?l|la real estate s\.?r\.?l" src --include=*.ts \
  | grep -vi "\.test\.\|spec\.ts\|__tests__" \
  | grep -v "societa.ts:\|identita.ts:"
```

**Esito del 12 set 2026 (prima della cura): 24 righe, 11 difetti** (i nove del disegno più i
due metadati che il `grep` stesso ha trovato e il conteggio a mano no) **e 13 legittime**
(tutto `checkin/*` — il check-in **è** l'attività de La Real Estate — l'identità e il blocco a
due società in `prompts.ts`, una descrizione di tool, un commento). **Esito del 13 set 2026,
dopo la cura, su questo ramo: 15 righe, 0 difetti** — tutte ricadono nell'elenco delle
legittime dichiarato nella spec: `checkin/*`, `drive.ts:1284` (descrizione di un tool),
`pdf-generator.ts:51,420` (commenti), `prompts.ts:130,141,149,190,191,225` (identità e blocco a
due società), `v19/render/utils.ts:110` (commento che ora **descrive** il vecchio difetto,
non lo riproduce). **Chi esegue questo controllo deve confrontarlo con l'elenco delle
legittime**, altrimenti conclude che ci sono 15 (o 24) difetti e non ne corregge nessuno.

**La regola:** un dato societario (ragione sociale, partita IVA) si scrive **una volta**, nel
registro. Ogni altra occorrenza è o un'esclusione dichiarata per iscritto, o un difetto.

### A9. Un `?? COSTANTE` dove `COSTANTE` è l'identità di un'entità reale

> **Nato da:** il 12 settembre 2026, `pdf-generator.ts:59` (`opzioni.societa ??
> SOCIETA_PREDEFINITA`) e `v19/render/utils.ts:110` (`text ?? "RESTRUKTURA … 02087420762 …"`).
> **Chi dimentica il parametro non sbaglia: prende un'identità in silenzio.** La cura non è un
> controllo a valle, è rendere il parametro **obbligatorio**, così l'omissione diventa un
> errore di compilazione invece di una stampa.

```bash
grep -rn '?? SOCIETA_PREDEFINITA\|?? DEFAULT_SOCIETA\|?? SOCIETA_DEFAULT' src --include=*.ts
grep -rn '?? [A-Z_]\{4,\}' src --include=*.ts | grep -v "\.test\."
```

**Esito del 13 set 2026: la prima riga dà 0 (la costante è stata eliminata, Task 5). La
seconda, più larga, dà 6 righe, 0 difetti** — tutte configurazioni legittime
(`DEFAULT_STATO`, `MAX_RUN_TOKENS`, `BUDGET_MS`, `SLEEP_MS`, `FETCH_TIMEOUT_MS`), non identità
di un'entità. Il confronto va fatto a mano: un `?? COSTANTE` è un difetto solo quando
`COSTANTE` rappresenta **chi siamo**, non **quanto aspettiamo**.

**La regola:** ogni fallback silenzioso su un'entità reale (una società, una persona, un
account) va promosso a parametro obbligatorio. Il compilatore, non la revisione, deve
accorgersi dell'omissione.

### A10. I metadati di un file generato — la guardia sul contenuto non li vede

> **Nato da:** il 12 settembre 2026, `pdf-generator.ts:653` e `:698` scrivevano «Restruktura
> S.r.l.» come `creator` di ogni PDF ed Excel, anche de La Real Estate. **Non li avevo contati
> a mano: li ha trovati il `grep` tarato di A8**, cercando la ragione sociale invece della sola
> partita IVA. Nessuna guardia che legge l'HTML li vede: i metadati non stanno nella pagina,
> stanno nelle proprietà del file.

```bash
grep -rniE "creator:.*restruktura|creator\s*=\s*.*restruktura|workbook\.creator" src --include=*.ts
grep -rniE "(creator|author|title|company)\s*[:=].*(restruktura|real estate)" src --include=*.ts | grep -vi "\.test\."
```

**Esito del 13 set 2026: 1 riga sulla prima ricerca, 0 sulla seconda — 0 difetti.** L'unica
riga che resta è `pdf-generator.ts:760`, ed è la **cura**: `` `Cervellone — ${opzioni.societa.denominazione}` ``, interpolata dai dati e non più cablata.

**La regola:** ogni generatore di PDF, Word o Excel va controllato anche sui **metadati**
(`creator`, `author`, `title`, `company`), non solo sul testo visibile.

### A11. Un `_` che viaggia con `parse_mode: 'Markdown'` mangia se stesso

> **Nato da:** il 12 settembre 2026, `messaggioBlocco` nominava `imposta_societa_attiva` nel
> testo di un blocco spedito su Telegram con `parse_mode: 'Markdown'`. Due underscore nello
> stesso messaggio delimitano il corsivo e **si mangiano**: all'Ingegnere arrivava
> `impostasocietaattiva`, un nome che non esiste. Seconda ricorrenza della stessa giornata
> dopo i comandi con codice (`/invia_<uuid>` troncato al primo trattino).
> **Prima misura, inutilizzabile:** «stringhe con ≥2 underscore» → 256 righe, quasi tutto
> rumore SQL/log. **Seconda misura:** solo gli identificatori snake_case **nudi** (fuori da un
> code span, che il Markdown non tocca) → 49. La terza distinzione, quella che conta davvero:
> il destinatario è **il modello** (l'underscore non gli fa danno) o **l'Ingegnere via
> Telegram** (gli arriva mutilato)?

```bash
grep -rnE "(cervellone_|memoria_[a-z_]*rielabora)[a-z_]*" \
    src/app/api/cron src/lib/audit-analyzer.ts src/lib/guardia-societa.ts --include=*.ts \
  | grep -v "\.test\." \
  | grep -vE '`[^`]*(cervellone_|memoria_[a-z_]*rielabora)[a-z_]*[^`]*`' \
  | grep -vE '\$\{|\.from\(|\.eq\(|const |let |tabella:|description:.*\.$'
```

**Esito del 13 set 2026: 6 righe, 2 difetti ancora aperti, 4 legittime.** Le 4 legittime sono
commenti di codice (`*`/`//`), che l'Ingegnere non legge su Telegram. I 2 difetti veri, **non
corretti in questo lavoro e dichiarati nei punti aperti**: `src/app/api/cron/monthly-foreign-invoices/route.ts:91` (`cervellone_email_senders` dentro l'avviso che spiega **perché** non
sono arrivate fatture) e `src/lib/audit-analyzer.ts:264` (`memoria_giornate_da_rielaborare` /
`memoria_rielabora`, due nomi nella stessa stringa — il caso della coppia che si mangia a
vicenda — dentro un rapporto di autodiagnosi che **ora viene consegnato**, quindi da oggi
l'Ingegnere lo legge davvero). ⚠️ **Il comando resta ristretto ai soli file che compongono
messaggi per l'Ingegnere** (cron, `audit-analyzer.ts`, `guardia-societa.ts`): esteso a tutto
`src` dà 69 risultati, quasi tutti nomi di tabella/tool che il modello legge e l'Ingegnere no
(cookie di sessione, dichiarazioni di tool in `comandi-uuid.ts`, `self.ts`, `mappa-officina.ts`,
`scadenze-tools.ts`) — un secondo esempio della stessa lezione di A8: un `grep` va ristretto al
**destinatario**, non solo alla forma del testo.

**La regola:** un identificatore con underscore destinato a un messaggio Telegram va o
racchiuso in un code span (`` ` ``), o riscritto senza underscore. Un nome di tool o di tabella
non si scrive mai nudo in un messaggio all'Ingegnere.

### A12. Un filtro in memoria dopo una query paginata, con la paginazione letta sull'insieme sbagliato

> **Nato da:** il 12 settembre 2026, `cercaFattureRicevute` (allora in `fic-pagamenti.ts:268-291`)
> chiedeva a FIC la prima pagina di **tutte** le fatture ricevute e filtrava il fornitore **in
> memoria**, ma leggeva `last_page` dall'insieme **non filtrato**. Conseguenza doppia: il tool
> rifiutava sempre (Restruktura riceve più di 100 fatture l'anno → `last_page > 1` → rifiuto,
> anche per 7 fatture) **e**, se il rifiuto non fosse scattato, un sottoinsieme sarebbe stato
> presentato come l'insieme intero. Il commento del file dichiarava l'invariante giusta venti
> righe sopra: *il ragionamento era giusto e l'implementazione lo violava.*

```bash
for f in $(grep -rl "last_page" src/lib --include=*.ts); do
  if grep -q "\.filter(" "$f"; then echo "CANDIDATO: $f"; grep -n "last_page\|\.filter(" "$f"; fi
done
```

**Esito del 13 set 2026: 2 file candidati, 0 difetti vivi.** `src/lib/fic-pagamenti.ts` è già
la cura (Task 13, commit `5f718f5`): cammina sulle pagine, filtra **dentro** il ciclo, e
`elenco_troncato` (righe 305-327) si calcola su `pagineLette`/`ultimaPagina`, cioè
sull'insieme **che si è davvero letto**. `src/lib/fic-write-tools.ts:763-767` ha `.filter(`
vicino a un `last_page` (riga 156, un caso diverso — `parseAliquotaFic`), ma il filtro lì
lavora su un elenco **già** completo e verificato non-troncato dai controlli precedenti
(righe 727-734): non è la stessa classe di difetto. Ogni candidato futuro va letto per
verificare **quale** insieme legge `last_page`/`total`, non solo se le due righe coesistono
nel file.

**La regola:** quando una funzione pagina **e** filtra, `last_page`/`total` vanno letti
**dopo** il filtro, o dentro un ciclo che li ricalcola pagina per pagina — mai sulla risposta
grezza di una sola pagina non filtrata.

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

### B9. 🚨 Un dato copiato nel prompt è una copia che invecchia

> **Nato da:** il 12 settembre 2026. Il `BASE_PROMPT` non sapeva nulla de LA REAL ESTATE S.R.L.S. —
> né il nome, né il CF, né cosa facesse — e l'Ingegnere ha dovuto dire lui al bot dove salvare i
> documenti, e ripeterglielo. Rimediare scrivendo i dati nel prompt **crea il difetto opposto**: il
> giorno che cambia una sede, un amministratore o un'aliquota, il prompt resta indietro e il bot
> riferisce il dato vecchio **con sicurezza** — che è peggio del non saperlo.

Ogni dato anagrafico, fiscale o di configurazione **scritto a mano nel prompt** è una copia di una
fonte che vive altrove (una visura, il Drive, una tabella). Tre cose vanno dichiarate nel testo
stesso, non lasciate al caso:

1. **dov'è la fonte autorevole** e con quale tool la si raggiunge — mai un id di cartella cablato,
   che una riorganizzazione rompe: un tool di ricerca sopravvive, un id no;
2. **quando vale la copia** (orientarsi subito, gratis) e **quando serve la fonte** (un dato che
   finisce in un atto, un contratto, una pratica);
3. **chi vince in caso di contraddizione** — e la precedenza va scritta, con un'asserzione nel test
   che la pinza (qui: `VALE LA VISURA`). Aggiungi l'obbligo di **segnalarlo all'Ingegnere**: è il
   solo modo in cui la copia vecchia si fa aggiornare invece di restare una bugia.

Corollario: una entità che il bot deve **conoscere** ma su cui non deve **agire** (la partita IVA
personale dell'Ingegnere, di cui non emette fatture) va messa **solo nella conoscenza**, non nel
registro dei percorsi di scrittura (`src/lib/societa.ts`). Un registro attira credenziali; il
prompt no. E il divieto va asserito nei test come si asserisce un dato.

---

### B10. Una funzione non può restituire lo stesso valore per «assenza nota» e per «guasto»

> **Nato da: terza ricorrenza in due giorni.** Le mail pending (`pending.ts:109`, 12 set: un
> `error` di database diventava «zero bozze»), i prefissi UUID (11 set), la società attiva
> (12 set: `getSocietaAttiva` su errore di database restituiva Restruktura, esattamente come se
> l'Ingegnere l'avesse scelta). **Quando una classe torna tre volte, il controllo va fatto per
> costruzione — un tipo unione a due o tre varianti — non per revisione**: la revisione l'ha già
> mancata tre volte.

Per ogni funzione il cui risultato finisce in un documento, un pagamento o una dichiarazione:
il tipo di ritorno distingue esplicitamente *«non c'è nulla»* da *«non sono riuscito a
saperlo»*? Se il `catch` e il caso vuoto tornano la stessa forma, è questa classe. Il `grep`
meccanico è **A1**; questa voce è il principio che lo genera, e vale anche dove A1 non arriva
(un `catch` che non contiene la parola `return` in quella forma esatta).

### B11. Una guardia va valutata anche su come si ottiene il valore «atteso»

> **Nato da:** il 12 settembre 2026. La guardia sui dati societari confrontava l'intestazione
> del documento con `attesa`, e `attesa` veniva da `getSocietaAttiva` — che su errore di
> database restituiva Restruktura. Se la lettura fosse fallita mentre l'Ingegnere lavorava su
> La Real Estate, la guardia avrebbe confrontato Restruktura con Restruktura e **dichiarato
> conforme un documento sbagliato**. Una guardia che si fida di un dato indovinato non è una
> guardia: è la stessa bugia, con un timbro sopra.

Per ogni guardia che confronta il contenuto con un valore «atteso»: quel valore, quando la sua
fonte fallisce, **rifiuta** o **indovina**? Se indovina, la guardia eredita quel guasto — e lo
fa apparire come un successo, perché il confronto torna vero. La cura è la stessa di B10: un
tipo che distingue il dato letto dal dato assunto, e il percorso guardato usa **solo** la
variante che rifiuta.

### B12. Una guardia copre una FORMA del dato, non il dato — dichiararlo per iscritto

> **Nato da:** il 12 settembre 2026. La guardia sui dati societari cerca le **partite IVA**;
> tre degli undici punti cablati (i piedi del preventivo, del CME e del quadro economico)
> portano **solo la ragione sociale**, senza partita IVA — e per quei tre la guardia **non li
> vedrebbe mai**. Corretti alla fonte nello stesso lavoro (Task 7), ma se domani nasce un
> dodicesimo piede con la sola ragione sociale, nessun controllo automatico lo trova: solo il
> `grep` A8, se qualcuno lo esegue.

Ogni guardia dichiara, nella stessa riga in cui dichiara cosa copre, **la forma esatta** che
cerca (una partita IVA, una stringa esatta, un pattern) e nomina esplicitamente le forme
equivalenti che **non** cerca. Una guardia che promette «i dati societari sono protetti» mentre
copre solo un formato promette più di quanto fa — ed è il documento `cosa-NON-copre.md` di
questo stesso lavoro l'esempio di come si scrive questa dichiarazione: un elenco onesto dei
buchi, consegnato insieme al lavoro.

### B13. Un'istruzione all'Ingegnere va scritta valida su ENTRAMBI i canali

> **Nato da:** il 12 settembre 2026, la stessa riga di A11. `messaggioBlocco` doveva dire
> all'Ingegnere come sciogliere il blocco. Nominare `/societa` sarebbe stata un'istruzione
> **sbagliata sul web**, dove i comandi slash nudi non esistono (`telegram/route.ts:557` è
> l'unico che li gestisce); nominare `imposta_societa_attiva` è un'istruzione che **nessun
> umano esegue**, ed è pure mutilata su Telegram (A11). La correzione: *«dimmi su quale
> società stiamo lavorando e la sistemo»* — valida su entrambi per costruzione, perché non
> nomina né un comando né una funzione.

Per ogni messaggio che dice all'Ingegnere **cosa fare**: l'istruzione regge se la legge sul web?
Regge se la legge su Telegram? Se la risposta cambia fra i due canali (un comando slash, un
nome di tool, un tasto che esiste solo in un'interfaccia), l'istruzione non è pronta — va
riscritta come un'azione in linguaggio naturale che il modello sa eseguire su entrambi.

### B14. Un tool che espone un campo «di sistema» e un campo «del documento» deve nominare la differenza

> **Nato da:** il 12 settembre 2026, le tre ore su Limongi. `payment_account` (il conto con
> cui **noi** abbiamo registrato il pagamento) e `ModalitaPagamento` SDI (quello che ha scritto
> il **fornitore** sulla fattura) sono due dati diversi. Il tool restituiva solo il primo, il
> bot ha riportato l'assenza del primo come assenza del secondo, ed è arrivato a dire *«nel
> corpo di questa fattura non c'è scritta nessuna modalità di pagamento»* — un'affermazione sul
> **contenuto della fattura**, fatta guardando un campo che non è il contenuto della fattura.
> **Non è un difetto di lettura: è un difetto di significato.**

Per ogni tool il cui risultato mescola un dato **nostro** (una registrazione, uno stato interno)
con un dato **altrui** (quello che un terzo ha scritto sul documento): il risultato nomina la
differenza esplicitamente (due campi con nomi che non si confondono, o un commento che il
modello legge)? Se no, un'assenza dell'uno diventa — con sicurezza — un'assenza dell'altro.

### B15. Un rifiuto con due cause diverse vuole due messaggi diversi

> **Nato da:** il 12 settembre 2026. `fic-write-tools.ts:711` rifiutava sia per «troppe
> fatture» sia per «FIC le dà su più pagine, non le vedo tutte» con **un solo messaggio**,
> quello del tetto. Con 7 fatture trovate (ma più pagine da leggere) il bot ha letto *«la
> selezione tocca più di 7 fatture, oltre il tetto di 50»* e l'ha riferito come *«7 non supera
> 50, il messaggio sembra bacato»* — aveva ragione: un rifiuto che dichiara il motivo sbagliato
> manda a caccia del problema inesistente.

Per ogni `return fail(...)`/`if (...) return`  con più di una condizione nell'`if`: ogni causa
ha il **suo** messaggio, che nomina il numero o il fatto vero di quella causa? Un `||` fra due
condizioni con un solo template di errore è il sospetto da cercare.

### B16. Un'autoaccusa del modello vale come dato solo se è VERIFICATA

> **Nato da:** il 12 settembre 2026. Contraddetto dall'Ingegnere, il bot ha scritto *«Ha
> ragione a insistere — esiste un tool e non l'avevo usato, mi scuso per l'errore»* — **si è
> scusato per un errore che non aveva commesso**: il tool era stato introdotto (`7e7fcff`,
> 14:42:59 UTC) **dopo** le sue due risposte (14:17 e 14:25 UTC) che dicevano di non averlo.
> Diceva la verità due volte. **Io stesso avevo già contato quella confessione come un difetto,
> prima di guardare le date** — un quarto difetto che non esisteva, nello stesso rapporto che
> ne elencava tre veri.

Ogni volta che un rapporto cita un'autoaccusa o una scusa del bot come **prova** di un difetto:
va datata contro i commit (`git log`) e contro `cervellone_tool_calls`/`messages` **prima** di
trattarla come un fatto. Un modello contraddetto tende a concedere; una concessione registrata
diventa, mesi dopo, la prova di un difetto che non c'era.

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

### C6. Una guardia si valuta su DUE prove, mai una

> **Nato da:** la guardia `.docx`, 3 settembre 2026, che bloccava il caso normale. Ripetuto e
> misurato bene il 12 settembre sulla guardia dei dati societari: la mutazione che disattiva il
> cross-check CIGO lascia **verde** il test del caso normale (Restruktura attiva su pratica
> Restruktura) — prova diretta che quel test passa per merito suo, non per merito della guardia.

Ogni guardia porta **due** controlli, mai uno solo: il caso vero **morde** (mutazione che la
disattiva → il test che dovrebbe accorgersene muore) **e** il caso normale **passa** (lo stesso
test, senza la mutazione, non blocca un documento legittimo). Un solo controllo dei due prova
solo metà della promessa.

### C7. Un imbuto DICHIARATO non è un imbuto MISURATO

> **Nato da:** il 12 settembre 2026. Il primo disegno della guardia sui dati societari la
> metteva in `generatePdfFromHtml`, «l'unico imbuto». Falso: `genera_preventivo_completo`
> scrive la riga in `documents` **da solo**, senza passare da lì — il preventivo, cioè il
> documento che l'Ingegnere aveva nominato, non sarebbe stato protetto. Trovato dalla scansione
> pre-volo del piano, non dai test.

Prima di mettere un controllo «nel punto per cui passa tutto»: **contare** i punti con un `grep`
(vedi A7). Un imbuto che si dichiara guardando l'architettura e non l'inventario reale delle
scritture è una supposizione, non una misura.

### C8. Un controllo proposto e NON ESEGUITO non è un controllo

> **Nato da:** il 12 settembre 2026. Ho proposto la versione maiuscola di A8
> (`grep -rn "RESTRUKTURA\|LA REAL ESTATE"`) senza eseguirla: mancava **un terzo** dei difetti,
> perché tre piedi scrivono `Restruktura` in minuscolo. Un controllo che dà un falso verde è
> peggio di nessun controllo, perché mente sul fatto di esserci — ed è lo stesso errore che
> questa lista esiste per prevenire, commesso mentre la scrivevo. **Ricorso il 13 settembre**,
> scrivendo questo stesso Task 8: la prima idea per A11 (grep su tutto `src`) dava 69 righe di
> rumore prima di essere ristretta ai file giusti — tarata **prima** di entrare in lista, non
> dopo.

Ogni `grep` che entra in questa lista va **lanciato prima di scriverlo qui**, e accanto va
annotato quante righe dà **oggi** e quante di quelle sono difetti. Una voce senza quel numero
non è verificabile: al prossimo giro nessuno sa se il conteggio sia normale o un'emergenza.

### C9. Un `vi.mock` che fornisce MENO export di quelli che il modulo esporta

> **Nato da:** il 12 settembre 2026. **Prima misura, rotta:** lo strumento
> `misura-mock-parziali.js` diceva «16 mock parziali su 16, il 100% degli export mancanti» —
> implausibile, perché i test passavano. Bilanciava le parentesi partendo da quelle **vuote**
> della arrow function `() => ({ … })` e catturava `()`. Tarato, ha dato il dato vero: **23 mock
> parziali sui due test di canale, 79 export mancanti in totale**, e due esplosioni in avvio
> nella stessa serata (`chat/route.comandi.test.ts` senza `leggiSocietaAttiva`, Task 3;
> `telegram/route.comandi.test.ts` senza `societaPerDocumento`, previsto e confermato nel
> Task 4) — entrambe scambiabili per regressioni del codice.
> **Il fatto più grave:** i due test di canale mockano **insiemi di moduli diversi** (solo il
> web mocka `claude`/`prompts`/`working-memory`, solo Telegram mocka
> `telegram-helpers`/`memory`/`trascrizione`/`resilience`) — non sono lo strumento con cui si
> può dimostrare l'equipollenza web↔Telegram, perché misurano cose diverse.

```bash
node .superpowers/sdd/2026-09-12-guardia-dati-societari/misura-mock-parziali.js \
  src/app/api/chat/route.comandi.test.ts
node .superpowers/sdd/2026-09-12-guardia-dati-societari/misura-mock-parziali.js \
  src/app/api/telegram/route.comandi.test.ts
```

**Esito del 13 set 2026 (rieseguito):** `chat/route.comandi.test.ts` → **4 completi, 12
parziali, 42 export mancanti**; `telegram/route.comandi.test.ts` → **6 completi, 11 parziali,
36 export mancanti**. Non bonificato (condizione preesistente diffusa, allargherebbe qualunque
task che lo tocchi fino a renderlo irreviewabile): resta un lavoro a parte, misurabile con
questo stesso comando.

**La regola:** un `vi.mock('@/lib/modulo', () => ({ ... }))` scritto a mano marcisce quando il
modulo cresce. La forma che non può diventarlo è lo spread di `importActual`:
```ts
vi.mock('@/lib/modulo', async (orig) => ({
  ...(await orig<typeof import('@/lib/modulo')>()),
  funzioneDaFingere: vi.fn(),
}))
```

### C10. Ogni mutazione vuole un `grep -c` che provi il morso — e i template literal si spezzano attorno al `$`

> **Nato da:** il 12 settembre 2026. Mutando `input.azienda.denominazione` interpolato in un
> template literal, `perl -0pi -e 's/\Q…${input.azienda.denominazione}…\E/…/'` **non ha
> morso**: perl interpola `${input...}` come variabile **prima** di applicare `\Q...\E`, quindi
> il pattern cercava una stringa che non esiste. La suite è rimasta verde, e senza il `grep -c`
> avrei letto quel verde come «mutazione sopravvissuta» — cioè il **contrario** del vero: un
> falso verde travestito da prova. È il sesto strumento che ha mentito in quella serata.

**La forma corretta**, quando la riga da mutare contiene un template literal, spezza `\Q…\E`
attorno al `$` e scrive il `$` come `\$`:
```bash
perl -0pi -e 's/\Qprefisso \E\$\Q{espressione} suffisso\E/nuovo/' file
```

**La regola, in due parti:** (1) ogni mutazione va accompagnata da `grep -c` sul file mutato,
che provi che la sostituzione ha colpito **esattamente** le occorrenze attese — senza, non si
distingue «mutazione sopravvissuta» (il codice regge) da «pattern che non ha morso» (il test
non ha provato niente). (2) se la riga contiene `${…}`, il pattern `perl` va spezzato attorno
al `$` come sopra, altrimenti non morde mai.

---

## Il filo che lega tutto

Le voci sono **38** (`grep -c '^### '` — il 12 set 2026 questa riga diceva «diciotto» quando le
intestazioni erano **sedici**: un indice non aggiornato mente come un test vacuo, e il conto ora si
misura invece di ricordarlo; erano **20** prima del Task 8, che ne ha aggiunte **18**: A7-A12,
B10-B16, C6-C10). Di quelle, la maggior parte sono la stessa cosa detta in posti diversi:

> **Un guasto non deve poter passare per un'assenza, per un successo, o per una colpa
> dell'Ingegnere.**

È la classe di difetto che questo progetto paga di più — e l'unica difesa che funziona non è un test
in più: è **rendere impossibile la confusione**, con un tipo che il compilatore controlla o un
segnale messo dove il fatto accade.
