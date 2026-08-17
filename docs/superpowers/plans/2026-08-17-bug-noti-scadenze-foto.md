# Chiusura bug noti — scadenze (lettura) e foto (archiviazione)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chiudere i sei bug non-P0 rimasti aperti dopo la notte del 17 ago 2026, più un settimo trovato durante la mappatura (troncamento silenzioso nel cron promemoria).

**Architecture:** Nessuna modifica strutturale. Ogni fix riusa un helper o un pattern **già presente** nel repo — `ilikePattern` + `normalizeKey` per l'identità delle scadenze, il loop `pageToken` per Drive — e ogni troncamento o residuo silenzioso diventa un **campo booleano/numerico esplicito** nel JSON verso l'LLM, mai una frase in prosa (dottrina già stabilita in `scadenze-tools.ts:405-413`: la prosa il modello la ignora).

**Tech Stack:** TypeScript, Next.js App Router, Supabase (PostgREST), googleapis (Drive), vitest.

**Spec:** questo documento (i bug sono già diagnosticati; le evidenze sono citate inline in ogni task).

---

## Global Constraints

- **Test runner:** `npx vitest run src/lib/<file>.test.ts`. Lo script `npm test` è Playwright, **non** vitest — non usarlo. La suite unit completa è `npm run test:unit`.
- **`globals: false`** in `vitest.config.ts` → `describe/it/expect/vi/beforeEach` vanno **importati** esplicitamente da `'vitest'`.
- **Flake noto, non è una regressione:** al primo run a cache Vite fredda, `scadenze-tools.test.ts:620` (`calendar_create_event NON invita piu a duplicare le scadenze`) va in timeout 5s perché fa `vi.importActual('./calendar-tools')` che carica googleapis. Al secondo run passa. Non "aggiustarlo" e non indebolirlo.
- **Il build nei worktree fallisce sempre** (`supabaseUrl is required` = manca `.env.local`). Nei worktree si usano **solo** `npx tsc --noEmit` e `vitest`. Il `next build` si fa dopo il merge su `main`.
- **Typecheck obbligatorio prima di ogni consegna:** `npx tsc --noEmit` deve essere a 0 errori.
- **Prova di non-vacuità obbligatoria** per ogni test scritto: `git stash` del solo codice sorgente lasciando i test, rilanciare, mostrare che diventano ROSSI, `git stash pop`. Un test che non fallisce quando il fix non c'è non protegge niente.
- **Mai indebolire un'asserzione per far passare un test.** Se un test esistente diventa rosso, la causa va capita e corretta, non aggirata.
- **Baseline da preservare:** 758 test, 753 verdi + 4 skipped + 1 flake noto. Nessun test esistente deve diventare rosso.
- **Lingua:** commenti e messaggi utente in italiano, senza accenti nei messaggi di commit (il repo usa `piu`, `gia` nei commit).

## Worktree e branch

Il lavoro è diviso in due corsie **indipendenti** (nessun file in comune), già preparate:

| Corsia | Worktree | Branch | Task |
|---|---|---|---|
| Scadenze | `C:/Progetti claude Code/02.SuperING/cervellone-codex` | `fix/scadenze-lettura` | 1, 2, 3, 4 |
| Foto | `C:/Progetti claude Code/02.SuperING/cervellone-w3` | `fix/foto-archiviazione` | 5, 6, 7 |

Entrambi allineati a `main` = `5594cc8`. `node_modules` già presenti in entrambi.

## File Structure

**Corsia scadenze**
- Modify: `src/lib/scadenze-tools.ts` — `listaScadenze` (filtro categoria + limite), `aggiornaScadenza` (collisione chiave), export di `normalizeKey`.
- Modify: `src/lib/scadenze-tools.test.ts` — estendere `ParsedResult`, aggiungere i test dei task 1, 2, 4.
- Modify: `src/app/api/cron/scadenze/route.ts` — paginazione della select.
- Create: `src/app/api/cron/scadenze/route.test.ts` — non esiste; il pattern per una route cron è in `src/app/api/cron/gmail-crons.dead-token.test.ts`.

**Corsia foto**
- Modify: `src/lib/drive.ts` — `listSubfolders` con paginazione.
- Create: `src/lib/drive.pagination.test.ts` — nuovo file (non esiste `drive.test.ts` generico).
- Modify: `src/lib/foto-archive-tools.ts` — residuo in `archiviaFoto`, coerenza move/DB.
- Create: `src/lib/foto-archive-tools.test.ts` — nuovo file (non esiste).

---

## Task 1: BUG A — `lista_scadenze` non trova le categorie con case diverso

**Il bug:** `src/lib/scadenze-tools.ts:594-595` filtra la categoria con uguaglianza binaria:

```ts
const categoria = cleanString(input.categoria)
if (categoria) query = query.eq('categoria', categoria)
```

`cleanString` (`:66-70`) fa solo strip NUL + `trim()`: nessun lowercase, nessun collasso degli spazi interni. Quindi cercare `'Personale'` **non trova** le righe salvate `'personale'`, e `'attestato  ponteggi'` (doppio spazio) non trova `'attestato ponteggi'`. La riga 592 subito sopra fa già la cosa giusta per il soggetto: `query.ilike('soggetto', ilikePattern(soggetto))`.

**Attenzione — trappola:** il path di **scrittura non lowercasa** la categoria (`parseWriteFields`, `:237`, usa `nullableString` che fa solo trim). Quindi in DB la categoria conserva il case originale e il fix **non** può essere "normalizza in lettura come si fa in scrittura": non esiste normalizzazione in scrittura.

**Il fix (pattern già stabilito nel file):** filtro server-side **sovrainsieme** con `ilike` + selezione esatta in JS con `normalizeKey`, esattamente come fa `marcaSostituite` (`:454-484`). L'`ilike` da solo non basta: `%ponteggi%` prende anche `sub-ponteggi`.

**Files:**
- Modify: `src/lib/scadenze-tools.ts:577-611` (`listaScadenze`), e `:165-174` (esportare `normalizeKey`)
- Modify: `src/lib/scadenze-tools.ts:706` (description del parametro `categoria`)
- Test: `src/lib/scadenze-tools.test.ts`

**Interfaces:**
- Consumes: `ilikePattern(value: string): string` (già esportata, `:198-209`), `normalizeSubject`, `cleanString`.
- Produces: `export function normalizeKey(value: string | null | undefined): string` — resa pubblica, usata anche dal Task 4.

- [ ] **Step 1: Estendere l'interfaccia dei risultati parsati nel file di test**

In `src/lib/scadenze-tools.test.ts`, l'interfaccia `ParsedResult` (`:117-126`) non ha i campi che servono. Aggiungere:

```ts
  count?: number
  scadenze?: { id: string; soggetto: string; categoria: string | null }[]
  troncato?: boolean
  limite?: number
```

- [ ] **Step 2: Scrivere i test falliti (comportamentale + strutturale)**

Aggiungere in `src/lib/scadenze-tools.test.ts`, dentro il `describe` principale. Il mock Supabase del file **non filtra nulla**: registra soltanto le operazioni. Per questo servono **entrambe** le asserzioni — quella comportamentale prova che il filtro JS esiste, quella strutturale che la query server-side è un sovrainsieme e non un `eq`.

