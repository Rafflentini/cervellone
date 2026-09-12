# DECOLLO — il disegno

**Nome in codice scelto da Raffaele.** 13 settembre 2026.

**Spec di riferimento precedenti:** `2026-09-11-strada-c-differimento-tool-design.md`
(il differimento dei tool), `2026-09-12-guardia-dati-societari-design.md` (la guardia).

---

## 1. La metafora, che è il requisito

Parole di Raffaele, 12-13 set 2026:

> *«In un'officina organizzatissima le cassette sono riposte negli scaffali, attaccate,
> catalogate e organizzate per nome e per settore. Il meccatronico non le cerca: sa che la
> cassetta per smontare la turbina sta nello scaffale etichettato turbine. Non deve perdere
> minuti a cercare il tool, deve sapere subito dove mettere le mani.»*
>
> *«Io mi rivolgo al mio coordinatore che sta al centro della stanza; lui va vicino allo
> scaffale e riferisce alla segretaria, che parte e prende la cassettina che le serve per
> fare le cose che deve fare. (…) Dentro questa cassettina ci sarà la segretaria, la
> contabile, l'ingegnere, il geometra, la signora che fa le pulizie delle case.»*
>
> *«Ma ha comunque una conoscenza di chi è, di chi è al servizio, di che cosa si occupano in
> quell'officina, quali riparazioni possono fare, quali non possono fare, quali ancora non
> le possono fare ma le potranno fare, quali le possono fare ma hanno bisogno di strumenti
> esterni — e qui deve potersi implementare da solo. Se non ha un tool deve poter lavorare
> come un'IA normale su un task che non rientra nei suoi tool.»*

**La metafora descrive i subagenti senza nominarli.** «La contabile», «il geometra» non sono
scaffali: sono **persone**. Il passo da «mappa degli scaffali» a «specialisti» è il Decollo.

---

## 2. I fatti misurati, che il disegno deve rispettare

Chiamate vere all'API il 12-13 set 2026, leggendo `usage.input_tokens` — **non** stime.

| Configurazione | token di input per turno |
|---|---|
| oggi, `TOOL_DEFER` spento | **49.874** |
| acceso, cieco | **22.136** (−56%) |
| acceso + mappa piccola (7 domini) | ~22.450 (−55%) |
| **di cui il solo prompt** | **17.371** — il **78%** di ciò che resta |

**Due misure mie sbagliate, entrambe corrette misurando meglio.** Vanno ricordate perché
ognuna portava a una decisione opposta a quella giusta:

1. **Contando i byte** dell'array dei tool il risparmio risultava **negativo** (−3%): stavo
   per dichiarare inutile una funzione che taglia il 56%. `defer_loading` **non toglie** i
   tool dalla richiesta — li manda e lascia all'API decidere cosa rendere. Il risparmio
   avviene dall'altra parte del filo.
2. **I 115 tool differiti costano ZERO token**: la richiesta pesa 6.999 sia mandandoli sia
   togliendoli del tutto. Il modello è **completamente cieco** su di loro.

**La conseguenza che comanda tutto il disegno:** dopo l'interruttore, **il pavimento non
sono più i tool — è il prompt**, con 17.371 token. Qualunque cosa faremo agli strumenti, se
non tocchiamo il prompt restiamo sopra i 17.000 token per turno.

---

## 3. I tre strati

### Strato 1 — Chi è, e cosa sa fare (sempre addosso)

**Misurato il 13 set 2026** sul prompt vivo di **entrambi** i canali:

| | presente? |
|---|---|
| le due società nominate | ✅ |
| la partita IVA personale (studio individuale) | ✅ |
| i settori di Restruktura | ✅ |
| i settori de La Real Estate | ✅ |
| il personale | ✅ |
| i mezzi | ✅ |
| i suoi limiti | ✅ |
| i tool che può costruirsi | ✅ |
| **«senza tool lavori comunque, al 100%»** | ❌ **assente su entrambi** |

L'ultima riga è il **principio fondamentale**, e la memoria del progetto dichiarava già che è
**codice morto**: vive in un file che nessuno importa
(`cervellone-principio-fondamentale-e-codice-morto`). Raffaele l'ha chiesto di nuovo il
13 set: *«se non ha un tool deve poter lavorare come un'IA normale»*. **Va nel prompt vivo,
con un test che prova che ci arriva.**

**Ma lo strato 1 è troppo grasso.** 17.371 token di cui gran parte sono dettagli:

- **sempre addosso** (il biglietto da visita, obiettivo ~1.000 token): chi è Raffaele, le
  tre partite IVA, cosa fa ciascuna, i quattro confini (sa fare / non sa / non ancora / solo
  con strumenti esterni), e il principio fondamentale
