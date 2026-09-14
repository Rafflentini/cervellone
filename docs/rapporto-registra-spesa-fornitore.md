# `registra_spesa_fornitore` — rapporto

**14 settembre 2026.** Worktree `worktree-agent-a19e3a8503de3984a`.

## Il difetto che chiude

`compila_autofattura` sapeva creare l'integrazione TD17 in reverse charge per le
fatture estere: l'IVA a **debito**. La fattura d'acquisto a monte — il costo e
l'IVA a credito — nessuno la registrava. Mezzo adempimento.

Il perimetro l'ha dettato l'Ingegnere in una riga: *«deve solo mettere PDF e
importo»*. Il tool non legge il PDF, non ricava nessun importo, non indovina
niente.

## Come funziona

1. Si prepara un'anteprima e **non si scrive niente** su Fatture in Cloud.
2. Alla conferma (una sola: `spesa_ricevuta` sta in `A_CONFERMA_SINGOLA`) parte
   la catena: anti-doppione → scaricamento del PDF da Gmail → caricamento
   multipart su FIC → `POST /received_documents` → **rilettura**.
3. L'esito viene dalla rilettura, non dalla risposta della POST. Tre esiti mai
   confusi: `SPESA REGISTRATA`, `SPESA NON REGISTRATA`, `SPESA DA VERIFICARE`.

## Le difese, e la prova che sanno mordere

Ognuna è stata **spenta** e la suite è diventata rossa; poi ripristinata e
tornata verde. 14 mutazioni su 14 uccise (`grep`/conteggio dell'ancora prima e
dopo ogni mutazione, riletto dal disco: i sorgenti qui sono CRLF).

| Mutazione | Cosa spegne | Test che muore |
|---|---|---|
| `vat_default` | l'IVA prende la prima aliquota dell'elenco | «senza vat_id NON prepara niente…» |
| `conto_default` | il conto prende il primo dell'elenco | «senza modalita_pagamento…» |
| `doppione_compila` | l'anti-doppione della compilazione | «se su FIC c'è già quel fornitore…» |
| `doppione_crea` | l'anti-doppione della creazione | «ANTI-DOPPIONE anche alla conferma» |
| `doppione_fail_open` | un elenco troncato diventa «via libera» | «se l'elenco è TRONCATO si RIFIUTA» |
| `pagamento_non_saldato` | `status: 'paid'` → `not_paid` | «il piano pagamenti è ESPLICITO…» |
| `esito_senza_rilettura` | l'esito viene dalla POST | «POST riuscita ma rilettura che NON conferma» |
| `allegato_assente_ok` | documento senza allegato = riuscito | «allegato ASSENTE nella rilettura» |
| `pdf_non_ferma` | un PDF non scaricabile non ferma la creazione | «se il PDF non si scarica…» |
| `elimina_spesa_creata` | «annulla» torna a `eliminaDocumentoFIC` | «una spesa GIÀ registrata non si cancella da qui» |
| `allegato_indovinato` | con più allegati prende il primo | «con più allegati e senza nome_file si RIFIUTA» |
| `formato_non_controllato` | formato fuori elenco passa | «un formato che FIC non accetta…» |
| `imponibile_ambiguo` | `parseNumber` sull'imponibile | «un imponibile in formato italiano viene RIFIUTATO» |
| `conferma_doppia` | `spesa_ricevuta` esce da `A_CONFERMA_SINGOLA` | «spesa_ricevuta: … una conferma sola» |

Accanto a ogni rifiuto c'è il **controllo positivo** (con aliquota e conto veri
prepara; con `nome_file` sceglie; con un numero diverso prepara; …): un tool che
rifiuta sempre passerebbe ogni guardia senza fare niente di utile.

## Due difetti trovati dai test, non in produzione