```ts
  it('lista_scadenze trova la categoria anche con case diverso (BUG A)', async () => {
    mockHandler = (op) => {
      if (op.op === 'select') {
        return {
          data: [
            { id: 'a', soggetto: 'Mario Rossi', categoria: 'personale', tipo_documento: 'visita medica', data_scadenza: '2027-01-01', reminder_days: 5, recipients: [], drive_file_id: null, drive_url: null, note: null, stato: 'attivo', updated_at: '2026-08-17T00:00:00Z' },
            { id: 'b', soggetto: 'Fiat Ducato', categoria: 'Automezzi', tipo_documento: 'revisione', data_scadenza: '2027-02-01', reminder_days: 5, recipients: [], drive_file_id: null, drive_url: null, note: null, stato: 'attivo', updated_at: '2026-08-17T00:00:00Z' },
          ],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = parse(await executeScadenzeTool('lista_scadenze', { categoria: 'Personale' }))

    expect(res.ok).toBe(true)
    expect(res.count).toBe(1)
    expect(res.scadenze?.[0].id).toBe('a')
  })

  it('lista_scadenze tollera gli spazi interni nella categoria (BUG A)', async () => {
    mockHandler = (op) => {
      if (op.op === 'select') {
        return {
          data: [
            { id: 'a', soggetto: 'Mario Rossi', categoria: 'primo soccorso', tipo_documento: 'attestato', data_scadenza: '2027-01-01', reminder_days: 5, recipients: [], drive_file_id: null, drive_url: null, note: null, stato: 'attivo', updated_at: '2026-08-17T00:00:00Z' },
          ],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = parse(await executeScadenzeTool('lista_scadenze', { categoria: ' Primo  Soccorso ' }))

    expect(res.count).toBe(1)
  })

  it('lista_scadenze filtra la categoria server-side con ilike, non con eq (BUG A)', async () => {
    mockHandler = (op) => (op.op === 'select' ? { data: [], error: null } : { data: null, error: null })

    await executeScadenzeTool('lista_scadenze', { categoria: 'Personale' })

    const select = mockOps.find(op => op.op === 'select')
    expect(select?.filters.find(f => f.method === 'eq' && f.args[0] === 'categoria')).toBeUndefined()
    expect(select?.filters.find(f => f.method === 'ilike' && f.args[0] === 'categoria')?.args[1])
      .toBe(ilikePattern('Personale'))
  })

  it('lista_scadenze non scarta le righe quando la categoria non e richiesta (BUG A - controprova)', async () => {
    mockHandler = (op) => {
      if (op.op === 'select') {
        return {
          data: [
            { id: 'a', soggetto: 'Mario Rossi', categoria: 'personale', tipo_documento: 'visita medica', data_scadenza: '2027-01-01', reminder_days: 5, recipients: [], drive_file_id: null, drive_url: null, note: null, stato: 'attivo', updated_at: '2026-08-17T00:00:00Z' },
            { id: 'b', soggetto: 'Fiat Ducato', categoria: null, tipo_documento: 'revisione', data_scadenza: '2027-02-01', reminder_days: 5, recipients: [], drive_file_id: null, drive_url: null, note: null, stato: 'attivo', updated_at: '2026-08-17T00:00:00Z' },
          ],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = parse(await executeScadenzeTool('lista_scadenze', {}))

    expect(res.count).toBe(2)
  })
```

Verificare che `ilikePattern` sia fra gli import del file di test; se non c'è, aggiungerlo all'import esistente da `'./scadenze-tools'`.

- [ ] **Step 3: Lanciare i test e verificare che falliscano**

Run: `npx vitest run src/lib/scadenze-tools.test.ts`
Expected: il primo test FALLISCE con `count` = 2 invece di 1; il secondo FALLISCE con `count` = 1 solo per caso (il mock non filtra) — se passa già, va comunque tenuto come regressione; il terzo FALLISCE su `toBeUndefined()` perché oggi c'è l'`eq`. Il quarto passa già (controprova).

- [ ] **Step 4: Esportare `normalizeKey`**

In `src/lib/scadenze-tools.ts:171`, cambiare `function normalizeKey(` in `export function normalizeKey(`. Non toccare il corpo né la docstring.

- [ ] **Step 5: Implementare il fix in `listaScadenze`**

Sostituire `src/lib/scadenze-tools.ts:594-595`:

```ts
  const categoria = cleanString(input.categoria)
  if (categoria) query = query.eq('categoria', categoria)
```

con:

```ts
  // Filtro categoria case- e whitespace-insensitive. Stessa dottrina di
  // `marcaSostituite`: ILIKE lato server come SOVRAINSIEME (per non scaricare
  // tutte le righe attive) + selezione esatta in JS con `normalizeKey`, perche
  // `%ponteggi%` da solo prenderebbe anche "sub-ponteggi".
  // NB: il path di scrittura non normalizza il case, quindi in DB convivono
  // 'personale' e 'Personale': il filtro deve tollerarli entrambi.
  const categoria = cleanString(input.categoria)
  if (categoria) query = query.ilike('categoria', ilikePattern(categoria))
```

e nel blocco di uscita (`:602-610`), applicare la selezione esatta prima di `summarize`:

```ts
  const { data, error } = await query
  if (error) return fail(`Errore lista scadenze: ${error.message}`)

  const allRows = (data ?? []) as ScadenzaRow[]
  const categoriaKey = categoria ? normalizeKey(categoria) : null
  const rows = categoriaKey === null
    ? allRows
    : allRows.filter(row => normalizeKey(row.categoria) === categoriaKey)

  return ok({
    today: todayISO(),
    count: rows.length,
    scadenze: rows.map(summarize),
  })
```

- [ ] **Step 6: Aggiornare la description del parametro**

`src/lib/scadenze-tools.ts:706`, da:
```ts
        categoria: { type: 'string', description: 'Filtro categoria esatta.' },
```
a:
```ts
        categoria: { type: 'string', description: 'Filtro categoria, case-insensitive.' },
```

- [ ] **Step 7: Lanciare i test e verificare che passino**

Run: `npx vitest run src/lib/scadenze-tools.test.ts`
Expected: tutti verdi (salvo il flake noto a cache fredda: rilanciare una seconda volta).

- [ ] **Step 8: Prova di non-vacuità**

```bash
git stash push -- src/lib/scadenze-tools.ts
npx vitest run src/lib/scadenze-tools.test.ts
# atteso: i 3 test nuovi del BUG A tornano ROSSI
git stash pop
```
Riportare l'output nel resoconto. Se un test resta verde senza il fix, quel test non protegge niente e va riscritto.

- [ ] **Step 9: Typecheck e commit**

```bash
npx tsc --noEmit
git add src/lib/scadenze-tools.ts src/lib/scadenze-tools.test.ts
git commit -m "fix(scadenze): lista_scadenze trova la categoria anche con case diverso"
```

---

## Task 2: BUG B — `lista_scadenze` tronca in silenzio oltre il row-cap

**Il bug:** in tutto `src/lib/scadenze-tools.ts` non compare **mai** `.limit(`. `listaScadenze` (`:577-611`) esegue una select senza limite: oltre il row-cap di PostgREST (default 1000) la lista è troncata dal server e `count: rows.length` riporta il conteggio **della pagina troncata**. L'LLM lo legge come "sono tutte" e non ha modo di accorgersene.

**Il fix:** limite esplicito + segnale booleano. Il repo ha già la dottrina (`:405-413`): un booleano, non una nota in prosa, perché la prosa il modello la ignora — come `calendar_ok`. Si chiede `LIMITE + 1` righe per sapere se ce n'erano altre, se ne restituiscono `LIMITE`, e si espone `troncato`.

**Files:**
- Modify: `src/lib/scadenze-tools.ts:577-611`
- Modify: `src/lib/scadenze-tools.ts:701` (description del tool)
- Test: `src/lib/scadenze-tools.test.ts`

**Interfaces:**
- Consumes: niente dal Task 1 se non il fatto che il blocco di uscita è già stato riscritto — **questo task va eseguito dopo il Task 1**, sullo stesso blocco.
- Produces: costante modulo `const LISTA_SCADENZE_LIMITE = 200`; output `ok({ today, count, troncato, limite, scadenze })`.

- [ ] **Step 1: Scrivere i test falliti**

```ts
  it('lista_scadenze chiede un limite esplicito al server (BUG B)', async () => {
    mockHandler = (op) => (op.op === 'select' ? { data: [], error: null } : { data: null, error: null })

    await executeScadenzeTool('lista_scadenze', {})

    const select = mockOps.find(op => op.op === 'select')
    expect(select?.filters.find(f => f.method === 'limit')).toBeDefined()
  })

  it('lista_scadenze segnala il troncamento invece di mentire sul conteggio (BUG B)', async () => {
    // 201 righe = LIMITE(200) + 1: il server ne aveva altre.
    mockHandler = (op) => {
      if (op.op === 'select') {
        return {
          data: Array.from({ length: 201 }, (_, i) => ({
            id: `s-${i}`, soggetto: `Soggetto ${i}`, categoria: 'personale',
            tipo_documento: 'attestato', data_scadenza: '2027-01-01', reminder_days: 5,
            recipients: [], drive_file_id: null, drive_url: null, note: null,
            stato: 'attivo', updated_at: '2026-08-17T00:00:00Z',
          })),
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = parse(await executeScadenzeTool('lista_scadenze', {}))

    expect(res.troncato).toBe(true)
    expect(res.limite).toBe(200)
    expect(res.count).toBe(200)
    expect(res.scadenze).toHaveLength(200)
  })

  it('lista_scadenze dichiara troncato:false quando la lista e completa (BUG B)', async () => {
    mockHandler = (op) => {
      if (op.op === 'select') {
        return {
          data: Array.from({ length: 3 }, (_, i) => ({
            id: `s-${i}`, soggetto: `Soggetto ${i}`, categoria: 'personale',
            tipo_documento: 'attestato', data_scadenza: '2027-01-01', reminder_days: 5,
            recipients: [], drive_file_id: null, drive_url: null, note: null,
            stato: 'attivo', updated_at: '2026-08-17T00:00:00Z',
          })),
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = parse(await executeScadenzeTool('lista_scadenze', {}))

    expect(res.troncato).toBe(false)
    expect(res.count).toBe(3)
  })
```