- **cercabile** (l'archivio): elenco degli operai, targhe dei mezzi, aliquote, indirizzi,
  scadenze

Il motivo non è il costo, è la **verità**: i dettagli invecchiano. Un furgone venduto resta
nel prompt per mesi; in un archivio interrogabile no. *Un dato che invecchia nel prompt è un
dato che mentirà, e nessuno se ne accorgerà.*

### Strato 2 — Gli scaffali, e poi gli specialisti

**Oggi (Task 17): la mappa piccola.** Sette domini, 318 token, l'1,1% del risparmio. Dice
**dove** guardare e vieta di concludere «non so farlo» senza aver guardato.

**Domani: quei sette domini diventano sette specialisti.** La mappa non si butta: si
trasforma nell'elenco di chi chiamare.

### Strato 3 — Quando l'attrezzo non c'è

Due comportamenti, in quest'ordine:

1. **Lavora comunque.** Ragiona, scrive, calcola, propone — con la sua intelligenza piena.
   Un coordinatore che risponde «non ho lo strumento» a una domanda che saprebbe affrontare
   è un centralino, non un collaboratore.
2. **Se manca davvero, si costruisce l'attrezzo** — con il cancello: propone una PR
   (`github_propose_fix`), la approva Raffaele. La versione ingenua (l'agente che scrive e
   rilascia da sé) è quella che si rimpiange in produzione.

---

## 4. Gli specialisti

Derivati dai 131 tool raggruppati per **ruolo** — come li pensa Raffaele, non coi nomi dei
moduli.

| Specialista | Cosa ha in mano | Tocca cose irreversibili? |
|---|---|---|
| **La contabile** | Fatture in Cloud (lettura e scrittura, entrambe le società), prima nota, movimenti di banca e carte, riconciliazione, note spese | **sì** — scrive su un gestionale fiscale |
| **Il geometra** | Prezzari, preventivi, computi metrici, quadri economici, SAL | no, produce documenti |
| **La segretaria** | Posta, calendario, scadenze di mezzi e documenti | **sì** — manda mail |
| **Il capocantiere** | Foto di cantiere, commesse, resa, pratiche CIGO e INPS | **sì** — manda pratiche all'INPS |
| **La signora delle case** | Check-in Maratea, Portale Alloggiati, imposta di soggiorno | **sì** — comunica alla Questura |
| **L'archivista** | Google Drive: file, cartelle, permessi, condivisioni | no |
| **Il tecnico di sé stesso** | Autodiagnosi, skill, proprio codice, rilasci | **propone**, non rilascia |

### La regola che Raffaele ha dichiarato, e che vale su tutto

> *«Né il coordinatore né la segretaria spedisce MAI una fattura. Quello lo faccio solo io.»*

**Stato misurato il 13 set:** oggi **non esiste alcuna via** nel codice verso il Sistema di
Interscambio. Nessun `e_invoice/send`: quell'endpoint FIC esiste solo per i documenti
**emessi** e non è mai chiamato. Il bot sa **creare** una fattura su Fatture in Cloud e
**segnare pagate** quelle ricevute. La trasmissione la fa Raffaele, a mano.

⚠️ **Ma la regola è rispettata per omissione, non per disegno.** Va resa un'invariante
dichiarata, con un test che **fallisce** se un giorno qualcuno aggiunge la capacità. «Nessuno
ci ha ancora pensato» non è una garanzia.

### Chi chiede la conferma — **deciso: passa dal coordinatore**

Scelta di Raffaele, 13 set 2026, con la mia raccomandazione concorde.

Lo specialista **prepara** e restituisce *«pronte 5 fatture, serve la conferma»*; il
**coordinatore** la chiede a Raffaele e gira la risposta.

**Due ragioni, e la seconda è più forte della prima:**

1. **Una sola voce.** Con sette specialisti che scrivono ognuno per conto suo, il giorno che
   uno resta in silenzio **nessuno se ne accorge**. È la forma esatta dell'autodiagnosi che
   per sei settimane non consegnava niente e nessuno lo sapeva.
2. **Le conferme che toccano i soldi passano per un canale solo**, quello già sorvegliato —
   la coda dei codici tappabili, con la doppia conferma e la scadenza.

---

## 5. Come funziona la delega

### Cosa riceve lo specialista

- **il compito**, in una frase, scritto dal coordinatore
- **il contesto minimo**: la società attiva, l'identificativo della conversazione, e i fatti
  che lui non può ricavare da solo
- **i suoi attrezzi**, caricati — non differiti: sono pochi per costruzione

**Non riceve** la cronologia della conversazione. È il punto di tutto: se gli passiamo il
contesto del coordinatore, abbiamo due contesti grandi invece di uno.

### Cosa restituisce

**La risposta, non i passaggi.** Il coordinatore riceve un esito strutturato:

```ts
type EsitoSpecialista =
  | { ok: true; risposta: string; azioni_fatte: string[]; conferma_richiesta?: Conferma }
  | { ok: false; motivo: string; cosa_ho_provato: string[] }
```

⭐ **`cosa_ho_provato` non è un di più.** Uno specialista che fallisce e dice solo «non ci
sono riuscito» riporta il coordinatore al buio, e il coordinatore lo riporta a Raffaele —
che è il difetto che questo progetto ha pagato più volte: *un errore non deve mai travestirsi
da assenza*. Se la contabile non trova le fatture, deve dire **dove ha guardato**.

### Il tetto

Ogni specialista ha un tetto di iterazioni e di budget. Superato: **si ferma e lo dichiara**,
con quello che ha fatto fino a quel punto. Mai un lavoro a metà spacciato per finito —
il guard rail esiste già nel motore (`isRunOverBudget` in `claude.ts`) e va ereditato, non
riscritto.

---

## 6. Equipollenza

La delega vive **sotto** i due canali, nel motore che già condividono. Ma *un motore
condiviso NON rende equipollenti i canali*: quel che cambia è **come la conferma arriva** a
Raffaele.

⚠️ **E c'è un problema misurato il 12 set che va risolto PRIMA di fidarsi dei test di
canale:** i due test di canale mockano **insiemi di moduli diversi** (23 mock parziali, 79
export mancanti in totale). Sono i test con cui si dovrebbe dimostrare che i canali si
comportano uguale, e **non sono confrontabili fra loro**. Finché non lo sistemiamo (Task 6),
«provato su entrambi i canali» vale meno di quanto suona.

---

## 7. Come sapremo che funziona — l'insieme delle prove

**È la cosa che manca di più, più della mappa e più degli specialisti.**

Il 12 settembre 2026 sono stati trovati **dodici difetti**. **Tutti** li ha trovati Raffaele
usandolo: la partita IVA sbagliata sul preventivo, i codici non toccabili, le tre ore su
Limongi, la marcatura massiva che rifiutava sempre. Nessuno è stato trovato da una misura.

**E le prove sono gratis:** stanno già in archivio, nella tabella `messages`. La sola
giornata del 12 set contiene dieci casi con la risposta giusta **ormai nota**:

- *«su questa fattura l'esercente aveva scritto MP01 contanti»* — e il bot diceva «non c'è nulla»
- *«questo preventivo deve portare La Real Estate»* — e usciva con Restruktura
- *«questo codice deve essere toccabile»* — e arrivava con quattro trattini

Si estraggono, si annota la risposta giusta, e si rieseguono a ogni modifica.
**Non va inventato: va estratto da quello che è già successo.**

---

## 8. Il pilota: la contabile

**Non si costruiscono sette specialisti al buio.** Se ne costruisce **uno**, si guarda come
va, e si decide.

La contabile, perché:
- è quella che Raffaele usa di più, e dove ha perso tre ore ieri
- ha il perimetro più chiaro (Fatture in Cloud, prima nota, movimenti, riconciliazione)
- è quella che **scrive**, quindi mette subito alla prova la parte difficile: chi chiede la
  conferma, e come torna indietro
- se il modo di lavorare è sbagliato, si vede su di lei e si butta un solo pezzo

**Il criterio per dire che il pilota è riuscito**, deciso prima di costruirlo:

1. *«quali fatture Limongi del 2026 non sono pagate»* → risposta giusta, con **meno** token
   del coordinatore di oggi
2. *«di queste, quali hanno contanti sulla fattura»* → usa la scrematura e distingue i tre
   esiti
3. *«segnale pagate alla data della fattura»* → prepara, **il coordinatore** chiede la
   conferma, Raffaele tappa il codice, la scrittura avviene
4. e su **entrambi** i canali, provato per canale

Se uno di questi quattro non passa, il pilota ha insegnato qualcosa e non si passa al
secondo specialista.

---

## 9. Cosa questo disegno NON fa, dichiarato

- **Non tocca il prompt da 17.371 token** in questa fase. È il pavimento vero dopo
  l'interruttore, e merita un lavoro suo: qui lo si dichiara, non lo si risolve.
- **Non costruisce sette specialisti.** Uno, come pilota.
- **Non dà a nessuno il potere di trasmettere una fattura.** Per costruzione, e con un test
  che lo impedisce.
- **Non toglie il coordinatore di mezzo** per le conferme. Deciso il contrario.
- **Non risolve l'insieme delle prove**: lo dichiara come il pezzo mancante più importante e
  ne descrive la fonte.
