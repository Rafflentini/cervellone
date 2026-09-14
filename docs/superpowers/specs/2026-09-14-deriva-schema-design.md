# La deriva fra il repo e il database — design

*14 settembre 2026*

## Il problema, misurato

Il 14 settembre 2026, partendo da un errore visto per caso nei log
(`column procedures.output_preferences does not exist`), un audit ha confrontato tutte e 43 le
migrazioni di `supabase/migrations/` con il database di produzione. **Cinque non erano mai state
applicate**, e due reggevano codice vivo:

- **`2026-06-13-procedures-output-preferences`** — `getProcedure` metteva `output_preferences`
  nella SELECT, la query falliva intera, la funzione tornava `null` a ogni chiamata. La memoria di
  lavoro è stata inerte **tre mesi**, con il flag `working_memory_enabled` **acceso**, su entrambi
  i canali. In produzione c'erano tre procedure che il bot non ha mai letto — una aggiornata
  quattro giorni prima.
- **`2026-05-06-gmail-processed-pk-fix`** — la chiave primaria era rimasta semplice mentre il
  codice faceva l'upsert con `onConflict: 'message_id,bot_action'`. Postgres rispondeva 42P10 e
  l'errore finiva in un `console.error` inghiottito. Prova a runtime: **`gmail_processed_messages`
  conteneva ZERO righe.** L'anti-loop delle risposte Gmail non è mai esistito, e il cron
  `gmail-alerts` rialzava lo stesso alert critico a ogni giro.

Entrambe sono state applicate lo stesso giorno. **Questa spec non serve a quelle due: serve a
impedire la sesta.**

### La causa, che è più grande dei cinque sintomi

`supabase_migrations.schema_migrations` ha 44 righe, ma **non sono i nomi dei file del repo**:
~18 file del repo non vi compaiono, e il registro elenca ~14 migrazioni che nel repo non esistono.
**Diverge in entrambe le direzioni.** Oggi nessuno può rispondere alla domanda «questa migrazione è
applicata?», e finché è così ogni migrazione nuova è una scommessa che si scopre mesi dopo.

## Il vincolo che decide la forma (verificato, e smentisce la prima idea)

La prima proposta era «un test che fa fallire la suite». **Non sta in piedi.**
`vitest.setup.ts` impone credenziali Supabase **finte con assegnazione secca** — apposta, perché un
test che dimenticasse un mock non scriva sul database vero — e `.github/workflows/ci.yml` non porta
nessuna credenziale Supabase. Nessun test tocca il database vero, e non deve.

Un controllo che *tenti* di leggere il database dai test avrebbe due esiti, entrambi cattivi:
fallire sempre, oppure **saltarsi in silenzio**. Il secondo è precisamente il difetto che stiamo
uccidendo.

**Quindi la logica si separa dalla lettura**: il confronto è una funzione pura, provabile offline;
la lettura del database vera avviene in produzione, dove la chiave di servizio esiste.

## Architettura

### 1. `src/lib/deriva-schema.ts` — il cuore, senza database

Tre pezzi, ciascuno con un compito solo:

**`oggettiAttesi(sqlPerFile)` → `OggettiAttesi`.** Legge il testo delle migrazioni ed estrae ciò
che il repo *promette* che esista. Riconosce SOLO forme ben definite:

| forma SQL | oggetto atteso |
|---|---|
| `CREATE TABLE [IF NOT EXISTS] <t>` | tabella `<t>` |
| `ALTER TABLE <t> ADD COLUMN [IF NOT EXISTS] <c>` | colonna `<t>.<c>` |
| `ALTER TABLE <t> ADD PRIMARY KEY (<cols>)` | chiave primaria di `<t>` su `<cols>` |
| `CREATE [UNIQUE] INDEX [IF NOT EXISTS] <i>` | indice `<i>` |
| `INSERT INTO cervellone_config (key, value) VALUES ('<k>'` | chiave di configurazione `<k>` |

**`confronta(attesi, fotografia)` → `Deriva`.** Funzione pura: due elenchi dentro, l'elenco dei
mancanti fuori. Nessun I/O, nessuna data, nessun caso speciale.

**`fotografaSchema()` → `Fotografia`.** L'unico pezzo che parla col database. Vive dietro
un'interfaccia, così `confronta` si prova senza.

⚠️ **Ostacolo trovato in autorevisione, prima di scrivere una riga.** Il client Supabase non può
leggere `information_schema` né `pg_catalog`: PostgREST espone solo gli schemi dichiarati
(`public`), e quelli non ci sono. La fotografia **non si può prendere dal client**.

Cura: una **funzione Postgres di sola lettura** `public.fotografia_schema()` che ritorna un `jsonb`
con tabelle, colonne, chiavi primarie, indici e chiavi di `cervellone_config`, chiamata con
`supabase.rpc('fotografia_schema')`. Nasce con la sua migrazione — applicata con `apply_migration`,
così **resta registrata**, che è il punto di partenza di tutta questa storia.

