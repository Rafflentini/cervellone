# Controllo di gestione commesse — Fase 1: commesse e ore

**Data:** 9 settembre 2026
**Società:** Restruktura S.r.l.
**Stato:** in revisione — da approvare prima di implementare

---

## 1. Il problema, detto con i numeri

Restruktura lavora su più cantieri con 4 operai e un ingegnere in ufficio. I dati economici dei cantieri esistono ma arrivano tardi: le fatture stanno in Fatture in Cloud e non sanno a quale cantiere appartengono, le ore si ricostruiscono a memoria a fine mese, l'avanzamento fisico non è registrato da nessuna parte.

Conseguenza: **la marginalità di un lavoro si conosce quando il lavoro è chiuso**, cioè quando non si può più intervenire.

### Cosa manca davvero, misurato sul database (9 set 2026)

Non esiste nessuna tabella di commesse, di operai o di ore. Il cantiere compare **come testo libero** in due punti — `project_state.cantiere` (2 righe) e `cervellone_foto_contesto.cantiere`. `cervellone_movimenti` esiste ed è **vuota**.

Le commesse di cui si parla ogni giorno (C2026-006, C2026-008, C2026-017) vivono nelle conversazioni e dentro i documenti generati, **non in un registro**.

**Questo è il vero punto di partenza**: ore, fatture e rapportini non hanno niente a cui attaccarsi. E finché il cantiere resta una stringa scritta a mano, ogni numero che ci si calcola sopra eredita l'ambiguità di quella stringa.

---

## 2. Perimetro

Il modulo completo è composto da cinque pezzi. **Questa specifica copre solo i primi due**, che non dipendono da niente e da cui dipende tutto il resto.

| | Pezzo | Dipende da | In questa specifica |
|---|---|---|---|
| **0** | Anagrafica commesse | — | ✅ |
| **1** | Ore per commessa | 0 | ✅ |
| 2 | Imputazione fatture → commessa | 0 | ❌ specifica sua |
| 3 | Rapportino dettato a voce | 0, 1 | ❌ specifica sua |
| 4 | Cruscotto margini | 0, 1, 2 | ❌ specifica sua |

Motivo della decomposizione: le ore sono il dato oggi **del tutto assente**, e fatture e cruscotto senza ore non hanno niente da mostrare. Consegnare prima un pezzo che raccoglie ore vere permette di decidere il resto guardando dati, non ipotesi.

### Fuori perimetro, per scelta esplicita

Riconciliazione bancaria e PSD2 · accesso a SDI e cassetto fiscale (già coperti da Fatture in Cloud) · gestione sicurezza PSC/POS · contabilità lavori pubblici · funzioni per imprese da decine di cantieri.

---

## 3. Le decisioni prese, e perché

Ogni voce è stata decisa esplicitamente. Il "perché" serve a chi leggerà fra un anno e sarà tentato di cambiarla.

### 3.1 Livello singolo: solo il cantiere, niente sottocommesse

L'operaio sceglie **il cantiere e basta**. Niente WBS, niente lavorazioni.

*Perché:* con 4 operai il fattore critico è l'adozione, non la ricchezza del dato. Ogni livello in più è una scelta da fare col telefono in mano in cantiere. Il confronto ore-preventivo si fa comunque sul totale. Se un giorno servirà più dettaglio, si aggiunge **senza buttare via le timbrature già raccolte** — per questo la tabella nasce con la commessa come chiave e non con una gerarchia.

### 3.2 Il costo orario è datato

`cervellone_operai_costo` porta una **data di inizio validità**. Il costo di un turno si calcola col costo in vigore **il giorno del turno**, non con quello di oggi.

*Perché:* con un solo numero per operaio, al primo rinnovo del CCNL o al primo passaggio di livello **tutta la storia dei margini si riscriverebbe da sola, in silenzio**. Un cantiere chiuso a giugno cambierebbe marginalità a novembre senza che nessuno abbia toccato niente.

⭐ Principio generale, che ritorna anche al punto 3.5: **il metro con cui hai misurato va conservato insieme alla misura.**

