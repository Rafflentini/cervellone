# DECOLLO — dove siamo, 13 settembre 2026

**Spec:** `docs/superpowers/specs/2026-09-13-decollo-design.md`
**Ramo:** `feat/scrematura-e-mappa`, mergiato su `main` a ogni passo.

---

## Fatto

| Passo | Cosa | Stato |
|---|---|---|
| 1 | L'insieme delle prove (§8) | fatto prima, `src/prove/` |
| 2 | `runAgentTurn` restituisce l'esito, non solo il testo | ✅ `ac7490f`, `c548553`, `7aa5408` |
| 3 | Il registro degli specialisti coi test anti-marciume | ✅ `843d72b` |
| 4 | Il pilota: la contabile | ✅ il meccanismo. ⬜ **la prova sul campo** |
| 5 | Il secondo specialista | ⬜ non iniziato |

### Cosa esiste ora, in produzione ma SPENTO

- `EsitoTurno { testo, outcome, troncato, iterazioni, tool_chiamati }` — il motore dice **com'è andata**, non solo cosa ha scritto.
- `sinkMuto()` — uno specialista lavora in silenzio; la voce che parla all'Ingegnere è una sola.
- `PerimetroSpecialista` — i suoi attrezzi e nessun altro, bloccato **all'esecuzione** e non solo alla vista.
- `SPECIALISTI` + `AZIONI_IRREVERSIBILI` — il registro, con l'irreversibilità **calcolata**.
- `delega()` — il confine, con try/catch che torna **sempre** un esito.
- `chiedi_alla_contabile` — la porta, **dietro `DECOLLO=1`, spenta**.

**Per accenderlo:** `DECOLLO=1` su Vercel, poi `npx vercel redeploy <url>` — su Vercel le variabili sono legate al deployment, non al progetto.

---

## ⚠️ Cosa NON è provato, dichiarato

**Il pilota ha il meccanismo, non la prova.** I cinque criteri di riuscita del
disegno (§9) misurano il comportamento con **chiamate vere al modello**, che
costano. Nessuno dei cinque è stato eseguito:

1. ⬜ «quali fatture Limongi 2026 non sono pagate» → risposta giusta **e token
   non superiori a oggi**
2. ⬜ «di queste, quali hanno contanti sulla fattura» → i **tre esiti** distinti
3. ⬜ «segnale pagate» → il coordinatore chiede, l'Ingegnere tappa, la scrittura
   avviene — **anche a distanza di mezz'ora**
4. ⬜ su **entrambi** i canali, provato per canale
5. ⬜ il cammino del fallimento, con una domanda vera

Il quinto è l'unico che ha una prova **meccanica** (`delega.test.ts`, sei test),
ma con turni finti: prova che il confine si comporta bene, non che la contabile
fallisca in modo utile su un caso reale.

**Il numero 1 è quello che può bocciare il Decollo.** Un turno delegato **si
somma** a quello del coordinatore: se la contabile costa quanto costava fare
tutto da soli, la delega è un lusso. Va misurato su `api_usage`, non stimato.

---

## Come si accende, e cosa si guarda

**Nessuno di questi passi è stato eseguito.** Costano chiamate vere al modello.

### 1. Prima di accendere: la misura di partenza

Senza questa, il criterio n. 1 non è verificabile — non si può dire «non
superiore a oggi» senza sapere quanto è oggi.

```sql
-- Su Supabase. La spesa per turno, per canale, degli ultimi 7 giorni.
-- ⚠️ Le colonne sono PIATTE (input_tokens, output_tokens, estimated_cost_usd),
-- non dentro un JSON: verificato su src/lib/api-usage.ts:83. La prima stesura
-- di questa query leggeva `usage->>'input_tokens'` e avrebbe restituito NULL
-- su tutto — cioè un confronto fra due niente, che sembra un confronto.
select entry_point,
       count(*)                    as turni,
       round(avg(input_tokens))    as input_medio,
       round(avg(output_tokens))   as output_medio,
       round(avg(cache_read_tokens)) as cache_media,
       round(sum(estimated_cost_usd)::numeric, 2) as costo_totale
from api_usage
where created_at > now() - interval '7 days'
group by entry_point
order by turni desc;
```

