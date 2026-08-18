# Guardrail anti-duplicato: intervento sui TOKEN, non sulla formula

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development o
> superpowers:executing-plans. Gli step usano checkbox (`- [ ]`).

**Goal:** rendere il guardrail di `prepara_cartella` capace di riconoscere le due
parafrasi con cui i duplicati nascono davvero — la ragione sociale scritta per esteso
e il typo nel cognome — senza toccare né la formula di somiglianza né la soglia.

**Architecture:** l'intervento è interamente dentro `significantTokens` (quali parole
contano) e dentro il ciclo di confronto di `similarityRatio` (come si riconoscono due
token uguali). `SOGLIA_DUPLICATO` resta **0.60** e la formula resta il rapporto pesato
IDF `comune / totNuova`. Nessuna modifica a `foto-archive-tools.ts`.

**Tech Stack:** TypeScript, vitest. Nessuna dipendenza nuova.

**Spec:** questo documento. I numeri vengono da tre misure su registri sintetici
(R ∈ {150,400} × pool committenti ∈ {200,20}) più una verifica avversariale.

## Global Constraints

- `SOGLIA_DUPLICATO` **non si tocca**: resta `0.6`.
- La formula di `similarityRatio` **non si simmetrizza**: il Dice pesato è stato
  misurato e REFUTATO (vedi Task 4). Chi legge un commento che prescrive il Dice sta
  leggendo documentazione superata: va corretta, non eseguita.
- Peso del match approssimato: **esattamente 0.7**. Distanza di edit massima: **1**,
  oppure **2** per token di lunghezza **>= 8**. Sono i valori con cui sono stati
  misurati i risultati: cambiarli invalida la calibrazione.
- Comandi: `npx vitest run <file>` per un file, `npx vitest run` per la suite,
  `npx tsc --noEmit` per il typecheck. **NON** usare `npm test` (è Playwright E2E).
- Nel worktree manca `.env.local`: `npm run build` fallisce con `supabaseUrl is
  required`. NON è una regressione. Qui valgono solo `tsc` e `vitest`.
- Un commit per task, messaggi in italiano.

---

### Task 1: D — le parole generiche di forma societaria non devono pesare al massimo

**Perché:** `Impresa Edile Rossi Società a responsabilità limitata` non fa match con
`Rossi Srl` già nel Registro. NON per colpa di `srl`/`spa`, che sono già stopword e
vengono scartati: colpa di `edile`, `societa`, `responsabilita`, `limitata`, che sono
token MAI VISTI nel Registro, prendono `pesoMai` (il peso massimo) e finiscono solo al
denominatore, affossando il rapporto proprio quando il cognome ha fatto match.

**Misurato:** la variante "ragione sociale per esteso" passa da **0% a 100%** di
riconoscimento in tutte e 4 le celle. Costo: `fpB` (falso positivo su cliente
ricorrente) +4 punti medi, `fpA` (cliente mai visto) −0.7 punti.

**Files:**
- Modify: `src/lib/foto-archive-match.ts` (costante `MATCH_STOPWORDS`, righe 31-38)
- Test: `src/lib/foto-archive-match.test.ts`

**Interfaces:**
- Consuma: `significantTokens`, `tokenWeights`, `similarityRatio` (già esportate)
- Produce: nessuna API nuova. Cambia solo il comportamento di `significantTokens`.

- [ ] **Step 1: scrivi il test che fallisce**

In `src/lib/foto-archive-match.test.ts`, dentro il describe `tokenWeights / similarityRatio`:

```ts
  it('la ragione sociale per esteso resta riconoscibile: le parole generiche non pesano', () => {
    // Il duplicato nasce cosi': la stessa ditta reinserita scrivendo per esteso
    // cio' che la prima volta era un'abbreviazione. Le parole in piu' non
    // identificano NESSUN committente, quindi non devono affossare il rapporto.
    const registro = [...REGISTRO, '2020-005 Venosa Coviello Srl Rifacimento copertura']
    const pesi = tokenWeights(registro)
    const esteso = '2031-001 Venosa Impresa Edile Coviello Societa a responsabilita limitata Rifacimento copertura'
    const r = similarityRatio(esteso, registro[4], pesi, registro.length)
    expect(r).toBeGreaterThanOrEqual(SOGLIA_DUPLICATO)
  })

  it('le parole generiche di forma societaria non sono token significativi', () => {
    const t = significantTokens('Impresa Edile Rossi Societa a responsabilita limitata')
    expect(t).toEqual(['rossi'])
  })
```

