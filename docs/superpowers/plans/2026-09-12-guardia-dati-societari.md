# Guardia sui dati societari nei documenti — piano di attuazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nessun documento generato da Cervellone può essere consegnato portando i dati societari di una società diversa da quella attiva, senza che l'Ingegnere lo sappia.

**Architecture:** un modulo nuovo (`guardia-societa.ts`) che cerca nel contenuto solo l'insieme **chiuso** delle nostre partite IVA; un secondo modulo nuovo (`salva-documento.ts`) che diventa l'**unica** strada per scrivere il contenuto di un documento, con la guardia dentro; la stessa guardia nei tre imbuti di rendering (PDF, Word da HTML, modelli .docx); le sei intestazioni cablate che diventano dati della societa attiva; e le tre catene che oggi trasformano un guasto in «Restruktura» che imparano a distinguere un'assenza nota da un errore.

**Tech Stack:** TypeScript, Next.js, vitest, Supabase.

**Spec:** `docs/superpowers/specs/2026-09-12-guardia-dati-societari-design.md` — leggerla **prima** di ogni task: contiene il perché delle scelte e i tranelli.

## Global Constraints

- **Equipollenza web ↔ Telegram** (vincolo dichiarato da Raffaele): ogni comportamento nuovo vale identico sui due canali, e serve **un test per canale**. Un motore condiviso NON rende equipollenti i canali: quello che cambia è come il messaggio arriva.
- **Nessun fallback che indovina.** Un errore non può condividere il valore di ritorno di un'assenza nota. Se non sappiamo quale società, il documento **non si genera** e si dichiara il perché.
- **La guardia non deve bloccare il caso normale.** Cerca solo le NOSTRE partite IVA (insieme chiuso, due valori dal registro). La P.IVA del committente non fa scattare niente. *Una guardia che blocca il caso normale è peggio del buco che chiude.*
- **Mai riscrivere una partita IVA a mano.** Unica fonte: `REGISTRO` in `src/lib/societa.ts`.
- **Ogni asserzione «non passa» vuole accanto il controllo positivo** che prova che passerebbe. Un test che non muore quando il codice mente non è un test.
- **I sorgenti sono CRLF.** Le mutazioni di prova si fanno con `cp` + `perl -0pi`, verificando `md5sum` prima e dopo e che le occorrenze siano esattamente 1. Un `sed -i` con pattern `\n` non morde e dà un **falso verde**.
- **Niente `git stash`**: altri agenti possono avere lavoro nell'albero.
- Typecheck (`npx tsc --noEmit`) e suite intera verdi prima di ogni commit.

## Struttura dei file

| File | Responsabilità |
|---|---|
| `src/lib/guardia-societa.ts` | **nuovo** — insieme chiuso delle nostre P.IVA + verdetto sul contenuto |
| `src/lib/salva-documento.ts` | **nuovo** — l'unica strada per scrivere il contenuto di un documento; la guardia sta qui |
| `src/lib/societa-attiva.ts` | `leggiSocietaAttiva` con esito discriminato; `getSocietaAttiva` invariata |
| `src/lib/societa-documenti.ts` | `societaPerDocumento` con esito discriminato, nessun `catch → undefined` |
| `src/lib/pdf-generator.ts` | `societa` obbligatoria, `SOCIETA_PREDEFINITA` eliminata, guardia nei due imbuti HTML |
| `src/v19/render/docx.ts` + `utils.ts` | terzo imbuto: modelli .docx; nessun predefinito Restruktura nel piede |
| `src/lib/tools/studio-tecnico.ts` | tre intestazioni cablate → societa attiva; l'insert su `documents` passa dal modulo nuovo |
| `src/lib/prompts.ts` | riga `Intestazione:` condizionata alla societa attiva |
| `chat/route.ts`, `agent-job.ts`, `artifact-capture.ts`, `draft-tools.ts` | le cinque scritture di contenuto passano da `salva-documento.ts` |
| chiamanti dei render (`tools.ts`, `draft-tools.ts`, `sal-tools.ts`, `document-template-tools.ts`) | passano la societa e dichiarano il rifiuto |

---

### Task 1: il modulo guardia

**Files:**
- Create: `src/lib/guardia-societa.ts`
- Test: `src/lib/guardia-societa.test.ts`

**Interfaces:**
- Consumes: `listaSocieta()`, `type CodiceSocieta` da `./societa`
- Produces:
  ```ts
  export type DatiSocietari = { denominazione: string; piva: string }
  export type EsitoGuardia =
    | { ok: true }
    | { ok: false; trovate: Array<{ piva: string; denominazione: string }>; attesa: DatiSocietari }
  export function pivaNostre(): Map<string, { codice: CodiceSocieta; denominazione: string }>
  export function verificaDatiSocietari(contenuto: string, attesa: DatiSocietari): EsitoGuardia
  export function messaggioBlocco(esito: Extract<EsitoGuardia, { ok: false }>): string
  ```

- [ ] **Step 1: scrivere i test che falliscono**

