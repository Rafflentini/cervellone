# Un solo loop per due canali — design

**Data:** 3 settembre 2026
**Stato:** design approvato, da implementare
**Contesto:** [[feedback_due_canali_equipollenti]] — punto 2 di 5 dell'equipollenza, quello che i quattro
rimanenti presuppongono.

## Il problema

Cervellone parla su due canali, Telegram e chat web. Oggi girano su **due loop agentici distinti**,
`callClaudeStream` (web) e `callClaudeStreamTelegram`, entrambi in `src/lib/claude.ts`. Nascono da un
copia-incolla e da allora divergono: ogni correzione viene applicata su un canale e portata sull'altro
solo se qualcuno si ricorda di farlo.

Non è un problema estetico. Il 2 settembre la chat web moriva a metà turno per un `break` che Telegram
si era già tolto **il 24 maggio** e che nessuno aveva portato sul web: tre mesi di un difetto già
risolto, vivo su un canale solo.

Il costo non è il codice duplicato. È che **una fix non vale per il prodotto, vale per un canale**.

### Perché è divergiato proprio così

I due loop non sono coperti allo stesso modo: `claude.web-loop.test.ts` contiene 11 test sul loop web,
e **il loop Telegram non ha nessun test sulla sua logica interna** (`agent-job.*.test.ts` mockano
`callClaudeStreamTelegram` a scatola nera e testano il cablaggio, non il motore). Un canale è
sorvegliato, l'altro no. La divergenza non è un incidente: è il risultato prevedibile di questa
asimmetria.

## Le divergenze, misurate

Diff dei due corpi: **314 righe differenti su ~300 per lato**. Sotto le differenze cosmetiche (nomi di
log, commenti) ci sono divergenze di comportamento vere. Ognuna è verificata sul codice.

| # | Divergenza | Web | Telegram | Effetto |
|---|---|---|---|---|
| **D1** | `server_tool_use` contati in `totalToolCalls` | sì (`claude.ts:477-484`) | **no** | Un turno Telegram risolto con `web_search` ha `totalToolCalls = 0` → `detectHallucination` lo giudica **promessa a vuoto**. Outcome `hallucination` falso, che spinge il circuit breaker verso un rollback immotivato. |
| **D2** | guard `isCompletedOrConditional` sull'outcome finale | sì (`claude.ts:664`) | **no** (`claude.ts:1076`) | "Ho preparato il documento. Se vuole glielo mando" viene contato come fallimento **su Telegram**. Il commento sul lato web riporta la misura: **6 falsi positivi su 8**. |
| **D3** | `resetAnthropicBillingAlertIfNeeded()` dopo un successo | **no** | sì (`claude.ts:1079`) | L'alert "crediti esauriti" si riarma solo se il primo turno riuscito passa da Telegram. Se il ripristino avviene via web, l'alert resta armato e **non riparte più**. |
| **D4** | `notifyAnthropicBillingIfNeeded` protetta da `.catch()` | sì (`claude.ts:613`) | **no** (`claude.ts:1013`) | Su Telegram un errore dentro la notifica sfugge dal blocco `catch` che la contiene: il turno muore con eccezione al posto del messaggio d'errore leggibile. |
| **D5** | Messaggio d'errore API mostrato all'utente | errore tecnico grezzo | messaggio in italiano | Sul web l'utente legge `⚠️ 404 model not found: claude-...` (`chat/route.ts:305`); su Telegram legge "Modello AI temporaneamente non disponibile, il sistema sta recuperando". |
| **D6** | `maxRunTokens` configurabile | no (costante fissa) | sì | Il path durable può alzare il budget solo su Telegram. |
| **D7** | Nomi dei tool nel log di iterazione | no | sì | Diagnostica asimmetrica: gli stessi log non si leggono allo stesso modo. |

