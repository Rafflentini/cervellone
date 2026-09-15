# `modifica_documento_fic` — modificare invece di cancellare e rifare

15 settembre 2026. Worktree `agent-aa8e0b5659dd449bd`, branch
`worktree-agent-aa8e0b5659dd449bd`, rebasato su `origin/main` (`30e9252`).

## Stato: FATTO, non applicato

Due commit:

- `151dcdc` — cancellare e rifare bruciava il numero: adesso un documento si MODIFICA
- `1c35b43` — l'impronta rimisurata dopo il rebase: 143 tool, `873a2973` -> `15b0192d`

⛔ La migrazione `supabase/migrations/2026-09-15-fic-pending-modifica-documento.sql`
**NON e' stata applicata**: la applica Raffaele. Finche' non lo e', il tool si ferma
sul salvataggio dell'anteprima con
`violates check constraint "cervellone_fic_pending_tipo_check"` — cioe' prima
ancora di parlare con Fatture in Cloud.

## Cosa fa

`modifica_documento_fic` cambia campi di un documento EMESSO gia' creato
(autofattura TD17, fattura, nota) che non sia ancora stato trasmesso:

- `data` del documento
- `note`
- descrizione e importo di una **riga esistente**, per posizione
- i «dati fattura collegata» (`DatiFattureCollegate` di una TD17)

Non aggiunge e non toglie righe, non tocca numero, serie, controparte e aliquota.

Motore in `src/lib/fic-modifica.ts`; anteprima, pending, conferma ed esito in
`src/lib/fic-write-tools.ts`.

## Le regole, e dove vivono

1. **Documento trasmesso = rifiuto.** `documentoModificabile` guarda `locked` e
   `ei_status`. Gli stati che valgono «mai partita» sono solo `''` (assente) e
   `not_sent`: **qualunque altro valore, compreso uno sconosciuto, fa rifiutare**,
   e il messaggio riporta il valore vero. Le difese si rifanno valere alla
   conferma, non solo sull'anteprima.