```ts
import { describe, it, expect } from 'vitest'
import { verificaDatiSocietari, pivaNostre, messaggioBlocco } from './guardia-societa'

const RESTRUKTURA = { denominazione: 'RESTRUKTURA S.r.l.', piva: '02087420762' }
const LAREALESTATE = { denominazione: 'LA REAL ESTATE SRLS', piva: '02232730768' }

describe('pivaNostre', () => {
  it('deriva dal registro, non da valori riscritti a mano', () => {
    const m = pivaNostre()
    expect(m.size).toBe(2)
    expect(m.get('02087420762')?.codice).toBe('restruktura')
    expect(m.get('02232730768')?.codice).toBe('larealestate')
  })
})

describe('verificaDatiSocietari — CONTROLLO NEGATIVO: il caso normale deve passare', () => {
  it('preventivo Restruktura con la P.IVA del COMMITTENTE nel corpo: passa', () => {
    const html = `<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p>
      <div>Committente: Edil Limongi S.r.l. — P.IVA 01234567890</div>`
    expect(verificaDatiSocietari(html, RESTRUKTURA)).toEqual({ ok: true })
  })

  it('documento che non nomina nessuna partita IVA: passa', () => {
    expect(verificaDatiSocietari('<p>Relazione tecnica senza dati fiscali</p>', RESTRUKTURA)).toEqual({ ok: true })
  })

  it('documento La Real Estate con la SUA partita IVA: passa', () => {
    const html = `<h1>LA REAL ESTATE SRLS</h1><p>P.IVA 02232730768</p>`
    expect(verificaDatiSocietari(html, LAREALESTATE)).toEqual({ ok: true })
  })
})

describe('verificaDatiSocietari — CONTROLLO POSITIVO: il caso vero deve mordere', () => {
  it('IL DIFETTO DI OGGI: La Real Estate attiva, intestazione Restruktura cablata', () => {
    const html = `<div class="header"><h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762 — Villa d'Agri (PZ)</p></div>
      <h2>PREVENTIVO N. 1</h2>`
    const esito = verificaDatiSocietari(html, LAREALESTATE)
    expect(esito.ok).toBe(false)
    if (esito.ok) throw new Error('controllo positivo inerte: la guardia non ha morso')
    expect(esito.trovate).toEqual([{ piva: '02087420762', denominazione: 'RESTRUKTURA S.r.l.' }])
    expect(esito.attesa).toEqual(LAREALESTATE)
  })

  it('riconosce la P.IVA anche con prefisso IT', () => {
    const esito = verificaDatiSocietari('<p>IT02087420762</p>', LAREALESTATE)
    expect(esito.ok).toBe(false)
  })

  it('riconosce la P.IVA anche con separatori', () => {
    const esito = verificaDatiSocietari('<p>P.IVA 02.087.420.762</p>', LAREALESTATE)
    expect(esito.ok).toBe(false)
  })

  it('il messaggio di blocco NOMINA le due partite IVA: un rifiuto muto costringe a indovinare', () => {
    const esito = verificaDatiSocietari('<h1>RESTRUKTURA S.r.l.</h1><p>02087420762</p>', LAREALESTATE)
    if (esito.ok) throw new Error('atteso blocco')
    const msg = messaggioBlocco(esito)
    expect(msg).toContain('02087420762')
    expect(msg).toContain('02232730768')
    expect(msg).toContain('LA REAL ESTATE SRLS')
  })
})
```

- [ ] **Step 2: eseguire e verificare che FALLISCANO**

Run: `npx vitest run src/lib/guardia-societa.test.ts`
Expected: FAIL — `Cannot find module './guardia-societa'`

- [ ] **Step 3: implementare**

