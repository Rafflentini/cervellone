# SDD ledger — plan: docs/superpowers/plans/2026-08-18-guardrail-token-fuzzy.md

Branch: `fix/guardrail-token-fuzzy` da `main` @ 4cdd0c7 (worktree cervellone-codex).
Spec: il piano stesso (nessun documento di spec separato) → le rulings sono provvisorie.

## Nota di sessione (18 ago)
La sessione precedente ha dispacciato un esecutore su una premessa FALSA: il worktree
era su `fix/scadenze-lettura` (0 avanti / 24 dietro main, già confluito), e il branch
`fix/guardrail-token-fuzzy` non esisteva. Zero commit prodotti, nessun lavoro perso.
Branch creato davvero prima del ri-dispatch.

Deviazione consapevole dalla skill: l'esecuzione dei 5 task è affidata a UN solo
implementer (era già in volo quando la skill è stata caricata), non uno per task. La
review resta quella prescritta: review package sul range completo + final review.

## Pre-flight conflict scan

| # | Task coinvolti | File / interfaccia condivisa | Cosa produce vs cosa consuma | Esito |
|---|---|---|---|---|
| 1 | T1 × T2 | `foto-archive-match.ts` (stopwords vs ciclo) | T1 accorcia il denominatore; T2 aggiunge il match fuzzy | ⚠️ **Interazione nota e dichiarata**: T1 da sola PEGGIORA il typo (65.6%→43.8%). Non sono indipendenti. Ruling sotto. |
| 2 | T2 → T3 | `editDistanceAtMost`, `FUZZY_WEIGHT` | T2 le esporta, T3 le consuma nei test | ✅ Ordine corretto: T3 dopo T2. |
| 3 | T1+T2 × T4 | `foto-archive-tools.test.ts` | T4 riscrive il commento di `LIMITE NOTO` dando per scontato che il test resti VERDE dopo T1+T2 | ⚠️ Non verificato a priori. Se T2 rende quel caso riconosciuto, il test va rosso e il commento di T4 diventa falso. Il piano lo intercetta a T2/Step 4. |
| 4 | T1 × T3 | test `LIMITE NOTO parole di dettaglio` | T3 asserisce `< SOGLIA` su token (`sostituzione`, `lattoneria`, `pluviali`) non toccati dalle stopword di T1 | ✅ Nessun conflitto atteso. |
| 5 | T5 | `scenario` / `bloccata` nel describe calibrazione | T5 consuma un helper che il piano non ha verificato essere in scope | ⚠️ Sospetto di difetto del piano, segnalato all'esecutore. |
| 6 | T1 | coerenza interna | test attende `significantTokens(...) === ['rossi']` | ⚠️ Sospetto: `a` potrebbe già cadere per lunghezza minima. L'asserzione va corretta al valore vero, non il codice. |
| 7 | tutti | Global Constraint `SOGLIA_DUPLICATO = 0.6` | nessun task la modifica | ✅ Coerente. |
| 8 | T3, T5 | rubrica di review vs mandato del piano | T3/T5 sono test di CARATTERIZZAZIONE: asseriscono difetti noti, non virtù | ⚠️ Un reviewer li leggerà come "test che pinna un bug". Ruling sotto. |

### Rulings pre-esecuzione

- **Ruling (riga 1):** T1 e T2 vanno considerate UNA unità, non due miglioramenti
  indipendenti. Non si accetta un merge fermo dopo T1. — *Perché:* T1 da sola lascia il
  guardrail peggiore di com'era sul caso typo, che è il modo più frequente in cui nasce
  un duplicato. — *Costo se sbagliato:* nessuno sul codice; costringe solo a completare
  entrambe prima di valutare.
- **Ruling (riga 8):** i test di caratterizzazione di T3 e T5 sono voluti e restano.
  — *Perché:* pinnano un costo misurato, così il prossimo che tocca il file sa cosa sta
  rompendo; cancellarli nasconde il difetto invece di risolverlo. — *Costo se sbagliato:*
  la suite documenta un comportamento che qualcuno potrebbe scambiare per desiderato;
  mitigato dal commento esplicito "COSTO NOTO" / "LIMITE NOTO".