- [ ] **Step 2: Lanciare i test e verificare che falliscano**

Run: `npx vitest run src/lib/scadenze-tools.test.ts`
Expected: FAIL — `limit` non è fra i filters; `res.troncato` è `undefined`, non `true`/`false`.

- [ ] **Step 3: Implementare il fix**

Aggiungere la costante vicino alle altre costanti di modulo in cima al file:

```ts
/**
 * Tetto esplicito per `lista_scadenze`. Senza `.limit()` il troncamento lo fa
 * PostgREST al suo row-cap e nessuno se ne accorge: `count` riporterebbe il
 * numero della pagina troncata e il modello lo leggerebbe come "sono tutte".
 * Si chiede LIMITE+1 riga solo per sapere se ce n'erano altre.
 */
const LISTA_SCADENZE_LIMITE = 200
```

Aggiungere `.limit(LISTA_SCADENZE_LIMITE + 1)` alla catena di query (`:581-585`), dopo l'`.order(...)`:

```ts
    .order('data_scadenza', { ascending: true })
    .limit(LISTA_SCADENZE_LIMITE + 1)
```

E nel blocco di uscita, dopo il filtro categoria del Task 1:

```ts
  const troncato = rows.length > LISTA_SCADENZE_LIMITE
  const visibili = troncato ? rows.slice(0, LISTA_SCADENZE_LIMITE) : rows

  return ok({
    today: todayISO(),
    count: visibili.length,
    troncato,
    limite: LISTA_SCADENZE_LIMITE,
    scadenze: visibili.map(summarize),
  })
```

- [ ] **Step 4: Dichiarare il campo nella description del tool**

`src/lib/scadenze-tools.ts:701`, in coda alla description di `lista_scadenze`, aggiungere:

```
Se `troncato` e true la lista NON e completa (fermata a `limite` righe): restringi con soggetto/categoria/entro_giorni invece di rispondere come se fossero tutte.
```

- [ ] **Step 5: Lanciare i test e verificare che passino**

Run: `npx vitest run src/lib/scadenze-tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Prova di non-vacuità**

```bash
git stash push -- src/lib/scadenze-tools.ts
npx vitest run src/lib/scadenze-tools.test.ts
# atteso: i 3 test nuovi del BUG B tornano ROSSI
git stash pop
```

- [ ] **Step 7: Typecheck e commit**

```bash
npx tsc --noEmit
git add src/lib/scadenze-tools.ts src/lib/scadenze-tools.test.ts
git commit -m "fix(scadenze): lista_scadenze dichiara il troncamento invece di mentire sul conteggio"
```

---

## Task 3: BUG B-bis — il cron promemoria tronca in silenzio (trovato in mappatura)

**Il bug:** `src/app/api/cron/scadenze/route.ts:170-175` ha lo stesso difetto di `lista_scadenze`, in un posto peggiore:

```ts
    const { data, error } = await supabase
      .from('cervellone_scadenze')
      .select('id, soggetto, categoria, tipo_documento, data_scadenza, reminder_days, recipients, drive_url, reminders_sent')
      .eq('stato', 'attivo')
      .gte('data_scadenza', today)
      .order('data_scadenza', { ascending: true })
```

Nessun `.limit()`, nessuna paginazione. Oltre il row-cap le scadenze in coda **non ricevono mai il promemoria** e la risposta JSON riporta `checked: rows.length`, di nuovo il conteggio troncato.

**Gravità reale: bassa oggi, alta domani.** L'ordinamento è per data crescente, quindi il troncamento colpisce le scadenze **più lontane** — che non sono ancora in finestra di promemoria. Diventa un danno vero quando il volume cresce. Il costo del fix è però quasi zero, e lasciare un troncamento silenzioso in un cron è esattamente il tipo di bug che si scopre tardi.

**Il fix:** paginare con `.range()` finché il server restituisce pagine piene. Qui la paginazione è preferibile al limite+avviso del Task 2, perché nessun umano legge l'output del cron: non basta segnalare, bisogna processarle tutte.

**Files:**
- Modify: `src/app/api/cron/scadenze/route.ts:169-182`
- Test: `src/app/api/cron/scadenze/route.test.ts` (verificare se esiste; se non esiste, crearlo)

- [ ] **Step 1: Scrivere il test fallito**

Non esiste un test per questa route, ma il pattern per testare una route cron c'è già: `src/app/api/cron/gmail-crons.dead-token.test.ts` (autenticazione finta via header `authorization`, mock di `@/lib/supabase` con factory). Creare `src/app/api/cron/scadenze/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

// Range richiesti dal codice sotto test, nell'ordine.
const rangeCalls: Array<[number, number]> = []
// Pagine che il "server" restituisce.
let pagine: unknown[][] = []

function makeBuilder() {
  let ranged = false
  const builder: Record<string, unknown> = {}
  const self = () => builder
  for (const m of ['select', 'eq', 'gte', 'order']) builder[m] = self
  builder.range = (from: number, to: number) => {
    rangeCalls.push([from, to])
    ranged = true
    return builder
  }
  builder.then = (resolve: (v: unknown) => void) => {
    // Senza .range() si simula il row-cap di PostgREST: solo la prima pagina.
    const idx = ranged ? rangeCalls.length - 1 : 0
    return Promise.resolve({ data: pagine[idx] ?? [], error: null }).then(resolve)
  }
  return builder
}

vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => makeBuilder() },
}))

vi.mock('@/v19/tools/email/send-email', () => ({
  sendEmailInternal: vi.fn(async () => ({ ok: true, messageId: 'x' })),
}))

function cronRequest(): NextRequest {
  return {
    headers: { get: (name: string) => (name === 'authorization' ? `Bearer ${process.env.CRON_SECRET}` : null) },
  } as unknown as NextRequest
}

// Scadenze lontane: nessun promemoria parte, il test guarda solo la lettura.
function riga(i: number) {
  return {
    id: `s-${i}`, soggetto: `Soggetto ${i}`, categoria: 'personale',
    tipo_documento: 'attestato', data_scadenza: '2030-01-01', reminder_days: 5,
    recipients: [], drive_url: null, reminders_sent: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  rangeCalls.length = 0
  process.env.CRON_SECRET = 'test-secret'
})

describe('cron scadenze', () => {
  it('pagina le scadenze invece di fermarsi alla prima pagina', async () => {
    pagine = [
      Array.from({ length: 500 }, (_, i) => riga(i)),        // pagina piena
      Array.from({ length: 200 }, (_, i) => riga(500 + i)),  // pagina parziale -> stop
    ]

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(body.ok).toBe(true)
    expect(rangeCalls).toEqual([[0, 499], [500, 999]])
    expect(body.checked).toBe(700)
  })

  it('si ferma alla prima pagina quando non e piena (controprova)', async () => {
    pagine = [Array.from({ length: 3 }, (_, i) => riga(i))]

    const { GET } = await import('./route')
    const res = await GET(cronRequest())
    const body = await res.json()

    expect(rangeCalls).toEqual([[0, 499]])
    expect(body.checked).toBe(3)
  })
})
```

Se `vitest.config.ts` non include già `src/app/**`, verificarlo: l'`include` è `src/**/*.test.ts`, quindi la route è coperta.

- [ ] **Step 2: Lanciare il test e verificare che fallisca**

Run: `npx vitest run src/app/api/cron/scadenze/route.test.ts`
Expected: FAIL — `rangeCalls` è `[]` (oggi `.range()` non viene mai chiamato) e `body.checked` è 500 invece di 700.

- [ ] **Step 3: Implementare la paginazione**

```ts
    // PostgREST tronca al suo row-cap senza dirlo: senza paginare, oltre il cap
    // le scadenze piu lontane non riceverebbero MAI il promemoria e il JSON di
    // risposta riporterebbe il conteggio della pagina troncata come se fosse
    // il totale. Nessun umano legge l'output del cron: qui non basta segnalare
    // il troncamento, vanno processate tutte.
    const PAGINA = 500
    const rows: ScadenzaRow[] = []
    for (let offset = 0; ; offset += PAGINA) {
      const { data, error } = await supabase
        .from('cervellone_scadenze')
        .select('id, soggetto, categoria, tipo_documento, data_scadenza, reminder_days, recipients, drive_url, reminders_sent')
        .eq('stato', 'attivo')
        .gte('data_scadenza', today)
        .order('data_scadenza', { ascending: true })
        .range(offset, offset + PAGINA - 1)

      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
      }

      const page = (data ?? []) as ScadenzaRow[]
      rows.push(...page)
      if (page.length < PAGINA) break
    }
