# Strada C — il disegno

**11 settembre 2026.** Disegno architetturale, da approvare prima dell'implementazione.
Sostituisce l'intervento «A — alleggerire» ipotizzato il 10 settembre
(`2026-09-10-decisione-strada-c.md`), **non** la decisione che l'ha motivato.

---

## In una riga

Non costruiamo il meccanismo per aprire i domini: **ce l'ha già l'API**, si chiama ricerca dei tool,
e il codice da scrivere è un flag per tool più un tool server dichiarato. Misurato: il contesto di
ogni turno passa da **46.915 a 18.244 token**, il costo a cache calda **non peggiora**.

---

## 1. Le misure, rifatte con lo strumento giusto

Tutte le cifre qui sotto vengono da chiamate vere all'API su `claude-sonnet-4-6`, il modello di
produzione, leggendo `usage.input_tokens`. Non sono stime.

### 🚨 Il pavimento era sottostimato del 46%

| | 10 set (stimato a 4 byte/token) | 11 set (misurato) |
|---|---:|---:|
| prompt + 129 tool + un messaggio corto | ~32.200 token | **46.915 token** |

I byte non sono cambiati (129 tool, 88.479 byte; prompt 39.610 byte in 252 righe: **rimisurati, delta
zero**). È il **divisore** a essere sbagliato: su italiano e schemi JSON il rapporto reale è **2,72
byte/token**, non 4,0. Il problema era **più grande** di come lo avevamo scritto.

Ripartizione misurata, isolando le voci una per una:

| voce | token |
|---|---:|
| prompt + 9 tool di nucleo | 18.244 |
| **le 120 definizioni di tool in più** | **28.671** |
| avere in più la ricerca dei tool disponibile | 188 |

### ⚠️ Una correzione a noi stessi

Il rapporto del 10 settembre segnava come 🚨 che il commento `claude.ts:367` («input −80/90% sul
prefisso fisso, **~4-5K token**») fosse *«falso di 7-8×»*. **Non lo è.** Quel commento parla del
**residuo dopo un cache-hit**, non della dimensione grezza del prefisso: il 10% di 46.915 è **~4.700
token**, cioè esattamente «~4-5K». La riga di codice era giusta; a sbagliare è stata la nostra
lettura. Va tolto il 🚨 dai documenti.

---

## 2. Il meccanismo: la ricerca dei tool, che è dell'API

`tool_search_tool_bm25_20251119` è un tool **server**, GA sull'API Claude, **senza beta header**, e
**funziona su `claude-sonnet-4-6`** (provato, non dedotto). Ogni tool marcato `defer_loading: true`
resta *dichiarato* nella richiesta ma **non entra nel contesto del modello** finché il modello stesso
non lo cerca. Gli schemi trovati vengono **aggiunti in coda, non scambiati**: la cache non si rompe.

Prova, dalla risposta vera a *«Leggimi le ultime mail non lette sulla casella info»*:

```
server_tool_use        → query "read_email unread", limit 3      ← il limite lo sceglie lui
tool_search_tool_result → gmail_mark_read, leggi_allegato_mail, read_email
tool_use               → read_email {account:"info", unread_only:true, limit:20}
```

Cerca, trova, e chiama con gli argomenti giusti — **con lo schema vero sotto gli occhi**, non a
memoria. Su sei richieste realistiche ha cercato in cinque; la sesta (`lista_scadenze`) non aveva
bisogno di cercare perché il tool era già nel nucleo.

### Perché questo e non un `apri_dominio` scritto da noi

1. **Il principio di Raffaele, alla lettera.** *«Costruire in modo che, quando il modello migliora,
   si possa CANCELLARE codice — non aggiungerne.»* Qui non si aggiunge un router, un classificatore
   o una mappa di parole chiave: si aggiunge **un flag**. Se un domani il modello sceglie meglio da
   sé, non c'è nostro codice da riscrivere: c'è quello di Anthropic che migliora sotto di noi.