- [ ] **Step 2: eseguilo e verifica che FALLISCA**

Run: `npx vitest run src/lib/foto-archive-match.test.ts -t "ragione sociale per esteso"`
Atteso: FAIL — il rapporto è sotto 0.60, e `significantTokens` restituisce anche
`edile`, `societa`, `responsabilita`, `limitata`.

- [ ] **Step 3: implementa**

In `src/lib/foto-archive-match.ts`, aggiungi alla `MATCH_STOPWORDS` esistente le voci
seguenti (NON riscrivere le esistenti, solo aggiungere):

```ts
  // Parole generiche di forma societaria e di settore. Non identificano nessun
  // committente: se restano "token significativi" e non compaiono nel Registro
  // prendono `pesoMai` e affossano il rapporto proprio quando il cognome ha
  // fatto match. Misurato: la ragione sociale per esteso passa da 0% a 100% di
  // riconoscimento. NB: `srl`/`spa`/`sas`/`snc`/`ditta`/`impresa` erano gia'
  // sopra — non erano loro il problema.
  'societa', 'responsabilita', 'limitata', 'azioni', 'individuale',
  'edile', 'edilizia', 'costruzioni', 'generale', 'generali',
```

Nota: `normalizeName` toglie gli accenti prima del confronto, quindi va scritto
`societa`, non `società`.

- [ ] **Step 4: esegui e verifica che passi**

Run: `npx vitest run src/lib/foto-archive-match.test.ts`
Atteso: PASS su tutto il file.

- [ ] **Step 5: commit**

```bash
git add src/lib/foto-archive-match.ts src/lib/foto-archive-match.test.ts
git commit -m "fix(foto): le parole generiche di forma societaria non pesano al massimo"
```

---

### Task 2: B — tolleranza al typo nel cognome

**Perché:** `Coviella` per `Coviello` è un token diverso, l'overlap si perde e il
duplicato passa. È il modo più comune in cui un duplicato nasce, perché chi reinserisce
sta riscrivendo a mano.

**Attenzione — Task 1 da sola PEGGIORA questo caso:** togliendo le parole generiche il
denominatore si accorcia e il cognome sbagliato pesa proporzionalmente di più.
Misurato: il riconoscimento del typo scende da 65.6% a 43.8% con la sola Task 1. Task 2
non è un miglioramento indipendente, è ciò che ripara il danno collaterale di Task 1 e
porta il caso al 100%. **Le due task vanno insieme: non fermarsi dopo la prima.**

**Files:**
- Modify: `src/lib/foto-archive-match.ts` (nuovo helper + ciclo dentro `similarityRatio`)
- Test: `src/lib/foto-archive-match.test.ts`

**Interfaces:**
- Produce: `export function editDistanceAtMost(a: string, b: string, max: number): boolean`
  e `export const FUZZY_WEIGHT = 0.7`. Il Task 3 li usa nei test.

- [ ] **Step 1: scrivi il test che fallisce**

```ts
  it('un typo nel cognome non fa perdere il match, ma vale meno di un match esatto', () => {
    const registro = [...REGISTRO, '2020-005 Venosa Coviello Rifacimento copertura']
    const pesi = tokenWeights(registro)
    const conTypo = similarityRatio('2031-001 Venosa Coviella Rifacimento copertura', registro[4], pesi, registro.length)
    const esatto = similarityRatio('2031-001 Venosa Coviello Rifacimento copertura', registro[4], pesi, registro.length)
    expect(conTypo).toBeGreaterThanOrEqual(SOGLIA_DUPLICATO)
    // Un match approssimato NON deve essere indistinguibile da uno esatto:
    // se valesse il peso pieno, "quasi uguale" e "uguale" sarebbero la stessa prova.
    expect(conTypo).toBeLessThan(esatto)
  })

  it('editDistanceAtMost: 1 per i token corti, 2 per quelli lunghi', () => {
    expect(editDistanceAtMost('rossi', 'rossa', 1)).toBe(true)
    expect(editDistanceAtMost('rossi', 'rosse', 1)).toBe(true)
    expect(editDistanceAtMost('rossi', 'russo', 1)).toBe(false)
    expect(editDistanceAtMost('coviello', 'coviella', 2)).toBe(true)
    // early-exit sulla differenza di lunghezza
    expect(editDistanceAtMost('abc', 'abcdefgh', 1)).toBe(false)
  })
```