```

Rimuovere la vecchia `const rows = (data ?? []) as ScadenzaRow[]` (`:181`) e adattare il codice a valle che usa `rows`. Attenzione: la vecchia gestione dell'errore (`:177-179`) è ora **dentro** il loop — non lasciarne due copie.

- [ ] **Step 4: Lanciare il test e verificare che passi**

Run: `npx vitest run src/app/api/cron/scadenze/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Prova di non-vacuità**

```bash
git stash push -- src/app/api/cron/scadenze/route.ts
npx vitest run src/app/api/cron/scadenze/route.test.ts
# atteso: ROSSO
git stash pop
```

- [ ] **Step 6: Typecheck e commit**

```bash
npx tsc --noEmit
git add src/app/api/cron/scadenze/
git commit -m "fix(cron): pagina le scadenze, oltre il row-cap i promemoria non partivano"
```

---

## Task 4: BUG C — `aggiornaScadenza` crea due righe attive con la stessa chiave

**Il bug:** `src/lib/scadenze-tools.ts:613-635` fa **un solo UPDATE per id**, nessuna SELECT delle righe con la nuova chiave, nessuna chiamata a `marcaSostituite`:

```ts
  const { data, error } = await supabase
    .from('cervellone_scadenze')
    .update(fields)
    .eq('id', id)
    .select('...')
    .maybeSingle()
```

`parseWriteFields(input, true)` (`:227-271`) accetta e passa `soggetto`, `categoria`, `tipo_documento` — cioè **le tre componenti della chiave di identità**. Quindi portando una riga alla stessa terna di una riga già attiva si ottengono due righe attive con chiave identica: lo stato che `registraScadenzaCore` è progettato per non produrre (due promemoria dal cron, due eventi in agenda). Simmetricamente, cambiare la chiave **scollega** la riga dai rinnovi futuri.

L'unica difesa attuale è una nota in prosa rivolta all'LLM (`:715`) — proprio la forma che il repo ha già dichiarato inefficace.

**DECISIONE DI DESIGN (vincolante per questo task): rilevare e avvisare, MAI cancellare.**

L'istinto sarebbe chiamare `marcaSostituite` anche da `aggiornaScadenza`. **Non farlo.** `marcaSostituite` marca `sostituito` — cioè fa sparire righe da `lista_scadenze` e dal cron. Applicarla a un UPDATE significa che correggere un refuso nel soggetto può **cancellare silenziosamente** la scadenza di qualcun altro. È esattamente il P0 introdotto e chiuso la notte del 17 ago (categoria hardcoded → confermare il secondo attestato cancellava il primo), e contraddice la dottrina scritta nel file stesso (`:350-357`): «il caso peggiore e una riga DUPLICATA — visibile e recuperabile — invece di ZERO righe».

Quindi: dopo l'UPDATE, se la chiave è cambiata, cercare le altre righe attive con la nuova chiave e **riportarle** nell'output come `collisione: [id]` + `avviso`, senza toccarle. Due righe attive restano un fastidio visibile, risolvibile con `chiudi_scadenza`.

**Files:**
- Modify: `src/lib/scadenze-tools.ts:613-635` (`aggiornaScadenza`)
- Modify: `src/lib/scadenze-tools.ts:715` (description)
- Test: `src/lib/scadenze-tools.test.ts`

**Interfaces:**
- Consumes: `normalizeKey` (esportata al Task 1), `ilikePattern` (`:198-209`), `ScadenzaRow`, `ok`, `fail`.
- Produces: output `ok({ scadenza, collisione?: string[], avviso?: string })`.

- [ ] **Step 1: Estendere `ParsedResult` nel file di test**

Aggiungere:
```ts
  collisione?: string[]
  avviso?: string
```

- [ ] **Step 2: Scrivere i test falliti**

Non esiste **nessun** test che invochi `aggiorna_scadenza`: si parte da zero.

```ts
  it('aggiorna_scadenza segnala la collisione quando il cambio di chiave duplica una scadenza attiva (BUG C)', async () => {
    mockHandler = (op) => {
      if (op.op === 'update') {
        return {
          data: { id: 'target', soggetto: 'Mario Rossi', categoria: 'ponteggi', tipo_documento: 'attestato formazione', data_scadenza: '2029-03-01', reminder_days: 5, recipients: [], drive_file_id: null, drive_url: null, note: null, stato: 'attivo', updated_at: '2026-08-17T00:00:00Z' },
          error: null,
        }
      }
      if (op.op === 'select') {
        // la riga che ha GIA quella chiave
        return {
          data: [{ id: 'gia-esistente', soggetto: 'Mario Rossi', tipo_documento: 'attestato formazione', categoria: 'Ponteggi' }],
          error: null,
        }
      }
      return { data: null, error: null }
    }

    const res = parse(await executeScadenzeTool('aggiorna_scadenza', { id: 'target', categoria: 'ponteggi' }))

    expect(res.ok).toBe(true)
    expect(res.collisione).toEqual(['gia-esistente'])
    expect(res.avviso).toBeDefined()
  })

  it('aggiorna_scadenza NON marca sostituito nessuno: la collisione si segnala, non si cancella (BUG C)', async () => {
    mockHandler = (op) => {
      if (op.op === 'update') {
        return {
          data: { id: 'target', soggetto: 'Mario Rossi', categoria: 'ponteggi', tipo_documento: 'attestato formazione', data_scadenza: '2029-03-01', reminder_days: 5, recipients: [], drive_file_id: null, drive_url: null, note: null, stato: 'attivo', updated_at: '2026-08-17T00:00:00Z' },
          error: null,
        }
      }
      if (op.op === 'select') {
        return { data: [{ id: 'gia-esistente', soggetto: 'Mario Rossi', tipo_documento: 'attestato formazione', categoria: 'Ponteggi' }], error: null }
      }
      return { data: null, error: null }
    }

    await executeScadenzeTool('aggiorna_scadenza', { id: 'target', categoria: 'ponteggi' })

    // nessun UPDATE con stato:'sostituito' deve essere partito
    expect(sostituzioneOps()).toHaveLength(0)
  })

  it('aggiorna_scadenza non cerca collisioni quando la chiave non cambia (BUG C - controprova)', async () => {
    mockHandler = (op) => {
      if (op.op === 'update') {
        return {
          data: { id: 'target', soggetto: 'Mario Rossi', categoria: 'ponteggi', tipo_documento: 'attestato formazione', data_scadenza: '2030-01-01', reminder_days: 5, recipients: [], drive_file_id: null, drive_url: null, note: null, stato: 'attivo', updated_at: '2026-08-17T00:00:00Z' },
          error: null,
        }
      }
      return { data: [], error: null }
    }

    const res = parse(await executeScadenzeTool('aggiorna_scadenza', { id: 'target', data_scadenza: '2030-01-01' }))

    expect(res.ok).toBe(true)
    expect(res.collisione).toBeUndefined()
    // nessuna SELECT indipendente di ricerca chiave
    expect(mockOps.filter(op => op.op === 'select')).toHaveLength(0)
  })

  it('aggiorna_scadenza resta ok quando la nuova chiave e libera (BUG C)', async () => {
    mockHandler = (op) => {
      if (op.op === 'update') {
        return {
          data: { id: 'target', soggetto: 'Mario Rossi', categoria: 'antincendio', tipo_documento: 'attestato formazione', data_scadenza: '2029-03-01', reminder_days: 5, recipients: [], drive_file_id: null, drive_url: null, note: null, stato: 'attivo', updated_at: '2026-08-17T00:00:00Z' },
          error: null,
        }
      }
      if (op.op === 'select') return { data: [], error: null }
      return { data: null, error: null }
    }

    const res = parse(await executeScadenzeTool('aggiorna_scadenza', { id: 'target', categoria: 'antincendio' }))

    expect(res.ok).toBe(true)
    expect(res.collisione).toBeUndefined()
  })
```

Nota: `sostituzioneOps()` è l'helper già presente nel file di test (`:138-143`).

- [ ] **Step 3: Lanciare i test e verificare che falliscano**

Run: `npx vitest run src/lib/scadenze-tools.test.ts`
Expected: FAIL — `res.collisione` è `undefined` (il primo e il quarto test), nessuna SELECT parte oggi.

