# DECOLLO — il disegno

**Nome in codice scelto da Raffaele.** 13 settembre 2026.

> ⚠️ **Seconda stesura.** La prima è stata smontata da un audit avversariale che ha trovato
> **dieci rilievi**, fra cui due che invalidavano le premesse. Le correzioni sono dentro, e
> dove il documento prima mentiva ora c'è scritto cosa mentiva. L'audit integrale è in
> `.superpowers/sdd/2026-09-12-guardia-dati-societari/` e ha meritato la riscrittura.

**Spec precedenti:** `2026-09-11-strada-c-differimento-tool-design.md` (il differimento dei
tool), `2026-09-12-guardia-dati-societari-design.md` (la guardia).

---

## 0. Il precedente: 48 ore fa questa cosa è stata cancellata

**Va letto per primo, perché la prima stesura non lo citava — ed era il difetto più grave.**

L'11 settembre 2026, commit `8d20acc`: **«955 righe di sotto-agenti mai collegati:
cancellate, non riparate»**. Sette file in `src/v19/agent/` — orchestratore, loop, registro
dei sotto-agenti, persistenza, client — buttati dopo un audit, per **tre** motivi:

| # | Il motivo della cancellazione | Questo disegno lo risolve? |
|---|---|---|
| 1 | **tagliati per capacità tecnica invece che per dominio di lavoro** | ✅ sì — la metafora di Raffaele li taglia per **ruolo**: la contabile, il geometra, la segretaria |
| 2 | **le liste di strumenti erano marcite** (uno aveva 4 nomi su 5 di tool che non esistono più) | ⚠️ **la prima stesura NO** — vedi §4.1 |
| 3 | **mancavano quasi tutte le protezioni** che il motore di produzione ha accumulato in mesi di incidenti | ⚠️ **la prima stesura NO** — vedi §5 |

La prima stesura scriveva «il guard rail esiste già nel motore e va ereditato, non riscritto»
— **una frase, al posto di una specifica**. Ed è esattamente la specifica mancante che la
prima volta ha prodotto un sotto-sistema senza protezioni.

**Ripropone la forma di una cosa già costruita, trovata inaffidabile e cancellata due giorni
prima.** Può essere la cosa giusta lo stesso — ma solo se i motivi 2 e 3 sono chiusi **per
costruzione**, e non con una promessa.

---

## 1. La metafora, che è il requisito

> *«In un'officina organizzatissima le cassette sono riposte negli scaffali, catalogate e
> organizzate per nome e per settore. Il meccatronico non le cerca: sa che la cassetta per la
> turbina sta nello scaffale etichettato turbine. (…) Io mi rivolgo al mio coordinatore che
> sta al centro della stanza; lui va allo scaffale e riferisce alla segretaria, che parte e
> prende la cassettina. (…) Dentro ci sarà la segretaria, la contabile, l'ingegnere, il
> geometra, la signora che fa le pulizie delle case.»*
>
> *«Ma ha comunque una conoscenza di chi è, di chi è al servizio, quali riparazioni possono
> fare, quali non possono fare, quali ancora non le possono fare ma le potranno. (…) Se non
> ha un tool deve poter lavorare come un'IA normale.»*

«La contabile», «il geometra» non sono scaffali: sono **persone**. La metafora descrive i
subagenti senza nominarli, e li taglia per **dominio** — che è la correzione al motivo 1.

---

## 2. I numeri — e quale è misurato, quale no

⚠️ **Nella prima stesura questa tabella diceva «chiamate vere, non stime» e conteneva una
riga che era una SOMMA A MANO.** L'audit l'ha trovata. È la classe di difetto che questo
progetto caccia da due giorni — un valore calcolato presentato come misurato — commessa nel
documento che la nomina. Corretta:

| Configurazione | token di input per turno | come lo so |
|---|---|---|
| oggi, `TOOL_DEFER` spento | **49.874** | **misurato** (`usage.input_tokens`, prompt vero) |
| acceso, cieco | **22.136** | **misurato** (idem) |
| il solo prompt, senza tool | **17.371** | **misurato** (idem) |
| acceso + mappa piccola | ~22.450 | ⚠️ **PROIEZIONE**: 22.136 + 318 token stimati della mappa. **La mappa non esiste ancora.** Va misurata quando esiste |

**Altre due misure, e i due errori che le hanno precedute** (entrambi portavano alla
decisione opposta a quella giusta):

1. **Contando i byte** dell'array dei tool il risparmio risultava **negativo** (−3%): stavo
   per dichiarare inutile una funzione che taglia il 56%. `defer_loading` **non toglie** i
   tool dalla richiesta — li manda e lascia all'API decidere cosa rendere.
2. **I 115 tool differiti costano ZERO token**: la richiesta pesa 6.999 sia mandandoli sia
   togliendoli. Il modello è **completamente cieco** su di loro.