### 3.3 Tutte le commesse attive, a tutti gli operai

Nessun filtro per operaio, nessuna assegnazione preventiva. L'app mostra tutte le commesse `attiva` di Restruktura, con **l'ultima usata in cima**.

*Perché:* la squadra si sposta. Un'assegnazione da mantenere è lavoro d'ufficio che si disallinea dalla realtà entro una settimana, e produce l'operaio che non trova il proprio cantiere nella lista — cioè la timbratura saltata.

### 3.4 La geolocalizzazione esiste, ma nasce spenta

Vedi la sezione 7 per intero. In sintesi: il campo esiste nello schema e nel codice; finché l'interruttore è spento **l'app non chiede nemmeno il permesso di posizione al telefono**.

### 3.5 Tre esiti di posizione, non due

`dentro_area` · `fuori_area` · **`non_attendibile`**.

*Perché:* il GPS di un telefono, in una valle o fra le case, sbaglia di 50-100 metri e a volte molto di più. Se il telefono dichiara una precisione peggiore del raggio del cantiere, «dentro» e «fuori» sono **entrambi indistinguibili dal caso**: una misura il cui errore è più grande della cosa che misura non è una misura. Stampare comunque «fuori area» produrrebbe accuse false, e con quattro persone la fiducia si perde una volta sola.

`non_attendibile` **non è un sospetto**: è la risposta onesta, e la timbratura è valida.

### 3.6 Il raggio minimo è di sistema; per cantiere si può solo allargare

Il raggio di tolleranza minimo è un parametro **di sistema**, quello dichiarato nell'eventuale istanza all'Ispettorato. Sul singolo cantiere si può **solo allargarlo**, mai stringerlo.

*Perché:* se il raggio fosse libero per cantiere, prima o poi qualcuno ne stringerebbe uno a 50 metri — cioè adotterebbe senza accorgersene una modalità **più invasiva** di quella autorizzata. Con questo vincolo, qualunque cantiere si apra resta **per costruzione meno invasivo** del perimetro autorizzato, e aprire un cantiere nuovo non è mai un atto che cambia le modalità.

Stessa logica per la **ritenzione**: è di sistema, non per cantiere.

### 3.7 Il raggio applicato si salva con la timbratura

Insieme all'esito si salva **il raggio in vigore in quel momento**.

*Perché:* avendo scelto di non conservare la distanza, se il raggio di un cantiere viene allargato in seguito le timbrature vecchie **non si possono ricalcolare**. `fuori area, tolleranza 500 m` si capisce fra due anni; `fuori area` e basta, no. Il raggio non è un dato personale: è una proprietà del cantiere, quindi non aggiunge nulla da autorizzare.

### 3.8 Un turno dimenticato viene chiuso, ma non finge di essere timbrato

A fine giornata un turno ancora aperto viene chiuso all'orario di fine lavoro e marcato `chiuso_dal_sistema`. La mattina dopo l'operaio la trova in cima con **giusto / correggi**.

*Perché:* le due alternative sono entrambe peggiori. Lasciarlo aperto significa una giornata di lavoro che non esiste nel cruscotto, e un margine sbagliato per difetto. Chiuderlo in silenzio produce ore **indistinguibili da quelle vere**: fra sei mesi si guarda un margine senza poter sapere quali ore sono state timbrate e quali stimate.

⭐ È la regola che governa tutta questa specifica: **una stima non si traveste mai da misura.**

### 3.9 La pausa è il buco fra due turni

`INIZIO PAUSA` chiude il turno, `RIENTRO` ne apre un altro sullo stesso cantiere. Il sistema **non calcola e non sottrae niente**: somma quello che è stato timbrato.

*Perché:* dedurre un'ora fissa in automatico toglierebbe ore vere a chi lavora durante la pausa, ogni giorno, in silenzio. È la stessa forma del difetto CIGO chiuso il 9 set 2026 — un segnaposto plausibile che nessuno nota. La pausa è l'unico punto del sistema che può **togliere** ore, ed è per questo che deve essere una dichiarazione dell'operaio e non un calcolo nostro.