- [ ] **Step 4: Implementare il fix**

Aggiungere sopra `aggiornaScadenza` la funzione di rilevamento:

```ts
/**
 * Cerca ALTRE righe attive che, dopo un aggiornamento, avrebbero la stessa
 * chiave di identita della riga appena modificata.
 *
 * NON marca nulla: si limita a riportare gli id. E deliberato. `marcaSostituite`
 * fa sparire righe da lista_scadenze e dal cron: applicarla a un UPDATE
 * significherebbe che correggere un refuso nel soggetto puo cancellare in
 * silenzio la scadenza di qualcun altro. Vale qui la stessa regola dell'INSERT
 * (vedi il commento sull'ORDINE VOLUTO): una riga duplicata e un fastidio
 * visibile e recuperabile con chiudi_scadenza, zero righe no.
 */
async function trovaCollisioniChiave(opts: {
  id: string
  soggetto: string
  tipoDocumento: string | null
  categoria: string | null
}): Promise<string[]> {
  let query = supabase
    .from('cervellone_scadenze')
    .select('id, soggetto, tipo_documento, categoria')
    .eq('stato', 'attivo')
    .neq('id', opts.id)
    .ilike('soggetto', ilikePattern(opts.soggetto))

  query = opts.tipoDocumento === null
    ? query.is('tipo_documento', null)
    : query.ilike('tipo_documento', ilikePattern(opts.tipoDocumento))

  const { data, error } = await query
  if (error) return []

  const soggettoKey = normalizeKey(opts.soggetto)
  const tipoKey = normalizeKey(opts.tipoDocumento)
  const categoriaKey = normalizeKey(opts.categoria)

  return ((data ?? []) as Pick<ScadenzaRow, 'id' | 'soggetto' | 'tipo_documento' | 'categoria'>[])
    .filter(row =>
      row.id !== opts.id &&
      normalizeKey(row.soggetto) === soggettoKey &&
      normalizeKey(row.tipo_documento) === tipoKey &&
      normalizeKey(row.categoria) === categoriaKey,
    )
    .map(row => row.id)
}
```

In `aggiornaScadenza`, dopo `if (!data) return fail('Scadenza non trovata.', { id })`, sostituire il `return ok({ scadenza: summarize(data as ScadenzaRow) })` con:

```ts
  const aggiornata = data as ScadenzaRow

  // La chiave di identita e soggetto+tipo_documento+categoria: se l'update ne
  // ha toccata anche solo una, la riga puo essere finita addosso a un'altra
  // scadenza attiva. Si controlla SOLO in quel caso: aggiornare data o note
  // non deve costare una query in piu.
  const chiaveToccata = 'soggetto' in fields || 'tipo_documento' in fields || 'categoria' in fields
  const collisione = chiaveToccata
    ? await trovaCollisioniChiave({
        id: aggiornata.id,
        soggetto: aggiornata.soggetto,
        tipoDocumento: aggiornata.tipo_documento ?? null,
        categoria: aggiornata.categoria ?? null,
      })
    : []

  if (collisione.length > 0) {
    return ok({
      scadenza: summarize(aggiornata),
      collisione,
      avviso: `Attenzione: ora ci sono ${collisione.length + 1} scadenze attive con la stessa chiave (stesso soggetto, tipo documento e categoria). Il cron mandera un promemoria per ciascuna. Chiudi quella di troppo con chiudi_scadenza.`,
    })
  }

  return ok({ scadenza: summarize(aggiornata) })
```

- [ ] **Step 5: Aggiornare la description del tool**

`src/lib/scadenze-tools.ts:715`, sostituire la nota esistente con:

```
NB: soggetto/tipo_documento/categoria sono la chiave di identita della scadenza — cambiarli qui la scollega dai rinnovi futuri. Se dopo l'aggiornamento torna `collisione`, ci sono piu scadenze attive identiche: riportalo all'utente e proponi chiudi_scadenza su quella di troppo.
```

- [ ] **Step 6: Lanciare i test e verificare che passino**

Run: `npx vitest run src/lib/scadenze-tools.test.ts`
Expected: PASS, e nessuno dei 35 test preesistenti rosso.

- [ ] **Step 7: Prova di non-vacuità**

```bash
git stash push -- src/lib/scadenze-tools.ts
npx vitest run src/lib/scadenze-tools.test.ts
# atteso: i 2 test di collisione tornano ROSSI
git stash pop
```

- [ ] **Step 8: Typecheck, suite completa e commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/lib/scadenze-tools.ts src/lib/scadenze-tools.test.ts
git commit -m "fix(scadenze): aggiorna_scadenza segnala le collisioni di chiave invece di crearle in silenzio"
```

---

## Task 5: BUG D — `listSubfolders` tronca a 200 sottocartelle

**Il bug:** `src/lib/drive.ts:287-301`:

```ts
export async function listSubfolders(folderId: string): Promise<Array<{ id: string; name: string }>> {
  const drive = await getDrive()
  const res = await drive.files.list({
    q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    orderBy: 'name',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  return (res.data.files || [])
    .filter((f): f is { id: string; name: string } => Boolean(f.id && f.name))
    .map(f => ({ id: f.id, name: f.name }))
}
```

Due difetti nella stessa chiamata: `fields` **non chiede** `nextPageToken` (quindi l'API non lo restituirebbe nemmeno) e non c'è loop su `pageToken`. Con `orderBy: 'name'` il troncamento è **deterministico e silenzioso**: oltre 200 sottocartelle spariscono tutte quelle alfabeticamente dopo la 200ª.

**Il call site che fa il danno** è `src/lib/foto-archive-tools.ts:228` — `listSubfolders(rootId)` su `CANTIERI_ATTIVI`: la commessa oltre la 200ª non è nell'elenco → `matchNamedFolderScored` non trova nulla → `fail({ stato: 'non_trovata' })` (`:231`). La foto resta in attesa o l'utente crea una commessa duplicata. Altri call site: `:107` (BFS `findFotoFolderDeep`), `:256`, `:269`.

**Nel repo non esiste alcun pattern di paginazione Drive** (grep `nextPageToken|pageToken` → zero risultati): va scritto, non riusato.

**Files:**
- Modify: `src/lib/drive.ts:287-301`
- Create: `src/lib/drive.pagination.test.ts`

**Interfaces:**
- Produces: `listSubfolders` invariata nella firma — solo il comportamento cambia. Nessun consumatore va toccato.

- [ ] **Step 1: Scrivere il test fallito**

Nuovo file `src/lib/drive.pagination.test.ts`. Il pattern di mocking è quello di `src/lib/drive.dead-token.test.ts` (unico test che monta `drive.ts` vero con `googleapis` mockato):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetAuthorizedClient = vi.fn()

vi.mock('./google-oauth', () => ({
  getAuthorizedClient: mockGetAuthorizedClient,
}))

const GoogleAuthCtor = vi.fn()
const driveFactory = vi.fn()
const sheetsFactory = vi.fn()

vi.mock('googleapis', () => ({
  google: {
    auth: { GoogleAuth: GoogleAuthCtor },
    drive: driveFactory,
    sheets: sheetsFactory,
  },
}))

vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: async () => ({ data: [], error: null }) }) }),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  process.env.GOOGLE_SERVICE_ACCOUNT_KEY = '{}'
  // null => niente OAuth, si cade sul service account mockato senza log d'errore
  mockGetAuthorizedClient.mockResolvedValue(null)
})

describe('listSubfolders', () => {
  it('segue nextPageToken invece di fermarsi alla prima pagina (BUG D)', async () => {
    const pagina1 = Array.from({ length: 200 }, (_, i) => ({
      id: `f${i}`, name: `Commessa ${String(i).padStart(3, '0')}`,
    }))
    const mockList = vi.fn()
      .mockResolvedValueOnce({ data: { files: pagina1, nextPageToken: 'TK2' } })
      .mockResolvedValueOnce({ data: { files: [{ id: 'f200', name: 'ZZZ Commessa 2026-201' }] } })
    driveFactory.mockReturnValue({ files: { list: mockList } })

    const { listSubfolders } = await import('./drive')
    const result = await listSubfolders('root-id')

    expect(mockList.mock.calls[0][0].fields).toContain('nextPageToken')
    expect(mockList).toHaveBeenCalledTimes(2)
    expect(mockList.mock.calls[1][0].pageToken).toBe('TK2')
    expect(result).toHaveLength(201)
    expect(result.map(f => f.name)).toContain('ZZZ Commessa 2026-201')
  })

  it('si ferma quando non c'e nextPageToken (BUG D - controprova)', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: { files: [{ id: 'f1', name: 'Commessa A' }] },
    })
    driveFactory.mockReturnValue({ files: { list: mockList } })

    const { listSubfolders } = await import('./drive')
    const result = await listSubfolders('root-id')

    expect(mockList).toHaveBeenCalledTimes(1)
    expect(result).toHaveLength(1)
  })
})
```

Attenzione all'apostrofo in `'si ferma quando non c'e nextPageToken'`: usare doppi apici per quella stringa.

- [ ] **Step 2: Lanciare il test e verificare che fallisca**

Run: `npx vitest run src/lib/drive.pagination.test.ts`
Expected: FAIL — `fields` è `'files(id, name)'` e non contiene `nextPageToken`; `mockList` chiamato 1 volta invece di 2; `result` ha 200 elementi invece di 201.

- [ ] **Step 3: Implementare la paginazione**

```ts
// Elenca SOLO le sottocartelle dirette di una cartella (ritorno strutturato).
// PAGINATA: `files.list` tronca alla pageSize senza dirlo e con orderBy:'name'
// il taglio e deterministico — oltre la 200esima sparivano tutte le cartelle
// alfabeticamente successive. Effetto reale: una commessa esistente risultava
// 'non_trovata' e la foto finiva in attesa o in una commessa duplicata.
export async function listSubfolders(folderId: string): Promise<Array<{ id: string; name: string }>> {
  const drive = await getDrive()
  const out: Array<{ id: string; name: string }> = []
  let pageToken: string | undefined = undefined
  // Cap di sicurezza: 20 pagine x 200 = 4000 sottocartelle. Oltre, meglio una
  // lista troncata che un loop infinito su un token che non avanza mai.
  const MAX_PAGINE = 20

  for (let pagina = 0; pagina < MAX_PAGINE; pagina++) {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'nextPageToken, files(id, name)',
      orderBy: 'name',
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken ? { pageToken } : {}),
    })

    for (const f of res.data.files || []) {
      if (f.id && f.name) out.push({ id: f.id, name: f.name })
    }

    pageToken = res.data.nextPageToken || undefined
    if (!pageToken) break
  }

  return out
}
```

Se TypeScript si lamenta del tipo di `pageToken` nella `for`, annotare esplicitamente `let pageToken: string | undefined`.

- [ ] **Step 4: Lanciare il test e verificare che passi**

Run: `npx vitest run src/lib/drive.pagination.test.ts`
Expected: PASS.

- [ ] **Step 5: Verificare che nessun test esistente su drive sia rosso**

Run: `npx vitest run src/lib/drive.dead-token.test.ts`
Expected: PASS.

- [ ] **Step 6: Prova di non-vacuità**

```bash
git stash push -- src/lib/drive.ts
npx vitest run src/lib/drive.pagination.test.ts
# atteso: ROSSO
git stash pop
```

- [ ] **Step 7: Typecheck e commit**

```bash
npx tsc --noEmit
git add src/lib/drive.ts src/lib/drive.pagination.test.ts
git commit -m "fix(drive): listSubfolders pagina, oltre 200 cantieri la commessa risultava non trovata"
```

---

## Task 6: BUG E — `archivia_foto` con `gruppo:'ultimo'` dichiara "tutte archiviate"

**Il bug:** in `src/lib/foto-archive-tools.ts`, quando l'utente sceglie `gruppo:'ultimo'` si archivia **solo l'ultimo cluster** (`:409-420`):

```ts
  let rowsToArchive: FotoPendingRow[]
  if (gruppoScelta === 'ultimo') {
    // Solo la raffica più recente (l'ultimo cluster, ordinato per tempo).
    const lastCluster = clusters.length > 0 ? clusters[clusters.length - 1] : []
    rowsToArchive = lastCluster as FotoPendingRow[]
  } else {
    rowsToArchive = recent as FotoPendingRow[]
  }