```ts
/**
 * src/lib/guardia-societa.ts — un documento non esce con i dati di un'altra societa'.
 *
 * Il 12 set 2026 Raffaele ha chiesto: «mi assicuri che non compili un documento
 * sbagliando la partita IVA senza accorgersene?». La risposta onesta e' che il
 * testo lo scrive il modello e nessuna promessa sul modello e' una garanzia.
 * Questa e' la garanzia che si puo' dare invece: un confronto fra stringhe, che
 * non dipende dall'attenzione di nessuno.
 *
 * Cerca SOLO le partite IVA NOSTRE — un insieme CHIUSO, due valori, letti dal
 * registro. Non «ogni partita IVA deve essere quella attiva»: quella regola
 * bloccherebbe ogni preventivo, perche' un preventivo nomina il committente.
 * Una guardia che blocca il caso normale e' peggio del buco che chiude.
 */
import { listaSocieta, type CodiceSocieta } from './societa'

export type DatiSocietari = { denominazione: string; piva: string }

export type EsitoGuardia =
  | { ok: true }
  | { ok: false; trovate: Array<{ piva: string; denominazione: string }>; attesa: DatiSocietari }

/** Le nostre partite IVA, DAL REGISTRO: mai riscritte a mano qui. */
export function pivaNostre(): Map<string, { codice: CodiceSocieta; denominazione: string }> {
  const m = new Map<string, { codice: CodiceSocieta; denominazione: string }>()
  for (const s of listaSocieta()) m.set(s.piva, { codice: s.codice, denominazione: s.denominazione })
  return m
}

/**
 * Normalizza il contenuto alle sole cifre. Serve perche' la stessa partita IVA
 * si scrive `02087420762`, `IT 02087420762`, `02.087.420.762`, e dentro il
 * markup puo' essere spezzata da un tag. Cercare la stringa cosi' com'e'
 * troverebbe il caso facile e mancherebbe gli altri: una guardia che si
 * aggira con un punto non e' una guardia.
 *
 * Costo accettato: undici cifre consecutive che per caso coincidono con una
 * nostra partita IVA producono un blocco dichiarato. Meglio di un documento
 * sbagliato consegnato in silenzio.
 */
function soleCifre(testo: string): string {
  return (testo || '').replace(/\D+/g, '')
}

export function verificaDatiSocietari(contenuto: string, attesa: DatiSocietari): EsitoGuardia {
  const cifre = soleCifre(contenuto)
  const trovate: Array<{ piva: string; denominazione: string }> = []
  for (const [piva, info] of pivaNostre()) {
    if (piva === attesa.piva) continue
    if (cifre.includes(piva)) trovate.push({ piva, denominazione: info.denominazione })
  }
  if (trovate.length === 0) return { ok: true }
  return { ok: false, trovate, attesa }
}

/**
 * Il testo che legge l'Ingegnere. NOMINA le partite IVA: un rifiuto che non
 * dice cosa non torna lo costringe a indovinare, ed e' il difetto che abbiamo
 * chiuso sei volte questa settimana sotto altre forme.
 */
export function messaggioBlocco(esito: Extract<EsitoGuardia, { ok: false }>): string {
  const altre = esito.trovate
    .map((t) => `${t.denominazione} (P.IVA ${t.piva})`)
    .join(', ')
  return [
    `⚠️ DOCUMENTO NON CONSEGNATO — dati societari incoerenti.`,
    ``,
    `La societa' attiva e' ${esito.attesa.denominazione} (P.IVA ${esito.attesa.piva}),`,
    `ma nel documento compare ${altre}.`,
    ``,
    `Non l'ho consegnato: un documento con la partita IVA sbagliata, una volta`,
    `mandato, non si richiama piu'.`,
    ``,
    `Se e' voluto (per esempio l'altra societa' e' il committente), dimmelo e`,
    `lo genero comunque. Se non e' voluto, controlla con imposta_societa_attiva`,
    `quale societa' e' in uso.`,
  ].join('\n')
}
```

- [ ] **Step 4: eseguire e verificare che PASSINO**

Run: `npx vitest run src/lib/guardia-societa.test.ts`
Expected: PASS, tutti

- [ ] **Step 5: provare che i test MUOIONO se il codice mente (mutation testing)**

```bash
cp src/lib/guardia-societa.ts /tmp/g.bak
md5sum src/lib/guardia-societa.ts
# Mutazione: invertire il confronto → la guardia blocca la societa' giusta e lascia passare l'altra
perl -0pi -e 's/\Qif (piva === attesa.piva) continue\E/if (piva !== attesa.piva) continue/' src/lib/guardia-societa.ts
grep -c "piva !== attesa.piva" src/lib/guardia-societa.ts   # deve stampare 1
npx vitest run src/lib/guardia-societa.test.ts              # DEVE FALLIRE
cp /tmp/g.bak src/lib/guardia-societa.ts
md5sum src/lib/guardia-societa.ts                            # deve tornare identico
```
Expected: la suite FALLISCE con la mutazione; md5 identico dopo il ripristino. Se la suite resta verde, i test non misurano: **fermarsi e dirlo**, non proseguire.

- [ ] **Step 6: commit**

```bash
git add src/lib/guardia-societa.ts src/lib/guardia-societa.test.ts
git commit -m "la guardia che impedisce a un documento di uscire con la P.IVA di un'altra societa'"
```

---

### Task 2: `leggiSocietaAttiva` — un guasto non è più «Restruktura»

**Files:**
- Modify: `src/lib/societa-attiva.ts`
- Test: `src/lib/societa-attiva.test.ts` (esistente, aggiungere)

**Interfaces:**
- Produces:
  ```ts
  export type EsitoSocietaAttiva =
    | { ok: true; codice: CodiceSocieta; esplicita: boolean }
    | { ok: false; errore: string }
  export async function leggiSocietaAttiva(conversationId?: string): Promise<EsitoSocietaAttiva>
  ```
- `getSocietaAttiva()` **resta con la firma di oggi e il comportamento di oggi**: i chiamanti in cui indovinare Restruktura non produce un documento (contesto, prompt) non cambiano. Riscrivere `getSocietaAttiva` sopra `leggiSocietaAttiva` va bene solo se il comportamento osservabile resta identico e i test esistenti lo provano.

- [ ] **Step 1: scrivere i test che falliscono**

```ts
describe('leggiSocietaAttiva — un errore NON e\' una societa\'', () => {
  it('nessuna riga: Restruktura, ma dichiarata NON esplicita', async () => {
    // mock: maybeSingle → { data: null, error: null }
    const e = await leggiSocietaAttiva('conv-1')
    expect(e).toEqual({ ok: true, codice: 'restruktura', esplicita: false })
  })

  it('riga presente: la societa\' scelta, esplicita', async () => {
    // mock: maybeSingle → { data: { societa: 'larealestate' }, error: null }
    const e = await leggiSocietaAttiva('conv-1')
    expect(e).toEqual({ ok: true, codice: 'larealestate', esplicita: true })
  })

  it('CONTROLLO POSITIVO — errore dal database: ok:false, NON Restruktura', async () => {
    // mock: maybeSingle → { data: null, error: { message: 'connessione persa' } }
    const e = await leggiSocietaAttiva('conv-1')
    expect(e.ok).toBe(false)
    if (e.ok) throw new Error('un guasto si e\' travestito da societa\': e\' il difetto, non il fix')
    expect(e.errore).toContain('connessione persa')
  })

  it('CONTROLLO POSITIVO — eccezione: ok:false', async () => {
    // mock: maybeSingle → throw
    const e = await leggiSocietaAttiva('conv-1')
    expect(e.ok).toBe(false)
  })

  it('senza conversationId: Restruktura non esplicita (non c\'e\' niente da leggere)', async () => {
    expect(await leggiSocietaAttiva(undefined)).toEqual({ ok: true, codice: 'restruktura', esplicita: false })
  })

  it('codice sconosciuto in riga: Restruktura non esplicita, non un\'azienda fantasma', async () => {
    // mock: maybeSingle → { data: { societa: 'acme' }, error: null }
    const e = await leggiSocietaAttiva('conv-1')
    expect(e).toEqual({ ok: true, codice: 'restruktura', esplicita: false })
  })
})

describe('getSocietaAttiva — comportamento invariato', () => {
  it('su errore restituisce ancora restruktura (i chiamanti di contesto non cambiano)', async () => {
    // mock: error
    expect(await getSocietaAttiva('conv-1')).toBe('restruktura')
  })
})
```

- [ ] **Step 2: eseguire, verificare il fallimento**

Run: `npx vitest run src/lib/societa-attiva.test.ts`
Expected: FAIL — `leggiSocietaAttiva is not a function`

- [ ] **Step 3: implementare**

```ts
export type EsitoSocietaAttiva =
  | { ok: true; codice: CodiceSocieta; esplicita: boolean }
  | { ok: false; errore: string }

