# Il censimento delle capacità — 11 settembre 2026

Doveva rispondere a una domanda sola: **differendo le definizioni dei tool, si perde qualcosa?**

La risposta è **sì, cinque cose, e sono state recuperate**. Ma la parte istruttiva di questo
documento non è quel numero: è che **il censimento ha dato tre risposte sbagliate prima di darne una
giusta**, e ogni volta l'errore era nello strumento, non nel codice misurato.

---

## 1. Le tre risposte sbagliate

| # | cosa diceva | perché era sbagliata |
|---|---|---|
| 1 | **67 tool persi su 119** | **Mancava il termine di paragone.** Il censimento chiedeva «questo tool è raggiungibile?» e non «lo era **prima**?». Rifatto in forma differenziale: **47 dei 67 erano già irraggiungibili oggi**, con tutti e 129 i tool caricati. Non era il differimento: era la mia richiesta di prova, costruita dalla prima frase della descrizione del tool, che spesso non è un compito. |
| 2 | **9 tool persi** | **Il prompt non diceva al modello che i suoi strumenti sono cercabili.** In 6 casi su 9 la diagnosi mostrava `query: (nessuna ricerca)`: il modello non cercava affatto, rispondeva con i pochi tool del nucleo. Il `BASE_PROMPT` non lo dice da nessuna parte. Aggiunta una riga: **da 3 a 7 ricerche su 9**. |
| 3 | **4 tool «che la ricerca non trova»** | **`max_tokens: 500` troncava la risposta** subito dopo la chiamata di ricerca, prima che i risultati arrivassero. Sembrava che la ricerca tornasse vuota. Alzando a 3.000, `checkin_prepara_foglio` è passato da «non trovato» a **trovato e chiamato**. |

⭐ **Tre tarature, tre risposte diverse.** Se la prima cifra fosse stata portata all'Ingegnere come
verdetto, il lavoro sarebbe stato buttato per un difetto della misura.

---

## 2. La corsa di controllo negativo — l'unica ragione per cui i numeri valgono qualcosa

**Fatta prima di ogni altra cosa.** Con un prompt che vieta l'uso degli strumenti, su 12 tool:
**12 NON RAGGIUNTI, zero chiamati, zero trovati.**

Serve a rispondere alla domanda che un censimento non si fa mai: *sa dire di no?* Senza, un «119 su
119 raggiungibili» sarebbe potuto essere uno strumento che risponde sempre di sì.

---

## 3. La risposta giusta — con frasi vere

Le richieste derivate dalle descrizioni sono scritte male per costruzione. La prova finale usa
**frasi scritte come le direbbe l'Ingegnere**, sulle due configurazioni:

| tool | oggi | col differimento | |
|---|---|---|---|
| `riconcilia_automatico` | ✅ | `lista_movimenti` | la ricerca **lo trovava**, il modello sceglieva un altro |
| `modello_attivo` | ✅ | `richiama_memoria` | |
| `checkin_prepara_foglio` | ✅ | `richiama_memoria` | |
| `cervellone_check_aggiornamenti` | ✅ | `cervellone_info` | |
| `affitti_imposta_soggiorno` | ✅ | **niente** | rispondeva a parole |
| `affitti_situazione` | ✅ | perso 2 volte su 3 | |

**Cinque perse stabilmente, più una a 2/3.** Stabilità verificata rilanciando tre volte: due tool
(`weather_now`, `estrai_movimenti`) comparivano una volta su tre ed erano **rumore**.

### La cura, e quanto costa

I sei entrano nel nucleo: **3.602 byte, ~1.200 token**. Il pavimento dei soli tool passa da 5.785 a
**6.985 token**, contro i **33.635** di oggi — resta **−79%**.

⚠️ Ma entrano **separati**, in `NUCLEO_DEBITO_RICERCA`, non nel nucleo di disegno: ci stanno perché
**la ricerca non li ritrova**, non perché lo meritino. È un **debito**, e il file lo dichiara: ognuno
esce da lì il giorno in cui la sua descrizione conterrà le parole con cui lo si cerca.

### La verifica finale

Con il nucleo a 14 e l'avviso nel prompt, rifatta la prova sulle sei più tre di controllo:

**9 su 9 chiamano lo stesso tool di oggi. Zero perse.** E `getToolDefinitions()` senza argomenti ha
md5 **`5fe48792af88c5f89beaf66c53366b1c`**, identico a `main`.

---

## 4. Il braccio A — e perché non risponde alla domanda per cui era stato costruito

Rigioca i **primi messaggi veri** delle conversazioni dell'Ingegnere (22 auto-contenuti, presi dal
database) nelle due configurazioni.

**Esito grezzo: 7 su 18 chiamano lo stesso insieme di tool. Token: −38%.**

**Undici divergenze — e NON sono rumore.** Il controllo lo dimostra: la stessa richiesta, due volte
di fila sulla configurazione di oggi, dà **0 divergenze su 6**. Oggi il comportamento è
deterministico.

🚨 **Ma il braccio A ha un difetto che lo rende inconcludente, ed è mio:** confronta **solo la prima
risposta**, mentre in produzione il ciclo fa fino a **10 iterazioni**. Col differimento il modello
spesso spende il primo giro a orientarsi o a cercare — per esempio su *«Fammi un preventivo per la
sig.ra Giano»* chiama `imposta_progetto_attivo` mentre oggi chiama subito `genera_preventivo_completo`
— **ma la ricerca aveva già trovato `genera_preventivo_completo`**, e il turno sarebbe proseguito.
Un primo passo diverso non è una capacità persa.

**Per rispondere davvero servirebbe eseguire il ciclo intero con i tool veri** — cioè mandare mail e
creare fatture. Non è una cosa che si fa in uno script.

> **Quindi la verifica che manca non è scrivibile: va fatta in produzione, guardando.** È la stessa
> conclusione dell'8 settembre, quando dieci minuti di verifica vera trovarono un difetto che 1.863
> test verdi non vedevano.

---

## 5. ⚠️ Un difetto trovato per caso, mentre costruivo la verifica

Il braccio A, alla prima corsa, ha letto **zero messaggi** e **non si è lamentato**. Causa:
`.env.local` non contiene `SUPABASE_SERVICE_ROLE_KEY`, il client è ripiegato su anonimo, **RLS ha
negato, e la lettura è tornata vuota** — indistinguibile da «non c'è niente».

È esattamente `cervellone-lettura-negata-torna-vuota`, il difetto annotato il 10 settembre, che
riguarda **~22 funzioni** altrove nel codice. Mi ha morso mentre costruivo lo strumento che doveva
trovare i guasti.

---

## 6. I limiti, dichiarati

- Le richieste del braccio B sono **derivate dalle descrizioni dei tool**: circolari. Il numero «90
  già irraggiungibili oggi» **non significa** che il Cervellone non sappia fare quelle 90 cose —
  significa che quelle 90 richieste di prova sono scritte male.
- **L'unico numero difendibile è il differenziale**, perché il difetto della richiesta si annulla da
  entrambe le parti.
- Le 22 richieste del braccio A **non sono un campione**: sono tutto il traffico auto-contenuto che
  esiste.
- Il braccio A guarda **un turno solo** (vedi §4).
- Niente di tutto questo è stato provato con l'interruttore acceso in produzione.
