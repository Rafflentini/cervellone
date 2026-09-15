# `fic_crea_fattura_ospite` — la fattura al cliente per un soggiorno Booking

**Stato: PRONTO, mai girato sul vero.** Nessuna fattura e' stata creata su Fatture in
Cloud durante questo lavoro: tutto quello che c'e' qui sotto e' provato con `fetch`
finti. Il primo uso vero va guardato a mano sul gestionale.

⛔ Nessun tool di questo lavoro trasmette allo SdI. Dopo ogni creazione si chiama
`verificaFormaleXml` (GET `…/e_invoice/xml_verify`, sola lettura) e se risponde
«errori» il tool **non dichiara successo**: restituisce id ed errori testuali.

## File

| File | Cosa |
|---|---|
| `src/lib/fic-fattura-ospite.ts` | NUOVO. Il documento, le difese, la creazione, la rilettura. |
| `src/lib/fic-aliquote.ts` | NUOVO. `elencoAliquoteFic` estratta da `fic-write-tools.ts` (la leggono in due: qui per VALORE, li' per la natura N1, che si riconosce dalla descrizione). `fic-write-tools.ts` la ri-esporta col vecchio nome. |
| `src/lib/fic-write-tools.ts` | Tool `fic_crea_fattura_ospite`, anteprima, pending `fattura_ospite`, conferma SINGOLA, ramo di `confirmFicStep2`. |
| `…rispecchiamento.test.ts` · `…difese.test.ts` · `fic-write-tools.fattura-ospite.test.ts` | 78 test. |

## Come si verifica

- `npx tsc --noEmit`: **pulito** sui file toccati.
- `npx vitest run` sulle 62 suite FIC + check-in: **1013 test verdi**, 1 suite fallita per
  un guasto d'ambiente pre-esistente (`Cannot find module 'pino'`, dipendenza di
  `imapflow` assente da `node_modules` — verificato con `require.resolve`, e non tocca
  nessun file di questo lavoro).
- `npm run build`: **fallisce prima di arrivare al mio codice**, sugli stessi moduli
  assenti (`pdf-parse`, `puppeteer-core`, `@sparticuz/chromium`) piu' `pino`. E'
  l'installazione di `node_modules` a essere incompleta, non il codice: gli stessi
  quattro errori li dava `tsc` **prima** che toccassi qualcosa. ⚠️ **Il build NON e'
  stato dimostrato verde.**
- **Mutation testing: 15 mutazioni, 15 uccise**, con `grep -c` prima/dopo su ogni
  sostituzione e `md5sum` per provare il ripristino. Due erano mal tarate al primo giro e
  sono state rifatte — e vale la pena scriverlo, perche' senza la taratura sarebbero
  passate per «difesa assente»:
  - una era **additiva** (il testo nuovo CONTIENE quello vecchio: `grep -c` dell'originale
    restava 1, e sembrava che la sostituzione non avesse morso). Si conta la **spia**, cioe'
    il testo aggiunto.
  - una aveva un'**ancora non unica**: `  if (doppione.esistente) {` compare **3 volte** in
    `fic-write-tools.ts`, e `perl` aveva colpito l'anti-doppione della SPESA — i miei test
    non potevano accorgersene. Risultava «mutazione sopravvissuta» ed era una mutazione
    fatta nel posto sbagliato.

Le mutazioni uccise: elenco troncato che non rifiuta piu' · CF non validato · imposta il
cui conto non deve piu' tornare · natura N1 non controllata nella rilettura ·
`use_gross_prices: false` · `revenue_detect: false` · `numeration: 'Principale'` ·
`tax_code: ''` sull'estero · `payment_method` scritto anche a livello di documento ·
verifica formale bocciata ignorata · anti-doppione che guarda solo `subject` · problemi
della rilettura ignorati · `fattura_ospite` fuori da `A_CONFERMA_SINGOLA` · anti-doppione
tolto dalla compilazione · anti-doppione tolto dalla creazione.

---

# 🚨 I DUBBI — quello che ho deciso io e che va rivisto

