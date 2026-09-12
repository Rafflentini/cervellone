# La guardia sui dati societari nei documenti — disegno

**Data:** 12 settembre 2026
**Origine:** domanda di Raffaele — *«l'importante è che lui non compili un documento
sbagliando la partita IVA o il codice area senza accorgersene. Questo mi assicuri che non
succederà mai? Compili un preventivo, un documento, una lettera, qualsiasi cosa sbagliando
i dati che sa, questo mi assicuri che non succederà.»*

## La risposta onesta alla domanda

**No, non si può assicurare che non succeda mai.** Il testo di un documento lo scrive il
modello; nessuna promessa sul comportamento di un modello è una garanzia. Quello che si può
costruire, e che è una garanzia vera perché è un confronto fra stringhe e non un giudizio,
è questo:

> **Un documento che porta i dati societari di una società diversa da quella attiva non
> viene consegnato.** Non esce, e il motivo viene dichiarato all'Ingegnere.

«Non succederà mai» diventa **«non può passare inosservato»**. La differenza non è retorica:
la prima è una speranza, la seconda è una riga di codice con un test che muore se la si
toglie.

## Lo stato di fatto, misurato il 12 set 2026

Il rischio non era ipotetico: era già nel codice, in quattro punti.

| Punto | Cosa c'è oggi | Conseguenza |
|---|---|---|
| `src/lib/tools/studio-tecnico.ts:837` e `:857` | `<h1>RESTRUKTURA S.r.l.</h1><p>… P.IVA 02087420762 …` **cablato nell'HTML** | Un preventivo de La Real Estate **esce oggi** con la ragione sociale e la P.IVA di Restruktura. Non è una scelta del modello: è scritto a mano, e vale qualunque sia la società attiva. |
| `src/lib/pdf-generator.ts:59` | `const SOCIETA_PREDEFINITA = { 'RESTRUKTURA S.r.l.', '02087420762' }`, usata come `opzioni.societa ?? SOCIETA_PREDEFINITA` | Chi genera un documento senza passare la società **non sbaglia**: prende Restruktura in silenzio. |
| `src/lib/societa-documenti.ts` | `} catch { return undefined }`, con il commento *«Best-effort: se non si riesce a risolvere la societa' attiva resta Restruktura»* | **Un guasto nella lettura della società attiva non è un guasto: è Restruktura.** È la classe di difetto che questo repo ha chiuso sei volte in dodici ore — l'errore che si traveste da risposta. |
| `src/lib/prompts.ts:134` | `Intestazione: RESTRUKTURA S.r.l. — P.IVA 02087420762, …`, **incondizionata** | Il prompt afferma una sola intestazione mentre il blocco identità (aggiunto oggi) descrive **due** società: al modello diamo un'informazione e la sua smentita. |

E soprattutto: `grep -rn 'verificaDocumento|controllaIntestazione|validaPiva' src` → **nessun
risultato**. Nessuna riga di codice, prima di oggi, controllava che la partita IVA stampata
su un documento fosse quella giusta.

## Il principio: insieme chiuso, non insieme aperto

La guardia sbagliata sarebbe: *«ogni partita IVA nel documento deve essere quella della
società attiva»*. Bloccherebbe **ogni preventivo**, perché un preventivo nomina il
committente, e il committente ha la sua partita IVA. Sarebbe la guardia `.docx` da capo:
*«una guardia che blocca il caso normale è peggio del buco che chiude»*.

La guardia giusta cerca **solo le partite IVA nostre**, che sono un insieme **chiuso e noto
a tempo di compilazione** — due valori, in un registro unico (`src/lib/societa.ts`), non
riscritti a mano:

- `02087420762` — RESTRUKTURA S.r.l.
- `02232730768` — LA REAL ESTATE SRLS

Regola: **se in un documento compare una partita IVA nostra che non è quella della società
attiva, il documento non esce.** La partita IVA del committente, del fornitore, del
professionista terzo non fa scattare niente: non è nell'insieme.

La partita IVA personale dell'Ingegnere **non è nel codice per scelta** (il prompt dice di
cercarla sul Drive), e resta fuori: non la si scrive qui solo per farla controllare. Se un
giorno entrasse nel registro, la guardia la coprirebbe senza modifiche.