```

ma il messaggio di esito (`:521-534`) dichiara comunque il totale come se fosse tutto:

```ts
    message: `Tutte le ${spostate} foto spostate e verificate in ${path}.${notaDb}${notaOrfani}`,
```

`totale` è `rowsToArchive.length`, cioè **solo il cluster selezionato**. Le foto dei cluster precedenti sono recenti (<48h), non selezionate, ancora `in_attesa`, e non compaiono da nessuna parte: `notaOrfani` guarda solo `older` (>48h) e `vecchie_non_archiviate` riporta `older.length`. L'utente legge "Tutte le 2 foto spostate", crede di aver finito e non le cerca più.

Aggravante a valle: `src/lib/claude.ts:382-395` (`archiveToolSucceededIn`) considera qualsiasi `"ok":true` di `archivia_foto` come archiviazione riuscita e chiude il flusso.

**DECISIONE DI DESIGN (vincolante): restare `ok: true`, aggiungere il residuo come campo + cambiare il messaggio.**

Le foto selezionate *sono* state archiviate davvero: passare a `ok:false` sarebbe falso e cambierebbe il comportamento del gate in `claude.ts:392`, che è fuori dallo scope di questo task. Il fix è togliere la parola "Tutte" quando non è vero e rendere il residuo un numero esplicito.

**Files:**
- Modify: `src/lib/foto-archive-tools.ts:409-420` (calcolo residuo), `:493-498` (conteggi), `:521-534` (messaggio)
- Create: `src/lib/foto-archive-tools.test.ts`

**Interfaces:**
- Consumes: `executeFotoArchiveTool(name, input, conversationId)` — export pubblico (`:674`). `archiviaFoto` **non è esportata**: il test deve passare da qui.
- Produces: output `ok({..., recenti_non_archiviate: number, message })`.

- [ ] **Step 1: Scrivere il test fallito**

Nuovo file `src/lib/foto-archive-tools.test.ts`. Serve `vi.useFakeTimers()` perché `:358` usa `Date.now()` reale per lo split recenti/vecchie. Due cluster con gap > `DEFAULT_GAP_MS` (3 min), entrambi entro 48h.

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const moveFile = vi.fn(async () => 'File spostato nella nuova cartella')
const listSubfolders = vi.fn()
const getOrCreatePathFolders = vi.fn(async () => 'target-folder')

vi.mock('./drive', () => ({
  DRIVE_FOLDERS: { CANTIERI_ATTIVI: 'root-cantieri', STUDIO_ATTIVI: 'root-studio' },
  SHEETS: { REGISTRO_CANTIERI: 's1', REGISTRO_PROGETTI: 's2' },
  listSubfolders,
  getOrCreatePathFolders,
  moveFile,
  readSheet: vi.fn(async () => []),
  appendSheet: vi.fn(),
  DrivePolicyError: class extends Error {},
}))
```

Il mock Supabase deve supportare sia `select().eq().in().order().limit()` (thenable, usato a `:170-177`) sia `update().eq()` (`:461-472`). Usare il builder chainabile sullo stile di `src/lib/draft-tools.test.ts:5-23`, adattato a `./supabase` e con `in` aggiunto. `moveFile` **deve** restituire una stringa che passa `isMoveSuccess` (`src/lib/foto-archive-match.ts:231-239`: minuscola, non inizia con "errore", contiene `spostato nella nuova cartella`).

Fixture: cluster A = 3 righe a T-60/-59/-58 min, cluster B = 2 righe a T-5/-4 min.

```ts
  it('archivia_foto gruppo:ultimo non dichiara "tutte" quando restano foto recenti (BUG E)', async () => {
    const out = await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Commessa 2026-007', gruppo: 'ultimo', data: '2026-08-17',
    }, 'chat-1')
    const res = JSON.parse(out!)

    expect(res.ok).toBe(true)
    expect(moveFile).toHaveBeenCalledTimes(2)          // la selezione resta corretta
    expect(res.recenti_non_archiviate).toBe(3)         // oggi: undefined
    expect(res.message).not.toMatch(/^Tutte le/)       // oggi: "Tutte le 2 foto..."
    expect(res.message).toContain('3')
  })

  it('archivia_foto gruppo:tutti resta invariato (BUG E - controprova)', async () => {
    const out = await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Commessa 2026-007', gruppo: 'tutti', data: '2026-08-17',
    }, 'chat-1')
    const res = JSON.parse(out!)

    expect(moveFile).toHaveBeenCalledTimes(5)
    expect(res.recenti_non_archiviate).toBe(0)
    expect(res.message).toMatch(/^Tutte le 5/)
  })
```

- [ ] **Step 2: Lanciare il test e verificare che fallisca**

Run: `npx vitest run src/lib/foto-archive-tools.test.ts`
Expected: FAIL — `res.recenti_non_archiviate` è `undefined`; `res.message` inizia con "Tutte le 2".

