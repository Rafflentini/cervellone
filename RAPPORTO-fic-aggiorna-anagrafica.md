# `fic_aggiorna_anagrafica` — rapporto

15 settembre 2026. Worktree `agent-aa8091137e2ba8dcc`, ramo di lavoro locale.

## Cosa c'era e cosa c'e' adesso

Cervellone sapeva CREARE un'anagrafica (`fic_crea_cliente`) e CERCARLA
(`fic_cerca_anagrafica`). Non sapeva correggerla: davanti a una scheda con un
dato sbagliato l'unica strada praticabile era crearne un'altra, cioe'
fabbricare un DOPPIONE — il difetto che `fic-anagrafica.ts` esiste per
impedire.

Adesso c'e' `fic_aggiorna_anagrafica`: modifica una scheda cliente o fornitore
che esiste gia', correggendo **solo** i campi passati.

### Il meccanismo, in ordine

1. **rifiuta senza `id` e senza `elenco`** (nessuna lettura, nessuna
   scrittura): non si cerca per nome per modificare «il primo che capita», e
   non si indovina se un soggetto sia cliente o fornitore;
2. **rilegge la scheda intera** da `GET /c/{id}/entities/{clients|suppliers}/{id}`;
3. **calcola cosa cambia sui dati VERI**: un campo non passato non entra nel
   giro, un campo passato vuoto finisce fra gli ignorati e viene dichiarato, un
   campo gia' uguale non fa scrivere niente;
4. **guardia sull'identita' fiscale** (sotto);
5. **rispedisce l'oggetto COMPLETO** con sopra le sole modifiche
   (`PUT .../entities/{elenco}/{id}`), meno `id`, `created_at`, `updated_at`;
6. **rilegge** e confronta: modifiche confermate, modifiche NON confermate,
   campi cambiati fuori dalla richiesta, chiavi fiscali mosse da sole;
7. l'esito `ok` e' vero **solo** se la rilettura conferma tutto.

Il punto 5 e' la conseguenza diretta del vincolo citato in testa a
`fic-pagamenti.ts`: la documentazione di FIC **non dichiara** se il PUT
sostituisca l'entita' o accetti un payload parziale. Rispedire tutto e'
l'unica forma il cui esito e' identico sotto entrambe le semantiche. Se un
giorno FIC lo documentera', il commento nel codice dice cosa riaprire.

## Le decisioni che ho preso io

### 1. Sul cambio di partita IVA / codice fiscale: **si ferma e chiede**

La consegna lasciava la scelta. Ho scelto il rifiuto, con una via d'uscita
esplicita (`conferma_cambio_identita: true`), e non «esegui e dichiaralo»:

- «eseguire dichiarandolo» dichiara un danno **gia' fatto**: se la P.IVA nuova
  e' di un altro soggetto, le fatture di quella scheda sono gia' intestate a
  qualcun altro nel momento in cui il messaggio viene scritto;
- il rifiuto costa un turno ed e' recuperabile a costo zero;
- il difetto di famiglia di questo repo e' «il guasto che invece di chiudere
  APRE»: nel dubbio, qui, la strada larga.

La guardia scatta **solo se il campo aveva gia' un valore diverso**. Riempire
una P.IVA vuota non chiede niente — e' il caso normale di una scheda
incompleta, ed e' meta' del motivo per cui il tool esiste. Una guardia che
bloccasse anche quello sarebbe peggio del buco che chiude.

Quando il cambio viene confermato, l'esito lo dice comunque forte, con nome,
valore vecchio e valore nuovo.

### 2. Una chiave fiscale che si muove da sola e' un esito NEGATIVO

Se la rilettura mostra `tax_code`/`vat_number` cambiati **senza** che nessuno
li avesse chiesti, `ok` e' falso. Non e' un'avvertenza: e' lo stesso danno che
la guardia impedisce, entrato da un'altra porta.

Per gli altri campi cambiati fuori richiesta l'esito resta positivo con
un'avvertenza LOUD, perche' FIC deriva dei campi da altri (`country_iso` da
`country`) e un rifiuto la' griderebbe al lupo su una modifica legittima. I
derivati noti sono in `DERIVATI_ENTITA` e non generano nemmeno l'avvertenza.

### 3. L'insieme dei campi e' lo stesso di `fic_crea_cliente`

Nome, tipo, CF, P.IVA, indirizzo, CAP, citta', provincia, paese, email, codice
destinatario. Niente di piu': cio' che si sa creare si sa correggere. Un campo
correggibile ma non creabile sarebbe una differenza fra i due tool che nessuno
si ricorda il giorno che serve.

### 4. NON e' fra le `AZIONI_IRREVERSIBILI`