### Falsi positivi: dove la guardia deve tacere

Un documento **può legittimamente** nominare l'altra società: una lettera di Restruktura
indirizzata a La Real Estate, un contratto fra le due, un preventivo in cui La Real Estate
è il committente. In quei casi la partita IVA dell'altra società compare **come dato del
destinatario**, non come intestazione, e bloccare sarebbe sbagliato.

Non si distingue in modo affidabile l'intestazione dal corpo guardando l'HTML. Quindi la
guardia **non indovina**: blocca, dichiara **quale** partita IVA ha trovato e **dove**, e
offre all'Ingegnere la strada per procedere comunque. Un blocco che si può togliere con una
frase è accettabile; una consegna sbagliata silenziosa no.

> **Decisione:** in caso di conflitto la guardia **blocca e dichiara**, non corregge. Una
> correzione automatica dell'intestazione produrrebbe un documento che l'Ingegnere non ha
> visto nascere e di cui non conosce la provenienza — esattamente il tipo di silenzio che
> stiamo eliminando.

## Dove sta la guardia — e perché il primo disegno era sbagliato

> **Correzione registrata.** Il primo disegno metteva la guardia dentro
> `generatePdfFromHtml` e `generateDocxFromHtml`, «i due unici imbuti». La
> scansione pre-volo del piano ha dimostrato che **non sono gli imbuti**: il
> preventivo non passa da lì. `genera_preventivo_completo` scrive la riga in
> `documents` **da solo** (`studio-tecnico.ts:986`) e restituisce l'HTML dentro
> un blocco `~~~document`; l'Ingegnere lo apre dal pannello anteprima e lo
> stampa dal browser. La guardia nel PDF avrebbe protetto i PDF e **mancato
> esattamente il preventivo**, cioè il caso che Raffaele ha nominato.
> La lezione va nella lista tarata: *un imbuto dichiarato non è un imbuto
> misurato.* Si conta chi scrive, non chi sembra il posto giusto.

### La misura

`grep -rn "from('documents')" src` → **28 punti**, di cui **10 inseriscono**.
Non esiste un collo di bottiglia: esiste una dispersione. Dei dieci, questi
portano il contenuto di un documento **che Cervellone compila**:

| Punto | Cosa scrive | Guardia |
|---|---|---|
| `src/app/api/chat/route.ts:502` | il blocco `~~~document` del modello, **web** | ✅ |
| `src/lib/agent-job.ts:215` | lo stesso blocco, **Telegram** | ✅ |
| `src/lib/tools/studio-tecnico.ts:986` | preventivo, CME, quadro economico | ✅ |
| `src/lib/artifact-capture.ts:169` | l'auto-bozza ricavata dal testo del modello | ✅ |
| `src/lib/draft-tools.ts:186` | la **modifica** del contenuto di una bozza | ✅ |
| `src/lib/pdf-generator.ts:384` / `:520` | HTML→PDF e HTML→Word | ✅ |
| `src/v19/render/docx.ts:34` | i modelli `.docx` coi segnaposto | ✅ |

I due primi punti sono **già simmetrici**: stessa `insert`, stessa forma, cambia
solo `metadata.source` (`web_chat` / `telegram`). L'equipollenza qui non va
costruita: va **non rotta**, e provata.

### Le esclusioni, dichiarate

Una guardia si giudica anche da cosa lascia passare di proposito. Queste
scritture **non** vengono guardate, e il motivo conta:

- `src/app/api/projects/route.ts:371,380,437` — il digest di un file **che
  l'Ingegnere ha caricato**. Un capitolato ricevuto da La Real Estate porta
  legittimamente la partita IVA de La Real Estate: guardarlo bloccherebbe il
  caso normale. Non è un documento che Cervellone compila, è un documento che
  Cervellone legge.
- `src/lib/image-memory.ts`, `src/lib/sent-mail.ts`, `src/lib/share-proposte.ts`
  — memoria interna, copia di una mail già spedita, righe di condivisione.
  Nessuna di queste è un documento compilato.

### La conseguenza architetturale