**Il fatto che comanda il disegno:** dopo l'interruttore il pavimento non sono più i tool —
è il **prompt**, 17.371 token, il **78%** di ciò che resta.

---

## 3. I tre strati

### Strato 1 — Chi è, e cosa sa fare

**Misurato il 13 set sul prompt vivo di entrambi i canali:** ci sono già le due società, la
partita IVA personale, i settori, il personale, i mezzi, i limiti, i tool che può
costruirsi. **Manca una sola cosa, su entrambi i canali:** *«senza tool lavori comunque, al
100%»* — il **principio fondamentale**, che la memoria del progetto dichiarava già essere
**codice morto**, in un file che nessuno importa. Raffaele l'ha richiesto il 13 set. Va nel
prompt vivo, **con un test che prova che ci arriva**.

**E lo strato 1 è troppo grasso**: 17.371 token, in gran parte dettagli.

- **sempre addosso** (~1.000 token): chi è Raffaele, le tre partite IVA, cosa fa ciascuna, i
  quattro confini (sa fare / non sa / non ancora / solo con strumenti esterni), il principio
- **cercabile**: elenco operai, targhe, aliquote, indirizzi

Il motivo non è il costo, è la **verità**: *un dato che invecchia nel prompt mentirà, e
nessuno se ne accorgerà.* Un furgone venduto resta nel prompt per mesi.

### Strato 2 — Gli scaffali, poi gli specialisti

**Task 17 (pianificato, NON ancora costruito):** la mappa piccola, sette domini, ~318 token
stimati. Dice **dove** guardare e **vieta** di concludere «non so farlo» senza aver guardato.
I sette domini **diventeranno** i sette specialisti: la mappa non si butta, si trasforma.

### Strato 3 — Quando l'attrezzo non c'è

1. **Lavora comunque**, con la sua intelligenza piena. Un coordinatore che risponde «non ho
   lo strumento» a una domanda che saprebbe affrontare è un centralino.