/**
 * Quale societa' e' in uso, distinguendo TRE casi che il codice di prima
 * schiacciava in uno:
 *
 *   - l'Ingegnere l'ha scelta      → { ok: true, esplicita: true }
 *   - non l'ha mai scelta          → { ok: true, esplicita: false }  (politica: Restruktura)
 *   - non siamo riusciti a leggere → { ok: false }
 *
 * Il terzo caso e' il motivo per cui questa funzione esiste. Prima tornava
 * `restruktura` anche su errore, col commento «un errore di database non deve
 * cambiare azienda» — ragionamento sano che pero' rendeva un guasto
 * indistinguibile da una scelta. Chi stampa una partita IVA su un documento
 * NON puo' accontentarsi di un'ipotesi: la guardia a valle vale esattamente
 * quanto vale questo dato.
 */
export async function leggiSocietaAttiva(conversationId?: string): Promise<EsitoSocietaAttiva> {
  if (!conversationId) return { ok: true, codice: DEFAULT_SOCIETA, esplicita: false }
  try {
    const { data, error } = await getSupabaseServer()
      .from('cervellone_societa_attiva')
      .select('societa')
      .eq('conversation_id', conversationId)
      .maybeSingle()

    if (error) return { ok: false, errore: error.message || 'lettura della societa\' attiva fallita' }
    if (!data?.societa) return { ok: true, codice: DEFAULT_SOCIETA, esplicita: false }
    const codice = data.societa as CodiceSocieta
    if (!getSocieta(codice)) return { ok: true, codice: DEFAULT_SOCIETA, esplicita: false }
    return { ok: true, codice, esplicita: true }
  } catch (err) {
    return { ok: false, errore: err instanceof Error ? err.message : String(err) }
  }
}
```

`getSocietaAttiva` va riscritta sopra questa, mantenendo il comportamento osservabile:

```ts
export async function getSocietaAttiva(conversationId?: string): Promise<CodiceSocieta> {
  const e = await leggiSocietaAttiva(conversationId)
  return e.ok ? e.codice : DEFAULT_SOCIETA
}
```

- [ ] **Step 4: eseguire, verificare il passaggio**

Run: `npx vitest run src/lib/societa-attiva.test.ts && npx tsc --noEmit`
Expected: PASS, typecheck pulito

- [ ] **Step 5: mutazione**

```bash
cp src/lib/societa-attiva.ts /tmp/sa.bak
perl -0pi -e "s/\Qreturn { ok: false, errore: error.message\E/return { ok: true, codice: DEFAULT_SOCIETA, esplicita: false }; \/\/ x (error.message/" src/lib/societa-attiva.ts
npx vitest run src/lib/societa-attiva.test.ts   # DEVE FALLIRE
cp /tmp/sa.bak src/lib/societa-attiva.ts
```
Expected: FALLISCE. Se resta verde, il controllo positivo è inerte — dirlo.

- [ ] **Step 6: commit**

```bash
git add src/lib/societa-attiva.ts src/lib/societa-attiva.test.ts
git commit -m "un guasto nella lettura della societa' attiva non e' piu' 'Restruktura'"
```

---

### Task 3: `societaAttivaPerDocumenti` smette di dire «best-effort»

**Files:**
- Modify: `src/lib/societa-documenti.ts`
- Test: `src/lib/societa-documenti.test.ts` (creare)

**Interfaces:**
- Consumes: `leggiSocietaAttiva` (Task 2), `getSocieta`
- Produces:
  ```ts
  export type EsitoSocietaDocumento =
    | { ok: true; societa: DatiSocietari; esplicita: boolean }
    | { ok: false; errore: string }
  export async function societaPerDocumento(conversationId?: string): Promise<EsitoSocietaDocumento>
  ```
- `societaAttivaPerDocumenti` (vecchia, `Promise<DatiSocietari | undefined>`) **va rimossa**, insieme ai suoi due chiamanti che passano al nuovo esito (Task 4 li aggiorna). Se rimuoverla rompe il typecheck in punti non previsti dal piano: **fermarsi e riferirlo**, non lasciarla come alias.

- [ ] **Step 1: test che falliscono** — tre casi: società esplicita → `ok:true`; nessuna scelta → `ok:true` Restruktura `esplicita:false`; `leggiSocietaAttiva` in errore → `ok:false` col messaggio dentro. **Controllo positivo**: mutando il ritorno d'errore in `ok:true` almeno un test muore.
- [ ] **Step 2: eseguire, verificare il fallimento**
- [ ] **Step 3: implementare — nessun `catch { return undefined }`; il commento vecchio («Best-effort: … resta Restruktura») va sostituito con la spiegazione del perché non lo è più**
- [ ] **Step 4: eseguire, verificare il passaggio + typecheck**
- [ ] **Step 5: mutazione come sopra**
- [ ] **Step 6: commit** — `git commit -m "chi genera un documento non indovina piu' la societa'"`

---

### Task 4: `salva-documento.ts` — l'unica strada per scrivere il contenuto di un documento

**Files:**
- Create: `src/lib/salva-documento.ts`
- Test: `src/lib/salva-documento.test.ts`
- Modify: `src/app/api/chat/route.ts:502`, `src/lib/agent-job.ts:215`, `src/lib/tools/studio-tecnico.ts:986`, `src/lib/artifact-capture.ts:169`, `src/lib/draft-tools.ts:186`

**Interfaces:**
- Consumes: `verificaDatiSocietari`, `messaggioBlocco` (Task 1), `societaPerDocumento` (Task 3)
- Produces:
  ```ts
  export type EsitoSalvataggio =
    | { ok: true; id: string }
    | { ok: false; motivo: 'dati_societari'; messaggio: string; esito: Extract<EsitoGuardia, { ok: false }> }
    | { ok: false; motivo: 'societa_ignota'; messaggio: string }
    | { ok: false; motivo: 'errore'; messaggio: string }

  /**
   * L'UNICO modo per scrivere il contenuto di un documento in `documents`.
   * Un secondo modo e' un difetto: la guardia sui dati societari sta qui.
   */
  export async function salvaDocumento(d: {
    nome: string
    contenuto: string
    conversationId: string
    tipo: string
    metadata?: Record<string, unknown>
  }): Promise<EsitoSalvataggio>

  /** Aggiorna il contenuto di una bozza esistente, con la stessa guardia. */
  export async function aggiornaContenutoDocumento(
    id: string,
    contenuto: string,
    conversationId: string,
  ): Promise<EsitoSalvataggio>
  ```

**Perché tre `motivo` e non un `error: string`:** chi chiama deve poter dire cose
diverse all'Ingegnere. «Dati societari incoerenti» è un blocco che lui può
sciogliere; «non so quale società» è un guasto da riferire; «errore» è un guasto
del database. Schiacciarli in una stringa riporta il difetto che stiamo chiudendo.

- [ ] **Step 1: scrivere i test che falliscono**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const insert = vi.fn()
vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      insert: (row: unknown) => { insert(row); return { select: () => ({ single: () => Promise.resolve({ data: { id: 'doc-1' }, error: null }) }) } },
      update: (row: unknown) => ({ eq: () => { insert(row); return Promise.resolve({ error: null }) } }),
    }),
  }),
}))
const societaPerDocumento = vi.fn()
vi.mock('./societa-documenti', () => ({ societaPerDocumento: (...a: unknown[]) => societaPerDocumento(...a) }))

import { salvaDocumento } from './salva-documento'

const RESTRUKTURA = { denominazione: 'RESTRUKTURA S.r.l.', piva: '02087420762' }
const LAREALESTATE = { denominazione: 'LA REAL ESTATE SRLS', piva: '02232730768' }

beforeEach(() => { insert.mockClear(); societaPerDocumento.mockReset() })

describe('salvaDocumento — la guardia sta dentro, non nei chiamanti', () => {
  it('CONTROLLO POSITIVO: La Real Estate attiva, contenuto con la P.IVA di Restruktura → NON scrive', async () => {
    societaPerDocumento.mockResolvedValue({ ok: true, societa: LAREALESTATE, esplicita: true })
    const r = await salvaDocumento({
      nome: 'Preventivo', tipo: 'html', conversationId: 'c1',
      contenuto: '<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p>',
    })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('ha salvato un documento con la partita IVA sbagliata')
    expect(r.motivo).toBe('dati_societari')
    expect(r.messaggio).toContain('02087420762')
    expect(r.messaggio).toContain('02232730768')
    // la prova che conta: NESSUNA scrittura
    expect(insert).not.toHaveBeenCalled()
  })

  it('CONTROLLO NEGATIVO: societa\' coerente → scrive, e scrive il contenuto vero', async () => {
    societaPerDocumento.mockResolvedValue({ ok: true, societa: RESTRUKTURA, esplicita: true })
    const r = await salvaDocumento({
      nome: 'Preventivo', tipo: 'html', conversationId: 'c1',
      contenuto: '<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p><p>Committente P.IVA 01234567890</p>',
    })
    expect(r).toEqual({ ok: true, id: 'doc-1' })
    expect(insert).toHaveBeenCalledTimes(1)
    expect((insert.mock.calls[0][0] as Record<string, unknown>).content).toContain('02087420762')
  })

  it('societa\' non leggibile → NON scrive, e lo dice: non indovina Restruktura', async () => {
    societaPerDocumento.mockResolvedValue({ ok: false, errore: 'connessione persa' })
    const r = await salvaDocumento({ nome: 'x', tipo: 'html', conversationId: 'c1', contenuto: '<p>x</p>' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('atteso rifiuto')
    expect(r.motivo).toBe('societa_ignota')
    expect(r.messaggio).toContain('connessione persa')
    expect(insert).not.toHaveBeenCalled()
  })

  it('un documento senza nessuna partita IVA passa: non e\' un caso sospetto', async () => {
    societaPerDocumento.mockResolvedValue({ ok: true, societa: RESTRUKTURA, esplicita: true })
    const r = await salvaDocumento({ nome: 'x', tipo: 'html', conversationId: 'c1', contenuto: '<p>Relazione</p>' })
    expect(r.ok).toBe(true)
  })
})
```