## Baseline VERA di `main` @ 4cdd0c7 (misurata 18 ago, non presunta)

```
 Test Files  1 failed | 69 passed | 1 skipped (71)
      Tests  1 failed | 829 passed | 4 skipped (834)
   Duration  32.69s
```
`npx tsc --noEmit`: **0 errori**.

⚠️ **Il piano dichiarava "baseline 830 passati + 4 skipped": è SBAGLIATO.** `main` non è
verde. Il rosso è `src/lib/scadenze-tools.test.ts:634` — `calendar_create_event NON
invita piu a duplicare le scadenze (FIX 5)` — *Test timed out in 5000ms* (durata reale
6532ms). È un flake da contesa di CPU, NON un difetto del codice: il test fa un
`importActual` reale di `./calendar-tools` e la transform supera i 5s quando girano 71
file in parallelo.

**Conseguenza operativa:** se l'implementer chiude con `829 passed | 1 failed` su QUEL
test, non è una regressione del guardrail. Il numero da confrontare è **829 + i nuovi
test**, non 830.

**Il fix esiste già e non è mergiato:** branch `fix/test-flaky-timeout` (`1540002`,
worktree `cervellone-w3`) alza quel solo timeout a 20000ms con commento esplicativo.
Merge NON eseguito: è un'azione su branch condiviso, la decide Raffaele.

## Merge del fix flake in `main` (autorizzato da Raffaele, 18 ago)

`main` 4cdd0c7 → **1540002**, fast-forward, 1 file / 5 righe (solo
`src/lib/scadenze-tools.test.ts`). **NON pushato**: la spinta su un repo condiviso
resta una decisione di Raffaele.

Verifica mirata (file isolato): `Test Files 1 passed (1) — Tests 55 passed (55)`, 5.33s.

⚠️ **Numero che cambia la lettura del fix:** il test FIX 5 impiega **4533 ms anche in
isolamento**, senza alcuna contesa. Il vecchio tetto era 5000 ms → passava con **467 ms
di margine (9%)**. Non era "flaky per sfortuna": era tarato sul filo. Il tetto a 20000 ms
non maschera un blocco — accoglie un test realmente lento, perché fa un `importActual`
del modulo vero.

*Minor differito:* un unit test da 4.5s è comunque un difetto di design (l'import reale
andrebbe evitato, non atteso). Non toccato qui: fuori dallo scope del guardrail.

## Onda di fix + re-review — VERDETTO: mergiabile

6 commit (`b20f591..fab00d4`). Suite **850 passed | 4 skipped**, `tsc` 0 errori,
verificati indipendentemente dal re-reviewer. Tutti e 8 i rilievi ADDRESSED, ciascuno
con una prova **uccidibile**: mutation testing rifatto dal re-reviewer in sandbox
isolata → **16 mutazioni, 15 uccise**.

Prove che contano di più:
- i 3 casi di regressione sul match cartelle diventano rossi se si rimette lo scope
  sbagliato (M1/M1b) → il test di regressione morde davvero
- coerenza `tokenWeights`/`similarityRatio`: **tutti e 5 i call-site** verificati a mano
  (guardrail 128/191/197 via `guardrailTokens`; match cartelle 383/415 via
  `significantTokens` senza opzioni)
- i 10 valori della tabella di documentazione **riprodotti 10 su 10** dal re-reviewer
- il pavimento `> 0.9` ha headroom provato: a soglia 0.72 il test diventa rosso
  (`expected 0.825 to be greater than 0.9`), col vecchio `> 0.2` sarebbe rimasto verde
  fino a sotto il 20%

**Ruling (M3b, unica mutazione sopravvissuta):** parcheggiata, nessun secondo giro di
fix. Il test `COERENZA` copre 3 direzioni su 4: non uccide la divergenza del solo
`rigaTok`. — *Perché:* è una lacuna di COPERTURA, non un difetto del codice spedito;
`guardrailTokens()` rende la divergenza possibile solo bypassando l'helper a mano, e la
skill vieta una seconda onda di fix. — *Costo se sbagliato:* se un domani qualcuno
bypassa l'helper su `rigaTok`, nessun test lo ferma.