Se si dimentica `RIENTRO`, vale il 3.8.

### 3.10 Il cambio cantiere apre un **transito**, non il turno successivo

`CAMBIO CANTIERE` chiude il turno in corso e apre uno stato **`in_transito`** verso la commessa scelta. Il turno nuovo si apre solo quando l'operaio **conferma di essere arrivato**.

Se dopo **30 minuti** non ha confermato:
1. parte una notifica sul telefono;
2. **e in più**, al riaprire l'app compare in cima una fascia impossibile da ignorare — *«sei in transito verso La Colla da 47 minuti, sei arrivato?»*.

*Perché due livelli:* la notifica push su iPhone è fragile — richiede iOS recente, che la PWA sia stata installata **da Safari** (non dal browser interno di WhatsApp — errore già capitato consegnando il gestionale a Luciana) e un permesso che l'operaio può negare. **Un avviso che dipende da un permesso non è un avviso**: la fascia dentro l'app non dipende da niente.

*Perché non riaprire subito il turno:* se il cambio cantiere aprisse immediatamente il turno nuovo, un operaio che parte alle 12:30 e si ferma a pranzo per strada risulterebbe al lavoro sul cantiere nuovo dalle 12:30. Il transito è uno stato vero, e va misurato.

**Il tempo di transito è attribuito al cantiere di destinazione**, perché è tempo speso per andare a lavorare lì — e perché un cantiere lontano costa davvero di più, e quella differenza deve restare visibile nel numero su cui si decide se accettare lavori a Maratea. Nel prospetto il transito resta **marcato come tale**: si vede sempre quanto è stato viaggio e quanto lavoro.

```
GIORNATA — Mario Rossi
  C2026-008  07:12 → 12:30   5h 18m
  ↳ tragitto   12:30 → 13:10    40m
  C2026-017  13:10 → 17:00   3h 50m

COSTO C2026-017 = 4h 30m  (di cui 40m di tragitto)
```

Un transito mai confermato ricade nella regola 3.8: viene chiuso, marcato, e la mattina dopo si conferma o si corregge. **Non viene mai convertito in ore di lavoro in silenzio.**

### 3.11 Credenziali personali per ogni operaio

Ogni operaio ha le proprie credenziali, resta connesso, e vede **solo la propria timbratura** — non fatture, non margini, non le ore degli altri.

*Perché:* oggi la web app sta dietro **una sola password condivisa** (`APP_PASSWORD`, peraltro ancora da ruotare perché rimasta in chiaro in un repository pubblico). Dietro quella porta c'era solo Raffaele. Le presenze di quattro dipendenti sono dati personali di lavoratori: non possono stare dietro la stessa chiave che apre contabilità e fatture.

### 3.12 Correggere non sovrascrive

Una correzione conserva il valore originale, il nuovo, **chi** l'ha fatta e **quando**. Validano sia Raffaele sia l'ingegnere, senza livelli di permesso diversi: con cinque persone un doppio livello è peso morto, sapere di chi è la mano no.

*Perché:* un'ora finisce in una busta paga e in un margine. Si deve poter risalire a chi l'ha decisa.

---

## 4. Modello dei dati

### 4.1 `cervellone_commesse`

| colonna | tipo | note |
|---|---|---|
| `id` | uuid PK | |
| `codice` | text **unique** | `C2026-008` |
| `cliente` | text | |
| `descrizione` | text | |
| `societa` | text | oggi sempre `restruktura`; il campo c'è per non doverlo aggiungere dopo |
| `stato` | text | `attiva` \| `chiusa` — CHECK |
| `preventivo_documento_id` | uuid FK → `documents` | base per lo scostamento; nullable |
| `lat`, `lon` | double precision | posizione del cantiere; **non è un dato personale** |
| `raggio_m` | integer | ≥ raggio minimo di sistema (vincolo applicato in scrittura) |
| `created_at`, `updated_at` | timestamptz | |

Le colonne `cantiere` testuali già esistenti (`project_state`, `cervellone_foto_contesto`) **restano dove sono**: non le tocchiamo in questa fase. La migrazione di quei riferimenti è lavoro del pezzo 2.