- [ ] **Step 2: eseguire, verificare il fallimento**

Run: `npx vitest run src/lib/salva-documento.test.ts`
Expected: FAIL — `Cannot find module './salva-documento'`

- [ ] **Step 3: implementare il modulo**

La guardia gira **prima** di qualunque scrittura. L'intestazione del file deve
dire perché il modulo esiste, in una forma che sopravvive a chi lo legge fra sei
mesi:

```ts
/**
 * src/lib/salva-documento.ts — l'unica strada per scrivere in `documents` il
 * contenuto di un documento che Cervellone compila.
 *
 * Nasce da una misura: il 12 set 2026 `grep "from('documents')"` dava VENTOTTO
 * punti, DIECI dei quali inserivano. Cinque scrivevano il contenuto di un
 * documento compilato, ognuno a modo suo, e nessuno controllava che la partita
 * IVA stampata fosse quella della societa' attiva. Il preventivo, che e' il
 * documento piu' importante, era fra questi.
 *
 * Un secondo modo di scrivere un documento e' un difetto, non una comodita':
 * sarebbe senza guardia, e nessuno se ne accorgerebbe. Il `grep` A7 nella lista
 * tarata sorveglia questa invariante.
 */
```

- [ ] **Step 4: migrare i cinque punti**

Ognuno smette di fare `insert` a mano. Su `ok: false` il chiamante:
- **non** consegna il documento
- **dice all'Ingegnere** `r.messaggio` — su entrambi i canali; mai un silenzio, mai un documento parziale