**Differite (non bloccanti):** import morto di `significantTokens` in
`foto-archive-tools.ts:19` (pre-esistente) · il flake di `scadenze-tools` sparisce col
merge in `main`, che ha già `1540002`.

## Avanzamento

- **Task 1-5: complete** (commit `4cdd0c7..b20f591`, 5 commit). Verificato da me in modo
  indipendente, non solo dichiarato dall'implementer:
  - file toccati: SOLO `foto-archive-match.ts`, `foto-archive-match.test.ts`,
    `foto-archive-tools.test.ts` (+184 / −10)
  - `foto-archive-tools.ts`: diff VUOTO ✅
  - `SOGLIA_DUPLICATO = 0.6` ✅ · `FUZZY_WEIGHT = 0.7` ✅ · `t.length >= 8 ? 2 : 1` ✅
  - formula ancora `comune / totale`, NON simmetrizzata ✅
  - suite: 837 passati / 4 skipped / 0 falliti · `tsc --noEmit`: 0 errori
- (in corso) review finale whole-branch (opus) + mutation testing (sonnet).

### Il piano era sbagliato sul Task 5 — corretto dall'implementer
Il test come l'avevo scritto misurava **0%**, non 87-92%: `ComuneNuovo${i}Zx` e
`LavoroNuovo${i}Qw` rendono 2 token su 3 MAI VISTI (peso `pesoMai`), quindi la query non
è "un cliente che torna" ma la commessa più distintiva possibile (ratio 0.144).
L'implementer ha misurato 4 costruzioni **anche su `main`** per escludere che fossero i
Task 1-2 a causarlo (identico su main → non è una regressione), ha scartato la
costruzione B perché contaminata (34/40 righe erano duplicati letterali veri), e ha
adottato la costruzione **F**: parole già note al Registro, ma combinazione
comune+committente+lavoro ASSENTE (87 libere su 320). Risultato: **100% bloccate,
rapporto medio 0.733**. La tesi del piano regge ed è semmai sottostimata.

## Review finale (opus) — 2 rilievi di comportamento + 6 su test/documentazione

Metodo del reviewer: sorgenti ricostruiti con `git show b20f591:` (il working tree era
mutato dal mutation testing in corso), port a mano delle funzioni pure in scratchpad,
`editDistanceAtMost` confrontata con un Levenshtein di riferimento su **200.000 coppie
casuali → 0 errori**, early-exit verificati su **300.000 coppie → 0 divergenze**.

**Le due domande difficili: nessun difetto.** La DP è corretta, i bound sono validi
(dimostrato: il minimo di riga non può venire da `cur[j-1]+1`, quindi è non-decrescente
in `i`). La contabilità di `comune` è sana: `comune <= totale` sempre, rapporto in [0,1].

### 🔴 Rilievo 1 — REGRESSIONE DI PRODUZIONE introdotta dai 5 commit
`MATCH_STOPWORDS` alimenta anche `matchNamedFolderScored` (regola (c): overlap >= 2
token significativi → candidato 'debole'). Confermato strutturalmente da me:
`significantTokens` è UNA funzione, usata alle righe 86/149/155 (guardrail) **e**
293/325 (match cartelle). Togliendo 10 parole l'overlap scende sotto 2 e la cartella
sparisce dai candidati → `non_trovata` → **le foto non vengono archiviate**, cioè la
classe di fallimento che il modulo esiste per impedire. Tre casi misurati
(`Rossi Costruzioni`, `Coviello Edile`, `Edilizia Potenza`). **Nessun test lo copriva.**

### 🟠 Rilievo 2 — il fuzzy si applica anche a numeri e comuni
Documentato e testato solo sui cognomi, ma applicato a tutto: `2026`~`2025`, `110`~`100`,
e `Ravello`~`Lavello` (due comuni REALI diversi) porta il rapporto 0.4495 → **0.8349**.
Corollario non documentato: `FUZZY_WEIGHT` (0.7) **>** `SOGLIA_DUPLICATO` (0.6), quindi
una riga con ZERO token identici può bloccare (misurato: esattamente **0.7000**).

### Rilievi 3-6 — convergono col mutation testing
Costanti non pinnate (M9/M12/M13), il test di caratterizzazione con asserzione `> 0.2`
che non scatterebbe mai (100% → 30% resterebbe verde), e due documentazioni che si
contraddicono a 20 righe di distanza.