Otto punti da guardare non si guardano otto volte: il nono, scritto fra un mese,
sarebbe senza guardia **e nessuno se ne accorgerebbe**. Quindi:

1. **Un modulo nuovo, `src/lib/salva-documento.ts`**, con l'unica funzione che
   scrive il contenuto di un documento in `documents`. La guardia sta dentro.
   I cinque punti Supabase passano da lì.
2. **La guardia dentro i tre imbuti di rendering** (`generatePdfFromHtml`,
   `generateDocxFromHtml`, `renderDocx`), perché quelli non passano da Supabase.
3. **Un `grep` nella lista tarata** che trova un `insert` su `documents` fuori
   da `salva-documento.ts`. È il solo meccanismo che non dipende dalla memoria
   di nessuno — e la dispersione di oggi è nata proprio perché quel `grep` non
   esisteva.

E soprattutto: **la guardia è la rete, non la cura.** La cura è togliere le sei
intestazioni cablate, così il documento sbagliato non nasce. La rete serve per il
caso che resta — il modello che scrive la partita IVA di testa sua, che è
letteralmente la domanda di Raffaele.

## L'architettura

### Nuovo modulo: `src/lib/guardia-societa.ts`

```ts
/** Le partite IVA nostre, derivate dal registro: mai riscritte a mano. */
export function pivaNostre(): Map<string, { codice: CodiceSocieta; denominazione: string }>

export type EsitoGuardia =
  | { ok: true }
  | { ok: false; trovate: Array<{ piva: string; denominazione: string }>; attesa: { piva: string; denominazione: string } }

/**
 * Cerca nel contenuto le partite IVA NOSTRE. Se ne trova una che non e' quella
 * attesa, il documento non e' consegnabile.
 */
export function verificaDatiSocietari(
  contenuto: string,
  attesa: { piva: string; denominazione: string },
): EsitoGuardia
```

Riconoscimento: la partita IVA va trovata anche scritta `IT02087420762`, con spazi o punti
di separazione (`02.087.420.762`), e dentro il markup. Si normalizza il contenuto ai soli
numeri prima di cercare, e si cercano le undici cifre. Questo dà un **falso positivo
possibile**: undici cifre consecutive che per caso coincidono. Su una partita IVA specifica
la probabilità è trascurabile, e l'esito è un blocco dichiarato, non un documento sbagliato.

### Il parametro `societa` diventa obbligatorio

`OpzioniDocumento.societa?` → `societa` **richiesto**. `SOCIETA_PREDEFINITA` **eliminata**.
Il compilatore diventa la guardia dei sei chiamanti: un settimo punto che dimentica la
società **non compila**, invece di stampare Restruktura.

### `societaAttivaPerDocumenti` smette di mentire

```ts
export type EsitoSocieta =
  | { ok: true; societa: { denominazione: string; piva: string } }
  | { ok: false; errore: string }
```

Nessun `catch { return undefined }`. Se la società attiva non si riesce a leggere, **il
documento non si genera** e l'Ingegnere legge perché. Il caso «di gran lunga più frequente»
non è un argomento per indovinare: è l'argomento per cui l'errore sarebbe passato inosservato
proprio quando conta.

### Il prompt

`prompts.ts:134` — la riga `Intestazione: RESTRUKTURA S.r.l. …` diventa **condizionata alla
società attiva**, costruita dal registro. Con La Real Estate attiva, il prompt dice La Real
Estate. La coerenza fra prompt e guardia conta: se il prompt suggerisce Restruktura e la
guardia blocca, il bot combatte contro se stesso e l'Ingegnere vede solo un rifiuto.

## Equipollenza web ↔ Telegram

La guardia vive in `src/lib` — **sotto** entrambi i canali, nel motore che già condividono.
Ma *«un motore condiviso NON rende equipollenti i canali»*: quello che cambia fra i due è
**come il rifiuto arriva all'Ingegnere**. Quindi un test per canale, che verifica che il
messaggio di blocco:

1. **arrivi** (non venga inghiottito), e
2. **nomini** la partita IVA trovata e quella attesa — un rifiuto che non dice cosa non
   torna costringe a indovinare.