`chat/route.ts:502` e `agent-job.ts:215` vanno migrati **nello stesso commit**:
sono la stessa scrittura sui due canali, e migrarne uno solo crea la divergenza
che questo repo ha già pagato più volte.

- [ ] **Step 5: verificare che non resti nessun'altra strada**

```bash
grep -rn "from('documents')" src --include=*.ts --include=*.tsx | grep -v "\.test\." | grep -v "salva-documento.ts" | grep -E "insert|update\(\{ ?content"
```
Expected: solo `projects/route.ts` (digest di file caricati — **esclusione dichiarata** nella spec) e `sent-mail.ts` / `image-memory.ts` / `artifact-capture.ts` se scrivono tipi non-documento. Qualunque altra riga è un punto che il piano non ha visto: **riferirla**, non migrarla d'iniziativa.

- [ ] **Step 6: suite intera + typecheck**

Run: `npx vitest run && npx tsc --noEmit`

- [ ] **Step 7: mutazione**

```bash
cp src/lib/salva-documento.ts "$TMP/sd.bak"
md5sum src/lib/salva-documento.ts
# La guardia smette di bloccare: deve morire almeno un test
# Disattivare la guardia. Il nome della variabile dipende dall'implementazione:
# si legge dal file, NON si copia da qui. Sotto, ESITO e' un segnaposto.
perl -0pi -e 's/\Qif (!ESITO.ok)\E/if (false \&\& !ESITO.ok)/' src/lib/salva-documento.ts
grep -c "false &&" src/lib/salva-documento.ts   # deve stampare 1, altrimenti il pattern non ha morso
npx vitest run src/lib/salva-documento.test.ts        # DEVE FALLIRE
cp "$TMP/sd.bak" src/lib/salva-documento.ts
md5sum src/lib/salva-documento.ts                      # identico a prima
```
Se la suite resta verde con la mutazione: **fermarsi e dirlo.** Un controllo positivo inerte è peggio di nessun controllo, perché mente sul fatto di esserci.

- [ ] **Step 8: commit**

```bash
git add src/lib/salva-documento.ts src/lib/salva-documento.test.ts src/app/api/chat/route.ts src/lib/agent-job.ts src/lib/tools/studio-tecnico.ts src/lib/artifact-capture.ts src/lib/draft-tools.ts
git commit -m "una sola strada per salvare un documento, e la guardia sta dentro"
```

---

### Task 5: la guardia nei tre imbuti di rendering

**Files:**
- Modify: `src/lib/pdf-generator.ts` (`OpzioniDocumento`, `:59`, `:384`, `:520`, `:409`, `:644`)
- Modify: `src/v19/render/docx.ts:34`, `src/v19/render/utils.ts:110`
- Modify: i chiamanti — `src/lib/tools.ts:152,166`, `src/lib/draft-tools.ts:249`, `src/lib/sal-tools.ts:189`, `src/lib/document-template-tools.ts:305`
- Test: `src/lib/pdf-generator.guardia.test.ts`

**Interfaces:**
- Consumes: Task 1 e Task 3
- Produces:
  ```ts
  export class ErroreDatiSocietari extends Error {
    readonly esito: Extract<EsitoGuardia, { ok: false }>
    constructor(esito: Extract<EsitoGuardia, { ok: false }>)
  }
  ```
  `OpzioniDocumento.societa` passa da opzionale a **richiesto**; `SOCIETA_PREDEFINITA` **eliminata**.

**Perché un `throw` e non un tipo di ritorno unione:** le funzioni restituiscono
`Promise<Buffer>` e hanno cinque chiamanti. Un'unione obbligherebbe a gestire il
caso in cinque modi diversi nello stesso commit. Un errore **tipizzato**
attraversa il `try/catch` per-tool già presente in `claude.ts:1126`, che
consegna il messaggio all'Ingegnere su entrambi i canali. Questo rende
l'equipollenza gratuita — motivo in più per **provarla** invece di dedurla (Task 6).

- [ ] **Step 1: i test che falliscono**

```ts
it('CONTROLLO POSITIVO — PDF con la P.IVA di Restruktura e La Real Estate attesa: RIGETTA', async () => {
  await expect(generatePdfFromHtml('<h1>RESTRUKTURA S.r.l.</h1><p>02087420762</p>', 'x', { societa: LAREALESTATE }))
    .rejects.toThrow(/02087420762/)
})

it('la guardia gira PRIMA di Chromium: un documento bloccato non deve costare un browser', async () => {
  await expect(generatePdfFromHtml(HTML_SBAGLIATO, 'x', { societa: LAREALESTATE })).rejects.toThrow()
  expect(launchMock).not.toHaveBeenCalled()
})

it('CONTROLLO NEGATIVO — societa\' coerente: genera, la guardia non interferisce', async () => {
  await expect(generatePdfFromHtml('<h1>RESTRUKTURA S.r.l.</h1><p>02087420762</p>', 'x', { societa: RESTRUKTURA }))
    .resolves.toBeInstanceOf(Buffer)
})

it('il Word si comporta identico al PDF: due formati dallo stesso HTML non possono divergere', async () => {
  await expect(generateDocxFromHtml(HTML_SBAGLIATO, 'x', { societa: LAREALESTATE })).rejects.toThrow(/02087420762/)
})

it('renderDocx dai modelli .docx: stessa guardia', async () => {
  // il testo dei segnaposto compilati e' il contenuto da verificare
})
```

