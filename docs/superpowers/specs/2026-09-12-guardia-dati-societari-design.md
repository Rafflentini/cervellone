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

## Dove sta la guardia

**Dentro l'imbuto, non nei chiamanti.** Tutti i documenti HTML→PDF e HTML→Word passano per
due funzioni sole:

- `generatePdfFromHtml(html, title, opzioni)` — `src/lib/pdf-generator.ts:384`
- `generateDocxFromHtml(html, title, opzioni)` — `src/lib/pdf-generator.ts:520`

con **sei** punti di chiamata (`document-template-tools.ts:305`, `draft-tools.ts:249`,
`sal-tools.ts:189`, `tools.ts:152`, `tools.ts:166`). Se la guardia stesse nei chiamanti, il
settimo punto scritto fra un mese la dimenticherebbe **senza che nessuno se ne accorga**.
Dentro l'imbuto, nessuno la aggira per distrazione.

`src/v19/render/docx.ts:renderDocx` genera dai modelli `.docx` con segnaposto e **non passa
da lì**: è un secondo imbuto, coperto separatamente (Task 6).

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