Stessa ragione di `fic_crea_cliente`: una scheda anagrafica si ricorregge e non
lascia traccia fiscale. Se lo fosse, la contabile — che e' chi lavora le
anagrafiche — non l'avrebbe in mano (`perimetroDiLavoro`).

## Come si verifica

`src/lib/fic-anagrafica.aggiorna.test.ts`, 26 test, I/O finto
(`vi.mock('./fatture-in-cloud')`), logica vera. Guardano le due cose che
possono sbagliare: i **percorsi chiamati** e il **corpo spedito**.

Ogni difesa ha accanto il suo CONTROLLO POSITIVO: con `elenco: 'cliente'` si va
sui clienti; con id ed elenco la modifica passa; riempire una chiave vuota non
chiede conferma; la stessa P.IVA scritta con spazi non e' un cambio; un CAP si
corregge senza conferme; un campo derivato non fa gridare al lupo;
`fic_crea_cliente` e' ancora suo.

### Mutation testing — 9 su 9 morte

Conteggio delle ancore PRIMA e DOPO ogni mutazione (i sorgenti qui sono CRLF:
un'ancora che non entra darebbe un falso verde; l'harness si ferma se
l'occorrenza non e' esattamente una).

| # | guardia spenta | test diventati rossi |
|---|---|---|
| 1 | la stringa vuota cancella | 1 |
| 2 | guardia identita' spenta | 3 |
| 3 | guardia identita' troppo larga (anche sui campi vuoti) | 1 (il controllo positivo) |
| 4 | la rilettura non conta, vince la PUT | 1 |
| 5 | si spedisce solo il delta invece della scheda intera | 2 |
| 6 | l'id diventa facoltativo | 1 |
| 7 | l'elenco si indovina | 1 |
| 8 | l'errore di FIC viene interpretato invece che riportato | 1 |
| 9 | la chiave fiscale mossa da sola diventa innocua | 1 |

Piu' una decima sulla catena degli esecutori (`tools.ts`): `executeFicWrapper`
che rivendica per prefisso **e** messo prima di `executeAnagraficaWrapper` fa
diventare rossi 2 test. ⚠️ Il solo scambio d'ordine, senza il prefisso, e' una
mutazione **sopravvissuta**, e la spiegazione e' che `nomiDi()` rende l'ordine
irrilevante: la difesa vera e' l'elenco di nomi, l'ordine e' ridondanza.

## Stato dei test e del typecheck — leggere questo

- `npx vitest run` (suite intera, meno `pdf-generator*`): **246 file passati,
  3.076 test, 0 rossi**.
- `npx tsc --noEmit`: **6 errori, tutti preesistenti e in file che non ho
  toccato** (`pdf-parse`, `puppeteer-core`, `@sparticuz/chromium`, `puppeteer`).

🚨 **Il `node_modules` CONDIVISO del checkout principale ha cinque cartelle
VUOTE**: `pino`, `pdf-parse`, `puppeteer`, `puppeteer-core`, `rimraf`.
Installazione parziale, preesistente a questo lavoro e non riparata da me
perche' e' l'albero condiviso con le altre sessioni. Conseguenza: con la
configurazione vera di vitest **33 file di test non si caricano nemmeno** — fra
cui `tools.differimento.test.ts`, `mappa-officina.test.ts`,
`specialisti.test.ts`. Per poter LEGGERE il fallimento vero dell'impronta ho
usato una configurazione usa-e-getta con quattro stub (cancellata: non e' nel
commit). Numero e impronta vengono da quel fallimento, non da un calcolo a
parte:

    142 → 143 definizioni
    6d2b95c878cf6cdc4100f244971a8ce1 → e6276bc3bc326987d2d842f15918fdd5

**Chi riprende questo lavoro dovrebbe lanciare `npm install` nel checkout
principale e rilanciare la suite senza stub.**

## Quello che NON sono riuscito a costruire

- **Una prova contro la semantica vera del PUT.** Tutti i test sono su I/O
  finto: dimostrano che spediamo la scheda intera, non che FIC si comporti come
  crediamo. Il primo uso vero va guardato sul gestionale, come per
  `segna_fatture_emesse_pagate`.
- **La lista dei campi `readOnly` dell'entita' non e' verificata sullo schema
  ufficiale.** Tolgo `id`, `created_at`, `updated_at` per analogia con
  `fic-pagamenti.ts`. Se FIC ne rifiutasse altri, il PUT torna un 400 col testo
  vero e il tool lo riporta — quindi il guasto si vede, ma il primo che lo
  incontra paga un giro.
- **`country_iso` come derivato di `country` non e' documentato**: e'
  un'inferenza mia, e vale come tale.
- **Non sa svuotare un campo.** Deliberato — «vuoto non vuol dire cancella» —
  ma resta un buco: per azzerare un campo si va a mano su Fatture in Cloud, e
  nessun tool lo sa fare.