- **Il nome del fornitore che non trovava il doppione.** Nel payload del pending
  finiva `entity.descrizione`, cioè la denominazione **decorata** («Booking.com
  B.V. (id 9)», o con l'avviso «NON risulta in anagrafica»). L'anti-doppione
  della conferma cercava con quella stringa e non trovava mai niente: era una
  difesa che sembrava esserci e non c'era. Ora il payload porta due campi:
  `fornitore` (nudo, per la ricerca) e `fornitore_descritto` (per l'anteprima).
- **`elimina_bozza_fic` avrebbe cancellato il documento sbagliato.**
  `eliminaDocumentoFIC` è cablato su `/issued_documents`: passargli l'id di una
  spesa avrebbe chiesto a Fatture in Cloud di cancellare la **fattura emessa**
  che porta quel numero. Stessa famiglia del difetto dei pagamenti già presidiato
  lì accanto. Ora la spesa già registrata non si cancella da qui.

## Cosa ho deciso io, e che qualcuno dovrebbe rivedere

1. **Il PDF si scarica DOPO la conferma, non prima.** In compilazione si *sceglie*
   l'allegato (si legge la mail, si controllano nome, formato e dimensione) ma i
   byte si prendono solo al momento di caricarli. Il prezzo: fra l'anteprima e la
   conferma la mail potrebbe sparire, e allora la spesa non nasce — l'anteprima lo
   dichiara. L'alternativa era parcheggiare un PDF in base64 dentro un campo JSON
   del database per il tempo di una conferma. Ho scelto di non farlo, ma è una mia
   scelta.
2. **Il payload manda `amount_net`, `amount_vat`, `amount_gross` *e* `items_list`.**
   Il brief ne elencava una parte; ho aggiunto gli altri due importi perché il
   `payments_list` deve valere il lordo e volevo che i numeri fossero spediti,
   non dedotti. Se Fatture in Cloud ricalcola dagli `items_list` con un
   arrotondamento diverso dal nostro, potrebbe rifiutare con 422 «il totale dei
   pagamenti non corrisponde». **Non verificabile in locale.**
3. **L'IVA in euro la calcolo io**, dal valore dell'aliquota *letto da FIC*
   (`Math.round(imponibile * valore) / 100`). Se FIC non espone `value`, il tool
   rifiuta invece di scrivere zero. Ma resta un calcolo nostro su un documento
   fiscale.
4. **`invoice_number`** è il campo in cui scrivo il numero del fornitore: è quello
   che `datiFattura` legge sui documenti ricevuti. Che sia **scrivibile** in
   creazione l'ho dedotto dalla lettura, non verificato.
5. **L'anti-doppione cerca l'anno della fattura** e filtra il fornitore in memoria
   (riuso di `cercaFattureRicevute`). Se il nome in anagrafica è diverso da quello
   scritto — «Booking.com» contro «Booking.com B.V.» — il filtro `includes` può
   mancare il doppione. Mitigato usando la denominazione **risolta**
   sull'anagrafica, non quella digitata: resta imperfetto se il fornitore non è in
   anagrafica affatto.
6. **Una spesa per chiamata**, non N come per pagamenti e autofatture. Ogni spesa
   porta il suo PDF, il suo numero e il suo anti-doppione: un gruppo confermato in
   blocco vorrebbe dire dire «sì» a quindici documenti mai visti uno per uno. Se
   l'Ingegnere vorrà il massivo, è un lavoro a parte.
7. **Refactor collaterale**: `resolveClientEntity` è diventata `resolveEntitaFic`
   con un parametro `segmento` (`clients` | `suppliers`), perché su un documento
   *ricevuto* l'anagrafica giusta è quella dei fornitori. Default invariato, i due
   chiamanti esistenti non cambiano comportamento. E i tre rami gemelli di
   `elimina_bozza_fic` passano ora da un unico `annullaPendingInAttesa`.

## La difesa che NON sono riuscito a costruire

**Non ho una prova che il multipart arrivi a Fatture in Cloud fatto bene.**
`caricaAllegatoFIC` costruisce `FormData` + `Blob` e lascia a `fetch` il
boundary; i test la sostituiscono, quindi provano che il *token* finisce sul
documento, non che il *file* arrivi integro. Un PDF corrotto o un `filename`
rifiutato si scoprirà al primo uso vero. Un test sul `fetch` vero (ispezionando
il corpo multipart) sarebbe possibile ma proverebbe la libreria, non noi:
l'unica prova che conta è la prima chiamata reale.

Insieme a questa restano non verificabili in locale: se FIC accetta
`invoice_number` in scrittura, se espone `attachment_url` nella rilettura con
`fieldset: 'detailed'` (il codice distingue «non l'ho visto» da «non c'è», ma
quale dei due casi sia quello vero lo dirà FIC), e se il payload degli importi
passa senza 422.

## Cosa resta da fare a mano

- ⛔ **La migrazione NON è applicata**:
  `supabase/migrations/2026-09-14-fic-pending-spesa-ricevuta.sql`. Finché non lo è,
  il tool si ferma sul salvataggio dell'anteprima con
  `violates check constraint "cervellone_fic_pending_tipo_check"` — è già successo
  due volte questo mese.
- Al primo uso vero: aprire il documento su Fatture in Cloud e controllare che
  l'allegato ci sia, che il numero del fornitore sia al posto giusto e che la
  spesa **non** compaia nello scadenzario.

## Verifiche

- `npx tsc --noEmit`: pulito.
- `npx vitest run`: **241 file, 3076 test verdi**, 4 saltati. I 36 test nuovi
  stanno in `src/lib/fic-write-tools.spesa.test.ts`, più uno in
  `conferma-fic.conferma-singola.test.ts`.
- `npx eslint` sui file toccati: 0 errori (3 warning preesistenti in
  `fatture-in-cloud.ts`, righe che non ho toccato).
- `npm run build`: **compila** e **passa il TypeScript**, poi si ferma su
  `supabaseUrl is required` raccogliendo i dati delle pagine — è il limite noto
  dei worktree (manca `.env.local`), non un difetto di questo lavoro.
- Impronta dei tool: da 140 a **141**, md5
  `1f2040fdd43a653c897ee0119d750d14` → `f3513aaed2b46c211dea858865676c1a`.
  Numero e impronta presi **dal fallimento del test**, con la voce di decisione
  scritta accanto alle altre.

### Un test fragile, non mio ma da sapere

`src/lib/fatture-in-cloud.pagamento-fornitore.test.ts` ha un caso che fa un
`await import('./fic-allegato')` dentro un timeout di 5 s. Su `main` quel file
impiega ~4,7 s a cache fredda: **la prima esecuzione dopo qualunque modifica a
`fatture-in-cloud.ts` lo fa scadere**, e la seconda passa. L'ho riprodotto e
misurato in entrambi i sensi (revertito → verde, rimesso → verde alla seconda
corsa). Non l'ho toccato — allargare il timeout di un test altrui non è lavoro
di questo ramo — ma è un falso rosso che farà perdere tempo a qualcuno.