## Come si prova che funziona

Il verde non basta. Per ogni asserzione, il controllo che prova che morirebbe:

| Prova | Cosa dimostra |
|---|---|
| **Controllo negativo** — preventivo Restruktura con la P.IVA del committente nel corpo → **passa** | La guardia non blocca il caso normale |
| **Controllo positivo** — documento con La Real Estate attiva e `02087420762` nell'HTML → **bloccato**, esito nomina entrambe | La guardia morde il caso vero, quello che succede oggi |
| **Mutazione 1** — invertire il confronto in `verificaDatiSocietari` | Deve uccidere almeno un test |
| **Mutazione 2** — rimettere `?? SOCIETA_PREDEFINITA` | Deve uccidere almeno un test |
| **Mutazione 3** — far restituire `{ok:true}` al `catch` di `societaAttivaPerDocumenti` | Deve uccidere almeno un test |
| **Prova per canale** — lo stesso conflitto su chat web e su Telegram | Il rifiuto arriva su entrambi e dice le due partite IVA |
| **Prova end-to-end** — preventivo con La Real Estate attiva **prima** del fix | Il documento esce con la P.IVA di Restruktura. È il difetto, riprodotto prima della difesa. |

## Cosa questo NON copre, dichiarato

- **Il «codice area»** che Raffaele nomina (sede, indirizzo, telefono): la guardia controlla
  la partita IVA e la ragione sociale, che sono nel registro. La sede di Restruktura è
  scritta in due posti con due valori diversi — `identita.ts` dice *Villa d'Agri (PZ)*,
  la memoria dice *Via Roma 60, 85050 Marsicovetere (PZ)*. Sono lo stesso luogo
  (Villa d'Agri è frazione di Marsicovetere), ma **non sono la stessa stringa**, e nessuno
  dei due è nel registro come dato verificabile. → punto aperto, Task 7 lo dichiara.
- **I dati del committente**: se il modello sbaglia la partita IVA del cliente, nessuna
  guardia lo sa — non c'è una fonte di verità contro cui confrontarla.
- **I documenti FIC**: le fatture le compila Fatture in Cloud dal profilo azienda, non
  Cervellone; lì l'intestazione non passa da questo codice.

## Punto aperto per l'Ingegnere

La sede di Restruktura va scritta **una volta sola**, nel registro, nella forma che deve
comparire sui documenti: *Villa d'Agri (PZ)* oppure *Via Roma 60, 85050 Marsicovetere (PZ)*.
Finché sono due stringhe in due file, un documento può portare l'una e un altro l'altra, e
nessuno dei due è «sbagliato» per il codice.

---

## La crepa sotto la guardia: `attesa` indovinata

Aggiunto dopo la lettura di `src/lib/societa-attiva.ts:24-40`. È il punto più importante di
tutto il disegno.

```ts
if (error || !data?.societa) return DEFAULT_SOCIETA
} catch { return DEFAULT_SOCIETA }
```

Il commento sopra dice: *«Restruktura se non è mai stata scelta, o se la lettura fallisce:
un errore di database non deve cambiare azienda»*. Il ragionamento è **sano**, non pigro:
un guasto transitorio non deve spostare le operazioni su un'altra azienda.

Ma unisce **due assenze che non sono la stessa cosa**:

| Caso | Cosa sappiamo | Cosa è giusto fare |
|---|---|---|
| Nessuna riga: `/societa` mai usato | Sappiamo che non ha scelto → Restruktura **è** la politica dichiarata | Restruktura, correttamente |
| `error` dal database, o eccezione | **Non sappiamo niente** | Non indovinare |

La conseguenza sulla guardia è fatale se la si lascia così. **La guardia vale esattamente
quanto vale `attesa`:** se la lettura fallisce mentre l'Ingegnere lavora su La Real Estate,
la guardia riceve «Restruktura» come società attesa, guarda l'intestazione Restruktura,
e **lascia passare il documento sbagliato dichiarandolo conforme**. Una difesa che si fida
di un dato indovinato non è una difesa: è la stessa bugia, con un timbro sopra.

È la terza volta che questa distinzione compra la correttezza (dopo `EsitoLetturaPending`
per le mail e `risolviPrefisso` per i codici): **un'assenza nota e un guasto non possono
condividere lo stesso valore di ritorno.**

### La modifica

```ts
export type EsitoSocietaAttiva =
  | { ok: true; codice: CodiceSocieta; esplicita: boolean }
  | { ok: false; errore: string }

export async function leggiSocietaAttiva(conversationId?: string): Promise<EsitoSocietaAttiva>
```

- `esplicita: true` → l'Ingegnere l'ha scelta con `/societa`.
- `esplicita: false` → nessuna riga, vale la politica: Restruktura.
- `ok: false` → **il percorso documenti rifiuta**. Non si stampa una partita IVA su un
  documento basandosi su un'ipotesi.

`getSocietaAttiva()` resta come è, con la firma di oggi, per i chiamanti in cui indovinare
Restruktura non produce un documento (lettura di contesto, blocco nel prompt): cambiarli
tutti in un colpo allarga il lavoro senza chiudere niente in più. **Ma il percorso che
genera documenti usa solo `leggiSocietaAttiva`.**

→ Gli altri chiamanti di `getSocietaAttiva` che **scrivono** su Fatture in Cloud restano un
punto aperto dichiarato: un'operazione FIC sull'azienda sbagliata è grave quanto un
documento sbagliato, ma non è il lavoro di oggi e non va nascosto dentro a questo.

---

## Inventario completo, chiuso il 12 set 2026 — SETTE punti

La prima tabella di questo documento ne elencava quattro, il messaggio a Raffaele
sei. Il conto definitivo, dopo aver tracciato anche la catena CIGO, è **sette**.
Lo scarto non è un dettaglio: due dei tre punti aggiunti sono della stessa classe
(`?? COSTANTE`), e uno è peggiore degli altri perché *sembra* prendere il dato dai
dati.

| # | Punto | Forma | Chi lo prende |
|---|---|---|---|
| 1 | `src/lib/tools/studio-tecnico.ts:837` | letterale cablato nell'HTML | intestazione CME |
| 2 | `src/lib/tools/studio-tecnico.ts:857` | letterale cablato nell'HTML | **intestazione del preventivo** |
| 3 | `src/lib/tools/studio-tecnico.ts:~970` | letterale nel piede | quadro economico |
| 4 | `src/lib/pdf-generator.ts:59` | `opzioni.societa ?? SOCIETA_PREDEFINITA` | ogni PDF e Word generato da HTML |
| 5 | `src/v19/render/utils.ts:110` | `text ?? "RESTRUKTURA … 02087420762 …"` | il piede di ogni Word dai modelli |
| 6 | `src/lib/prompts.ts:134` | riga incondizionata nel prompt statico | il modello, a ogni turno |
| 7 | `src/v19/tools/cigo/build-allegato10.ts:257` | letterale **accanto** al dato | piede dell'Allegato 10 INPS |

### Perché il settimo è il più insidioso

```ts
footer: `RESTRUKTURA S.r.l. — P.IVA ${input.azienda.codice_fiscale} — ${input.azienda.denominazione} — …`
```

La ragione sociale compare **due volte**: una cablata, una interpolata dai dati
della pratica. Chi legge questa riga vede le due interpolazioni e conclude che il
piede viene dai dati — e non nota che il nome dell'azienda, davanti, è scritto a
mano. Se la pratica fosse di un'altra azienda il piede si contraddirebbe da solo:
`RESTRUKTURA S.r.l. — P.IVA <altra> — <ALTRA DENOMINAZIONE>`, su un documento
destinato all'INPS.

Il rischio pratico oggi è basso — il CIGO è per natura di Restruktura — ma è
«basso per caso», non per costruzione: nessuna riga di codice impedisce a quella
funzione di essere riusata.

### Le due classi, nominate

- **Letterale cablato** (1, 2, 3, 7): un dato societario riscritto a mano dentro un
  generatore, fuori dal registro. → `grep` **A8**.
- **Fallback non configurato** (4, 5): `opzioni.X ?? COSTANTE` dove `COSTANTE` è
  l'identità di un'entità reale. **Chi dimentica il parametro non sbaglia: prende
  un'identità in silenzio.** → `grep` **A9**. La cura non è un controllo, è
  rendere il parametro **obbligatorio**: così l'omissione diventa un errore di
  compilazione invece di una stampa.
- Il sesto è a parte: non è codice che genera, è **il prompt che afferma**. Vive
  in un file statico che non conosce la conversazione, quindi non può sapere quale
  società è attiva. Si cancella, e l'informazione va in `bloccoSocietaAttiva`, che
  la società attiva la riceve già e viene iniettato **simmetricamente sui due
  canali**.

---

## Il conto definitivo: NOVE punti — e perché è cresciuto quattro volte

La sezione precedente dice sette. Prima ne diceva quattro, e a Raffaele ne ho
detti sei. **Il numero vero è nove**, e la progressione non è sciatteria: ogni
conto veniva da un `grep` più largo del precedente, e vale la pena scriverla,
perché è la parte generalizzabile di tutto questo lavoro.

| Conto | Come l'avevo misurato | Cosa mi era sfuggito |
|---|---|---|
| **4** | `grep` delle due partite IVA nei sorgenti | i piedi con la **sola ragione sociale**, e la catena CIGO |
| **6** | lo stesso `grep`, letto meglio | idem |
| **7** | tracciata la catena CIGO fino a `renderDocx` | i tre piedi in `studio-tecnico.ts` |
| **9** | `grep` della **ragione sociale**, non della partita IVA | — |

### L'inventario, riga per riga

| # | Punto | Forma | Porta la P.IVA? |
|---|---|---|---|
| 1 | `src/lib/tools/studio-tecnico.ts:837` | `const headerHtml = …` — **vivo**, usato a `:915` (CME) e `:944` (QE) | ✅ |
| 2 | `src/lib/tools/studio-tecnico.ts:857` | la **stessa** intestazione riscritta inline → preventivo | ✅ |
| 3 | `src/lib/tools/studio-tecnico.ts:875` | piede del preventivo | ❌ solo ragione sociale |
| 4 | `src/lib/tools/studio-tecnico.ts:935` | piede del CME | ❌ solo ragione sociale |
| 5 | `src/lib/tools/studio-tecnico.ts:971` | piede del quadro economico | ❌ solo ragione sociale |
| 6 | `src/lib/pdf-generator.ts:59` | `opzioni.societa ?? SOCIETA_PREDEFINITA` | ✅ |
| 7 | `src/v19/render/utils.ts:110` | `text ?? "RESTRUKTURA … 02087420762 …"` | ✅ |
| 8 | `src/lib/prompts.ts:134` | riga incondizionata nel prompt statico | ✅ |
| 9 | `src/v19/tools/cigo/build-allegato10.ts:257` | letterale **accanto** al dato interpolato | ✅ (dai dati) |

### Le due cose che questo conto insegna

**1. La guardia non copre tutto, e va detto.** I punti 3, 4 e 5 portano **solo la
ragione sociale**, senza partita IVA. La guardia del Task 1 cerca le partite IVA:
**non li vedrebbe.** Su un documento de La Real Estate resterebbe «Restruktura
S.r.l.» stampato in fondo, e nessun controllo automatico lo troverebbe. Per
quei tre punti la **cura è l'unica difesa** — e questo è esattamente il motivo per
cui la promessa giusta è «non può passare inosservato» e non «non succederà mai».

> Estensione possibile, non fatta oggi e dichiarata: far cercare alla guardia
> anche le **ragioni sociali** oltre alle partite IVA. Costo: le denominazioni
> sono stringhe libere (`RESTRUKTURA S.r.l.` vs `RESTRUKTURA S.R.L.` vs
> `Restruktura S.r.l.`), quindi servirebbe una normalizzazione, e il rischio di
> falso positivo sale — una lettera che *nomina* l'altra società è molto più
> comune di una che ne riporta la partita IVA. Va misurato prima di costruirlo,
> non stimato. **Punto aperto.**

**2. Il duplicato è il difetto sotto il difetto.** Il punto 2 è una copia
**letterale** del punto 1: la stessa intestazione scritta due volte a venti righe
di distanza. Non è un errore di battitura, è la forma in cui i difetti si
moltiplicano — e il file `societa-documenti.ts` esiste già proprio perché questa
funzione era stata copiata in due posti. La cura non è correggere due stringhe:
è costruirne **una** e usarla tre volte.

### Il `grep` che questo insegna alla lista tarata

Il controllo **A8** non basta se cerca solo le partite IVA. Va cercata anche la
**ragione sociale**:

    grep -rn "RESTRUKTURA\|LA REAL ESTATE" src --include=*.ts | grep -vi "test\|spec" | grep -v "societa.ts\|identita.ts"

Con questo comando i nove punti si trovano **tutti**, il giorno in cui nascono.
Senza, se ne trovano sei — ed è precisamente l'errore che ho fatto stasera.

---

## UNDICI. E il conto l'ha chiuso lo strumento, non io

La sezione qui sopra dice nove, e propone un `grep` per trovarli. **Quel `grep`
era sbagliato:** cercava `RESTRUKTURA` maiuscolo, e i tre piedi di
`studio-tecnico.ts` scrivono `Restruktura S.r.l.` in minuscolo. Avrei proposto
alla lista tarata un controllo che manca un terzo dei casi che deve trovare —
cioè un controllo che dà **un falso verde**: lo stesso errore, in forma nuova,
commesso mentre lo catalogavo.

Il comando tarato è questo, e prima di scriverlo qui l'ho eseguito:

    grep -rniE "restruktura s\.?r\.?l|la real estate s\.?r\.?l" src --include=*.ts \
      | grep -vi "\.test\.\|spec\.ts\|__tests__" \
      | grep -v "societa.ts:\|identita.ts:"

24 righe, che contengono **tutti** i punti — e **due che il mio conteggio a mano
aveva mancato**:

| # | Punto | Cosa |
|---|---|---|
| 10 | `src/lib/pdf-generator.ts:653` | `creator: 'Cervellone — Restruktura S.r.l.'` — **metadati del PDF** |
| 11 | `src/lib/pdf-generator.ts:698` | `workbook.creator = 'Cervellone — Restruktura S.r.l.'` — **metadati dell'Excel** |

Un PDF de La Real Estate porterebbe «Restruktura S.r.l.» come **autore nelle
proprietà del file**: invisibile nella pagina, visibile a chiunque apra le
proprietà del documento o lo ispezioni. Non è la cosa più grave della lista, ma è
un dato societario dentro un documento consegnato, e nessuna guardia che legge il
**contenuto** lo vedrebbe mai — i metadati non stanno nell'HTML.

Sono due righe, nello stesso file dove `societa` diventa obbligatoria (Task 5):
`creator: 'Cervellone — ' + societa.denominazione`. Costo zero, fatte lì.

### Le righe legittime, per non toccarle

Delle 24, queste **non** sono difetti e vanno lasciate:

- tutto `src/lib/checkin/*` e `src/app/api/checkin/*` — il check-in **è**
  l'attività de La Real Estate, la sua ragione sociale lì è il dato giusto
- `src/lib/drive.ts:1254` — testo della descrizione di un tool, non un documento
- `src/lib/prompts.ts:129`, `:138`, `:146`, `:187`, `:188`, `:222` — l'identità e
  il blocco che descrive **entrambe** le società: è informazione, non intestazione
  (l'unica riga di `prompts.ts` da togliere è la **`:134`**)
- `src/lib/pdf-generator.ts:49` — un commento

### La lezione, che è la più utile di tutta la serata

**Ho sbagliato il conto quattro volte — 4, 6, 7, 9 — e ogni volta perché lo
strumento era più stretto della cosa da misurare.** Il conto giusto è arrivato
quando ho smesso di contare a mano e ho **tarato il `grep`**: lui ne ha trovati
undici, io undici meno due.

È la stessa regola che questo repo ha già scritto due volte (*«la misura non è il
dato»*, *«tarare lo strumento, non solo il dato»*), e stasera l'ho violata
proponendo un comando senza eseguirlo. La differenza fra le due versioni di quel
comando — `RESTRUKTURA` contro `-i` — è un terzo dei difetti.