**⚠️ La colonna del tempo si chiama `ts`, non `created_at`** — verificato su
`information_schema`. La prima stesura di questa query usava `created_at` e
sarebbe esplosa. E `entry_point` è `text` senza vincoli: le righe
`specialista:*` si scriveranno (controllato: l'unico vincolo della tabella è la
chiave primaria).

### 📊 La misura di partenza — **eseguita il 13 set 2026**, 7 giorni

| entry_point | turni | input medio | output medio | **cache letta media** | costo totale |
|---|---|---|---|---|---|
| `chat` | 141 | 31.795 | 3.270 | 290.301 | **$49,83** |
| `telegram` | 96 | 25.048 | 3.689 | 339.429 | **$100,64** |
| `cron:memoria` | 5 | 32.779 | 3.877 | 0 | $0,78 |
| `cron:audit` | 1 | 372 | 247 | 0 | $0,00 |

**Il numero che salta all'occhio, e che nessuno aveva guardato: Telegram costa
tre volte la chat, a turno.** $1,05 contro $0,35. Non è l'output (3.689 contro
3.270, praticamente uguale) e non è l'input (25.048, addirittura *meno* della
chat): è la **cache letta**, 339k contro 290k. Su Telegram il contesto
ricaricato a ogni turno è più grosso.

Quindi: **$151 in sette giorni**, e due terzi vengono da Telegram — il canale
con meno turni.

⚠️ Questa è un'**osservazione**, non una diagnosi: il perché quelle 339k si
ricarichino va indagato, non indovinato. Ma dice dove guardare, e dice che il
criterio n. 1 del pilota va misurato **per canale**: un miglioramento medio
nasconderebbe il canale che costa.

### 2. Accendere

`DECOLLO=1` su Vercel → `npx vercel redeploy <url>`. Su Vercel le variabili
sono legate al **deployment**, non al progetto: senza il redeploy non cambia
niente e sembrerebbe che l'interruttore non funzioni.

### 3. I cinque criteri, nell'ordine in cui vanno provati

Il **quinto va per primo**: se il cammino del fallimento non regge, gli altri
quattro non vale la pena misurarli.

| # | Cosa chiedere | Cosa guardare |
|---|---|---|
| 5 | una domanda a cui la contabile **non può** rispondere (un fornitore che non esiste) | il coordinatore riporta il fallimento **e cosa è stato provato**, senza travestirlo da risposta parziale né da silenzio |
| 1 | «quali fatture Limongi 2026 non sono pagate» | risposta giusta **e** `api_usage` di quel turno ≤ la media di partenza |
| 2 | «di queste, quali hanno contanti sulla fattura» | i **tre esiti** distinti: dichiarata / non dichiarata / **non leggibile** (un dato e un guasto non sono la stessa cosa) |
| 3 | «segnale pagate alla data della fattura» | la contabile **prepara**, il coordinatore chiede, tu tappi — e funziona **anche mezz'ora dopo** |
| 4 | ripetere 1 e 2 sull'**altro** canale | stessa risposta, stesso comportamento |

### 4. Il turno delegato, dove si legge

```sql
-- I turni degli specialisti si riconoscono dall'entry_point: `delega.ts` li
-- scrive come `specialista:<chiave>` (es. `specialista:contabile`).
-- `outcome`, `iterations` e `totalToolCalls` stanno dentro `meta` (jsonb):
-- verificati su claude.ts, dove logApiUsage li scrive.
select entry_point,
       meta->>'outcome'        as esito,
       meta->>'iterations'     as giri,
       meta->>'totalToolCalls' as tool,
       input_tokens, output_tokens, cache_read_tokens, estimated_cost_usd, ts
from api_usage
where entry_point like 'specialista:%'
order by ts desc limit 20;
```

E il confronto che conta davvero — **il costo di una richiesta intera**,
coordinatore più specialisti:

```sql
-- Tutto quello che è successo in una finestra di 5 minuti, in ordine.
-- Le righe `specialista:*` vanno SOMMATE a quella del coordinatore.
select entry_point, meta->>'outcome' as esito,
       input_tokens, output_tokens, cache_read_tokens, estimated_cost_usd, ts
from api_usage
where ts > now() - interval '5 minutes'
order by ts;
```