- [ ] **Step 2: eseguilo e verifica che FALLISCA**

Run: `npx vitest run src/lib/foto-archive-match.test.ts -t "typo nel cognome"`
Atteso: FAIL — `editDistanceAtMost` non esiste.

- [ ] **Step 3: implementa**

In `src/lib/foto-archive-match.ts`, PRIMA di `similarityRatio`:

```ts
/**
 * Peso di un match APPROSSIMATO. Non 1.0: se "quasi uguale" valesse quanto
 * "uguale", il guardrail non potrebbe piu' distinguere la prova forte da quella
 * debole. 0.7 e' il valore con cui e' stata misurata la calibrazione.
 */
export const FUZZY_WEIGHT = 0.7

/**
 * true se `a` e `b` distano al piu' `max` edit (Levenshtein).
 * Early-exit sulla differenza di lunghezza: e' il caso piu' frequente.
 */
export function editDistanceAtMost(a: string, b: string, max: number): boolean {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > max) return false
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let minRiga = i
    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + costo)
      cur.push(v)
      if (v < minRiga) minRiga = v
    }
    // Nessuna cella della riga e' entro `max`: nessun percorso potra' rientrarci.
    if (minRiga > max) return false
    prev = cur
  }
  return prev[b.length] <= max
}
```

Poi, DENTRO `similarityRatio`, sostituisci il ciclo esistente

```ts
  for (const t of nuovi) {
    const w = pesi.get(t) ?? pesoMai
    totale += w
    if (rigaTok.has(t)) comune += w
  }
```

con:

```ts
  for (const t of nuovi) {
    const w = pesi.get(t) ?? pesoMai
    totale += w
    if (rigaTok.has(t)) {
      comune += w
      continue
    }
    // Typo: chi reinserisce sta riscrivendo a mano, e `Coviella` per `Coviello`
    // azzerava l'overlap sul token che conta di piu'. Vale FUZZY_WEIGHT, non il
    // peso pieno. Costo noto e misurato: due cognomi DIVERSI ma simili possono
    // collidere — vedi il test di caratterizzazione sui cognomi confondibili.
    const max = t.length >= 8 ? 2 : 1
    for (const r of rigaTok) {
      if (editDistanceAtMost(t, r, max)) {
        comune += w * FUZZY_WEIGHT
        break
      }
    }
  }
```

- [ ] **Step 4: esegui e verifica che passi**

Run: `npx vitest run src/lib/foto-archive-match.test.ts`
Atteso: PASS. Poi `npx vitest run src/lib/foto-archive-tools.test.ts` — atteso PASS.
Se `foto-archive-tools.test.ts` diventa rosso, NON aggiustare il test per farlo passare:
riporta quale test e perché — è un'informazione sul cambio di contratto.

- [ ] **Step 5: commit**

```bash
git add src/lib/foto-archive-match.ts src/lib/foto-archive-match.test.ts
git commit -m "fix(foto): un typo nel cognome non fa piu perdere il duplicato"
```

---

### Task 3: pinnare i costi misurati, invece di scoprirli in produzione

Due costi sono REALI e vanno pinnati da test di CARATTERIZZAZIONE — test che descrivono
un difetto noto, non una virtù. Servono perché il prossimo che tocca il file sappia cosa
sta rompendo.

**Files:**
- Test: `src/lib/foto-archive-match.test.ts`

- [ ] **Step 1: scrivi i test (passano subito: descrivono ciò che il codice fa)**

