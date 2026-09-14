# Le caselle di posta sono quattro — design

*14 settembre 2026*

## Perché

La segretaria deve poter leggere anche la posta di **La Real Estate**
(`larealestate.amministrazione@gmail.com`). Il caso che ha fatto nascere il lavoro: *«sono arrivate
fatture da Booking?»* — su Fatture in Cloud La Real Estate ha quattro fatture ricevute e **nessuna
è Booking**, quindi o non ne sono arrivate o stanno in quella casella e non le ha mai raccolte
nessuno.

La credenziale OAuth **c'è già**: autorizzata e verificata il 14 set 2026 alle 13:01
(`google_oauth_credentials` ha due righe). Manca il codice che la usa.

### Lo stato di partenza, misurato

- **Cinque** punti aprono un client Google e hanno tutti la società **cablata**:
  `gmail-tools.ts:66`, `drive.ts:22`, `calendar-tools.ts:36`, `document-saver.ts:93`,
  `hallucination-validator.ts:121`. In `gmail-tools.ts` c'è perfino il commento di una sessione
  precedente: *«nel Task 4 arriverà dalla società attiva… leggere quella sbagliata significa
  cercare fatture inesistenti»*. Il Task 4 non è mai arrivato.
- **Nessuno dei 16 tool `gmail_*`** accetta una casella o una società.
- Il prompt (`prompts.ts:260-262`) **elenca tre caselle** e dice (`:281`) che i tool Gmail lavorano
  su `restruktura.drive@gmail.com`.
- ⚠️ **Questa è la difesa che oggi funziona.** Alla domanda sulla posta di LRE il bot ha risposto
  *«non ho accesso a quella casella»* ed era corretto — **ma la difesa sta nel prompt, non nel
  codice**. Ha tenuto. È un dato, non una garanzia.

### Due mezzi registri che non si parlano