Differenze **legittime**, che restano e diventano esplicite: lo streaming (il web manda i delta appena
arrivano, Telegram riscrive un messaggio ogni 3 s), il placeholder "🧠 Sto pensando…" (Telegram non ha
streaming vero), `onToolStart` (la UI web mostra i tool), e chi scrive il messaggio utente a DB (sul
web lo fa il browser — scriverlo anche nel loop produceva due righe).

### Terzo loop, morto

`callClaude` (`claude.ts:686-779`, ~95 righe) è una terza copia non-streaming. **Nessun chiamante in
tutto il repo**; un commento in `memory.embedding-split.test.ts:85` lo dice già ("codice morto"). Va
cancellato: è una terza superficie che diverge senza che nessuno la esegua.

## La soluzione

Un solo motore, due adattatori sottili. Il motore non sa su che canale sta girando; il canale è un
**sink** (dove va il testo) più una **policy** (quattro scelte esplicite).

```
                    ┌─────────────────────────────┐
  /api/chat  ──────▶│                             │
   (web)            │       runAgentTurn()        │
                    │  il loop, uno solo:         │
                    │  iterazioni, tool, retry,   │
                    │  force-action, anti-bugia,  │
  agent-job  ──────▶│  sintesi forzata, budget,   │
   (telegram)       │  outcome, circuit breaker   │
                    └──────────┬──────────────────┘
                               │
                    ┌──────────┴──────────┐
                    ▼                     ▼
              ChannelSink           ChannelPolicy
         dove esce il testo      4 scelte esplicite
```

### Le interfacce

```ts
/** Dove esce quello che il modello produce. L'unica cosa che i due canali fanno davvero diversa. */
export interface ChannelSink {
  /** Testo del modello. `delta` = solo l'incremento, `accumulated` = tutto il turno finora.
   *  Il web usa `delta` (append allo stream); Telegram usa `accumulated` (riscrive il messaggio). */
  onText(delta: string, accumulated: string): void | Promise<void>
  /** Progresso durante il reasoning, quando non c'è ancora testo. Telegram lo mostra, il web no. */
  onThinking?(chars: number): void | Promise<void>
  /** Un tool eseguito da Anthropic (web_search, code_execution) è partito. */
  onServerTool?(name: string): void | Promise<void>
}

/** Le uniche scelte per-canale che restano. Quattro, non trecento. */
export interface ChannelPolicy {
  /** Etichetta nei log: 'web' | 'tg'. */
  tag: string
  /** entry_point di default per il logging consumi. */
  entryPoint: string
  /** Scrivere il messaggio UTENTE a DB. Il web no: lo fa già il browser (due righe altrimenti). */
  persistUserMessage: boolean
  /** Scrivere la risposta ASSISTANT a DB. Idem. */
  persistAssistantMessage: boolean
}
```

Firma: `runAgentTurn(request: ClaudeRequest, sink: ChannelSink, policy: ChannelPolicy): Promise<string>`.

I due entry-point pubblici restano **invariati nella firma** — nessun chiamante cambia:

```ts
export async function callClaudeStream(request, callbacks: ClaudeStreamCallbacks): Promise<string>
export async function callClaudeStreamTelegram(request, onChunk): Promise<string>
```

Entrambi diventano ~15 righe: costruiscono sink e policy, chiamano `runAgentTurn`.

### Dove vive

**Dentro `src/lib/claude.ts`, non in un modulo nuovo.** Il loop usa una dozzina di helper privati del
file (`getConfig`, `buildCachedSystem`, `buildModelOptions`, `resolveThinkingBudget`,
`extractLatestFileBlocks`, `archiveToolSucceededIn`, `executeToolBlocks`, `errorDetails`,
`isBillingError`, `notifyAnthropicBillingIfNeeded`, `trimMessages`, il `client`): estrarre il motore
significherebbe esportarli tutti o spostarli, cioè un secondo refactor dentro il primo. Il file
comunque **si accorcia**: 1158 → ~780 righe (‑95 di codice morto, ‑300 di copia).