```ts
  it('COSTO NOTO: due cognomi DIVERSI ma simili possono collidere', () => {
    // Misurato: 6 coppie su 18 di cognomi italiani confondibili superano la
    // soglia contro un cliente DIVERSO (Gallo/Gallu, Conti/Conte, Rizzo/Rizzi,
    // Costa/Cesta, Fontana/Fontano, Barbieri/Barbiero).
    // NON e' tarabile: "typo dello stesso cliente" e "cliente diverso col
    // cognome simile" sono lo STESSO segnale, e nessuna soglia li separa.
    // Accettato consapevolmente: l'esito e' una domanda di conferma in piu',
    // mai una perdita di dati, mentre il falso negativo costa una commessa
    // duplicata sul Drive.
    expect(editDistanceAtMost('conti', 'conte', 1)).toBe(true)
    expect(editDistanceAtMost('rizzo', 'rizzi', 1)).toBe(true)
  })

  it('LIMITE NOTO: le parole di dettaglio in piu nell oggetto restano invisibili', () => {
    // Misurato 0% di riconoscimento in TUTTE le configurazioni provate
    // (baseline e ogni combinazione di interventi sui token). L'unica cura
    // sarebbe simmetrizzare la formula, e il Dice pesato e' stato misurato e
    // REFUTATO: vedi il commento su SOGLIA_DUPLICATO.
    const registro = [...REGISTRO, '2020-005 Venosa Coviello Rifacimento copertura']
    const pesi = tokenWeights(registro)
    const conDettagli = similarityRatio(
      '2031-001 Venosa Coviello Rifacimento copertura con sostituzione lattoneria e pluviali esterni',
      registro[4], pesi, registro.length,
    )
    expect(conDettagli).toBeLessThan(SOGLIA_DUPLICATO)
  })
```

- [ ] **Step 2: eseguili**

Run: `npx vitest run src/lib/foto-archive-match.test.ts`
Atteso: PASS. Se il secondo test FALLISCE (cioè il caso viene ora riconosciuto), NON
cancellarlo: segnalalo — significa che qualcosa ha cambiato il comportamento in meglio e
il limite noto va riscritto, non nascosto.

- [ ] **Step 3: commit**

```bash
git add src/lib/foto-archive-match.test.ts
git commit -m "test(foto): pinna i due costi misurati del guardrail sui token"
```

---

### Task 4: correggere la documentazione che prescrive una cura sbagliata

Oggi il commento su `SOGLIA_DUPLICATO` (righe ~155-176) si chiude con: "La cura per 1 e
2 e la stessa: simmetrizzare (Dice pesato ...) e ricalibrare".
**Quella cura è stata misurata ed è dannosa.** Finché resta scritta lì, la prossima
sessione la implementa in buona fede.

**Files:**
- Modify: `src/lib/foto-archive-match.ts` (commento su `SOGLIA_DUPLICATO`)
- Modify: `src/lib/foto-archive-tools.test.ts:767-786` (commento del test `LIMITE NOTO`)

- [ ] **Step 1: sostituisci il paragrafo finale del commento su SOGLIA_DUPLICATO**

Sostituisci il paragrafo che inizia con "La cura per 1 e 2 e la stessa" con:

```
 * ⛔ LA CURA "DICE PESATO" E' STATA MISURATA E REFUTATA (18 ago 2026).
 * Simmetrizzare con `2*comune / (totNuova + totRiga)` sembra ovvio e non lo e':
 * riapre i falsi positivi sui committenti mai visti, cioe' il difetto che la
 * pesatura IDF esisteva per chiudere. E non e' un problema di taratura — il
 * confronto A PARITA' DI FALSI POSITIVI (curva ROC, non soglia fissa) da' il
 * rapporto attuale vincente o pari in 29 confronti su 30. La causa non e'
 * `pesoMai` (toglierlo peggiora): e' che `totRiga` al denominatore diluisce
 * qualunque penalita'. NON reimplementarla.
 *
 * Cio' che invece ha funzionato, senza toccare ne' formula ne' soglia, e'
 * intervenire sui TOKEN: le parole generiche di forma societaria non pesano
 * piu' al massimo, e un typo nel cognome non azzera piu' l'overlap. I due casi
 * passano da 0%/65% a 100%/100%.
 *
 * ⚠️ RESTA APERTO, ed e' il problema piu' grande: su un Registro realistico
 * (400 righe, ~20 committenti ricorrenti) il guardrail chiede conferma
 * sull'87-92% delle commesse nuove e LEGITTIME di clienti che tornano. E' di
 * nuovo saturo, per una via diversa da quella gia' curata: non il conteggio dei
 * token, ma il fatto che il committente ricorrente da solo porta abbastanza
 * peso. Misurato su registri SINTETICI: prima di intervenire va rifatto sul
 * Registro VERO, dove le righe hanno piu' testo distintivo e il tasso potrebbe
 * essere piu' basso.
```