### 4.2 `cervellone_operai` e `cervellone_operai_costo`

`cervellone_operai`: `id`, `nome`, `cognome`, `livello` (CCNL Edilizia Industria), `attivo`, `utente_id` (per le credenziali).

`cervellone_operai_costo`: `operaio_id`, `costo_orario_eur`, `valido_dal` (date), `note`.
Il costo di un turno = il record con `valido_dal` massimo **minore o uguale** alla data del turno. Se per quella data non esiste nessun costo valido, il turno **non viene valorizzato con una stima**: resta senza costo e finisce elencato nella quadratura mensile (6.3). Un margine calcolato su un costo inventato è peggio di un margine che dichiara di essere incompleto.

### 4.3 `cervellone_timbrature`

| colonna | tipo | note |
|---|---|---|
| `id` | uuid PK | |
| `operaio_id` | uuid FK | |
| `commessa_id` | uuid FK | per un transito è **la destinazione** (vedi 3.10) |
| `tipo` | text | `lavoro` \| `transito` — CHECK |
| `inizio`, `fine` | timestamptz | `fine` NULL = in corso |
| `origine_fine` | text | `operaio` \| `sistema` \| `ufficio` — **da dove viene quel numero** |
| `stato` | text | `aperto` \| `chiuso` \| `da_confermare` \| `confermato` |
| `client_msg_id` | text | **chiave d'invio** per l'offline |
| `posizione_esito` | text | `dentro_area` \| `fuori_area` \| `non_attendibile` \| NULL (non richiesta) |
| `raggio_applicato_m` | integer | il metro, conservato con la misura |
| `created_at` | timestamptz | |

**Indice unico parziale** `uniq_timbrature_client_msg_id` su `(operaio_id, client_msg_id) WHERE client_msg_id IS NOT NULL`.

`cervellone_timbrature_correzioni`: `timbratura_id`, `campo`, `valore_prima`, `valore_dopo`, `chi`, `quando`, `motivo`.

**Un transito è una riga come le altre**, con `tipo = 'transito'` e la commessa di destinazione. Le ore di una commessa sono la somma di `lavoro` + `transito`; il prospetto le mostra distinte. Non serve una tabella a parte, e soprattutto **non serve una regola di calcolo**: il costo del viaggio è già dove deve stare.

Vincolo: un operaio non può avere **due righe aperte** contemporaneamente (`fine IS NULL`). Indice unico parziale su `(operaio_id) WHERE fine IS NULL`. Il database lo impedisce, non solo l'app — perché l'app gira su un telefono che può essere offline e ritentare.

---

## 5. La PWA dell'operaio

Una schermata sola che cambia stato. Nessun menù, nessuna notifica, nessuna conferma superflua.

```
TURNO CHIUSO                      TURNO APERTO                     IN PAUSA
┌────────────────────────┐        ┌────────────────────────┐       ┌────────────────────────┐
│ Mario Rossi            │        │ Mario Rossi            │       │ Mario Rossi            │
│                        │        │                        │       │                        │
│ Dove stai lavorando?   │        │ ● C2026-008  Blasi     │       │ ○ C2026-008  Blasi     │
│ ┌────────────────────┐ │        │   dalle 07:12 — 5h 18m │       │   in pausa dalle 12:30 │
│ │ C2026-008  Blasi   │ │   →    │                        │  →    │                        │
│ │ C2026-017 La Colla │ │        │ [      E S C I       ] │       │ [   R I E N T R O    ] │
│ │ C2026-006  Cesareo │ │        │ [  INIZIO PAUSA      ] │       │ [      E S C I       ] │
│ └────────────────────┘ │        │ [ Cambio cantiere →  ] │       │                        │
│ [     E N T R A      ] │        │                        │       │                        │
└────────────────────────┘        └────────────────────────┘       └────────────────────────┘
```

**Due tocchi per entrare, uno per uscire.** L'ultima commessa usata in cima.

Il **cambio cantiere** ha una schermata sua, perché è uno stato vero (3.10):