- [ ] **Step 2: eseguire, verificare il fallimento**
- [ ] **Step 3: implementare** — guardia in cima alle tre funzioni, prima di `embedDriveImages` e di `getBrowser()`; eliminare `SOCIETA_PREDEFINITA` e i due `?? SOCIETA_PREDEFINITA`; in `v19/render/utils.ts:110` togliere il predefinito `"RESTRUKTURA … 02087420762"` e richiedere il dato
- [ ] **Step 4: aggiornare i cinque chiamanti** — `societaPerDocumento(conversationId)`, e su `ok:false` nessun documento più il messaggio all'Ingegnere
- [ ] **Step 5: suite + typecheck** — il typecheck è la prova che nessun chiamante è rimasto senza società: `societa` richiesta rende un'omissione un errore di compilazione, non una stampa silenziosa di Restruktura
- [ ] **Step 6: mutazione** — rimettere `?? SOCIETA_PREDEFINITA`: almeno un test deve morire
- [ ] **Step 7: commit** — `git commit -m "PDF, Word e modelli .docx: la societa' e' obbligatoria e verificata"`

---

### Task 6: equipollenza — un test per canale

**Files:**
- Test: `src/app/api/chat/route.guardia-societa.test.ts`
- Test: `src/app/api/telegram/route.guardia-societa.test.ts`

**Interfaces:** consuma i Task 1-5. **Nessun codice di produzione nuovo.** Se per far passare questi test servisse toccare la produzione, **è un difetto trovato**: riferirlo, non aggirarlo.

Lo schema dei test di canale sta in `src/app/api/chat/route.comandi.test.ts` e `src/app/api/telegram/route.comandi.test.ts`: seguirlo, non inventarne uno nuovo.

- [ ] **Step 1: per ciascun canale, il caso di blocco**

Con La Real Estate attiva e un turno che produce un documento intestato Restruktura:
1. il messaggio di blocco **arriva** — sul web nella risposta salvata; su Telegram in una `sendMessage` **verificata sulla chiamata al mock**, e con `sendTelegramMessageChecked`, non con la variante che non rigetta mai
2. il messaggio **contiene entrambe** le partite IVA
3. **nessuna riga** in `documents`

- [ ] **Step 2: eseguire, verificare il fallimento** (con un fixture che aggira i Task 1-5, o prima di essi)
- [ ] **Step 3: far passare senza toccare la produzione**
- [ ] **Step 4: CONTROLLO POSITIVO di canale** — con la società **giusta**, su entrambi i canali il documento viene salvato e **nessun** blocco appare. Un test che dice «bloccato» su ogni input non misura niente: è il difetto del 3 settembre, quando tre difetti in un giorno stavano nei test.
- [ ] **Step 5: commit** — `git commit -m "la guardia parla identica su chat web e Telegram, provato per canale"`

---

### Task 7: le sei intestazioni cablate — la cura, non la rete

**Files:**
- Modify: `src/lib/tools/studio-tecnico.ts:837`, `:857`, e il piede del quadro economico (`Restruktura S.r.l. — Le percentuali sono indicative`, ~`:970`)
- Modify: `src/v19/render/utils.ts:110` (se non già fatto nel Task 5)
- Modify: `src/lib/prompts.ts:134`
- Test: `src/lib/tools/studio-tecnico.characterization.test.ts` (aggiornare), più il test di riproduzione

**Interfaces:** consuma `societaPerDocumento` (Task 3). `executeStudioTecnico` ha già `conversationId` in firma (`:147`).

**Attenzione allo snapshot:** `studio-tecnico.characterization.test.ts` snapshotta l'output di `genera_preventivo_completo`. L'intestazione **cambia per costruzione**. Lo snapshot si aggiorna **dopo** aver letto il diff e verificato che cambi **solo** l'intestazione. Uno snapshot aggiornato senza guardare è un test che ha smesso di misurare — ed è esattamente come un difetto sopravvive a 2.468 test verdi.

- [ ] **Step 1: la riproduzione del difetto, PRIMA del fix**

Un test che, con La Real Estate attiva, prova che il preventivo di **oggi**
contiene `02087420762`. L'exploit si riproduce prima della difesa: senza questo
test non sappiamo di aver chiuso qualcosa di vero.

```ts
it('IL DIFETTO, riprodotto: con La Real Estate attiva il preventivo porta la P.IVA di Restruktura', async () => {
  // mock: leggiSocietaAttiva → larealestate
  const out = String(await executeStudioTecnico('genera_preventivo_completo', {
    committente: 'Cliente', comune: 'Maratea', descrizione_lavoro: 'x',
    lavorazioni: [{ descrizione: 'calcestruzzo', quantita: 10, um: 'mc' }], regione: 'basilicata',
  }, 'conv-lre'))
  expect(out).toContain('02087420762')   // ← passa OGGI. E' il difetto.
})
```

- [ ] **Step 2: eseguire e verificare che PASSI** — il difetto è vivo. Se non passa, il difetto non è dove credevo: **fermarsi e riferirlo** invece di aggiustare il test.
- [ ] **Step 3: intestazione e piede dalla società attiva** nei quattro punti HTML/Word; su `ok:false` il preventivo **non si genera** e lo dichiara
- [ ] **Step 4: `prompts.ts:134` si CANCELLA, e l'informazione va in `bloccoSocietaAttiva`**

La riga di oggi è `Intestazione: RESTRUKTURA S.r.l. — P.IVA 02087420762, Villa d'Agri (PZ), Ing. Raffaele Lentini.`
e sta in un prompt **statico**, che non conosce la conversazione e quindi non può sapere
quale società è attiva. Renderla condizionale lì vorrebbe dire passarle il `conversationId`:
lavoro inutile, perché il posto giusto **esiste già**.