2. **La cache.** L'ordine di rendering è `tools → system → messages`: un `apri_dominio` nostro
   **muterebbe l'array dei tool a metà turno** e invaliderebbe l'intero prefisso, prompt compreso.
   La ricerca nativa aggiunge in coda e la cache regge — misurato: 36.206 token letti dalla cache su
   due passaggi interni, **1.528 nuovi**.
3. **Niente parole chiave scritte da noi.** È il modello a formulare la query. Nessuna lista da
   manutenere, nessuna che invecchia.

### Cosa NON si può usare, e perché

`mid-conversation-tool-changes` (aggiunta/rimozione esplicita di tool) è **beta e da Opus 5 in su**:
su `sonnet-4-6` non esiste. È comunque il meccanismo sbagliato — serve a far decidere
**all'applicazione**, non al modello.

---

## 3. Il conto vero, a cache calda

Il confronto onesto non è a freddo: la produzione cacha il prefisso con TTL un'ora.

| turno | oggi | differito | |
|---|---:|---:|---|
| che **resta nel nucleo** (es. «che scadenze ho?») | $0,01499 | **$0,00645** | **−57%** |
| che **apre un dominio** (es. «leggimi le mail») | $0,01499 | $0,01545 | **+3%** |

**Il costo non peggiora.** Cercare costa un passaggio interno in più, ma quel passaggio legge dalla
cache: il sovrapprezzo è di 1.528 token nuovi, non di un prefisso intero.

Il guadagno vero è l'altro, ed è quello che il progetto voleva:

| | oggi | differito |
|---|---:|---:|
| contesto occupato a ogni passaggio | 46.915 | **18.244** (→ ~19.600 dopo una ricerca) |

**−58% / −61% di finestra di contesto**, che è la cosa che la cache non poteva comprare.

⚠️ **A freddo** (prima chiamata, cache vuota) un turno che cerca costa **+22%** in token
(57.393 contro 46.925). Va detto, e va tenuto d'occhio sui turni sparsi.

---

## 4. Le sezioni del disegno

### 4.1 — Passo 0: vedere. *Prima di ogni altra cosa.*

**Non esiste nessuna tabella che registri quali tool vengono chiamati.** Verificato: in Supabase ci
sono `messages`, `agent_workflow_runs`, `cervellone_audit_runs`, i log mail — **nessun registro delle
chiamate ai tool**.

Questo ha due conseguenze, e sono entrambe bloccanti:

1. **Il nucleo non è scegliibile su prove.** Oggi lo sceglieremmo a intuito.
2. **Una capacità persa sarebbe invisibile.** Se dopo il cambio un tool smettesse di essere trovato,
   nessuno se ne accorgerebbe finché non lo cerca l'Ingegnere — e allora sembrerebbe colpa sua.
   È lo stesso modo di sbagliare di [[cervellone-lettura-negata-torna-vuota]]: **il guasto si traveste
   da colpa dell'utente.**

**Intervento:** una riga per chiamata — `nome_tool`, `quando`, `canale`, `esito` — scritta in
`executeTool` (`tools.ts:895`), che è già il collo di bottiglia unico di tutte le esecuzioni.
Nessun cambio di comportamento, nessun rischio. Va in produzione **da solo**, e lo si lascia
raccogliere qualche giorno prima del passo 1.

### 4.2 — Passo 1: differire

**Cosa cambia nel codice, per intero:**

1. `getToolDefinitions(opzioni?)` prende un parametro **facoltativo**. Senza parametro il
   comportamento è **identico a oggi** — è additivo, come già stabilito il 10 settembre.