```
IN TRANSITO                       IN TRANSITO — oltre 30 min
┌────────────────────────┐        ┌────────────────────────┐
│ Mario Rossi            │        │ ⚠ Sei in transito      │
│                        │        │   verso La Colla       │
│ → verso C2026-017      │        │   da 47 minuti.        │
│   La Colla             │        │   Sei arrivato?        │
│   partito alle 12:30   │   →    │ ──────────────────────  │
│                        │        │ → verso C2026-017      │
│ [ S O N O  A R R I -   │        │                        │
│   V A T O            ] │        │ [ SONO ARRIVATO      ] │
│ [ Ho cambiato idea → ] │        │ [ Ho cambiato idea → ] │
└────────────────────────┘        └────────────────────────┘
```

La fascia d'avviso è **dentro l'app** e non dipende da nessun permesso; la notifica push è un di più. *«Ho cambiato idea»* riporta alla lista: capita di partire per un cantiere e finire su un altro.

### Offline

Le timbrature si scrivono in locale (IndexedDB) e si sincronizzano quando torna la rete. L'unico segnale è una riga discreta — *«2 timbrature da inviare»* — che sparisce da sola.

La deduplica è la **chiave d'invio** già in produzione dal 9 set 2026 (`uniq_messages_client_msg_id` sulla chat web, stesso schema): il telefono conia una chiave per timbratura, ritenta quanto vuole, il database ne accetta una sola. Un `23505` **non è un errore**: è la conferma che la timbratura c'era già, e il telefono la marca come sincronizzata.

### Cosa NON c'è, di proposito

Nessuna nota da scrivere, nessun «sei sicuro?», nessuna notifica push, nessuna schermata di riepilogo. Ogni cosa in più è un motivo per non usarla.

---

## 6. Il lato ufficio

### 6.1 La giornata di tutti
Turni per operaio e per commessa, **marcati per provenienza**: timbrato / chiuso dal sistema / corretto dall'ufficio. Un turno `da_confermare` è visibile a colpo d'occhio.

### 6.2 Correzione tracciata
Modifica di inizio, fine o commessa. Scrive in `cervellone_timbrature_correzioni`; il valore originale non si perde mai.

### 6.3 Quadratura mensile
Ore timbrate per operaio nel mese, da confrontare col libro unico. È il controllo che dice **se il dato di commessa è affidabile**: senza, il cruscotto è una schermata di cui non si sa se fidarsi.

Il prospetto segnala esplicitamente: turni `da_confermare` non ancora confermati · turni senza costo orario valido per quella data (**non stimati: elencati**) · turni con `posizione_esito` = `fuori_area`.

---

## 7. Geolocalizzazione: presente, e spenta

La badgiatura geolocalizzata non si può attivare con la sola informativa privacy: l'art. 4 dello Statuto dei Lavoratori esenta la rilevazione presenze, ma la geolocalizzazione fa decadere l'esenzione. Serve accordo sindacale o autorizzazione dell'Ispettorato Territoriale del Lavoro di Potenza. Il consenso individuale del lavoratore **non è sufficiente**.

Dati raccolti senza autorizzazione sono inutilizzabili e la sanzione ricade sul legale rappresentante. Quindi il sistema è costruito così:

1. **Nasce spento, e spento significa che l'app non chiede nemmeno il permesso di posizione.** Non «legge e non salva»: proprio non chiede.
2. **Il modello non può accenderlo.** L'interruttore sta **fuori dalla portata di `cervellone_modifica`**, il tool con cui il modello cambia valori di configurazione. Non è una preferenza, è un atto.
3. **Si accende con un atto tracciato**: chi, quando, e il riferimento del provvedimento che autorizza.
4. **Nessun effetto retroattivo.** I turni timbrati prima restano senza posizione: quel dato nessuno l'ha mai raccolto.

**Le coordinate del cantiere sono un'altra cosa** e non aspettano niente: sono la posizione di un luogo di lavoro, come l'indirizzo su una fattura. Si compilano da subito.