- [ ] **Step 3: Calcolare il residuo**

In `src/lib/foto-archive-tools.ts`, nel blocco `:409-420`, dopo la selezione:

```ts
  // Foto recenti (<48h) rimaste in attesa perche NON selezionate dal gruppo.
  // Non sono coperte da `notaOrfani`, che guarda solo le >48h: senza questo
  // conteggio il messaggio dichiarava "tutte archiviate" mentre i cluster
  // precedenti restavano in_attesa e l'utente non li cercava piu.
  const recentiNonArchiviate = gruppoScelta === 'ultimo'
    ? clusters.slice(0, -1).reduce((n, c) => n + c.length, 0)
    : 0
```

- [ ] **Step 4: Riportare il residuo nell'esito**

Sostituire il `return ok({...})` di `:527-534`:

```ts
  const notaResidue = recentiNonArchiviate > 0
    ? ` Restano ${recentiNonArchiviate} foto recenti NON archiviate (raffiche precedenti): richiama con gruppo:"tutti" se vanno nella stessa cartella.`
    : ''

  return ok({
    archiviate: spostate,
    errori_move: 0,
    errori_db: erroriDb,
    totale,
    path,
    recenti_non_archiviate: recentiNonArchiviate,
    vecchie_non_archiviate: !includiVecchie ? older.length : 0,
    message: recentiNonArchiviate > 0
      ? `Archiviate ${spostate} foto in ${path}.${notaDb}${notaResidue}${notaOrfani}`
      : `Tutte le ${spostate} foto spostate e verificate in ${path}.${notaDb}${notaOrfani}`,
  })
```

- [ ] **Step 5: Lanciare i test e verificare che passino**

Run: `npx vitest run src/lib/foto-archive-tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Prova di non-vacuità**

```bash
git stash push -- src/lib/foto-archive-tools.ts
npx vitest run src/lib/foto-archive-tools.test.ts
# atteso: ROSSO
git stash pop
```

- [ ] **Step 7: Typecheck e commit**

```bash
npx tsc --noEmit
git add src/lib/foto-archive-tools.ts src/lib/foto-archive-tools.test.ts
git commit -m "fix(foto): gruppo ultimo non dichiara piu tutte archiviate se restano recenti"
```

---

## Task 7: BUG F — la riga foto "strappata" dopo move OK + update DB fallito

**Il bug (confermato live su `main` @ `5594cc8`).** In `src/lib/foto-archive-tools.ts:458-491`, il loop fa `moveFile` e poi l'UPDATE. Se l'UPDATE fallisce, l'errore **non è ignorato: è catturato e deliberatamente scartato**:

```ts
      if (updateError) {
        // File spostato e verificato: contabilizziamo come archiviata di fatto. Lo stato
        // DB è solo disallineato (best-effort: log, non blocchiamo, non marchiamo 'errore').
        erroriDb += 1
        console.error(...)
      }
```

La riga resta `stato = 'in_attesa'`. Ma `OPEN_STATI` (`:50`) include `'in_attesa'` e `fetchOpenPending` (`:170-176`) fa `.in('stato', OPEN_STATI)`: alla successiva `archivia_foto` della stessa chat la riga **rientra nel pool**. `splitRecentOlder` (`:358`) usa `created_at`, mai toccato dall'UPDATE fallito, quindi entro 48h finisce di nuovo in `rowsToArchive` **senza conferma**, e `moveFile(row.drive_file_id, targetId_NUOVO)` **strappa il file dalla commessa giusta**.

**Il codice afferma il contrario di ciò che fa.** Messaggio all'utente (`:500`): `(${erroriDb} foto spostate ma stato non aggiornato — sono GIÀ nella cartella, nessuna azione necessaria)`. È falso: nessuno riconcilierà mai quella riga. Idem il commento `:451-456` («NON è una foto "in attesa": non va riprovata») — è esattamente ciò che il codice poi fa, perché **niente nel DB registra la differenza**.

**Perché `isMoveSuccess` rende il danno certo, non probabile:** `moveFile` (`src/lib/drive.ts:523-562`) è un move "onesto" — rilegge i parent e ritorna successo solo se `confirmedParents.includes(newParentId)` (`:554`). Quindi quando `isMoveSuccess` è true il file **è** verificatamente nella commessa giusta. Non è un dubbio: è una certezza che poi viene buttata via.

**Il fix, SENZA migration (verificato):** `target_folder_id text` esiste già nello schema, nullable e senza CHECK (`supabase/migrations/2026-05-26-cervellone-foto-pending.sql`). Oggi però è scritto **solo dentro lo stesso UPDATE atomico** che setta `stato='archiviata'` (`:465`): se quell'UPDATE fallisce resta `NULL` e non prova nulla. Si separa in **due fasi**:

1. **Prima** del `moveFile`, un UPDATE che scrive solo `{ target_folder_id: targetId }` = dichiarazione d'intento. Se fallisce → **non spostare** (fail-fast: la foto resta onestamente in attesa, che è lo stato vero).
2. Dopo il move OK, il secondo UPDATE porta `stato='archiviata'`. Se fallisce, la riga resta `in_attesa` **ma con `target_folder_id` valorizzato**.
3. All'ingresso del loop, una riga `in_attesa` con `target_folder_id` non nullo è **sospetta già spostata**: si leggono i parent reali su Drive e, se il file è già lì, si **riconcilia il DB senza toccare il file**. Se non è lì, il move non era mai avvenuto e si procede normale.

La verifica su Drive è ciò che rende il fix corretto e non solo plausibile: `target_folder_id` da solo è un'intenzione, non una prova. Serve un `getFileParents` esportato da `drive.ts` — oggi l'unica `files.get({ fields: 'parents' })` è **interna** a `moveFile` (`drive.ts:532`, `:549`).

**BLOCCATO e da NON pianificare:** ogni variante basata su un **nuovo valore di `stato`** (es. `'spostata_db_ko'`) richiede `ALTER TABLE ... DROP/ADD CONSTRAINT` sul CHECK, e ogni **nuova colonna** (`moved_at`, `drive_moved_to`) richiede `ALTER TABLE ... ADD COLUMN`. Non c'è accesso al DB (Supabase MCP non autenticato). Il fix qui pianificato non tocca lo schema.

**Note collaterali emerse (NON in scope, da riportare nel resoconto, non da fixare qui):**
- `:486-489` — l'UPDATE `stato:'errore'` è completamente non controllato (nessun destructuring di `error`).
- Nessun try/catch nel loop: se il client Supabase **lancia** invece di ritornare `{error}`, l'eccezione esce da `archiviaFoto` e `executeTool` (`src/lib/tools.ts:702-708`) non la cattura → batch interrotto a metà.
- `'da_archiviare'` è in `OPEN_STATI` ma **non è mai scritto da nessuna parte**. Rimuoverlo non è un fix, è rumore: lasciarlo stare.

**Files:**
- Modify: `src/lib/drive.ts` — nuovo export `getFileParents`
- Modify: `src/lib/foto-archive-tools.ts:458-491` (loop), `:500` (messaggio `notaDb`)
- Modify: `src/lib/foto-archive-tools.test.ts` (creato al Task 6)

**Interfaces:**
- Consumes: `executeFotoArchiveTool`, il mock Supabase e i mock Drive del Task 6 — **questo task va eseguito dopo il Task 6**, che crea il file di test e la sua impalcatura.
- Produces: `export async function getFileParents(fileId: string): Promise<string[]>` in `drive.ts`.

- [ ] **Step 1: Scrivere il test fallito — il round 2 che strappa il file**

Aggiungere in `src/lib/foto-archive-tools.test.ts`. Due round sulla stessa chat: il round 2 riproduce lo stato reale del DB dopo l'update fallito (riga ancora `in_attesa`, quindi il select la ritorna identica).

```ts
  it('non strappa dalla commessa giusta la foto gia spostata con update DB fallito (BUG F)', async () => {
    // ROUND 1: move OK, update stato fallito -> riga resta in_attesa
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPending], error: null }
      const payload = op.payload as Record<string, unknown> | undefined
      if (op.op === 'update' && payload?.stato === 'archiviata') {
        return { data: null, error: { message: 'PostgREST 503' } }
      }
      return { data: null, error: null }
    }
    getOrCreatePathFolders.mockResolvedValue('target-A')

    const r1 = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Commessa Alfa',
    }, 'chat-1'))!)
    expect(r1.errori_db).toBe(1)
    expect(moveFile).toHaveBeenCalledWith('file-1', 'target-A')

    // ROUND 2: altra commessa, stessa chat. Il file E GIA in target-A su Drive.
    moveFile.mockClear()
    getFileParents.mockResolvedValue(['target-A'])
    getOrCreatePathFolders.mockResolvedValue('target-B')
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPendingConTarget], error: null }
      return { data: null, error: null }
    }

    await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1')

    // OGGI ROSSO: il file viene spostato in target-B, strappato dalla commessa giusta.
    expect(moveFile).not.toHaveBeenCalledWith('file-1', 'target-B')
  })

  it('scrive target_folder_id PRIMA di spostare, cosi un update fallito lascia una traccia (BUG F)', async () => {
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPending], error: null }
      return { data: null, error: null }
    }

    await executeFotoArchiveTool('archivia_foto', { ambito: 'cantiere', nome: 'Commessa Alfa' }, 'chat-1')

    const updates = mockOps.filter(o =>
      o.table === 'cervellone_foto_pending' && o.op === 'update' &&
      o.filters.some(f => f.method === 'eq' && f.args[1] === 'row-1'))
    // OGGI ROSSO: oggi e esattamente 1 (solo quello finale).
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(updates[0].payload).toEqual({ target_folder_id: 'target-A' })
  })

  it('non sposta se non riesce nemmeno a dichiarare l intento (BUG F - fail fast)', async () => {
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPending], error: null }
      const payload = op.payload as Record<string, unknown> | undefined
      if (op.op === 'update' && payload && 'target_folder_id' in payload && !('stato' in payload)) {
        return { data: null, error: { message: 'PostgREST 503' } }
      }
      return { data: null, error: null }
    }

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Commessa Alfa',
    }, 'chat-1'))!)

    expect(moveFile).not.toHaveBeenCalled()
    expect(res.restano_in_attesa).toBe(1)
  })

  it('riprova normalmente se il file NON risulta gia spostato (BUG F - controprova)', async () => {
    // target_folder_id valorizzato ma il file su Drive e altrove: il move non era avvenuto.
    getFileParents.mockResolvedValue(['inbox-telegram'])
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPendingConTarget], error: null }
      return { data: null, error: null }
    }
    getOrCreatePathFolders.mockResolvedValue('target-B')

    await executeFotoArchiveTool('archivia_foto', { ambito: 'cantiere', nome: 'Beta Ristrutturazione' }, 'chat-1')

    expect(moveFile).toHaveBeenCalledWith('file-1', 'target-B')
  })

  it('guardia: move fallito resta un errore onesto (BUG F - anti-regressione)', async () => {
    moveFile.mockResolvedValue('Errore: il file NON risulta spostato nella cartella di destinazione.')
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPending], error: null }
      return { data: null, error: null }
    }

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Commessa Alfa',
    }, 'chat-1'))!)

    expect(res.ok).toBe(false)
    expect(res.restano_in_attesa).toBe(1)
  })