2. **Se manca davvero, propone di costruirlo** — con il cancello: una PR che approva
   Raffaele. La versione ingenua (l'agente che rilascia da sé) è quella che si rimpiange.

---

## 4. Gli specialisti

| Specialista | Cosa ha in mano | Irreversibile? |
|---|---|---|
| **La contabile** | Fatture in Cloud (lettura e scrittura, entrambe le società), prima nota, movimenti, riconciliazione, note spese | **sì** |
| **Il geometra** | Prezzari, preventivi, computi, quadri economici, SAL | no |
| **La segretaria** | Posta, calendario, scadenze | **sì** (manda mail) |
| **Il capocantiere** | Foto, commesse, resa, pratiche CIGO e INPS | **sì** (INPS) |
| **La signora delle case** | Check-in Maratea, Portale Alloggiati, imposta di soggiorno | **sì** (Questura) |
| **L'archivista** | Drive: file, cartelle, permessi | no |
| **Il tecnico di sé stesso** | Autodiagnosi, skill, proprio codice, rilasci | **propone** |

### 4.1 La difesa contro il marciume — chiude il motivo 2 della cancellazione

**La tabella qui sopra è testo in un documento. Il testo marcisce.** La prima volta un
sotto-agente aveva **4 nomi di tool su 5 che non esistevano più**, e nessuno se n'era accorto.

Quindi gli specialisti **non** si dichiarano in prosa: vivono in un **registro**
(`src/lib/specialisti.ts`), e due test lo sorvegliano:

```ts
it('ogni tool fuori dal nucleo appartiene a ESATTAMENTE uno specialista', () => {
  // il messaggio NOMINA gli orfani: un test che dice "3 != 0" fa perdere
  // mezz'ora a chi lo legge fra sei mesi
})

it('nessuno specialista elenca un tool che non esiste piu', () => {
  // e' il difetto ESATTO dell'11 set: 4 nomi su 5 marciti.
  // Questo test e' la ragione per cui il Decollo puo' esistere.
})
```

Sono gli stessi due test della mappa (Task 17): **il registro degli specialisti È la mappa**,
con in più chi la tiene in mano.

---

## 5. Come funziona la delega — la specifica che mancava

⚠️ **Chiude il motivo 3 della cancellazione.** La prima stesura diceva «va ereditato, non
riscritto». Non basta: va detto **come**, perché l'audit ha trovato che alla lettera
produrrebbe due difetti veri.

### 5.1 Lo specialista gira con un sink MUTO

**Verificato:** `claude.ts:794` — quando il budget scatta, il motore chiama
`await emit('⚠️ Mi fermo qui: la richiesta ha superato il budget…')` **sul sink del
chiamante**. Oggi l'unico chiamante è il turno vero, quindi va dritto a Raffaele.

Se lo specialista ereditasse il sink del coordinatore, **il suo testo interno arriverebbe a
Raffaele** e poi il coordinatore ci scriverebbe sopra: due messaggi per un evento, cioè
proprio la cosa che §6 vuole evitare.

→ **Lo specialista gira con un sink che non emette nulla verso l'utente.** L'unica voce che
parla è il coordinatore.

### 5.2 `runAgentTurn` deve restituire l'esito, non solo il testo

**Verificato:** `runAgentTurn` (`claude.ts:570`) restituisce `Promise<string>`. Il
`ModelOutcome` — che distingue `success | empty | force_text | hallucination | api_error |
timeout | run_aborted` — viene calcolato a `claude.ts:1040` e **buttato**: serve solo a
`recordOutcome`, telemetria che nessuno legge.

Con il sink muto e l'esito buttato, uno specialista che esaurisce il budget restituirebbe
**una stringa troncata senza nessun segnale di fallimento**: il coordinatore la
riporterebbe a Raffaele come se fosse una risposta. **È il difetto peggiore che questo
progetto conosce**, ricreato dentro la difesa.

→ `runAgentTurn` restituisce anche `outcome: ModelOutcome`. `ok` e `cosa_ho_provato` si
derivano **da quello**, **mai** dal testo libero del modello — un modello che racconta cosa
ha provato è la stessa autoaccusa che il 12 set mi ha fatto contare un difetto inesistente.

### 5.3 Cosa riceve e cosa restituisce

Riceve: **il compito** in una frase, **il contesto minimo** (società attiva, conversazione),
e **gli identificativi** di ciò a cui il compito si riferisce. **Non** la cronologia.

⚠️ **Identificativi, non riassunti in prosa.** Se il coordinatore dice «le 5 fatture Limongi
non pagate trovate prima», lo specialista **rifà la query** e può trovare un insieme diverso
— una fattura registrata nel frattempo, un filtro applicato in modo diverso. Raffaele
riceverebbe due risposte plausibili su due insiemi diversi **senza saperlo**: è la forma
esatta di *«l'insieme presentato non è l'insieme descritto»*, il difetto più grave del 12
set. Un test deve provare che nel payload ci sono **gli id esatti**, non un conteggio.

Restituisce:

```ts
type EsitoSpecialista =
  | { ok: true; risposta: string; azioni_fatte: string[]; conferma_richiesta?: Conferma }
  | { ok: false; motivo: string; cosa_ho_provato: string[] }
```

`cosa_ho_provato` **non è un di più**: uno specialista che dice solo «non ci sono riuscito»
riporta il coordinatore al buio, e il coordinatore riporta al buio Raffaele.

### 5.4 Il confine ha un try/catch, sempre

Uno specialista può **non rispondere affatto**: eccezione, timeout della funzione
serverless, chiamata FIC che non torna. Il tipo `EsitoSpecialista` presuppone un ritorno
normale; un `reject` lo salta.

→ La chiamata è avvolta da un `try/catch` che produce **sempre** un esito:
`{ ok: false, motivo: 'la contabile non ha risposto', cosa_ho_provato: [] }`. **Mai**
un'eccezione che risale al turno del coordinatore, dove diventerebbe «il bot è rotto».

---

## 6. Chi chiede la conferma — deciso: il coordinatore

Scelta di Raffaele, 13 set. Lo specialista **prepara**; il **coordinatore** chiede e gira.

1. **Una sola voce.** Con sette specialisti che scrivono per conto loro, il giorno che uno
   tace **nessuno se ne accorge**: la forma esatta dell'autodiagnosi muta per sei settimane.
2. **Le conferme che toccano i soldi passano per un canale solo**, quello già sorvegliato.

### La regola dichiarata da Raffaele

> *«Né il coordinatore né la segretaria spedisce MAI una fattura. Quello lo faccio solo io.»*

**Verificato il 13 set:** non esiste alcuna via verso il Sistema di Interscambio. Nessun
`e_invoice/send`. Il bot **crea** su FIC e **segna pagate** le ricevute; la trasmissione è di
Raffaele.

⚠️ **Rispettata per omissione, non per disegno** → invariante con un test che **fallisce** se
qualcuno aggiunge la capacità.

### ⚠️ Il caso che rompe la delega: la conferma che arriva dopo

Raffaele tappa il codice **mezz'ora dopo**, quando il contesto dello specialista non esiste
più. **Chi esegue la scrittura?**

→ **Non lo specialista.** La conferma sblocca una riga in `cervellone_fic_pending`, che
contiene **già il payload completo** dell'operazione — è così che funziona oggi e continua a
funzionare. Lo specialista **prepara e persiste**; l'esecuzione alla conferma è del percorso
che esiste già, nella route del canale. **Nessuno specialista viene risvegliato.**

---

## 7. Il costo vero — e il criterio che poteva dare un falso verde

⚠️ **L'audit ha trovato che la delega può costare DI PIÙ, non di meno.**

Oggi «quali fatture Limongi non pagate, e quali hanno contanti» è **una** `runAgentTurn`:
3-5 iterazioni sullo stesso lineage di cache.

Con gli specialisti: 1 chiamata del coordinatore per delegare + 2-3 dello specialista (con
il **suo** prompt, un lineage di cache **diverso**, quindi una scrittura di cache non
ammortizzata) + 1 del coordinatore per sintetizzare. **5-8 chiamate contro 3-5**, ognuna che
ripaga il pavimento del prompt.

**Il guadagno vero della delega non è il costo: è la qualità** — contesti piccoli e focalizzati,
e il coordinatore che non si porta addosso ventisette passaggi. Il costo va **misurato**, non
assunto.

→ **Il criterio 1 del pilota misura il TOTALE dei token fatturati per l'intera richiesta**
(tutte le chiamate, `usage.input_tokens` sommati), non la sola chiamata dello specialista.
Scritto come nella prima stesura, un pilota poteva passare mentre costava il doppio.

---

## 8. L'insieme delle prove — **PRIMA** del pilota, non dopo

⚠️ **Nella prima stesura era in §9 fra le cose rimandate. Era l'esclusione sbagliata**, e il
documento si contraddiceva da solo: tre paragrafi prima diceva *«è la cosa che manca di più»*
e *«le prove sono gratis»*.

Costruire il pilota prima della rete che lo sorveglia significa verificarlo **a occhio** —
come si è sempre fatto, ed è così che dodici difetti sono sopravvissuti a sei audit e 2.255
test verdi.

**I dieci casi del 12 settembre, già in archivio** nella tabella dei messaggi, con la
risposta giusta **ormai nota**:

- *«su questa fattura l'esercente ha scritto MP01 contanti»* — il bot diceva «non c'è nulla»
- *«questo preventivo deve portare La Real Estate»* — usciva con Restruktura
- *«questo codice deve essere toccabile»* — arrivava con quattro trattini

Si estraggono, si annota la risposta attesa, si rieseguono a ogni modifica. **Costa un
pomeriggio; il pilota costa settimane.**

---

## 9. Il pilota: la contabile

Uno, non sette. È quella che Raffaele usa di più, ha il perimetro più chiaro, ed è quella
che **scrive** — quindi mette subito alla prova la parte difficile.

**I criteri di riuscita, decisi PRIMA di costruirla:**

1. *«quali fatture Limongi 2026 non sono pagate»* → risposta giusta, e **il totale dei token
   fatturati dell'intera richiesta** non superiore a oggi
2. *«di queste, quali hanno contanti sulla fattura»* → usa la scrematura e distingue i **tre
   esiti** (dichiarata / non dichiarata / non leggibile)
3. *«segnale pagate alla data della fattura»* → prepara, **il coordinatore** chiede, Raffaele
   tappa, la scrittura avviene — **e funziona anche se tappa mezz'ora dopo** (§6)
4. su **entrambi** i canali, provato per canale
5. ⭐ **il cammino del fallimento**: una domanda a cui la contabile **non sa** rispondere (dato
   assente, o azione FIC che fallisce a metà) → l'esito arriva al coordinatore come
   `ok: false` con `cosa_ho_provato` **non vuoto**, e il coordinatore lo riporta a Raffaele
   **senza travestirlo** da successo parziale né da silenzio

⚠️ **Il quinto criterio mancava nella prima stesura.** I primi quattro provano solo cammini
di successo: un pilota poteva passare 4 su 4 **senza aver mai esercitato** il pezzo che
questo documento chiama il più importante. E se il meccanismo di fallimento non esiste
ancora (§5.2), **il pilota non è pronto a partire**.

---

## 10. Cosa questo disegno NON fa, dichiarato

- **Non tocca il prompt da 17.371 token**, che è il pavimento vero dopo l'interruttore.
  Merita un lavoro suo: qui si dichiara, non si risolve.
- **Non costruisce sette specialisti.** Uno, come pilota.
- **Non dà a nessuno il potere di trasmettere una fattura.**
- **Non toglie il coordinatore di mezzo** per le conferme.
- **Non risveglia uno specialista** per eseguire una conferma tardiva.

## 11. L'ordine, dopo l'audit

1. **L'insieme delle prove** (§8) — era rimandato, è stato promosso
2. `runAgentTurn` restituisce l'`outcome` (§5.2) — senza, il pilota non può fallire onestamente
3. Il registro degli specialisti coi due test anti-marciume (§4.1)
4. Il pilota: la contabile, coi **cinque** criteri
5. Solo allora, il secondo specialista