⚠️ **Il costo di un turno delegato si SOMMA a quello del coordinatore.** Per il
criterio n. 1 va sommato input+output del turno `chat`/`telegram` **e** di ogni
riga `specialista:*` con lo stesso momento. Guardare solo il turno del
coordinatore darebbe un falso verde: sembrerebbe che la delega costi meno
proprio perché una parte del lavoro è finita in un'altra riga.

### 5. Se qualcosa va storto

`DECOLLO` a qualunque cosa diversa da `1` (o cancellata) → redeploy. Il tool
resta nel registro e rifiuta, dicendo al coordinatore di fare il lavoro da sé:
nessuna capacità si perde, si perde solo la scorciatoia.

---

## Le cose trovate, che il piano non prevedeva

Sei difetti, tutti della **stessa famiglia**: *un ramo di codice che in
produzione non si percorre mai, e che si percorrerà sempre appena si aggiunge
il secondo chiamante.*

1. **Il tetto di iterazioni non avvisava nessuno.** Le altre due fermate
   scrivono una frase; questa era muta anche per l'Ingegnere.
2. **Il fallback per risposta vuota copriva la causa vera.** Un turno fermato
   dal budget veniva registrato `'empty'` invece di `'run_aborted'`.
   `'run_aborted'` è **escluso** dal conteggio del circuit breaker, `'empty'`
   no: uno specialista che sfonda il budget tre volte avrebbe fatto scattare il
   rollback su un modello sano.
3. **`tool_chiamati` mentiva, due volte in un giorno.** Prima leggeva i blocchi
   *richiesti* mentre il commento prometteva l'esecuzione (trovato dall'audit,
   sterilizzando `executeToolBlocks`: test verde lo stesso). Poi ricostruiva
   dai `tool_use_id` e contava come eseguito anche un tool **rifiutato**.
4. **Il motore non sapeva limitare gli attrezzi.** Il disegno lo dava per
   scontato. Senza, uno «specialista» è il coordinatore con un altro cappello.
5. **La vista non è una guardia.** Togliere un tool dalle definizioni non
   impedisce al modello di chiederlo per nome — e i nomi qui sono parole
   italiane ovvie (`send_email`).
6. **Un ciclo di import** (`tools → delega-tools → delega → claude → tools`)
   che faceva esplodere il registro con «DELEGA_TOOLS is not iterable». Il
   peggior tipo di guasto: si manifesta o no a seconda di quale file viene
   caricato per primo — può funzionare in locale e non su Vercel.

7. 🚨 **Tre righe su sette della tabella §4 del disegno erano false**, misurate
   sugli attrezzi veri. Due sbagliavano per eccesso di prudenza (la signora
   delle case e il capocantiere, segnati irreversibili senza averne il potere)
   e si sarebbero notate. **La terza no: l'archivista era segnato «no»** e ha
   in mano `gestisci_accesso_cartelle` e `genera_link_condivisione` —
   condividere è pubblicare. Toglieva una sorveglianza a chi ne aveva bisogno,
   e **non si sarebbe notata mai**.

   Il default `perimetroDiLavoro()` lo copriva lo stesso, perché **calcola**
   invece di fidarsi della tabella. È il caso che giustifica da solo la scelta
   di derivare tutto il derivabile.

8. **Un test verde da solo e rosso nella suite.** Il mock di `../delega` usava
   `importOriginal`, che tira dentro l'intero registro: sotto carico superava i
   5 secondi, il mock non era pronto, partiva la funzione **vera** e il test
   falliva con un valore che *sembrava* un difetto del codice. Il sintomo
   peggiore possibile.

9. **Un mio test provava il cavo e non il comportamento**, e me ne sono
   accorto scrivendone un altro: la difesa «nessuno specialista ha azioni
   irreversibili» stava in `delega.test.ts`, dove la mappa è **mockata** con un
   solo dominio — sei specialisti su sette risultavano a mani vuote e il test
   passava senza guardare niente. Spostato in `specialisti.test.ts`, dove
   `DOMINI` è quello vero, insieme alla funzione che verifica.