## Le sette decisioni

Unificare obbliga a scegliere un comportamento dove oggi ce ne sono due. Ogni scelta è deliberata:

| # | Decisione | Perché |
|---|---|---|
| D1 | Contare i `server_tool_use` **su entrambi** | Chiude un falso `hallucination` su Telegram. Il web ha già la prova (`claude.web-loop.test.ts`, "una ricerca sul web conta come lavoro fatto"). |
| D2 | Guard `isCompletedOrConditional` **su entrambi** | Misurato: 6 falsi positivi su 8. Oggi Telegram li ha tutti. |
| D3 | `resetAnthropicBillingAlertIfNeeded` **su entrambi** | Un alert che non si riarma è un allarme che si spegne per sempre. |
| D4 | `.catch()` sulla notifica billing **su entrambi** | Una notifica che fallisce non deve uccidere il turno. |
| D5 | Messaggio d'errore leggibile **su entrambi** ⚠️ | **Cambio di comportamento visibile sul web**: al posto di `⚠️ 404 model not found…` l'utente legge la frase in italiano. Il motore non rilancia più sul web; la `catch` della route resta come rete di sicurezza per gli errori non-API. Il testo dell'errore viene **emesso attraverso il sink** (delta sul web, riscrittura su Telegram), altrimenti sul web l'utente non lo vedrebbe. |
| D6 | `maxRunTokens` onorato **su entrambi** | Era già nel tipo `ClaudeRequest`, ignorato dal web. |
| D7 | Log identici su entrambi (`STREAM(web)` / `STREAM(tg)` stesso formato, `toolNames` incluso) | Diagnostica simmetrica: la prossima divergenza si deve vedere dai log. |

D5 è l'unica che un utente noterà. È il verso giusto: il messaggio grezzo era il comportamento
peggiore dei due.

## Come si prova che sono equipollenti

Non con una promessa: con un test che **fallisce** se tornano a divergere.

`claude.web-loop.test.ts` diventa `claude.loop-parity.test.ts`, e ogni caso gira **su entrambi i
canali** con lo stesso corpo di asserzioni:

```ts
const CANALI = [
  ['web', (req) => callClaudeStream(req, { onText: () => {} })],
  ['telegram', (req) => callClaudeStreamTelegram(req, async () => {})],
] as const

describe.each(CANALI)('loop %s', (_nome, run) => {
  // gli 11 casi esistenti + i nuovi, identici per i due canali
})
```

Da quel momento una fix applicata a un canale solo **non compila il verde**: il test dell'altro canale
cade. È questa la garanzia strutturale, non il fatto che il codice sia unico — il codice unico si può
sempre ri-biforcare.

I casi esistenti sono 11 e diventano 22. Se ne aggiungono per le sette decisioni: D1-D4 sono
verificabili con asserzioni sull'outcome del breaker, D5 sul testo restituito, D6 sul numero di
iterazioni, D7 non si testa (è logging).

**Test di caratterizzazione prima del refactor.** I test del lato Telegram vengono scritti **contro il
codice attuale** e devono passare *prima* di toccare il motore: è quello che pinna il comportamento di
oggi. Solo i sette cambi deliberati sono attesi rossi, e ognuno ha il suo test che dice perché.

**Mutation testing obbligatorio** ([[feedback_mutation_testing]]): il verde non basta. Ogni nuovo test
va provato mutando il codice che copre — se il test non muore, non è un test.

## Rischi

| Rischio | Perché è contenuto |
|---|---|
| Il refactor cambia comportamento senza accorgersene | I 22 casi di parità girano prima e dopo. Il baseline è noto: 1462 verdi, 1 flaky preesistente (`tools.share.test.ts`, passa in isolamento in 5,6 s). |
| D5 peggiora la UX web invece di migliorarla | È una riga di policy: si inverte senza toccare il motore. |
| `runAgentTurn` diventa il nuovo monolite | ~330 righe con una sola responsabilità (un turno agentico). Sink e policy sono le uniche variabili. |
| Il path Telegram non è coperto oggi → il refactor rompe qualcosa di non testato | È esattamente il motivo per cui i test di caratterizzazione Telegram si scrivono **prima**. |

