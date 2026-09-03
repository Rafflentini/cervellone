# Durable Fase 2 — decisione: NON si costruisce

**Data:** 3 settembre 2026 · **Esito:** piano CHIUSO, non eseguito · **Branch:** `feat/durable-fase2` (lasciato, non mergiato)

Il piano `docs/superpowers/plans/2026-06-10-durable-fase2-anti-timeout.md` (561 righe, scritto il
10 giugno e mai committato) proponeva di spezzare il loop agentico in **uno step WDK per iterazione**,
per due obiettivi dichiarati: eliminare il **timeout 800s** e il **re-run da zero al crash**.

Prima di eseguirlo ho misurato se quei due problemi accadono. Non accadono.

## La misura (produzione, tabella `agent_workflow_runs`, 3 giu → 3 set 2026)

| | |
|---|---|
| Run durable totali | **104** |
| Run finiti in errore | **0** — tutti `done` |
| Run ri-eseguiti (`attempts > 1`) | **0** |
| Durata media | **64 s** |
| Durata massima | **392 s** |
| Run oltre 800 s | **0** |

**Il campione è quello giusto, non un campione facile.** Il path durable non prende le richieste
brevi: `shouldUseDurable()` lo attiva solo quando `classifyTask()` riconosce un lavoro documentale
pesante — preventivo, computo, CME, perizia, relazione tecnica, pratica, SCIA, CILA, SAL, POS. Quei
104 run **sono** i lavori lunghi, cioè esattamente la popolazione che la Fase 2 doveva proteggere. Il
più lungo di tutti si è fermato a meno della metà del limite.

**Lo strumento è tarato** (il controllo che serviva: un contatore rotto direbbe "0 ri-esecuzioni"
esattamente come un sistema sano). `attempts` vale **0 per i 21 run del 3-4 giugno** e **1 per gli 83
dal 6 giugno in poi**: lo stacco cade sul giorno esatto in cui è stato introdotto
`incrementRunAttempts` dopo l'incidente da $118. Il contatore si muove davvero; lo zero misurato è un
fatto, non un guasto. [[feedback_misura_non_e_dato]] · [[feedback_controllo_positivo]]

## Perché non basta dire "non serve": costruirla farebbe danno

La revisione del 10 giugno interna al piano aveva già deciso di **non** rifattorizzare il path live,
ritenendolo troppo rischioso, e di creare invece una funzione **separata e dedicata**
`runDurableIteration` — accettando la duplicazione del loop.

Quella decisione era ragionevole a giugno. Oggi è il contrario di dove siamo andati: il 3 settembre le
**tre copie del loop sono state unificate** in `runAgentTurn(request, sink, policy)` con due soli
adattatori sottili, e la garanzia anti-divergenza è meccanica — `claude.loop-parity.test.ts` fa girare
ogni caso su **entrambi** gli adattatori pubblici. Aggiungere `runDurableIteration` significherebbe
introdurre una **terza copia fuori da quella garanzia**, cioè ricreare di mano mia la classe di difetto
che in questa stessa sessione ha prodotto le due regressioni peggiori — una delle quali era
*"cablata su un canale solo, dentro il lavoro che eliminava le divergenze"*.
[[feedback_testare_gli_adattatori_non_il_motore]]

## L'idempotency (Task 2) resta fuori, e non è una svista

`withIdempotency` sul branch è codice sano (3/3 test verdi) e serve a impedire che un retry rispedisca
una mail già spedita. Ma protegge da un rischio che **oggi non esiste**: `runAgentJobStep` ha
`maxRetries = 0` e `MAX_RUN_ATTEMPTS = 1`, quindi nessun tool-write viene mai ri-eseguito. Quel rischio
lo introdurrebbe **la Fase 2 stessa**, spezzando il lavoro in step che WDK può ritentare. Mergiarla ora
sarebbe una difesa senza attaccante.

**Se un giorno la Fase 2 tornasse necessaria** (segnale che la rende tale: run che superano gli 800s,
oppure `attempts > 1` che compare in tabella), va ripresa così: prima `withIdempotency` sui tool-write,
poi gli step per iterazione costruiti **sopra `runAgentTurn`**, con un terzo sink — non con una quarta
copia del loop.

## Cosa resta vero del lavoro di giugno

- Il crash-restart da $118 **è già chiuso** dalla Fase 1: cap sui tentativi + doppio contatore
  (DB, che sopravvive ai crash; WDK nativo, che sopravvive al DB giù).
- La Fase 1 durable è **viva e sana** in produzione: 104 run, zero errori, ultimo oggi.
- Il branch `feat/durable-fase2` non va cancellato: contiene T0 (hello-replay), T1
  (`runDurableIteration`) e T2 (idempotency), utili se il segnale sopra dovesse comparire.