`bloccoSocietaAttiva(s: Societa)` (`src/lib/societa-attiva.ts:70`) riceve la società attiva
ed è iniettato **simmetricamente sui due canali** (`chat/route.ts:391`, `agent-job.ts:127`).
L'intestazione va lì, costruita da `s`, accanto alla partita IVA e all'aliquota che quel
blocco già dichiara. Così l'equipollenza è **strutturale**, non da ricostruire — ed è la
ragione per cui questo Step non ha bisogno di un test per canale suo: il blocco è uno.

Aggiungere al blocco una riga di questa forma (template literal, `s` è la società attiva):

    Intestazione dei documenti: ${s.denominazione} — P.IVA ${s.piva}, ${s.sede}.

⚠️ **`Societa` non ha oggi un campo `sede`.** La sede di Restruktura è scritta in due forme
diverse in due file — `src/v19/prompts/identita.ts` dice *Villa d'Agri (PZ), Italia*, la
memoria del progetto dice *Via Roma 60, 85050 Marsicovetere (PZ)* — e **nessuna delle due
è nel registro**. Sono lo stesso luogo (Villa d'Agri è frazione di Marsicovetere) ma non la
stessa stringa.

**Non inventarne una terza e non scegliere fra le due di tua iniziativa.** Aggiungi al
registro il campo `sede`, con per Restruktura **esattamente** il valore già presente in
`identita.ts` (`sedeLegale`) e per La Real Estate `Via Civita 8, Maratea (PZ)`; poi
**dichiara nel rapporto** che la forma definitiva la deve decidere Raffaele. Un dato
societario scelto da noi al posto suo è esattamente il difetto che questo lavoro chiude.

- [ ] **Step 5: invertire la riproduzione nella forma definitiva**

```ts
it('con La Real Estate attiva il preventivo porta LA SUA partita IVA, e non quella di Restruktura', async () => {
  const out = /* come sopra */
  expect(out).toContain('02232730768')
  expect(out).not.toContain('02087420762')
})
```

- [ ] **Step 6: suite + typecheck**
- [ ] **Step 7: verificare che non resti niente cablato**

```bash
grep -rn "02087420762\|02232730768" src --include=*.ts | grep -v "\.test\." | grep -v "__tests__" | grep -v "spec.ts"
```
Expected: **solo** `src/lib/societa.ts`, `src/v19/prompts/identita.ts`, `src/lib/checkin/foglio-schema.ts:101` (quest'ultimo è La Real Estate nel foglio check-in: **corretto**, il check-in è la sua attività). Ogni altra occorrenza è un punto che il piano non ha visto: **riferirla**.

- [ ] **Step 8: commit** — `git commit -m "sei intestazioni cablate diventano la societa' attiva"`

---

### Task 8: la lista tarata, e i punti aperti dichiarati

**Files:**
- Modify: `docs/superpowers/audit-checklist-tarata.md`
- Modify: `docs/superpowers/specs/2026-09-12-guardia-dati-societari-design.md` (sezione punti aperti, se i task ne hanno scoperti)

*«Fix, poi imparo e prossima volta calibro gli audit per scovare il problema in fase di creazione»* — un fix non è finito finché la classe non è nella lista.

- [ ] **Step 1: le voci nuove**, ognuna col difetto vero e la data che l'ha generata

- **A7 (grep):** `grep -rn "from('documents')" src | grep -E "insert|update\(\{ ?content"` fuori da `salva-documento.ts` → una strada nuova senza guardia. *Difetto: 12 set 2026, cinque scritture di contenuto sparse, nessuna che controllasse la partita IVA.*
- **A8 (grep):** un dato di un'entità reale (partita IVA, ragione sociale, sede) scritto a mano fuori dal suo registro. *Difetto: 12 set 2026, sei intestazioni Restruktura cablate; un preventivo de La Real Estate usciva con la P.IVA di Restruktura.*
- **A9 (grep):** `opzioni.X ?? COSTANTE` dove `COSTANTE` è il dato di un'entità reale. Un chiamante che dimentica non sbaglia: prende un'identità in silenzio. *Difetto: 12 set 2026, `pdf-generator.ts:59` e `v19/render/utils.ts:110`.*
- **B10:** una funzione che restituisce un dato su cui si costruisce un documento, un pagamento o una dichiarazione **non può** avere lo stesso valore di ritorno per «assenza nota» e per «guasto». **Terza ricorrenza** (mail pending, prefissi UUID, società attiva) — quando una classe torna tre volte, il controllo va fatto per costruzione, non per revisione.
- **B11:** una guardia che confronta il contenuto con un valore «atteso» va valutata **anche su come si ottiene l'atteso**. Una guardia che si fida di un dato indovinato timbra l'errore invece di trovarlo. *Difetto: 12 set 2026, `attesa` veniva da `getSocietaAttiva`, che su errore restituiva Restruktura.*
- **C6:** una guardia si valuta su **due** prove, mai una: il caso vero morde **e** il caso normale passa. *Difetto: guardia `.docx`, che bloccava il caso normale.*
- **C7:** **un imbuto dichiarato non è un imbuto misurato.** Prima di mettere un controllo «nel punto per cui passa tutto», contare i punti con un `grep`. *Difetto: 12 set 2026, il primo disegno di questa stessa guardia la metteva in `generatePdfFromHtml` «l'unico imbuto» — e il preventivo non passa da lì. Trovato dalla scansione pre-volo, non dai test.*

- [ ] **Step 2: dichiarare i punti aperti nella spec**, se ne sono emersi. In particolare: i chiamanti di `getSocietaAttiva` che **scrivono** su Fatture in Cloud (un'operazione FIC sull'azienda sbagliata è grave quanto un documento sbagliato, e non è chiusa da questo lavoro); e la sede di Restruktura scritta in due forme diverse in due file, nessuna delle quali nel registro.
- [ ] **Step 3: commit** — `git add docs/ && git commit -m "la lista tarata impara la classe dei dati societari indovinati"`