## 1. `subject` resta VUOTO, e l'anti-doppione ne dipende
La specifica diceva di riempire `subject` **e** `visible_subject`. Nei due documenti veri
`subject` e' `""` e il testo sta solo in `visible_subject`. **Ha vinto il modello.**
Conseguenza non ovvia: l'anti-doppione cerca il numero di prenotazione nel
**`visible_subject`** — cercarlo in `subject`, come diceva il brief, non troverebbe **mai**
niente. C'e' un test apposta.
⬜ Se domani qualcuno decide di riempire `subject`, l'anti-doppione va aggiornato insieme.

## 2. `net_price` sulle righe: NON lo scrivo
Con `use_gross_prices: true` mando solo `gross_price`. I modelli riportano anche
`net_price: 469.36364` — cinque decimali, il netto **calcolato da FIC**: riprodurlo
vorrebbe dire indovinare il suo arrotondamento. Che il conto sia tornato lo dice la
**rilettura** (`amount_net ≈ prezzo/1,1`), non la costruzione.
⬜ Al primo uso vero: controllare che FIC scorpori davvero e non prenda il lordo per
imponibile. Se lo prendesse, il tool lo DICE («l'imponibile risulta X invece di Y») e non
dichiara successo — ma la fattura sarebbe gia' nata e andrebbe corretta a mano.

## 3. Le NOTE del cliente estero non sono rispecchiate
La rilettura del modello francese che ho ricevuto **non espone il campo `notes`**: non so
se sia assente o solo omesso. Costruisco le note **uguali** per italiano ed estero, e
aggiungo `Cliente estero: passaporto n. …` **solo** se chi chiama passa `passaporto`.
Quella frase **me la sono scritta io**: non viene da nessun documento.
⬜ Da confrontare con una fattura estera vera.
(Il numero di passaporto non e' ne' data ne' luogo di nascita ne' la copia di un
documento: il divieto del Garante non lo tocca. Data e luogo di nascita restano fuori,
sempre.)

## 4. La LINGUA non esiste, e non l'ho inventata
La specifica chiede «lingua italiana anche per gli stranieri». In **nessuno** dei due
documenti compare un campo della lingua, e non l'ho trovato sulla documentazione del
documento. **Non l'ho impostato.** C'e' un test che fallisce se qualcuno aggiunge una
chiave che somiglia a `lang`/`lingua`/`locale`.
⬜ Se e' un attributo dell'**anagrafica**, si vedra' leggendo un'anagrafica vera — e allora
il posto dove metterlo e' `fic_crea_cliente`, non questo tool.

## 5. `ei_raw` / TD01: non lo scrivo, lo CONTROLLO
I modelli riportano `ei_raw … TipoDocumento: "TD01"`. Non lo mando: FIC lo deriva dal
tipo, e scrivere attributi dentro `ei_raw` e' esattamente la famiglia di difetti che il 15
settembre ha fatto rifare quattro TD17 a mano. La rilettura pero' lo **verifica**, se FIC
lo espone.

## 6. 🚨 La tariffa dell'imposta di soggiorno DIVERGE dal repo
I due documenti veri usano **1,50 €** a persona/notte. `REGOLE_MARATEA` in
`src/lib/checkin/imposta-soggiorno.ts` dichiara **`tariffa: 2.5`**, `maxPernottamenti: 5` e
`esenzioneEtaMax: 12` (con un commento che dice che la soglia dei 12 anni e' «DA
CONFERMARE al Comune»). E nel modello italiano paga anche il bambino (3 persone x 3
notti), quindi le due letture non combaciano nemmeno sulle esenzioni.
**Per questo il tool NON calcola l'imposta**: la prende dai parametri (`importo`,
`persone`, `notti`, `tariffa`) e verifica solo che `persone x notti x tariffa == importo`,
rifiutando se non torna. Collegarlo a `calcolaImpostaSoggiorno` avrebbe prodotto importi
diversi da quelli delle fatture vere, su denaro di terzi da riversare al Comune.
⬜ **Decisione di Raffaele: 1,50 o 2,50? E i minori pagano o no?** Finche' non e' deciso,
i due pezzi di codice si contraddicono.