Vincoli sulla funzione, non negoziabili:
- `STABLE`, nessuna scrittura. Il guardiano guarda e basta.
- `SECURITY INVOKER` (non `DEFINER`): il `service_role` legge già i cataloghi, e una funzione
  `DEFINER` sui metadati è un potere che non serve a nessuno.
- `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`, `GRANT` al solo `service_role`: la forma
  del proprio schema non è una cosa che si racconta a chi passa.
- ⚠️ **Questa migrazione è essa stessa soggetta alla deriva che cura.** Se la funzione mancasse,
  `fotografaSchema()` deve **fallire dicendolo** — mai tornare una fotografia vuota, che il
  confronto leggerebbe come «manca tutto» o, peggio, come «tutto a posto». È il caso limite più
  pericoloso dell'intero lavoro e va provato per primo.

### 2. 🚨 La regola anti-silenzio — è la parte che conta

Il parser incontrerà forme che non conosce (`DO $$`, viste, funzioni, `ALTER COLUMN`, policy RLS).
**Non deve fare finta di aver controllato.**

`OggettiAttesi` porta con sé un campo **`nonInterpretate`**: ogni statement che il parser non ha
saputo classificare, col nome del file e il testo troncato. Il rapporto finale dice sempre **due**
numeri: *«N oggetti verificati, M statement che non so leggere»*.

Senza questo, «nessuna deriva» finirebbe per voler dire «non ho guardato» — che è esattamente il
modo in cui `output_preferences` è sopravvissuta tre mesi, e il modo in cui tre commenti di questo
repo hanno promesso difese che non esistevano.

⚠️ Corollario di forma: il conto degli oggetti verificati **non deve poter essere zero in
silenzio**. Zero oggetti attesi su 43 file significa che il parser è rotto, non che va tutto bene,
e va segnalato come un guasto.

### 3. Dove gira, in produzione

**Un tool, non un comando slash.** `verifica_deriva_schema`: Raffaele chiede *«il database è
allineato al repo?»* e ha la risposta, sui due canali, perché `getToolDefinitions()` non conosce i
canali e un tool nasce equipollente per costruzione.

**Il cron `self-audit`** (settimanale, e dall'11 settembre consegna davvero) include la deriva nel
suo rapporto: è il battito che oggi non c'è. Se la deriva è zero **lo dice lo stesso** — un
sorvegliante che parla solo quando c'è un guasto è indistinguibile da uno morto.

## Prove

**Offline, nella suite:**
1. `oggettiAttesi` su un SQL di prova estrae le cinque forme, una per una.
2. `oggettiAttesi` sulle **43 migrazioni vere del repo**: il conto degli oggetti dev'essere
   `> 0` e gli statement non interpretati dev'essere un numero *dichiarato*, non nascosto.
3. `confronta` trova il mancante quando manca, e **non inventa** quando non manca.
4. Controllo positivo: con una fotografia completa, la deriva è vuota. Senza, il test resterebbe
   verde anche con un `confronta` che dice sempre «tutto mancante».
5. **Mutazione**: una migrazione finta che aggiunge una colonna inesistente deve comparire fra i
   mancanti. Se non compare, il guardiano è decorativo.
6. **Mutazione anti-silenzio**: uno statement che il parser non sa leggere deve finire in
   `nonInterpretate`. Se sparisce, il rapporto mente per omissione.
7. **Il caso limite pericoloso**: se `fotografia_schema()` non esiste o la RPC fallisce,
   `fotografaSchema()` deve sollevare o tornare un esito di errore **esplicito**. Il test pretende
   che il rapporto dica «non ho potuto guardare» e **non** «nessuna deriva». Un guardiano che tace
   quando non riesce a guardare è peggio di nessun guardiano: fa credere che qualcuno controlli.

**In produzione:** il primo giro deve ritrovare **le tre migrazioni inerti già note**
(`gmail-classification`, `v19-foundation`, `v19-memories-bucket`). È il controllo positivo sul
campo: se il guardiano nasce e dice «nessuna deriva», è rotto — perché la deriva, oggi, c'è e la
conosciamo.

## Fuori da questa spec, e detto apposta

- **Il battito positivo dei cron.** Oggi nessuna delle undici rotte lascia traccia di essere
  passata, e il 14 settembre questo ha impedito di rispondere a «i cron girano ancora?» dopo un
  deploy. È un fratello stretto di questo lavoro e va fatto, ma è un lavoro suo.
- **Le tre migrazioni inerti**: applicarle o cancellare il codice morto che le userebbe. Decisione
  di Raffaele, non di questa spec — che però le userà come banco di prova.
- **Riparare il registro** `supabase_migrations`. Questo guardiano lo rende non necessario: non
  chiede a un registro cosa è stato applicato, lo chiede allo schema.
- **Applicare da sé le migrazioni mancanti.** No: il guardiano *dice*, non scrive. Una correzione
  automatica su un database di produzione è un potere che non gli serve.