2. **Un campo non passato non si tocca.** La semantica del PUT di FIC non e'
   documentata (vincolo ereditato da `fic-pagamenti.ts`), quindi si rilegge il
   documento intero, ci si applicano sopra le sole modifiche e si rispedisce
   tutto meno i campi di sola lettura (`CAMPI_NON_SCRIVIBILI_EMESSA`, ora
   esportato da `fic-pagamenti.ts` perche' non esistano due elenchi divergenti).
   Un campo vuoto viene rifiutato, non letto come «cancella».
3. **Prima e dopo.** L'esito viene dalla RILETTURA: ogni campo chiesto e'
   confrontato col valore riletto; se anche uno solo non risulta cambiato il
   messaggio e' `MODIFICA DA VERIFICARE`. Si controllano anche gli invarianti
   (numero, tipo, controparte, stato SdI, TipoDocumento) e i totali, che possono
   muoversi SOLO se si sono toccate le righe.
4. **Conferma unica**, dentro `A_CONFERMA_SINGOLA`: vale sul percorso vocale e
   sui comandi `/fic_ok_` di entrambe le rotte.
5. **Anteprima con prima → dopo** campo per campo, piu' i campi gia' uguali
   dichiarati come tali. Alla conferma i «prima» si ricontrollano: se il
   documento e' cambiato nel frattempo, la modifica non parte.
6. **La risposta di FIC si riporta com'e'** (stato e testo), senza interpretarla.
7. Nessun token, nessun dato di cliente vero nei sorgenti e nei test.

## Prove

- `src/lib/fic-write-tools.modifica.test.ts`: 25 test, I/O finto
  (`vi.mock('./fatture-in-cloud')`), logica vera. Guardano il percorso chiamato
  (`PUT /c/111/issued_documents/77`) e il corpo spedito.
- Ogni guardia ha il suo controllo positivo (una modifica legittima passa).
- **12 mutazioni, 12 uccise** (guardia spenta -> suite rossa; file ripristinato e
  md5 verificato): `locked`, stato SdI, snapshot prima/dopo, conferma dalla
  rilettura, invarianti, corpo intero nel PUT, rifiuto quando non cambia niente,
  `ei_raw` assente, `gross_price` derivato, campo vuoto, testo vero di FIC,
  guardia di `elimina_bozza_fic`.
- `npx tsc --noEmit` pulito.
- Suite: **250 file e 3.156 test verdi**, rossi solo i due di `pdf-generator`,
  che esercitano davvero `puppeteer-core`.

⚠️ **Il checkout ha `node_modules` incompleto** (la cartella `pino` e' VUOTA;
mancano `puppeteer-core`, `@sparticuz/chromium`, `pdf-parse`, `rimraf`) e **33
file di test non si importano affatto**, da prima di questo lavoro — fra questi
`tools.differimento.test.ts`, `mappa-officina.test.ts`, `tools.registry.test.ts`.
Per misurare l'impronta e per verificare che non ci fossero regressioni ho
stuzzato SOLO quei pacchetti (in un file temporaneo prima, con un'aggiunta
temporanea a `vitest.setup.ts` poi), sempre ripristinando e verificando l'md5.
Le definizioni dei tool non toccano nessuno di quei pacchetti, e il conteggio
letto era 142 + 1.

## I dubbi — cosa andrebbe rivisto

1. 🚨 **`STATI_SDI_NON_TRASMESSO` e' una scommessa mia.** L'elenco degli stati
   SdI di Fatture in Cloud non l'ho potuto verificare su una fonte: qui dentro
   valgono «non trasmesso» solo lo stato vuoto/assente e `not_sent`. Se un
   documento mai trasmesso porta uno stato diverso (per esempio uno stato di
   bozza che non conosco), **il tool rifiutera' il caso normale**, che e' il
   difetto peggiore di una guardia. Si sbaglia dalla parte sicura e il messaggio
   stampa il valore vero, ma la prima modifica vera va guardata: se rifiuta,
   l'Ingegnere ci porta il valore e si allarga l'elenco con la prova in mano.
2. ⚠️ **Non ho mai visto un PUT vero su `issued_documents`.** Che FIC accetti di
   riscrivere il documento intero su un documento non trasmesso e' la mia
   ipotesi migliore, non una misura. Se rifiuta, la risposta testuale lo dira'
   senza inventare — ma potrebbe volerci un secondo giro per capire quali campi
   non gradisce. Il caso opposto e' gia' documentato nel repo: sulle fatture
   TRASMESSE il documento intero fa scattare il blocco, e per quello si manda
   solo `payments_list`.
3. ⚠️ **`gross_price` lo tolgo dalla riga toccata** perche' non so quale delle
   due verita' userebbe FIC fra netto nuovo e lordo vecchio. E' una scelta mia,
   ragionata, non verificata sull'API.
4. ⚠️ **Il tool non e' in `AZIONI_IRREVERSIBILI`**, per coerenza con
   `compila_autofattura` e `registra_spesa_fornitore`: chi prepara non scrive,
   scrive `conferma_bozza_fic`, che invece c'e'. Ma una modifica **perde i valori
   di prima**, e l'unico posto dove restano e' il payload del pending. Se si
   vuole che uno specialista non possa nemmeno prepararla, va aggiunto li'.
5. ⚠️ **Annullare non rimette i valori di prima.** `elimina_bozza_fic` su una
   modifica gia' scritta rifiuta e lo dice; la modifica inversa non la fa
   nessuno da solo. I valori vecchi sono nel pending: un «rimetti com'era»
   automatico sarebbe costruibile, ma e' una scrittura su un documento fiscale
   decisa da una macchina e non l'ho fatta.
6. ⚠️ **Difesa che NON sono riuscito a costruire: la prova sul campo.** Tutto
   quello che so di questo endpoint viene da documentazione e da codice di casa,
   non da una risposta vera di Fatture in Cloud. Il primo uso va fatto su un
   documento che si puo' sbagliare, e la modifica va **guardata a mano su FIC**
   prima di fidarsi — esattamente come e' stato scritto per
   `segna_fatture_emesse_pagate`.
7. ℹ️ L'anteprima mostra le date in ISO (`2026-08-03 → 2026-08-05`), come tutto
   il resto del repo, non nel formato italiano dell'esempio del brief.