## Fuori scopo — ma censito

Il loop è la parte **coperta** della divergenza. Attorno ai due entry-point ce n'è di più, e va
scritto qui perché è la roadmap dei tre punti di equipollenza rimanenti. Ordinato per quanto un utente
lo sente, tutto verificato sul codice:

| | Divergenza | Dove |
|---|---|---|
| 1 | **Nessun percorso durable sul web.** Un task lungo che su Telegram viene delegato a un workflow persistente (`shouldUseDurable`), sul web si tronca a 800 s senza avviso. `shouldUseDurable` non è mai importato in `chat/route.ts`. | `telegram/route.ts:1064` |
| 2 | **Nessun rate-limit serio, dedup, mutex o coda sul web.** Telegram ha doppio bucket, dedup su `message_id`, mutex per chat con heartbeat, coda. Il web ha solo 10 richieste/60 s: due richieste sulla stessa conversazione girano in parallelo senza che l'utente lo sappia. | `telegram/route.ts:62-89, 744-871` vs `chat/route.ts:22-31` |
| 3 | **Le doppie conferme `/sal_*`, `/regola_*`, `/condividi_ok_*` non esistono sul web.** I tool sono gli stessi, quindi il modello *può* proporre `/sal_ok_<uuid>` in chat web — e lì quel comando è solo testo. Il flusso si apre e non si può chiudere. | `telegram/route.ts:680-777` |
| 4 | **I documenti caricati dal web non finiscono su Drive.** Solo le immagini passano da `ingestPhotoUpload`; un PDF via Telegram è archiviato, lo stesso PDF via web resta solo in contesto. | `chat/route.ts:82-122` |
| 5 | **La history del web la scrive il browser.** Se il client crolla dopo lo streaming ma prima della POST a `/api/conversations/[id]/messages`, il messaggio si perde in silenzio. Su Telegram la scrive il server. | `chat/route.ts:406-408` |
| 6 | **Nessun controllo anti-allucinazione sui link Drive nel web.** Telegram verifica che un link Drive citato esista prima di inviare (`annotateHallucinatedLinks`); il web no. | `agent-job.ts:110-148` |
| 7 | **History shaping asimmetrico.** Telegram: 80 messaggi, cap 12k per messaggio, compressione stratificata dei blocchi documento. Web: nessun cap per singolo messaggio. | `telegram/route.ts:899-986` |
| 8 | **Pointer di memoria opposti.** `artifactsPointer` è incondizionato sul web e dietro flag su Telegram; `sentMailPointer` esiste solo su Telegram. | `agent-job.ts:175-209` vs `chat/route.ts:226-254` |

Nessuna di queste si tocca in questo lavoro. La #3 è la più insidiosa perché è già raggiungibile
oggi: merita di essere il prossimo passo.

Non si toccano nemmeno il contorno dei due entry-point (costruzione history, system prompt, allegati)
se non dove il loop lo attraversa.

## Definizione di fatto

- [ ] `callClaude` cancellato, nessun riferimento residuo
- [ ] Un solo loop; i due entry-point sono adattatori sotto le 20 righe
- [ ] `claude.loop-parity.test.ts` verde su entrambi i canali, tutti i casi
- [ ] Le sette decisioni hanno ciascuna un test che le pinna
- [ ] Mutation testing: ogni nuovo test muore quando il codice mente
- [ ] `tsc --noEmit` pulito
- [ ] Suite: 1462+ verdi, nessuna regressione oltre il flaky noto
- [ ] Audit avversariale multi-agente PRIMA del deploy ([[feedback_audit_sempre_prima_deploy]])
- [ ] Deploy verificato READY + smoke sui due canali
