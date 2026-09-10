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

**Effetto collaterale buono:** i 3 tool di check-in de La Real Estate oggi partono a **ogni** turno,
anche in una conversazione Restruktura. Differiti, compaiono solo se cercati.

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
| **Descrizioni corte = ricerca peggiore.** Le descrizioni diventano **l'indice di ricerca**; il ramo FIC bloccato le accorcia del 77% | **alta**, e non era prevista | Va detto a chi riprende quel ramo: dimagrire le descrizioni ora ha un **costo nuovo**. I due lavori vanno riconciliati prima, non dopo. |
| Turno a freddo che cerca: **+22% token** | media | Misurabile dal passo 0. Se pesa, si allarga il nucleo. |
| Il modello cerca **due volte** per un bisogno solo (visto) | bassa | Costa un passaggio cachato. Si guarda dopo il passo 0. |
| La ricerca è BM25 su testo **italiano** | media | Il censimento la mette alla prova su tutti e 127. |

---

## 6. Come si verifica

1. **I 2.203 test di `main` restano verdi.** (Linea di base presa stanotte: 2203 passati, 4 saltati,
   173 file, 41s.)
2. **Il censimento delle capacità** — il pezzo che conta. Per **ognuno** dei 127 tool, una richiesta
   realistica in italiano, e si verifica che il tool **venga raggiunto**. È la prova della regola
   n.2 («nessuna capacità viene tolta»), resa misurabile. Gira contro l'API vera: **non in CI**, ma
   una volta prima del merge e poi a ogni cambio del nucleo. Costo stimato ~2 dollari.
3. **Un controllo positivo**: un test che, rimettendo `defer_loading: false` ovunque, **fallisce** —
   altrimenti il censimento non sta misurando niente ([[feedback_controllo_positivo]]).
4. **Audit avversariale** da un agente che non ha scritto il codice e **non confronta col piano**
   ([[feedback_difetti_del_piano]]).
5. **Sui due canali.** Telegram e chat web passano dallo stesso `runAgentTurn`, ma
   l'equipollenza si **prova**, non si deduce ([[feedback_testare_gli_adattatori_non_il_motore]]).
6. **Il merge lo decide Raffaele.**

---

## 7. Cosa questo NON risolve

Vale ancora, parola per parola, quanto scritto il 10 settembre: **non risolve gli errori del 10
settembre.** La fattura non è uscita sbagliata per il peso del contesto, ma perché **nessuno
controllava l'esito**. Alleggerire rende più facile mettere le verifiche dove servono; **le
verifiche vanno comunque scritte.** Sono due lavori diversi.