Il documento tecnico per il consulente del lavoro (cosa si raccoglie, quando, come si calcola, cosa **non** si salva, per quanto) è un deliverable a parte, da produrre quando serve al tavolo.

---

## 8. Costi di esercizio

Misurato su `api_usage` il 9 set 2026: il bot costa **~200 $/mese** (agosto 260 $), dominati da Telegram a **1,08 $ per turno**, con 24.306 token in ingresso per turno. Il documento di partenza stimava «sotto i 20 $»: la realtà è **dieci volte tanto**.

**Questo modulo non peggiora quel numero**, per una scelta di progetto precisa:

> **La raccolta dei dati non passa dal modello.**

Un operaio che tocca `ENTRA` compila un modulo: la PWA scrive dritta sulla tabella. **Zero token, zero costo, zero tool nuovi** in un elenco che ne conta già 43 — e ogni tool in più peggiora la scelta del modello.

Il modello entra in scena **solo in lettura**, quando qualcuno chiede *«quanto mi è costato Blasi finora»*: tre o quattro tool, che consumano solo quando si usano. Quelli arriveranno col pezzo 4.

Il modo sbagliato — fare della timbratura un tool che il modello decide di chiamare — costerebbe circa un euro a timbratura, sarebbe più lento, e ogni tanto sbaglierebbe cantiere.

---

## 9. Come si verifica

TDD su tutto, secondo le regole del progetto. In particolare i test che devono esistere **prima** del codice:

- **Costo orario datato:** un turno di marzo valorizzato con un costo entrato in vigore a giugno deve fallire il test. Controllo positivo: con due costi in tabella, si sceglie quello giusto.
- **Chiave d'invio:** la stessa timbratura inviata due volte scrive una riga sola; **due timbrature diverse con lo stesso orario restano due**. Il mock deve far rispettare il vincolo vero (`23505`), non accettare tutto.
- **Turno dimenticato:** la chiusura automatica marca `origine_fine = 'sistema'` e `stato = 'da_confermare'`. Mutazione da uccidere: la marcatura tolta.
- **Transito:** il tempo di viaggio finisce nelle ore della commessa di **destinazione**, e resta distinguibile dal lavoro. Controllo positivo: senza transito, le ore della destinazione sono quelle del solo lavoro. Un transito mai confermato **non diventa mai ore di lavoro**: resta `transito` e `da_confermare`.
- **Un operaio non può avere due righe aperte insieme.** Il test va contro il vincolo del database (`23505`), non contro un controllo dell'app: l'app gira su un telefono che può essere offline e ritentare.
- **Raggio:** un cantiere non può essere salvato con un raggio **inferiore** al minimo di sistema.
- **Posizione:** con precisione dichiarata peggiore del raggio l'esito è `non_attendibile`, **mai** `fuori_area`.
- **Interruttore geolocalizzazione:** con l'interruttore spento nessuna richiesta di posizione parte e `posizione_esito` resta NULL. **Il predefinito ha il suo test**: un chiamante che non passa niente non deve attivare niente.
- **`cervellone_modifica` non può accendere l'interruttore.** Test esplicito.

**Mutation testing** su ogni guardia, con la regola imparata il 9 set: i sorgenti sono CRLF, quindi `perl -0pi` multiriga **non morde** e dà un falso verde — usare `sed -i '<riga>s/.*/…/'` e **contare le occorrenze prima di leggere l'esito**.

**Verifica in produzione** prima di dichiarare fatto: una timbratura vera da un telefono vero, offline e poi online, e il controllo che in tabella ci sia **una riga sola**.

---

## 10. Punti aperti

- **Ritenzione delle timbrature.** Da chiudere col consulente del lavoro; orientamento 24 mesi (quadratura col libro unico + eventuali contestazioni). Parametro **di sistema**.
- **Orario di fine lavoro standard** per la chiusura dei turni dimenticati: da fissare.
- **Costi orari reali** per livello CCNL Edilizia Industria, Cassa Edile inclusa: li fornisce Raffaele.
- **Rotazione di `APP_PASSWORD`**, propedeutica: non si aggiungono dati di dipendenti dietro una chiave rimasta in un repository pubblico.