2. Il chiamante di produzione (`claude.ts:520`, l'unico) passa le opzioni.
3. Ogni tool fuori dal nucleo prende `defer_loading: true`.
4. Si dichiara `tool_search_tool_bm25_20251119` in testa all'elenco.

**Cosa NON cambia, e va detto perché è la parte importante:**

- **`executeTool` non si tocca.** Definizione ed esecuzione sono **disaccoppiate**: `executeTool`
  scorre la catena dei 28 `EXECUTORS` e non consulta mai l'elenco delle definizioni
  (`tools.ts:895-901`). Un tool differito resta **eseguibile** esattamente come prima.
- **Il loop non si tocca.** Rimanda già `content: final.content` — **tutti** i blocchi
  (`claude.ts:728, 744, 764`), quindi la ricerca e gli schemi scoperti sopravvivono alle iterazioni.
  Gestisce già i tool server (`server_tool_use`, riga 668) perché `web_search` e `code_execution`
  ci sono da sempre.
- **Nessun tool viene cancellato.** Cambia *quando* si caricano, non *se* esistono. La regola
  chirurgica n.2 resta intatta.
- **Il database non si tocca.** Regola n.1 intatta.
- **Il prompt non si tocca.** Vedi 4.3.

**Il nucleo.** Criterio dichiarato: *è di nucleo un tool che serve a **capire la richiesta**, non a
**fare il lavoro***. Provvisoriamente: `cerca_documenti`, `ricorda`, `cerca_memoria`,
`working_memory_set/get`, `lista_scadenze`, `cervellone_info`, `imposta_societa_attiva`,
`lista_progetti`, più i due tool server già presenti. **Nove più due — e sono un'ipotesi, non una
scelta: si rivede sui dati del passo 0 dopo una settimana.**

### 🚨 Le due società: il rischio **peggiora**, e la decisione resta a Raffaele

Questa sezione diceva, fino al censimento: *«Effetto collaterale buono: i 3 tool di check-in de La
Real Estate oggi partono a ogni turno anche in una conversazione Restruktura. Differiti, compaiono
solo se cercati.»* **Era vero quando è stato scritto. È falso adesso.** Il censimento ha misurato che
quei tre si perdevano, il Task 9 li ha messi nel nucleo, e l'effetto si è **invertito**.

Misurato eseguendo `getToolDefinitions`:

| | tool de La Real Estate visibili | su quanti | quota |
|---|---:|---:|---:|
| oggi | 3 | 129 | **2,3%** |
| col differimento | 3 | 17 | **17,6%** |

E c'è dell'altro: `CHECKIN_TOOLS` è il **primo** blocco di `ALL_TOOLS` (`tools.ts:795`), quindi quei
tre occupano le **posizioni 4-6** della cassetta visibile. In una conversazione Restruktura il
modello vedrebbe una cassetta in cui **un attrezzo su sei è dell'altra società, in testa all'elenco**.

Con «maratea» che è un **anti-segnale** documentato — 4 messaggi su 5 che la nominano sono cantieri
Restruktura — la direzione è quella sbagliata. `imposta_societa_attiva` resta nel nucleo e il
riconoscitore dal testo resta timido apposta, ma **non compensano la salienza**.

> **Questa è l'unica decisione che resta a Raffaele, e non gliela prendo io**: scambia «il check-in
> funziona» con «rischio di confondere le due società», e l'esito di una confusione è un documento
> fiscale sbagliato. Le tre strade:
>
> 1. **tenerli nel nucleo** e accettare la salienza — è com'è adesso;
> 2. **toglierli**, e accettare che il check-in non si raggiunga finché la loro descrizione non
>    conterrà le parole con cui lo si cerca (§5.1);
> 3. **tenerli, ma in fondo all'elenco** invece che in testa: mitiga la salienza senza togliere
>    niente. Costa una riga, e **non è stato fatto** perché sposta l'ordine dei tool, che è il primo
>    blocco del prefisso della cache — va misurato, non improvvisato.

### 4.3 — Passo 2: il prompt. *Progettato a parte, non stanotte.*

Misurato oggi: delle 252 righe del `BASE_PROMPT` (39.610 byte), **il 75,6% sono manuali d'uso di tool
specifici** — foto 5.805 · scadenzario 4.248 · self-healing 3.706 · salvataggio file 3.084 ·
contabilità 2.530 · modelli 2.266 · mail 2.227 · SAL 1.351 · Gmail 1.183 · Drive 1.782 ·
file-pipeline 711 · memoria 665 · meteo 393. La condotta vera — identità, il «Lei», le due regole
anti-allucinazione, l'autonomia — è **~9.659 byte, il 24,4%**.

La tentazione è far viaggiare ogni manuale col suo dominio. **Non stanotte, e per una ragione
precisa:** una regola come quella anti-allucinazione deve essere presente **mentre il modello
ragiona**, cioè *prima* di aprire il dominio — non insieme allo strumento. Distinguere quali regole
possono viaggiare e quali no è un lavoro di lettura riga per riga, e la regola chirurgica n.3
(«per ogni riga rimossa, un test che prova che il comportamento regge») vale in pieno. **Merita il
suo disegno.**

---

## 5. I rischi, e cosa si fa

| rischio | gravità | cosa si fa |
|---|---|---|
| **Il modello non trova un tool** e dice «non posso» | **alta** — violerebbe «mai limitare» | Il **censimento** (§6): 127 richieste vere, una per tool. Nessun merge finché non passa. |
| **Descrizioni corte = ricerca peggiore.** Le descrizioni diventano **l'indice di ricerca**; il ramo FIC bloccato le accorcia dell'81% | **media, e circoscritta** (misurato, vedi sotto) | Va detto a chi riprende quel ramo. Non è un veto: è un criterio nuovo — *una descrizione deve contenere le parole con cui la si cercherebbe*. |
| Turno a freddo che cerca: **+22% token** | media | Misurabile dal passo 0. Se pesa, si allarga il nucleo. |
| Il modello cerca **due volte** per un bisogno solo (visto) | bassa | Costa un passaggio cachato. Si guarda dopo il passo 0. |
| La ricerca è BM25 su testo **italiano** | media | Il censimento la mette alla prova su tutti e 127. |

### 5.1 — Il ramo FIC e le descrizioni corte, misurato

Sul ramo bloccato `fix/fic-peso-e-conferma-voce` le descrizioni dei tool di scrittura FIC passano da
**1.451 a 272 byte (−81%)**. Ma le parole con cui uno *cercherebbe* quei tool **restano**:

| | main (338 byte) | ramo FIC (97 byte) |
|---|---|---|
| `compila_fattura_emessa` | «Compila una bozza di **fattura** emessa su **Fatture in Cloud**, senza trasmetterla. […] il **sezionale** di numerazione, il **centro di ricavo** […] la **cassa previdenziale/rivalsa INARCASSA**» | «Compila una bozza di **fattura** emessa su **Fatture in Cloud**. Il manuale sta nella skill «Segreteria».» |

«fattura», «bozza», «Fatture in Cloud» ci sono ancora: la ricerca normale regge. **Quello che si perde
sono le parole specialistiche** — una richiesta come *«azzerami la rivalsa INARCASSA su questa
fattura»* non aggancerebbe più niente.

**Il criterio che ne nasce, e che vale per tutti e 127 i tool:** una descrizione può dimagrire quanto
si vuole **purché conservi le parole con cui l'Ingegnere la cercherebbe**. Non è un veto sul ramo FIC:
è un vincolo nuovo che quel ramo non poteva conoscere, perché il differimento non esisteva.

⚠️ Nota a margine, già nota: quella descrizione rimanda alla skill «Segreteria», che secondo l'audit
del 10 settembre **sta in un file che nessun sorgente importa**. Il rimando è a vuoto.

---

## 6. Come si verifica

1. **I 2.203 test di `main` restano verdi.** (Linea di base presa stanotte: 2203 passati, 4 saltati,
   173 file, 41s.)
2. **Il censimento delle capacità** — il pezzo che conta. ⚠️ **Il cancello scritto qui sopra non è
   stato soddisfatto come formulato, ed è giusto dirlo.** Prometteva *«per ognuno dei 127 tool una
   richiesta realistica in italiano»*. Quello che è stato fatto è diverso, e il registro
   `2026-09-11-censimento-tool.md` lo racconta per esteso:
   - un differenziale su **119 richieste derivate dalle descrizioni** — circolari: il numero «90 già
     irraggiungibili oggi» **non è significativo**, dice che quelle richieste sono scritte male;
   - **9 richieste realistiche vere**, scritte a mano, sui tool sospetti: 5 capacità perse trovate e
     recuperate, poi **9 su 9 verificate** dopo la cura;
   - una **corsa di controllo negativo** (12 su 12 non raggiunti a strumenti vietati), che è l'unica
     ragione per cui questi numeri valgono qualcosa.

   **Le 119 richieste realistiche a mano non esistono.** Scriverle è il lavoro che manca perché il
   cancello sia davvero quello promesso.
3. **Un controllo positivo**: un test che, rimettendo `defer_loading: false` ovunque, **fallisce** —
   altrimenti il censimento non sta misurando niente ([[feedback_controllo_positivo]]).
4. **Audit avversariale** da un agente che non ha scritto il codice e **non confronta col piano**
   ([[feedback_difetti_del_piano]]).
5. **Sui due canali.** Telegram e chat web passano dallo stesso `runAgentTurn`, ma
   l'equipollenza si **prova**, non si deduce ([[feedback_testare_gli_adattatori_non_il_motore]]).
6. **Il merge lo decide Raffaele.**

---

## 6.1 — Come si accende, e cosa sorvegliare

**L'ordine conta, e non è quello che sembra.**

1. **Prima la migrazione, poi il merge.** `cervellone_tool_calls` va creata *prima* che il codice del
   registro arrivi in produzione. Al contrario, il registro scriverebbe a vuoto — e siccome è
   fire-and-forget, **in silenzio**. (Il Task 7 aggiunge un avviso una-volta-per-processo proprio
   perché quel silenzio non sia totale, ma la migrazione resta la cosa da fare per prima.)
2. **Poi si lascia girare qualche giorno con `TOOL_DEFER` spento.** Serve a raccogliere il dato su
   *quali tool vengono chiamati davvero*, che è quello che rende il nucleo una scelta invece di
   un'ipotesi.
3. **Solo dopo si accende.** `TOOL_DEFER=1` su Vercel, **più un redeploy**: su Vercel le variabili
   d'ambiente sono legate al *deployment*, non al progetto — cambiarla in dashboard non tocca quello
   in esecuzione. `npx vercel redeploy <url>`.

**Le tre cose da guardare il primo giorno con l'interruttore acceso:**

| cosa | perché | come si vede |
|---|---|---|
| 🚨 **Turni che si chiudono a metà** | `claude.ts:728` considera concluso un turno senza blocchi `tool_use`, e **i tool server non ne producono**. Se l'API rispondesse `stop_reason: 'pause_turn'` durante una ricerca, il turno verrebbe letto come finito. È un difetto **preesistente** (`web_search` c'è da sempre), ma il differimento fa passare *ogni* scoperta di tool da un tool server: da raro diventa frequente. | una risposta che si interrompe senza spiegazione |
| **Il risparmio si realizza davvero?** | Le misure di questo documento vengono da una configurazione costruita a mano. Che i 28.671 token si risparmino **con il codice vero** è una previsione finché non la si legge su un turno vero. | `usage.input_tokens` nei log |
| **Il registro registra?** | Se la tabella non c'è, o RLS blocca, il registro tace. | l'avviso `tool_call_log:` nei log di Vercel |

**Per tornare indietro:** `TOOL_DEFER` a qualunque valore diverso da `'1'` (o rimossa) più un
redeploy. Non si tocca il codice, e la garanzia è misurata: senza opzioni `getToolDefinitions()`
produce **esattamente** l'output di `main`, md5 identico, ordine compreso.

---

## 7. Cosa questo NON risolve

Vale ancora, parola per parola, quanto scritto il 10 settembre: **non risolve gli errori del 10
settembre.** La fattura non è uscita sbagliata per il peso del contesto, ma perché **nessuno
controllava l'esito**. Alleggerire rende più facile mettere le verifiche dove servono; **le
verifiche vanno comunque scritte.** Sono due lavori diversi.
