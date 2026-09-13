# Decollo, passo 2 — il motore restituisce l'esito, non solo il testo

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development.

**Spec:** `docs/superpowers/specs/2026-09-13-decollo-design.md`, §5.2.

**Goal:** `runAgentTurn` restituisce **anche** com'è andata, non solo cosa ha scritto — così
uno specialista può fallire **onestamente** invece di restituire una stringa troncata che
sembra una risposta.

**Perché viene prima del pilota.** Senza questo, il quinto criterio di riuscita del pilota
(«il cammino del fallimento») **non è nemmeno eseguibile**: non esiste un modo per
distinguere «la contabile ha finito» da «la contabile si è fermata a metà».

---

## Il fatto, verificato

`src/lib/claude.ts:570`:

```ts
export async function runAgentTurn(
  request: ClaudeRequest,
  sink: ChannelSink,
  policy: ChannelPolicy,
): Promise<string> {
```

Restituisce **solo** `fullResponse`. Ma a `claude.ts:1040` il motore calcola:

```ts
const outcome: ModelOutcome = apiErrorOccurred ? … 
```

— che distingue `success | empty | force_text | hallucination | api_error | timeout |
run_aborted` — e lo passa **solo** a `recordOutcome` e `logApiUsage`: telemetria che
nessuno legge. **Il chiamante non lo vede.**

E c'è di peggio, ed è il motivo per cui questo passo è bloccante. `claude.ts:794`: quando il
budget scatta, il motore fa

```ts
await emit('\n\n⚠️ _Mi fermo qui: la richiesta ha superato il budget…_')
```

**sul sink del chiamante.** Oggi l'unico chiamante è il turno vero, quindi quel testo va
dritto a Raffaele. Con uno specialista annidato ci sono solo due esiti, **entrambi
sbagliati**:

- stesso sink → il testo interno dello specialista arriva a Raffaele, e poi il coordinatore
  ci scrive sopra: **due messaggi per un evento**, cioè ciò che la scelta «una sola voce»
  doveva evitare;
- sink muto → quel testo **sparisce**, il chiamante riceve una stringa troncata e **nessun
  segnale di fallimento**. È il difetto peggiore che questo progetto conosce, ricreato
  dentro la difesa.

---

## Cosa cambia

```ts
export interface EsitoTurno {
  testo: string
  outcome: ModelOutcome
  /** Vero se il motore si e' fermato per il tetto di budget o di iterazioni. */
  troncato: boolean
  /** Quanti giri ha fatto: serve al coordinatore per capire se e' valsa la pena. */
  iterazioni: number
  /** I tool chiamati, in ordine. E' `cosa_ho_provato` dello specialista. */
  tool_chiamati: string[]
}

export async function runAgentTurn(…): Promise<EsitoTurno>
```

### ⚠️ Il vincolo che rende questo passo sicuro

**`runAgentTurn` ha chiamanti in produzione** (`callClaudeStream` per il web,
`callClaudeStreamTelegram`, `agent-job`). Il loro comportamento **non deve cambiare di un
carattere**: continuano a ricevere il testo, e lo ricevono da `esito.testo`.

Chi non cambia comportamento **non cambia test**. Se per far passare un test esistente devi
modificarlo, **fermati e riferiscilo**: significa che il comportamento è cambiato davvero, ed
è esattamente ciò che non deve succedere.

`tool_chiamati` si ricava dal ciclo che già esiste (`executeToolBlocks` conosce i nomi), **non
dal testo del modello**. Un modello che racconta cosa ha provato è la stessa autoaccusa che
il 12 set 2026 mi ha fatto contare un difetto che non c'era.

---

### Task 1: l'esito esce dal motore

**Files:** `src/lib/claude.ts`, `src/lib/claude.esito-turno.test.ts` (creare)

- [ ] **Step 1: i test che falliscono**

```ts
it('un turno riuscito restituisce outcome success e il testo di prima', async () => { … })

it('CONTROLLO POSITIVO — un turno fermato dal budget restituisce troncato:true', async () => {
  // e il testo che c'e' fino a li'. Oggi il chiamante non puo' distinguerlo
  // da una risposta completa: e' il difetto che questo passo chiude.
})

it('tool_chiamati viene dal CICLO, non dal testo del modello', async () => {
  // Il modello dice di aver chiamato X ma il ciclo ha chiamato Y:
  // tool_chiamati deve riportare Y.
})

it("i chiamanti di produzione ricevono lo stesso testo di prima", async () => {
  // callClaudeStream, callClaudeStreamTelegram: comportamento invariato.
})
```

- [ ] **Step 2: eseguire, verificare il fallimento**
- [ ] **Step 3: implementare** — `EsitoTurno`, e i tre chiamanti che leggono `esito.testo`
- [ ] **Step 4: suite intera + typecheck.** ⚠️ **Nessun test esistente deve essere modificato.** Se ne modifichi uno, riferiscilo invece di procedere
- [ ] **Step 5: mutazione** — far restituire sempre `outcome: 'success'`: deve morire il controllo positivo sul budget. `cp`, `perl -0pi`, **`grep -c` che provi il morso**, `md5sum` identico dopo il ripristino
- [ ] **Step 6: commit** — `git commit -m "il motore dice anche COM'E' andata, non solo cosa ha scritto"`

---

### Task 2: il sink muto

**Files:** `src/lib/claude.ts` (il tipo `ChannelSink` e il punto `:794`), test

Uno specialista deve poter girare **senza emettere nulla** verso l'utente.

- [ ] **Step 1: il test che fallisce** — con un sink muto, un turno fermato dal budget
  **non** chiama `emit`, **e** restituisce `troncato: true`. Oggi la prima metà è
  impossibile, la seconda pure
- [ ] **Step 2: eseguire, verificare il fallimento**
- [ ] **Step 3: implementare** — `sinkMuto()` esportato, che scarta tutto. Il messaggio di
  cortesia sul budget si emette **solo** se il sink non è muto: chi delega legge
  `troncato`, non una frase scritta per un umano
- [ ] **Step 4: suite + typecheck**, nessun test esistente modificato
- [ ] **Step 5: mutazione** — far emettere comunque il messaggio col sink muto: deve morire il test
- [ ] **Step 6: commit** — `git commit -m "uno specialista lavora in silenzio: la voce che parla all'Ingegnere e' una sola"`