**Rilievo 8 (accettato, non fixato):** costo della scansione su 500 righe da **2.61 ms a
7.13 ms** (2.7×). — *Ruling:* accettabile a questa scala. — *Costo se sbagliato:* a
Registri molto più grandi andrà rimisurato; la complessità è ora
O(righe × tok_nuovi × tok_riga × len²).

## Mutation testing — 17 mutazioni, 10 uccise, **7 sopravvissute**

Working tree ripristinato e verificato pulito (`git diff` vuoto, suite 87/87 verde).

**Le 3 costanti che il piano dichiarava "misurate e non negoziabili" NON sono pinnate
da nessun test.** È il difetto più grave emerso: chiunque può cambiarle e la suite resta
verde.

| # | Mutazione sopravvissuta | Che cosa resta scoperto |
|---|---|---|
| M9 | `FUZZY_WEIGHT` 0.7 → **0.4** | il valore della calibrazione non è pinnato: i test verificano solo `>= SOGLIA` e `< esatto`, vere per un ampio intervallo di pesi |
| M12 | `t.length >= 8 ? 2 : 1` → sempre **1** | la regola "distanza 2 per token lunghi" non è mai esercitata: `Coviella/Coviello` ha distanza **1**, non discrimina |
| M13 | stessa → sempre **2** | nessun test passa per `similarityRatio` con token CORTO a distanza 2 (il test COSTO NOTO chiama `editDistanceAtMost` diretto) |
| M11 | rimozione del `break` nel ramo fuzzy | nessuno scenario in cui un token nuovo somiglia a DUE token della stessa riga → il doppio conteggio non è coperto |
| M2 | early-exit lunghezza `>` → `>=` | manca il caso limite con differenza di lunghezza ESATTAMENTE `max` |
| M1 | `if (a === b) return true` → `false` | buco di contratto della funzione pura; irraggiungibile via `similarityRatio` (il match esatto è intercettato prima) |
| M3 | rimozione dell'early-exit `minRiga > max` | **mutante equivalente**: è pura ottimizzazione, il risultato del DP è identico |

**Ruling (M3):** parcheggiata, nessun test da scrivere. — *Perché:* è un mutante
equivalente per costruzione, nessun test di comportamento può ucciderlo senza misurare
il tempo. — *Costo se sbagliato:* nessuno; l'early-exit resta non protetto da regressioni
di sola performance.

**Ruling (M1, M2, M9, M11, M12, M13):** entrano tutte nell'onda di fix. — *Perché:* M9,
M12 e M13 lasciano non protetti proprio i tre valori che il piano dichiara vincolanti, e
M11 copre il doppio conteggio. — *Costo se sbagliato:* 6 test in più su codice già verde.

### ⚠️ Discrepanza APERTA, non ancora risolta
Il commento committato nel Task 4 dichiara "**87-92%**"; la misura sul generatore
`scenario` dice **100%**. Sono due popolazioni diverse (il mio harness R×pool 200/20 vs
il generatore del file), quindi non è una contraddizione: è un numero non qualificato.
L'implementer NON l'ha corretto di iniziativa — ha fatto bene a chiedere.
**Ruling:** il commento va qualificato citando ENTRAMBE le popolazioni invece di
asserire un numero solo. — *Perché:* un numero senza la sua popolazione è ciò che ha
prodotto il difetto del Task 5 in primo luogo. — *Costo se sbagliato:* una riga di
commento più lunga. Da applicare nell'onda di fix dopo la review.
- **Ruling (baseline):** la misura della baseline su `main` procede ignorando i 6 file
  *untracked* presenti nel checkout principale (un .docx, due piani in `docs/`, uno
  script in `scripts/`, `bridge/`, `.cigo-work/`). — *Perché:* `vitest.config.ts` ha
  `include: ['src/**/*.test.ts','src/**/*.spec.ts']` e nessuno di quei file sta sotto
  `src/`: non entrano nella raccolta dei test. Il codice tracciato è esattamente
  4cdd0c7. — *Costo se sbagliato:* la baseline sarebbe misurata su un albero non
  identico al commit; escluso dalla verifica del config. Nessun file è stato rimosso.