## 7. «Adulto» = maggiorenne al check-in — deciso da me
I modelli dicono «2 adulti, 1 bambino» senza dire con quale soglia. Se chi chiama passa
`date_nascita`, conto maggiorenne/minorenne al check-in; se passa `adulti` e `bambini`,
vincono quelli. ⚠️ **Non e'** la soglia dell'esenzione dall'imposta: le due cose si
somigliano e non sono la stessa.

## 8. Composizione a zero: forma non rispecchiata
Con `bambini: 0` scrivo `(2 adulti)`. Non ho un modello con zero bambini: la forma della
parentesi in quel caso e' una mia scelta.

## 9. L'anagrafica si crea PRIMA della conferma
Il tool risolve o **crea** la scheda del cliente in fase di compilazione, riusando
`fic_crea_cliente` (che ha gia' il suo anti-doppione). Motivo: l'anteprima deve dire A CHI
sara' intestata la fattura, e un guasto sull'anagrafica deve emergere prima del
«confermo». Creare un'anagrafica e' reversibile e non lascia traccia fiscale; emettere una
fattura no. ⚠️ **Effetto collaterale**: una bozza annullata lascia l'anagrafica creata. E'
voluto, ma va saputo.

## 10. `ei_code` di un privato italiano: 7 zeri, non 10
I documenti veri portano `ei_code: "0000000"` (sette). Lo schema di `fic_crea_cliente`
(`fic-anagrafica.ts`) documenta `0000000000` (dieci). **Non l'ho toccato** — non e' il mio
tool — ma uno dei due sbaglia. Nel mio percorso passo sempre sette.

---

# La difesa che NON sono riuscito a costruire

**Il divieto del Garante e' garantito per COSTRUZIONE, non da una guardia.** Data e luogo
di nascita non entrano nel payload perche' nessun campo li porta: `contaOspiti()` li
consuma e restituisce due numeri. I test lo verificano (le date non compaiono nel
documento serializzato, e nemmeno in cio' che si manda all'anagrafica), ma e' una **rete
di regressione, non un cancello**: se domani qualcuno aggiungesse un campo che le porta,
il test lo vedrebbe solo perche' cerca quelle tre stringhe. Una guardia vera — che
ispezioni l'oggetto in uscita e rifiuti QUALSIASI cosa somigli a una data di nascita —
non l'ho scritta: su un documento pieno di date (`date`, `paid_date`, `due_date`,
`check_in`, `check_out`) distinguere «la data sbagliata» dalle altre richiede una regola
che non ho saputo rendere sicura senza falsi positivi che bloccherebbero il caso normale
— ed e' proprio il difetto di `cervellone-guardia-modelli-docx`: una guardia che blocca il
caso normale e' peggio del buco.

**Altre cose non provate, e sono non-prove, non successi:**
- che `use_gross_prices` sia accettato in **scrittura** (i test non parlano con FIC);
- che `subject: ''` non dia fastidio a FIC;
- che `extra_data` sia scrivibile (nei modelli si legge; che si scriva e' un'inferenza);
- che il piano pagamenti `paid` con `payment_account` passi (su un'autofattura `paid`
  senza conto faceva 422: qui il conto c'e', ma non l'ho visto funzionare).

---

# Fuori scopo — cosa servira' dopo

Non fatto, come da brief: **lettura dal foglio Google del check-in**, **write-back sul
foglio**, **tool di modifica**. Il tool prende tutto dai parametri.
Per collegare il foglio servira':
1. le **unita' vere** nel Config (oggi sono segnaposto) e il loro **indirizzo**, che va nella
   descrizione della riga — oggi e' un parametro obbligatorio proprio perche' non lo so
   dedurre dal nome;
2. la decisione del punto 6 (tariffa ed esenzioni), perche' dal foglio l'imposta va
   **calcolata**, non passata;
3. il **prezzo lordo Booking** con la commissione dentro: dal foglio arriva il payout?
   Se si', va sommata la commissione prima di fatturare, altrimenti ogni fattura esce
   bassa del 15% circa;
4. una colonna sul foglio dove scrivere **id e numero** della fattura emessa — senza,
   l'anti-doppione resta l'unica difesa e costa una scansione dell'anno a ogni giro.
