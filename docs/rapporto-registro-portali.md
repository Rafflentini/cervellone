# Il registro a stati delle commissioni dei portali — rapporto

15 settembre 2026.

## Il difetto che chiude

Per quattro fatture Booking nessuno sapeva se un documento esistesse. L'id
`552625594` e' stato inseguito per un'ora su Fatture in Cloud — `issued_documents`,
`received_documents`, elenco per anno, e perfino l'altra societa' — prima di
capire che **non era mai stato creato**: la POST era fallita con un 422 e il tool
aveva comunque restituito un id rimasto da un tentativo precedente.

Con una riga per fattura e uno stato, quella domanda ha un posto solo dove si
risponde.

## Cosa c'e'

- **Migrazione** `supabase/migrations/2026-09-15-registro-portali.sql` — ⛔ **scritta e NON applicata.**
  Tabella `cervellone_registro_portali`, RLS accesa, **nessuna policy permissiva**
  (solo `service_role`), come le altre `cervellone_*`.
- **Motore** `src/lib/registro-portali.ts` — una funzione sola, `aggiornaRegistroPortali`,
  chiamata da tutti e due i tool che scrivono documenti.
- **Tool** `src/lib/tools/registro-portali-tools.ts` — `registro_portali_situazione`
  (a che punto siamo) e `registro_portali_riconcilia` (il registro dice la verita'?).
  Registrati in `ALL_TOOLS`/`EXECUTORS` (dietro il wrapper `contabile`: la societa'
  la decide la conversazione, mai l'input) e nello scaffale **Contabilita e fatture**
  di `mappa-officina.ts`, cioe' nel perimetro della **contabile**.
- **Gli adattatori**: `registra_spesa_fornitore` e `compila_autofattura` scrivono
  nel registro, e le loro **descrizioni lo dichiarano** — una capacita' che non e'
  nello schema, per il modello non esiste.

## Le quattro regole, e dove stanno nel codice

1. **Uno stato avanza solo su un fatto verificato.** `aggiornaRegistroPortali` non
   parla con Fatture in Cloud: la chiamano i due tool, e **solo dopo la rilettura**.
   - spesa riletta → `spesa_registrata`, con `spesa_fic_id`;
   - TD17 riletta **e** passata dalla verifica formale dell'XML → `td17_generata`;
   - TD17 riletta ma **bocciata** dalla verifica formale → `da_verificare`, **con**
     l'id (il documento esiste: rifarlo sarebbe un doppione);
   - rilettura che **non** conferma → `da_verificare` e l'id **solo nella nota**,
     mai in `spesa_fic_id`/`td17_fic_id`. E' esattamente il caso `552625594`.
2. **Un registro che mente e' peggio di nessun registro.** Se la scrittura fallisce
   dopo che il documento su FIC e' nato, `avvisoRegistroNonScritto` compone la riga
   che il tool **dice**, con l'id vero e un «NON rifarlo».
3. **Il registro non e' la verita'.** `registro_portali_riconcilia` rilegge da FIC i
   documenti che una riga cita. Scopre: il documento cancellato a mano (404), lo
   stato che promette un documento di cui la riga non porta l'id, numero e
   imponibile diversi, il tipo sbagliato. E distingue «non c'e' piu'» da «non sono
   riuscito a leggerlo» — un token scaduto non deve far dichiarare cancellato
   mezzo anno di documenti.
4. **Chi scrive i documenti aggiorna il registro.** Una funzione, un file, due
   chiamanti. Il registro tenuto da due copie di codice diverse diverge in tre
   settimane: e' cosi' che e' morta la memoria di lavoro di questo progetto.

## L'anti-doppione sta nel DATABASE

Indice `uniq_registro_portali_fattura` su `(societa, portale, numero_chiave)`, dove
`numero_chiave` e' una **colonna generata** dal database:
`upper(regexp_replace(numero_fattura, '[^A-Za-z0-9]', '', 'g'))`.

Due scelte da segnalare:

- la chiave e' sul numero **normalizzato**, non sul testo grezzo: «FT 123/2026» e
  «ft123-2026» sono lo stesso documento, ed e' la stessa normalizzazione che
  `chiaveNumeroFattura` gia' applica all'anti-doppione su Fatture in Cloud;
- la colonna e' **generata**, quindi non si puo' scrivere a mano e non puo'
  divergere dal numero vero.

Un test legge il vincolo **dal file .sql**: se qualcuno toglie l'indice, la suite
muore.

## I due stati della specifica che NON ci sono

`pdf_archiviato` e `controlli_ok` sono rimasti fuori, ed e' una scelta.

- **`pdf_archiviato`**: noi il PDF non lo archiviamo su Drive. Sta **allegato** al
  documento di spesa su Fatture in Cloud, e `rileggiSpesa` gia' controlla che ci
  sia. Non esiste nessun atto separato di archiviazione che qualcuno compia.
- **`controlli_ok`**: i controlli sono **dentro** i tool — verifica formale
  dell'XML, anti-doppione, rilettura — e avvengono prima che lo stato avanzi.
  Non c'e' nessun momento in cui qualcuno «fa i controlli».

Uno stato che non corrisponde a un fatto verificabile non lo sa far avanzare
nessuno: resterebbe li' per sempre, e una riga ferma su uno stato inventato fa
sembrare in ritardo un adempimento concluso. Rumore.

## Come si verifica

`npx tsc --noEmit` pulito. `npx vitest run`: **260 file, 3.352 test verdi**
(+49 rispetto alla base: 3.303).

Mutazioni — 11, tutte **uccise**, ognuna con `grep -c` prima/dopo (1 → 0) e md5
del file confrontato dopo il ripristino. ⚠️ I sorgenti di questo repo sono CRLF:
i file nuovi sono stati normalizzati a CRLF **prima** di mutare, e nessuna
sostituzione e' ancorata a fine riga.

| # | mutazione | esito |
|---|---|---|
| M1 | il rango sparisce: lo stato puo' tornare indietro | uccisa |
| M2 | `da_verificare` non e' piu' appiccicoso | uccisa |
| M3 | il `23505` del database trattato come errore qualunque | uccisa |
| M4 | lettura fallita = «non c'e'» → si inserisce al buio | uccisa |
| M5 | scadenza inventata quando manca la ricezione | uccisa |
| M6 | qualunque fornitore diventa un portale | uccisa |
| M7 | il vincolo UNIQUE sparisce dalla migrazione | uccisa |
| M8 | ogni guasto di FIC letto come «documento sparito» | uccisa |
| M9 | registro illeggibile riportato come registro vuoto | uccisa |
| M10 | il tool TACE il registro non scritto | uccisa |
| M11 | lo stato avanza senza che nessuno l'abbia verificato | uccisa |

Ogni difesa ha accanto il suo **controllo positivo**: un registro che rifiuta
sempre, o che non avanza mai, supererebbe tutte le guardie senza servire a niente.

## Le decisioni che ho preso io, e che vanno riviste

1. **`da_verificare` e' APPICCICOSO.** Un fatto nuovo, anche verificato, scrive i
   suoi campi ma **non toglie** il cartello. Ragione: chi l'ha messo aveva visto
   qualcosa che nessuno ha ancora guardato. Conseguenza: **non esiste nessun modo,
   dentro Cervellone, di rimettere in linea una riga marcata `da_verificare`** —
   si fa a mano sul database. E' la ruvidezza piu' grossa di questo lavoro.
2. **La societa' e' quella della conversazione**, sempre, anche in lettura: da un
   contesto Restruktura non si vede il registro de La Real Estate. Coerente con
   gli altri tool contabili, ma vuol dire che «tutte le fatture dei portali» non
   e' una domanda che si possa fare una volta sola.
3. **`data_ricezione` e' un parametro nuovo, facoltativo, di
   `registra_spesa_fornitore`.** Senza, la scadenza non si calcola: **non ripiego
   su oggi e non ripiego sulla data del documento**, perche' sposterebbero in
   avanti un termine vero. La riga nasce senza scadenza e il registro lo dice.
   `compila_autofattura` la aveva gia'.
4. **Il `regime` lo scrive solo la strada dell'autofattura** (`RC`, per
   costruzione: un'integrazione TD17 esiste solo in reverse charge). La spesa non
   lo deduce dall'etichetta dell'aliquota: sarebbe indovinare una qualificazione
   fiscale.
5. **Il portale si riconosce dal NOME del fornitore** (`booking`/`airbnb`
   contenuti nella denominazione). Se domani l'anagrafica cambia nome, quella
   fattura smette di entrare nel registro — in silenzio. Non l'ho difeso.

## Le difese che NON sono riuscito a costruire

- **Nessuno fa avanzare `td17_inviata`, `sdi_consegnata`, `chiusa`.** Sono nel
  `CHECK` perche' la specifica li chiede, ma Cervellone non trasmette allo SdI:
  lo fa l'Ingegnere da Fatture in Cloud. `registro_portali_riconcilia` **vede** il
  fatto (legge `ei_status` da FIC e lo riporta) ma **non scrive**, perche' il
  brief lo chiama tool di lettura. E' lo stesso difetto per cui ho lasciato fuori
  `pdf_archiviato`, con l'aggravante che questi tre stati ci sono: **oggi una
  riga si ferma a `td17_generata` per sempre.** La cura naturale e' una scrittura
  con conferma dentro la riconciliazione (`ei_status` riletto → avanza), e non
  l'ho fatta.
- **Niente scrittura di `stato_sdi`**, per lo stesso motivo: la riconciliazione lo
  legge e lo dice, ma la colonna resta vuota.
- **Il registro non si popola da solo**: nasce solo quando uno dei due tool crea
  un documento. Una fattura di commissioni ricevuta e mai lavorata **non compare**,
  e quindi non risulta nemmeno in ritardo. `registro_portali_situazione` lo dichiara
  esplicitamente quando non trova righe, ma e' un avviso, non una difesa: manca
  il passo «censisci le fatture del portale in arrivo».
- **La migrazione non e' stata applicata** (come richiesto), quindi il vincolo
  unico e le colonne generate sono provati contro un finto Supabase che li imita
  e contro il testo del `.sql`, **non contro Postgres**. L'espressione
  `upper(regexp_replace(...))` la do per immutabile — se non lo fosse, la colonna
  generata verrebbe rifiutata al momento dell'applicazione.