`societa.ts` è il registro delle **società**. `v19/tools/email/config.ts:12` definisce
`AccountKey = 'info' | 'raffaele'`, cioè un registro delle **caselle TopHost**. Gmail non sta in
nessuno dei due. Aggiungere una quarta casella senza unificare creerebbe il **terzo** posto dove la
stessa verità è scritta in modo diverso — la ferita che in questo repo si riapre di continuo (la
sede di Restruktura in due forme, undici copie della guardia dei cron, l'elenco delle automazioni).

## Le tre decisioni prese (Raffaele, 14 set)

1. **In lettura le caselle sono quattro e si guardano tutte.** Una segretaria che cerca le fatture
   Booking le cerca dappertutto, non «prima in una società e poi nell'altra».
2. **In scrittura la casella va SEMPRE detta, mai dedotta.** Stessa regola già in vigore per le
   società (`risolviSocieta` torna `null` apposta) e per la data di un bonifico.
3. **Solo la posta.** Drive, Calendar, salvataggio documenti e validatore restano su Restruktura.

## Architettura

### 1. `src/lib/caselle.ts` — il registro

Sul modello di `societa.ts`: **registro in CODICE**, revisionabile in una pull request, e **mai il
segreto** — si dichiara come si chiama la chiave, non il suo valore.

Quattro voci, ciascuna con: chiave breve, indirizzo, **trasporto** (`tophost` | `google`),
**società** di appartenenza, e per le due Google il `accountEmail` con cui cercare la riga in
`google_oauth_credentials`.

| chiave | indirizzo | trasporto | società |
|---|---|---|---|
| `info` | info@restruktura.it | tophost | restruktura |
| `raffaele` | raffaele.lentini@restruktura.it | tophost | restruktura |
| `drive` | restruktura.drive@gmail.com | google | restruktura |
| `larealestate` | larealestate.amministrazione@gmail.com | google | larealestate |

Le chiavi `info` e `raffaele` sono **le stesse** di `AccountKey`: il registro nuovo le assorbe
invece di inventarne altre, altrimenti nasce il quarto posto dove la verità è scritta diversa.

### 2. Lettura: tutte e quattro, e si dice sempre DOVE

I tool di lettura accettano un elenco di caselle **facoltativo**; assente = tutte quelle che il
trasporto di quel tool sa aprire. **Ogni risultato porta la casella di provenienza**: senza, «ho
trovato tre mail da Booking» è monca — non si saprebbe in quale società sono arrivate, che è metà
della risposta.

⚠️ **«Tutte e quattro» attraversa due trasporti, e va detto come.** I tool `gmail_*` sanno aprire
solo le due caselle Google; `info@` e `raffaele.lentini@` stanno dietro i tool TopHost (V19). Non
esiste oggi, e **non si costruisce qui**, un tool unico che le attraversi tutte: sarebbe un
diciassettesimo tool che duplica la logica dei sedici.

La scelta è: **ogni trasporto guarda per difetto tutte le proprie caselle** (i tool Gmail entrambe
le Google, invece dell'unica di oggi), e il fatto che una ricerca «nella posta» significhi
**entrambi i trasporti** è una **regola di prompt** — con la sua prova misurata in
`src/prove/esegui.ts`, come «ABBINA TU» (0/3 senza la regola, 3/3 con).

È una difesa morbida, e lo si dice invece di fingere il contrario: se il modello dimentica un
trasporto, cerca in due caselle su quattro. La si accetta perché il danno è **un risultato
incompleto**, non un'azione sbagliata — e il risultato incompleto è riconoscibile, perché ogni
risultato dichiara da quale casella viene. Per la **scrittura**, dove il danno è irreversibile, la
difesa resta nel codice (punto 3). ⚠️ Se la prova misurata dovesse restare sotto il 3/3, allora il
tool unico va costruito: la regola non basterebbe.

⚠️ **Una casella che non risponde non può sparire in silenzio.** Se una delle quattro fallisce (token
morto, IMAP giù), il risultato lo **dice**, e non si limita a restituire quello che ha trovato
altrove. Un elenco parziale che sembra completo è il difetto di famiglia di questa casa: quattro
mesi di fatture estere a zero, sei rapporti di autodiagnosi mai consegnati.

### 3. Scrittura: la casella è obbligatoria, e il rifiuto sta nel CODICE

Bozze, invii, etichette, archiviazione, cestino: senza `casella` il tool **si rifiuta** e
restituisce l'elenco delle quattro chiedendo quale.

- **Nessun predefinito.** In particolare **non** «quella dove ho letto»: rispondere da LRE a una
  mail trovata su LRE sembra ovvio, ma il giorno in cui il bot ha letto in tre caselle la scelta
  l'ha fatta lui e non l'ha vista nessuno.
- 🚨 **Il rifiuto sta nel tool, non nel prompt.** Per la lettura una regola di prompt basta — e oggi
  ha tenuto. Per la scrittura no: dev'essere impossibile da aggirare anche se un giorno il modello
  legge male la propria regola. **Una mail partita dall'indirizzo sbagliato non si richiama
  indietro**, e arriva a un cliente firmata da un'altra società.

### 4. Quello che resta fermo — ma smette di essere un caso

Drive, Calendar, `document-saver`, `hallucination-validator` continuano su Restruktura. Cambia
**come** è scritto: non più `getSocieta('restruktura')` sparso in quattro file, ma una costante con
un nome e accanto il motivo — *«i file e il calendario restano di Restruktura finché non si decide
dove vanno quelli di La Real Estate»*.

Non è estetica: oggi quel `'restruktura'` **sembra una svista**, e chi passa di lì è tentato di
«sistemarlo» senza sapere che sposterebbe i documenti generati in un altro Drive — un errore
fisico, silenzioso, di cui ci si accorge settimane dopo cercando un file.

### 5. `google_token_dead` diventa per account

Oggi è **una bandierina sola** per due account, e la scrivono i cron Gmail
(`gmail-alerts/route.ts:10`, `gmail-morning/route.ts:10`) guardando **solo** Restruktura. Se
morisse il token di La Real Estate non lo saprebbe nessuno: con due account e un interruttore solo,
il secondo è cieco **per costruzione**.

### 6. La prova di vita — il battito che manca

Un tool che **esercita ogni riga** di `google_oauth_credentials` (`getAuthorizedClient` fa già la
prova: `google-oauth.ts:266`, `getAccessToken()`) e dice quale credenziale è viva.

Serve perché oggi alla domanda *«la casella di LRE funziona?»* **non sa rispondere nessuno**. La
credenziale è salvata ma non è mai stata esercitata: l'email mostrata dal callback viene da un
**decode locale** del JWT (`google-oauth.ts:102`), non da una chiamata a Google. Il token c'è; che
funzioni è un'ipotesi.

⚠️ E deve parlare **anche quando va tutto bene**. Un sorvegliante che si fa vivo solo nei guai è
indistinguibile da uno morto — il 14 settembre questo ha impedito per quattro tentativi di sapere
se i cron girassero ancora dopo un deploy.

### 7. Il prompt cambia nello STESSO commit

`prompts.ts:260-262` elenca tre caselle e `:281` nomina l'account dei tool Gmail. Il giorno in cui
il codice ne conosce quattro e il prompt ne dichiara tre, il bot **rifiuta una posta a cui ha
accesso**: si passerebbe da un difetto al suo opposto.

## Prove

- **Registro**: le quattro voci esistono, le chiavi TopHost combaciano con `AccountKey` (un test le
  confronta: due elenchi della stessa cosa divergono al primo cambiamento).
- **Lettura**: senza caselle indicate le guarda tutte; ogni risultato porta la provenienza; una
  casella che fallisce **compare nell'esito** invece di sparire.
- **Scrittura**: senza `casella` il tool rifiuta. 🚨 **Controllo positivo obbligatorio**: con la
  casella indicata, scrive davvero — senza, un tool che rifiuta SEMPRE passerebbe il test.
- **Mutazioni**: togliere il rifiuto sulla scrittura ⇒ rosso; far sparire in silenzio una casella
  che fallisce ⇒ rosso; riportare `google_token_dead` a bandierina unica ⇒ rosso.
- **Regola di prompt misurata** con `src/prove/esegui.ts`, come si è fatto per «ABBINA TU» (0/3
  senza la regola, 3/3 con): un caso in cui la casella non è nominata e il bot **deve chiedere**
  invece di scegliere.
- **In produzione**, dopo il deploy: la prova di vita deve dire che **entrambe** le credenziali sono
  vive. Se dice che lo è solo Restruktura, abbiamo scoperto che il token di LRE non funziona — che
  è comunque una risposta, ed è quella che oggi non abbiamo.

## Fuori da questa spec, e detto apposta

- **Il Drive e il Calendar di La Real Estate.** Quando serviranno, sarà un lavoro suo: sposta file
  di posto e va deciso, non dedotto.
- **Raccogliere le fatture Booking.** È il motivo per cui questo lavoro esiste, ma è un lavoro
  separato — e appartiene al filone già aperto delle autofatture TD17 e delle fatture Booking.
- **Restringere gli scope OAuth di LRE** (oggi include `gmail.send` e Drive **completo**):
  richiederebbe un ri-consent di **entrambi** gli account.
- **Il battito positivo dei cron.** Fratello stretto del punto 6, ma è suo.