### Le due mutazioni SOPRAVVISSUTE, che valgono più di dieci test verdi

- **Il filtro `soloQuesti`:** i test del perimetro mockano `./tools`, quindi
  provavano che l'opzione **arriva** a `getToolDefinitions`, non che venga
  applicata. Disattivando il filtro restavano tutti verdi. → 5 test sul
  registro vero.
- **Il controllo su `troncato` in `delega.ts`:** restavano 16 su 16 verdi,
  perché ogni caso di troncamento che avevo scritto portava **anche** un
  outcome sbagliato — era il secondo controllo a salvarli. La combinazione
  mancante è reale: `troncato: true` **con** `outcome: 'success'`, il caso in
  cui il testo è scorrevole e il lavoro è tagliato a metà.

---

## Per tarare il prossimo audit

Tre domande che avrebbero trovato questi difetti **in fase di creazione**:

1. **Per ogni guardia esistente: quale ipotesi taciuta la tiene a riposo?**
   Qui era «`fullResponse` non è mai vuoto perché qualcuno ci scrive sempre
   sopra». Vera con un chiamante, falsa con due.
2. **Un test che mocka un modulo prova il CAVO o il COMPORTAMENTO?** Se mocka
   quello che dovrebbe verificare, serve un secondo test sul modulo vero.
3. **Ogni asserzione di fallimento è salvata da UN solo controllo?** Se un caso
   di prova attiva due condizioni insieme, disattivarne una non si nota.

---

## Test modificati, dichiarato

La regola di questo progetto è: *se per far passare un test esistente devi
modificarlo, fermati e riferiscilo.* Due sono stati modificati, e qui è scritto
perché.

1. **`tools.differimento.test.ts`** — l'asserzione «132 definizioni + impronta
   md5». Il test è **progettato** per questo: il suo commento dice «o è stata
   rotta per sbaglio, o si è DECISO di cambiarla — e allora va scritta la
   decisione, non il nuovo md5». La decisione è scritta. Il numero sale a 133.

2. **`mappa-officina.test.ts`** — la guardia «ogni tool fuori dal nucleo sta in
   esattamente un dominio» ora esclude `TOOL_DEL_COORDINATORE`.
   ⚠️ **Questa merita attenzione**, perché è un'esenzione da una guardia, cioè
   una scorciatoia per chi un giorno avrà fretta. La guardia ha morso
   giustamente: `chiedi_alla_contabile` non appartiene a nessun mestiere,
   serve a **girare il lavoro a chi il mestiere ce l'ha**, e il modello del
   mondo di quel test non lo prevedeva. Non sono state allargate le maglie —
   sarebbe stato spegnere la difesa insieme al problema — ma aggiunta una
   categoria **chiusa e sorvegliata** da tre test suoi: dimensione ≤ 3, ogni
   nome esiste davvero, nessuno sta anche su uno scaffale.

---

## Decisioni prese senza chiedere, e perché

- **Il perimetro di default esclude le azioni irreversibili.** La regola
  («né il coordinatore né la segretaria spedisce MAI una fattura») sta nel
  *valore predefinito* e non in una nota: una guardia che ci si deve ricordare
  di accendere è una guardia che un giorno resta spenta.
- **Il tool resta nel registro anche a interruttore spento.** Un tool che
  compare e scompare a seconda di una variabile sfuggirebbe alle guardie
  anti-buco: si spegnerebbe la difesa insieme alla funzione.
- **Il rifiuto a interruttore spento dice al coordinatore di farlo lui.** Un
  «non disponibile» secco lo farebbe rispondere «non posso farlo» — la frase
  che questo progetto combatte da mesi — mentre gli attrezzi ce li ha tutti.
- **La tabella del disegno §4 è già smentita dal codice.** Segna «la signora
  delle case → sì (Questura)»; nessun tool trasmette alla Questura. Il registro
  lo **calcola** e dice la verità di oggi. C'è un test che la contraddice
  apposta, e morirà — giustamente — il giorno che il tool arriverà.