- [ ] **Step 2: correggi il commento del test LIMITE NOTO in foto-archive-tools.test.ts**

Il test `LIMITE NOTO: la quasi-copia con oggetto diverso oggi NON viene fermata` resta
VERDE (la variante "parole in più" non è curata da nessun intervento). Ma il suo commento
dice: "La cura e' simmetrizzare (Dice pesato) e ricalibrare: [...] Quando sara' fatto
QUESTO TEST DEVE DIVENTARE ROSSO". Sostituisci quelle due frasi con:

```
    // La cura ipotizzata a maggio (simmetrizzare con Dice pesato) e' stata
    // misurata il 18 ago 2026 e REFUTATA: peggiora i falsi positivi sui clienti
    // mai visti e non vince mai a parita' di FP. Questo test quindi NON deve
    // diventare rosso per quella via. Resta un limite noto e accettato.
```

- [ ] **Step 3: verifica che nulla si sia rotto**

Run: `npx vitest run src/lib/foto-archive-match.test.ts src/lib/foto-archive-tools.test.ts`
Atteso: PASS. Run: `npx tsc --noEmit` — atteso 0 errori.

- [ ] **Step 4: commit**

```bash
git add src/lib/foto-archive-match.ts src/lib/foto-archive-tools.test.ts
git commit -m "docs(foto): il Dice pesato e refutato, non e piu la cura da implementare"
```

---

### Task 5: la calibrazione deve misurare anche i clienti che tornano

Il describe `SOGLIA_DUPLICATO — calibrazione` genera registri in cui ogni commessa ha un
committente pescato da 8 cognomi, ma le query "nuove" usano `Studio{i}Xq`, cioè
committenti MAI VISTI. Manca il caso che rompe: la commessa NUOVA e legittima di un
cliente che torna.

**Files:**
- Test: `src/lib/foto-archive-match.test.ts` (describe `SOGLIA_DUPLICATO — calibrazione`)

- [ ] **Step 1: aggiungi il test**

```ts
  it('CARATTERIZZAZIONE: il cliente che torna viene bloccato spesso — limite noto', () => {
    // Una commessa NUOVA e legittima di un committente gia' nel Registro. Il
    // committente da solo porta abbastanza peso da superare la soglia: il
    // guardrail chiede conferma anche quando non c'e' nessun duplicato.
    // Misurato su registri sintetici: 87-92% a 400 righe. Il test NON pretende
    // che sia risolto — pinna il tasso perche' un intervento futuro possa
    // dimostrare di averlo abbassato, invece di dichiararlo.
    const { registro, bloccata } = scenario(400)
    const ricorrenti = registro.slice(0, 40).map((r, i) => {
      const cognome = r.split(' ')[2]
      return `2033-${String(i + 1).padStart(3, '0')} ComuneNuovo${i}Zx ${cognome} LavoroNuovo${i}Qw`
    })
    const bloccate = ricorrenti.filter(bloccata).length / ricorrenti.length
    expect(bloccate).toBeGreaterThan(0.2)
  })
```

- [ ] **Step 2: esegui e riporta il numero vero**

Run: `npx vitest run src/lib/foto-archive-match.test.ts -t "cliente che torna"`
Atteso: PASS. **Riporta nel messaggio di commit il tasso effettivo misurato**: se è molto
diverso dall'87-92% delle misure sintetiche, è un'informazione, non un errore — questa
popolazione ha comuni e lavori inventati per essere distintivi.

- [ ] **Step 3: commit**

```bash
git add src/lib/foto-archive-match.test.ts
git commit -m "test(foto): pinna il tasso di blocco sui clienti ricorrenti"
```

---

## Verifica finale (obbligatoria, non opzionale)

- [ ] `npx vitest run` — suite intera verde (baseline: 830 passati, 4 skipped)
- [ ] `npx tsc --noEmit` — 0 errori
- [ ] Nessuna modifica a `foto-archive-tools.ts` (solo ai suoi test)
- [ ] `SOGLIA_DUPLICATO` è ancora `0.6`