```

Fixture da definire in cima al `describe`:

```ts
  const rigaPending = {
    id: 'row-1', drive_file_id: 'file-1', filename: 'IMG_1.jpg', stato: 'in_attesa',
    created_at: new Date().toISOString(), ambito: null, soggetto: null,
    lavorazione: null, target_folder_id: null,
  }
  const rigaPendingConTarget = { ...rigaPending, target_folder_id: 'target-A' }
```

Aggiungere `getFileParents` ai mock di `./drive` creati al Task 6:
```ts
const getFileParents = vi.fn(async () => [] as string[])
```
e includerlo nella factory `vi.mock('./drive', ...)`.

**Attenzione al select:** `fetchOpenPending` (`:170-176`) fa una `select` con una lista di colonne esplicita — verificare che includa `target_folder_id`, e se non c'è **aggiungerla**, altrimenti il campo arriva `undefined` e la riconciliazione non parte mai. È un punto facile da mancare: controllarlo prima di scrivere l'implementazione.

- [ ] **Step 2: Lanciare i test e verificare che falliscano**

Run: `npx vitest run src/lib/foto-archive-tools.test.ts`
Expected: FAIL — round 2 chiama `moveFile('file-1','target-B')`; gli UPDATE su `row-1` sono esattamente 1; con l'intento fallito il move parte comunque.

- [ ] **Step 3: Esportare `getFileParents` da `drive.ts`**

```ts
/**
 * Parent correnti di un file. Serve a distinguere "foto mai spostata" da "foto
 * gia spostata ma con lo stato DB rimasto indietro": senza questa verifica
 * `target_folder_id` e solo una dichiarazione d'intento, non una prova.
 */
export async function getFileParents(fileId: string): Promise<string[]> {
  const drive = await getDrive()
  const res = await drive.files.get({
    fileId,
    fields: 'parents',
    supportsAllDrives: true,
  })
  return res.data.parents || []
}
```

Metterla vicino a `moveFile` (`drive.ts:523`), che fa già la stessa chiamata internamente.

- [ ] **Step 4: Riconciliare invece di ri-spostare**

In `src/lib/foto-archive-tools.ts`, dentro il loop (`:458`), prima del `moveFile`:

```ts
  for (const row of rowsToArchive) {
    // Una riga ancora aperta ma con target_folder_id valorizzato ha gia avuto un
    // tentativo di archiviazione: il move puo essere riuscito e solo l'update di
    // stato fallito. Prima di rispostarla si guarda dove sta DAVVERO il file —
    // altrimenti la si strappa dalla commessa giusta.
    if (row.target_folder_id) {
      const parents = await getFileParents(row.drive_file_id).catch(() => [] as string[])
      if (parents.includes(row.target_folder_id)) {
        const { error: fixError } = await supabase
          .from('cervellone_foto_pending')
          .update({ stato: 'archiviata', updated_at: new Date().toISOString() })
          .eq('id', row.id)
        if (fixError) { erroriDb += 1 } else { riconciliate += 1 }
        continue
      }
    }

    // Dichiarazione d'intento PRIMA del move: se questa scrittura non passa, non
    // si sposta niente. Meglio una foto onestamente in attesa che un file spostato
    // di cui il DB non conserva traccia.
    const { error: intentError } = await supabase
      .from('cervellone_foto_pending')
      .update({ target_folder_id: targetId })
      .eq('id', row.id)
    if (intentError) {
      erroriMove += 1
      continue
    }

    const moveResult = await moveFile(row.drive_file_id, targetId)
    // ... resto del loop invariato
```

Dichiarare `let riconciliate = 0` insieme agli altri contatori (vicino a `archiviate`/`erroriDb`/`erroriMove`), e togliere `target_folder_id: targetId` dal payload dell'UPDATE finale (`:465`) — ora è già scritto in fase 1.

- [ ] **Step 5: Correggere il messaggio che oggi mente**

`:500`, sostituire `notaDb`:

```ts
  const notaDb = erroriDb > 0
    ? ` (${erroriDb} foto spostate ma stato non aggiornato — sono GIA nella cartella e verranno riconciliate al prossimo tentativo, non verranno rispostate)`
    : ''
```

e aggiungere, se `riconciliate > 0`, una nota `` ` (${riconciliate} gia spostate in precedenza, stato riallineato)` `` più il campo `riconciliate` nel payload di `ok()`.

- [ ] **Step 6: Lanciare i test e verificare che passino**

Run: `npx vitest run src/lib/foto-archive-tools.test.ts`
Expected: PASS, inclusi i test del Task 6.

- [ ] **Step 7: Prova di non-vacuità**

```bash
git stash push -- src/lib/foto-archive-tools.ts src/lib/drive.ts
npx vitest run src/lib/foto-archive-tools.test.ts
# atteso: i test del BUG F tornano ROSSI
git stash pop
```

- [ ] **Step 8: Typecheck, suite completa e commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/lib/drive.ts src/lib/foto-archive-tools.ts src/lib/foto-archive-tools.test.ts
git commit -m "fix(foto): la foto gia spostata viene riconciliata, non strappata dalla commessa giusta"
```

---

## Integrazione

Al termine delle due corsie, **non mergiare subito**:

1. `npx tsc --noEmit` + `npx vitest run` verdi su entrambi i branch.
2. Merge di entrambi su un branch di integrazione, non direttamente su `main`.
3. **Audit avversariale sullo stato MERGIATO**, non sui singoli branch: con più modifiche in parallelo il rischio vero è l'interazione fra fix singolarmente corretti. È così che la notte del 17 ago è saltato fuori il P0 introdotto in giornata.
4. `npm run build` (solo dopo il merge, mai nei worktree) + `npx vitest run` completo.
5. Push, verifica deployment `success` e CI `success` via API GitHub pubbliche.
