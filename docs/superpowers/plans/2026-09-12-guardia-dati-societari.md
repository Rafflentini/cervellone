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
- Modify: `src/lib/tools/studio-tecnico.ts` — **CINQUE punti, contati uno per uno** (non tre: il piano lo diceva sbagliato fino alla verifica del 12 set):

| Riga | Cosa | Dove finisce |
|---|---|---|
| `:837` | `const headerHtml = ...RESTRUKTURA S.r.l.... P.IVA 02087420762...` | **vivo**, usato a `:915` (CME) e `:944` (quadro economico) |
| `:857` | la **stessa** intestazione riscritta inline | intestazione del **preventivo** |
| `:875` | `<div class="footer">Restruktura S.r.l. — Validità offerta: 60 giorni...` | piede del preventivo |
| `:935` | `Restruktura S.r.l. — Conforme a DPR 207/2010...` | piede del CME |
| `:971` | `Restruktura S.r.l. — Le percentuali sono indicative...` | piede del quadro economico |

⚠️ **`:857` è una copia letterale di `:837`.** Non correggerne una e lasciare l'altra, e non
lasciarne due copie corrette: costruire l'intestazione **una volta** dalla società attiva e
usarla in tutti e tre i documenti. Due copie della stessa stringa sono due cose destinate a
divergere — è il motivo per cui `societa-documenti.ts` esiste.

I tre piedi (`:875`, `:935`, `:971`) portano **solo la ragione sociale**, senza partita IVA:
la guardia del Task 1 **non li vedrebbe**, perché cerca le partite IVA. Su un documento de
La Real Estate restano comunque il nome dell'azienda sbagliata, stampato in fondo. Vanno
corretti qui: è la cura, e in questo caso la rete non c'è.

- Modify: `src/v19/render/utils.ts:110` (se non già fatto nel Task 5)
- Modify: `src/lib/prompts.ts:134`
- Test: `src/lib/tools/studio-tecnico.characterization.test.ts` (aggiornare lo snapshot **dopo** aver letto il diff), più il test di riproduzione

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

- **A7 (grep):** una strada nuova per scrivere il contenuto di un documento, fuori da `salva-documento.ts`.
  ```bash
  grep -rn "from('documents')" src --include=*.ts --include=*.tsx \
    | grep -v "\.test\." | grep -v "salva-documento.ts" \
    | grep -E "insert|update\(\{ ?content"
  ```
  *Difetto: 12 set 2026 — 28 punti toccavano la tabella `documents`, 10 inserivano, cinque scrivevano contenuto di documenti, e nessuno controllava la partita IVA. Fra questi il preventivo.*

- **A8 (grep) — ⚠️ il comando è TARATO, non cambiarlo a occhio.** Un dato societario scritto a mano fuori dal registro:
  ```bash
  grep -rniE "restruktura s\.?r\.?l|la real estate s\.?r\.?l" src --include=*.ts \
    | grep -vi "\.test\.\|spec\.ts\|__tests__" \
    | grep -v "societa.ts:\|identita.ts:"
  ```
  **La prima versione di questo comando cercava `RESTRUKTURA` maiuscolo e mancava tre difetti su undici**, perché i piedi di `studio-tecnico.ts` scrivono `Restruktura S.r.l.` in minuscolo. Servono `-i` **e** la tolleranza sui punti (`s\.?r\.?l`), perché la stessa ragione sociale è scritta `S.r.l.`, `S.R.L.`, `SRL` e `SRLS`.
  Il comando tarato dà **24 righe**, di cui **11 difetti** e 13 legittime (tutto `checkin/*` — il check-in *è* l'attività de La Real Estate; l'identità e il blocco a due società in `prompts.ts`; una descrizione di tool; un commento). L'elenco delle righe legittime sta nella spec: **chi esegue questo controllo deve confrontarlo con quell'elenco**, altrimenti conclude che ci sono 24 difetti e non ne corregge nessuno.
  *Difetto: 12 set 2026 — undici punti con i dati societari cablati; un preventivo de La Real Estate usciva con la ragione sociale e la P.IVA di Restruktura.*

- **A9 (grep):** `opzioni.X ?? COSTANTE` dove `COSTANTE` è l'identità di un'entità reale. **Chi dimentica il parametro non sbaglia: prende un'identità in silenzio.** La cura non è un controllo a valle, è rendere il parametro **obbligatorio**, così l'omissione diventa un errore di compilazione.
  *Difetto: 12 set 2026 — `pdf-generator.ts:59` e `v19/render/utils.ts:110`.*

- **A10 (grep):** i **metadati** dei file generati (`creator`, `author`, `title`, `company`) con un dato societario cablato. Nessuna guardia sul **contenuto** li vede: non stanno nell'HTML.
  *Difetto: 12 set 2026 — `pdf-generator.ts:653` e `:698` scrivevano «Restruktura S.r.l.» come autore di ogni PDF ed Excel, anche de La Real Estate. **Non li avevo contati a mano: li ha trovati il grep tarato.***

- **B10:** una funzione che restituisce un dato su cui si costruisce un documento, un pagamento o una dichiarazione **non può** avere lo stesso valore di ritorno per «assenza nota» e per «guasto». **Terza ricorrenza** (mail pending il 12 set, prefissi UUID l'11 set, società attiva il 12 set): quando una classe torna tre volte, il controllo va fatto per costruzione — un tipo unione — non per revisione.

- **B11:** una guardia che confronta il contenuto con un valore «atteso» va valutata **anche su come si ottiene l'atteso**. Una guardia che si fida di un dato indovinato **timbra** l'errore invece di trovarlo.
  *Difetto: 12 set 2026 — `attesa` veniva da `getSocietaAttiva`, che su errore di database restituiva Restruktura. La guardia avrebbe dichiarato conforme un documento sbagliato.*

- **B12:** una guardia copre una **forma** del dato, non il dato. Dichiarare per iscritto cosa **non** copre, nella stessa riga in cui si dichiara cosa copre.
  *Difetto: 12 set 2026 — la guardia cerca le partite IVA; tre dei undici punti portano **solo la ragione sociale** e non li vedrebbe mai. Per quei tre la cura è l'unica difesa, e senza dirlo la promessa sarebbe stata più larga della difesa.*

- **C6:** una guardia si valuta su **due** prove, mai una: il caso vero morde **e** il caso normale passa.
  *Difetto: guardia `.docx`, 3 set 2026, che bloccava il caso normale.*

- **C7:** **un imbuto dichiarato non è un imbuto misurato.** Prima di mettere un controllo «nel punto per cui passa tutto», contare i punti con un `grep`.
  *Difetto: 12 set 2026 — il primo disegno di questa stessa guardia la metteva in `generatePdfFromHtml`, «l'unico imbuto»; il preventivo non passa da lì. Trovato dalla scansione pre-volo del piano, non dai test.*

- **C8:** **un controllo proposto e non eseguito non è un controllo.** Ogni `grep` che entra in questa lista va lanciato **prima** di scriverlo qui, e va scritto accanto quante righe dà e quante sono difetti.
  *Difetto: 12 set 2026 — ho proposto la versione maiuscola di A8 senza eseguirla: mancava un terzo dei difetti. Un controllo che dà un falso verde è peggio di nessun controllo, perché mente sul fatto di esserci — ed è lo stesso errore che questa lista esiste per prevenire, commesso mentre la scrivevo.*

- [ ] **Step 2: eseguire OGNI comando nuovo** e annotare accanto il numero di righe che dà oggi e quante sono difetti. Una voce senza quel numero non è verificabile: al prossimo giro nessuno sa se «24 righe» sia normale o un'emergenza.

- [ ] **Step 3: commit** — `git add docs/ && git commit -m "la lista tarata impara la classe dei dati societari indovinati"`

---

### Task 9: la lettera spedita — la guardia sull'invio delle mail

**Perché esiste questo task.** Raffaele ha detto: *«compili un preventivo, un
documento, **una lettera**, qualsiasi cosa sbagliando i dati che sa»*. Una lettera
raggiunge qualcuno per mail, e l'invio **non passa** dalla tabella `documents`: i
Task 4 e 5 non lo coprono. Ed è il caso peggiore dell'intero lavoro, perché una
mail spedita non si richiama: un documento sbagliato lo si rigenera, una lettera
con la partita IVA di un'altra società è già in mano al destinatario.

**Files:**
- Modify: `src/v19/tools/email/send-email.ts` (`SendEmailInput`, `sendEmailInternal` a `:84`)
- Modify: `src/v19/tools/email/forward-email.ts:58`, `src/v19/tools/email/pack-emails-and-send.ts:172`
- Test: `src/v19/tools/email/send-email.guardia-societa.test.ts`
- Test: i due test di canale del Task 6 si estendono al caso mail

**Interfaces:**
- Consumes: `verificaDatiSocietari`, `messaggioBlocco` (Task 1), `societaPerDocumento` (Task 3)
- Produces: `SendEmailInput` guadagna **un solo campo**
  ```ts
  /**
   * Il corpo contiene testo scritto da TERZI (un inoltro, un impacchettamento di
   * mail ricevute). La guardia sui dati societari NON si applica: una mail
   * ricevuta da La Real Estate porta legittimamente la partita IVA de La Real
   * Estate, e bloccarne l'inoltro bloccherebbe il caso normale.
   */
  contenuto_di_terzi?: boolean
  ```

**L'imbuto è vero, misurato.** `sendEmailInternal` è l'unico punto d'uscita: ci
passano `forward-email.ts:58`, `pack-emails-and-send.ts:172`,
`sendEmailWithAttachments` (`email/index.ts:326`), il cron scadenze
(`api/cron/scadenze/route.ts:183`) e la routine fatture estere
(`routines/monthly-foreign-invoices.ts:354`). Il commento in
`email/pending.ts:63` lo dice già: *«`sendEmailInternal`, che chiama questa
funzione in un punto solo»*.

**⚠️ Il falso positivo qui è reale, non teorico — a differenza del Task 4.**
Un inoltro porta il corpo di una mail di terzi. Se il commercialista scrive a
proposito de La Real Estate mentre la società attiva è Restruktura, la guardia
senza distinzione **bloccherebbe l'inoltro**. Questa è precisamente la guardia
`.docx` da capo: *una guardia che blocca il caso normale è peggio del buco che
chiude.* Per questo il campo `contenuto_di_terzi` esiste, e per questo i due
chiamanti che inoltrano **devono** impostarlo: non è un'ottimizzazione, è la
condizione perché la guardia sia accettabile.

**Cosa si guarda e cosa no:**

| Punto d'invio | Guardia | Perché |
|---|---|---|
| `send_email` chiamato dal modello (una lettera che il bot scrive) | ✅ | è il caso di Raffaele |
| `sendEmailWithAttachments` | ✅ | corpo composto da noi |
| `forward-email.ts:58` | ❌ `contenuto_di_terzi: true` | il corpo è di terzi |
| `pack-emails-and-send.ts:172` | ❌ `contenuto_di_terzi: true` | impacchetta mail ricevute |
| cron scadenze, routine fatture estere | ✅ | testi nostri, e girano **senza nessuno che guardi**: sono proprio i posti dove un errore resta muto |

**Nota sugli allegati:** non serve guardarli qui. Un allegato generato da noi è
già passato da `salva-documento.ts` o dagli imbuti di rendering (Task 4 e 5); un
allegato ricevuto è contenuto di terzi. Guardarlo una seconda volta aggiungerebbe
solo un secondo modo di sbagliare.

- [ ] **Step 1: scrivere i test che falliscono**

```ts
it('CONTROLLO POSITIVO — lettera composta dal bot con la P.IVA di Restruktura, La Real Estate attiva: NON parte', async () => {
  const r = await sendEmailInternal({
    from_account: 'raffaele', to: ['cliente@esempio.it'], subject: 'Offerta',
    body: 'RESTRUKTURA S.r.l. — P.IVA 02087420762', request_id: 'r1',
  }, { bypassUserConfirmation: true })
  expect(r.ok).toBe(false)
  expect(String(r.error ?? r.message)).toContain('02087420762')
  // La prova che conta: il trasporto non e' stato nemmeno aperto.
  expect(transportMock.sendMail).not.toHaveBeenCalled()
})

it('CONTROLLO NEGATIVO — un INOLTRO che nomina l\'altra societa\' PARTE', async () => {
  const r = await sendEmailInternal({
    from_account: 'raffaele', to: ['commercialista@esempio.it'], subject: 'Fwd: pratica',
    body: 'In allegato la pratica di LA REAL ESTATE SRLS — P.IVA 02232730768',
    contenuto_di_terzi: true, request_id: 'r2',
  }, { bypassUserConfirmation: true })
  expect(r.ok).toBe(true)
  expect(transportMock.sendMail).toHaveBeenCalledTimes(1)
})

it('CONTROLLO NEGATIVO — lettera con la societa\' GIUSTA parte', async () => { /* … */ })

it('la guardia gira PRIMA della coda di conferma: una mail bloccata non deve creare un pending', async () => {
  // altrimenti resta in sospeso una mail che non potra' mai partire, e
  // l'Ingegnere la ritrova senza capire perche'
})
```

- [ ] **Step 2: eseguire, verificare il fallimento**

Run: `npx vitest run src/v19/tools/email/send-email.guardia-societa.test.ts`

- [ ] **Step 3: implementare** — la guardia in cima a `sendEmailInternal`, **prima**
  di `createPendingSend` e prima di qualunque contatto col trasporto. Salta se
  `input.contenuto_di_terzi === true`. Su blocco restituisce l'esito d'errore con
  `messaggioBlocco`, **senza** creare il pending e **senza** scrivere `logEmail`
  come se un invio fosse stato tentato: un guasto non deve lasciare tracce che
  somiglino a un invio.

- [ ] **Step 4: impostare `contenuto_di_terzi: true`** in `forward-email.ts:58` e
  `pack-emails-and-send.ts:172`, con un commento che dica **perché** (il corpo è di
  terzi), non solo che è così.

- [ ] **Step 5: suite + typecheck**

- [ ] **Step 6: mutazione** — togliere il salto su `contenuto_di_terzi`: deve morire
  il controllo negativo dell'inoltro. Questa mutazione è la più importante del task,
  perché prova che il **falso positivo** è davvero coperto da un test e non solo da
  un'intenzione scritta nel commento. `cp` di backup, `perl -0pi`, `grep -c` che
  provi il morso, `md5sum` identico dopo il ripristino.

- [ ] **Step 7: commit** — `git commit -m "una lettera non parte con la partita IVA di un'altra societa'"`

---

### Task 10: Drive — l'ultima superficie, e la chiusura del censimento

**Perché esiste questo task.** Censite **tutte** le strade per cui un contenuto
scritto dal modello diventa un documento consegnabile, ne restavano due non
coperte, entrambe su Google Drive. Un documento archiviato con la partita IVA
sbagliata è meno grave di una mail spedita — si cancella — ma è più insidioso nel
tempo: un preventivo finito nella cartella del cliente viene ritrovato e **usato**
mesi dopo, quando nessuno si ricorda com'è nato.

**Il censimento completo, per il verbale** (misurato il 12 set 2026):

| # | Superficie | Copertura |
|---|---|---|
| 1 | `genera_pdf` / `genera_word` (`tools.ts:71`, `:84`) → imbuti di rendering | Task 5 |
| 2 | blocco `~~~document` del modello → `documents` (web e Telegram) | Task 4 |
| 3 | preventivo / CME / QE (`studio-tecnico.ts:986`) → `documents` | Task 4 |
| 4 | auto-bozza (`artifact-capture.ts:169`) → `documents` | Task 4 |
| 5 | modifica di una bozza (`draft-tools.ts:186`) → `documents` | Task 4 |
| 6 | Allegato 10 / SR41 CIGO → `renderDocx` | Task 5 (guardia sui **dati** della pratica) |
| 7 | invio mail (`sendEmailInternal`) | Task 9 |
| 8 | `salva_documento_su_drive` (`drive.ts:1155`, schema `:1413`) | **questo task** |
| 9 | `drive_create_document` (`drive.ts:1346`) | **questo task** |
| — | invio documenti su Telegram | nessuna: i documenti viaggiano come **link**, non come file |

**Files:**
- Modify: `src/lib/drive.ts` — i due `case` dell'executor (`:1155` e quello di `drive_create_document`)
- Test: `src/lib/drive.guardia-societa.test.ts`

**Interfaces:** consuma `verificaDatiSocietari`, `messaggioBlocco` (Task 1) e
`societaPerDocumento` (Task 3). Nessuna interfaccia nuova.

**Dove mettere la guardia.** Nei due `case`, **prima** di qualunque chiamata a
Google: una guardia che scatta dopo la scrittura non è una guardia, è un
commento. Su blocco il tool restituisce `messaggioBlocco(...)` come stringa di
errore — il `try/catch` per-tool di `claude.ts:1126` lo consegna all'Ingegnere su
entrambi i canali, quindi l'equipollenza qui è strutturale e non serve un test
per canale suo.

**⚠️ Da verificare e riferire, non da decidere di tua iniziativa:**
`archivia_documento` (`drive.ts:1178`). Se archivia un documento **già esistente**
per id, il suo contenuto è già passato dalla guardia a monte e guardarlo di nuovo
aggiungerebbe solo un secondo modo di sbagliare. Se invece riceve contenuto dal
modello, è una decima superficie e va coperta come le altre. **Leggi il `case` e
scrivi nel rapporto quale dei due casi è.**

- [ ] **Step 1: i test che falliscono**

```ts
it('CONTROLLO POSITIVO — salva_documento_su_drive con la P.IVA di Restruktura e La Real Estate attiva: NON scrive su Drive', async () => {
  const out = await executeDriveTool('salva_documento_su_drive', {
    title: 'Preventivo', document_type: 'preventivo',
    html_content: '<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p>',
  }, 'conv-lre')
  expect(String(out)).toContain('02087420762')
  expect(String(out)).toContain('02232730768')
  // la prova che conta: nessuna chiamata a Google
  expect(driveFilesCreate).not.toHaveBeenCalled()
})

it('CONTROLLO NEGATIVO — societa\' coerente: scrive, e la guardia non interferisce', async () => { /* … */ })

it('CONTROLLO NEGATIVO — la P.IVA del COMMITTENTE nel corpo non blocca niente', async () => { /* … */ })

it('drive_create_document: stessa guardia sullo stesso contenuto', async () => { /* … */ })
```

- [ ] **Step 2: eseguire, verificare il fallimento**
- [ ] **Step 3: implementare** nei due `case`, prima di ogni chiamata a Google
- [ ] **Step 4: leggere `archivia_documento` e riferire** quale dei due casi è (vedi sopra)
- [ ] **Step 5: suite + typecheck**
- [ ] **Step 6: mutazione** — disattivare la guardia in `salva_documento_su_drive`: deve morire il controllo positivo. `cp` di backup, `perl -0pi`, `grep -c` che provi il morso, `md5sum` identico dopo il ripristino
- [ ] **Step 7: commit** — `git commit -m "anche su Drive un documento non si archivia con la partita IVA di un'altra societa'"`

---

### Task 11: le operazioni contabili non girano sull'azienda indovinata

**Perché questo task esiste, e perché è il più importante dopo il Task 4.**

`src/lib/tools.ts:844`:

```ts
async function societaDellaConversazione(conversationId?: string): Promise<CodiceSocieta> {
  const { getSocietaAttiva } = await import('./societa-attiva')
  return getSocietaAttiva(conversationId)
}
```

`getSocietaAttiva` su errore di database restituisce `restruktura`. Quindi un
guasto transitorio nella lettura, mentre l'Ingegnere lavora su La Real Estate,
farebbe girare **ogni operazione contabile sull'azienda sbagliata, in silenzio**:
è il wrapper `contabile` (`:867`) che serve **cinque** esecutori — `fic_*`,
`FIC_WRITE_TOOLS`, riconciliazione, prima nota, movimenti.

Una fattura emessa o un pagamento registrato sull'azienda sbagliata è **peggio di
un documento sbagliato**: un documento si rigenera, una fattura elettronica
trasmessa no.

**E il codice già sa che non si deve indovinare.** Venti righe sopra, a `:872`:

```ts
if (!conversationId) return senzaConversazione(name)
```

col commento: *«Senza conversazione la società non è determinabile, e
un'operazione contabile NON deve ricadere su un default: è come sceglierla a
caso, cioè il difetto che questo ramo elimina. Meglio rifiutare dicendolo.»*

Il ragionamento è già quello giusto. È applicato a **una** delle due strade per
«non lo sappiamo» e non all'altra: *una correzione applicata a metà è il difetto
della giornata.*

**Files:**
- Modify: `src/lib/tools.ts` — `societaDellaConversazione` (`:844`), `senzaConversazione` (`:860`), `contabile` (`:867`)
- Test: `src/lib/tools.contabile-societa.test.ts` (creare)

**Interfaces:**
- Consumes: `leggiSocietaAttiva` da `./societa-attiva` (Task 2) — restituisce
  `{ ok: true; codice; esplicita } | { ok: false; errore }`
- Produces: nessuna interfaccia pubblica nuova. `contabile` guadagna un ramo di
  rifiuto; la firma degli esecutori **non cambia**.

**Il disegno.** `societaDellaConversazione` passa a `leggiSocietaAttiva` e
restituisce un esito, non un codice:

```ts
async function societaDellaConversazione(
  conversationId: string,
): Promise<{ ok: true; codice: CodiceSocieta } | { ok: false; errore: string }> {
  const { leggiSocietaAttiva } = await import('./societa-attiva')
  const e = await leggiSocietaAttiva(conversationId)
  return e.ok ? { ok: true, codice: e.codice } : { ok: false, errore: e.errore }
}
```

e `contabile` rifiuta come già rifiuta senza conversazione — **stesso formato**,
perché il modello e l'Ingegnere devono leggere la stessa forma per la stessa
categoria di problema:

```ts
const contabile = (esecutore, appartiene) => async (name, input, conversationId?) => {
  if (!appartiene(name)) return null
  if (!conversationId) return senzaConversazione(name)
  const s = await societaDellaConversazione(conversationId)
  // Una lettura fallita NON e' una societa'. Vale qui esattamente il motivo
  // scritto sopra per la conversazione assente: un'operazione contabile non
  // ricade su un default, perche' equivale a sceglierla a caso. La differenza
  // e' che quella strada era chiusa e questa era aperta.
  if (!s.ok) return societaNonLeggibile(name, s.errore)
  return esecutore(name, input, s.codice)
}
```

con `societaNonLeggibile` accanto a `senzaConversazione`, nella stessa forma
(`JSON.stringify({ ok: false, error: … })`), e un testo che **nomina il guasto**:
`${name}: non riesco a leggere quale societa' e' attiva (${errore}). Non eseguo
un'operazione contabile senza saperlo: dimmi su quale societa' stiamo lavorando.`

⚠️ **Niente underscore nel messaggio** e **nessun nome di comando**: `/societa`
esiste solo su Telegram, e su Markdown un `nome_con_underscore` arriva mutilato.
Il messaggio esistente di `senzaConversazione` dice «Usa /societa per
dichiararla»: **va corretto anche quello**, per la stessa ragione, ed è parte di
questo task.

- [ ] **Step 1: scrivere i test che falliscono**

```ts
// Lo stato del finto database vive fuori dal mock, come in societa-attiva.test.ts
let esitoSocieta: unknown = { ok: true, codice: 'larealestate', esplicita: true }
vi.mock('./societa-attiva', () => ({
  leggiSocietaAttiva: async () => esitoSocieta,
  getSocietaAttiva: async () => 'restruktura',
  setSocietaAttiva: async () => ({ ok: true }),
  bloccoSocietaAttiva: () => '',
}))

it('CONTROLLO POSITIVO — lettura della societa fallita: il tool contabile NON viene eseguito', async () => {
  esitoSocieta = { ok: false, errore: 'connessione persa' }
  const out = await executeTool('fic_lista_fatture', {}, 'conv-1')
  const j = JSON.parse(String(out))
  expect(j.ok).toBe(false)
  expect(j.error).toContain('connessione persa')
  // la prova che conta: l'esecutore non e' stato chiamato
  expect(spiaEsecutore).not.toHaveBeenCalled()
})

it('CONTROLLO NEGATIVO — societa leggibile: il tool gira, e gira sulla societa GIUSTA', async () => {
  esitoSocieta = { ok: true, codice: 'larealestate', esplicita: true }
  await executeTool('fic_lista_fatture', {}, 'conv-1')
  expect(spiaEsecutore).toHaveBeenCalledWith('fic_lista_fatture', {}, 'larealestate')
})

it('senza conversazione rifiuta come prima (comportamento invariato)', async () => {
  const out = await executeTool('fic_lista_fatture', {}, undefined)
  expect(JSON.parse(String(out)).ok).toBe(false)
})

it('un tool NON contabile non e\' toccato da questa guardia', async () => {
  esitoSocieta = { ok: false, errore: 'connessione persa' }
  // cerca_documenti non e' contabile: deve funzionare anche se la societa' non si legge
})

it('i messaggi di rifiuto non contengono underscore ne comandi slash', async () => {
  // su Telegram il Markdown mangia gli underscore, e /societa non esiste sul web
  esitoSocieta = { ok: false, errore: 'x' }
  const a = String(await executeTool('fic_lista_fatture', {}, 'conv-1'))
  const b = String(await executeTool('fic_lista_fatture', {}, undefined))
  for (const msg of [JSON.parse(a).error, JSON.parse(b).error]) {
    expect(msg).not.toMatch(/_/)
    expect(msg).not.toMatch(/\/[a-z]+/)
  }
})
```

- [ ] **Step 2: eseguire, verificare che FALLISCANO**

Run: `npx vitest run src/lib/tools.contabile-societa.test.ts`

- [ ] **Step 3: implementare** come sopra. **Cinque** esecutori passano da
  `contabile`: verificare che tutti e cinque siano coperti dal rifiuto (basta il
  wrapper, ma va **verificato**, non assunto — elencarli nel rapporto).

- [ ] **Step 4: correggere anche `senzaConversazione`** — via `/societa`, via
  gli underscore se ce ne sono.

- [ ] **Step 5: suite intera + typecheck**

- [ ] **Step 6: mutazione** — far restituire `{ ok: true, codice: 'restruktura' }`
  al ramo d'errore di `societaDellaConversazione`, cioè **rimettere il difetto**.
  Deve morire il controllo positivo. `cp` di backup, `perl -0pi`, `grep -c` che
  provi il morso, `md5sum` identico dopo il ripristino.

- [ ] **Step 7: commit** — `git commit -m "una fattura non si emette sull'azienda indovinata"`

---

### Task 12: la via d'uscita — un blocco che non si può sciogliere è un vicolo cieco

**Perché questo task esiste, e perché è bloccante per il rilascio.**

`messaggioBlocco` (`src/lib/guardia-societa.ts:79-81`) dice all'Ingegnere:

> *Se e' voluto (per esempio l'altra societa' e' il committente), dimmelo e lo
> genero comunque.*

**Quel modo di procedere non esiste.** Se l'Ingegnere risponde «sì, è voluto,
genera comunque», il modello ritenta, la guardia blocca di nuovo, e si ottiene un
giro a vuoto — **esattamente la cosa di cui si è lamentato il 12 set 2026**:
*«mi ha chiesto conferma 4 volte senza inviarla davvero»*. Avremmo costruito
quella frustrazione dentro la difesa fatta per evitarla.

E il caso è **reale, non teorico**: le società sono due e fanno affari fra loro.
Un preventivo di Restruktura con **La Real Estate come committente** contiene
legittimamente la partita IVA de La Real Estate, nel campo committente. La
guardia lo blocca, perché non distingue l'intestazione dal corpo — e non può
farlo in modo affidabile guardando l'HTML (è scritto nella spec).

Quindi: o si toglie la promessa dal messaggio, o si costruisce la via d'uscita.
**Si costruisce**, perché il caso è legittimo e frequente abbastanza da contare.

**Files:**
- Create: `src/lib/guardia-autorizzazioni.ts`
- Create: `src/lib/guardia-autorizzazioni.test.ts`
- Modify: `src/lib/salva-documento.ts` (accetta un'autorizzazione già data)
- Modify: `src/lib/pdf-generator.ts` (idem, per i due imbuti)
- Modify: `src/lib/comandi-uuid.ts` — due voci in `COMANDI_CON_CODICE`
- Modify: `src/app/api/telegram/route.ts` e `src/app/api/chat/route.ts` — i due rami di comando
- Test: `src/app/api/chat/route.guardia-autorizza.test.ts`, `src/app/api/telegram/route.guardia-autorizza.test.ts`

**Il meccanismo, che esiste già e va riusato — non inventato.**

Questo repo ha il suo schema per «mi serve il tuo OK esplicito, e deve essere
tappabile dal telefono»: `comandoDaMostrare('nome', uuid)` produce un comando con
codice di 16 cifre esadecimali, e i due canali lo riconoscono.

⚠️ **Verificato il 12 set 2026, e smentisce una mia affermazione precedente:** i
comandi **con codice** (`/nome_CODICE`) funzionano su **entrambi** i canali — il
web li gestisce a `src/app/api/chat/route.ts:182` via `comandoUuid`. Sono i
comandi **nudi** come `/societa` a essere solo di Telegram
(`telegram/route.ts:557`). Quindi un codice tappabile è **equipollente per
costruzione**, ed è la forma che l'Ingegnere ha chiesto esplicitamente:
*«io clicco e copia e mi copia il codice»*.

**Il disegno:**

```ts
export type Autorizzazione = {
  uuid: string
  conversationId: string
  /** md5 del contenuto autorizzato: autorizza QUEL documento, non «tutti». */
  impronta: string
  /** Le partite IVA che l'Ingegnere ha accettato di vedere nel documento. */
  piveAccettate: string[]
  scadenza: number
}

/** Registra un blocco in attesa e restituisce il codice da mostrare. */
export async function chiediAutorizzazione(
  conversationId: string,
  contenuto: string,
  esito: Extract<EsitoGuardia, { ok: false }>,
): Promise<{ uuid: string }>

/** L'Ingegnere ha tappato il codice. */
export async function concediAutorizzazione(uuid: string): Promise<{ ok: true } | { ok: false; motivo: string }>

/** Chi genera chiede: questo contenuto e' gia' autorizzato? */
export async function autorizzazioneValida(conversationId: string, contenuto: string): Promise<boolean>
```

**Le cinque scelte che rendono questa via d'uscita sicura, e il perché di ognuna:**

1. **L'autorizzazione è legata all'IMPRONTA del contenuto**, non alla
   conversazione. Autorizzare «questa conversazione» significa spegnere la
   guardia per tutto il resto della giornata: il primo documento sarebbe
   controllato e i dieci dopo no. Un'autorizzazione che vale per tutto è la
   guardia disattivata con un nome gentile.
2. **Scade.** Trenta minuti: il tempo di leggere e tappare, non il tempo di
   dimenticarsene. Il repo ha già `PROPOSTA_TTL_MS` come precedente.
3. **La concede l'INGEGNERE tappando, non il modello.** Nessun parametro di tool
   che il modello possa impostare da sé: se potesse, la guardia dipenderebbe dal
   giudizio che la guardia esiste per non dover usare. Il codice arriva da
   `comandoDaMostrare` e il ramo che lo consuma sta **nei route dei canali**, dove
   il modello non arriva.
4. **Dice cosa autorizza.** Il messaggio con il codice nomina le partite IVA che
   comparirebbero e la società attiva: si autorizza una cosa che si è letta.
5. **Si usa una volta.** Consumata alla prima generazione riuscita. Una
   autorizzazione riutilizzabile è un'autorizzazione dimenticata.

**Dove tenerla.** Tabella Supabase nuova (`cervellone_guardia_autorizzazioni`)
con **RLS attiva** — 57 tabelle su 57 ce l'hanno, e una tabella nuova senza RLS è
il difetto che l'11 set è passato inosservato nel piano. Migrazione nel repo.
⚠️ La chiave primaria è `uuid` (testo), **non** un `id`: non scrivere
`.select('id')` su questa tabella — è letteralmente il difetto delle mail in
sospeso, vissuto in produzione per tre mesi.

- [ ] **Step 1: i test che falliscono**

```ts
it('CONTROLLO POSITIVO — senza autorizzazione il documento resta bloccato', async () => { /* … */ })

it('con autorizzazione valida per QUESTO contenuto, il documento si salva', async () => { /* … */ })

it('CONTROLLO POSITIVO — l\'autorizzazione NON vale per un contenuto diverso', async () => {
  // autorizza il contenuto A, poi prova a salvare il contenuto B: deve bloccare.
  // E' la prova che non abbiamo spento la guardia per la conversazione.
})

it('CONTROLLO POSITIVO — scaduta non vale', async () => { /* … */ })

it('CONTROLLO POSITIVO — usata una volta, non vale la seconda', async () => { /* … */ })

it('il messaggio col codice NOMINA le partite IVA che si stanno autorizzando', async () => {
  // si autorizza una cosa che si e' letta, non un codice al buio
})

it('il codice e\' tappabile: 16 cifre esadecimali, nessun trattino, sotto i 32 caratteri', async () => {
  // Telegram tronca al primo trattino e il bot_command si ferma a 32 caratteri
})
```

- [ ] **Step 2: eseguire, verificare il fallimento**
- [ ] **Step 3: la migrazione** (tabella + **RLS**), poi il modulo
- [ ] **Step 4: consumo dell'autorizzazione** in `salva-documento.ts` e nei due imbuti di `pdf-generator.ts`
- [ ] **Step 5: i due rami di comando**, uno per canale, che chiamano `concediAutorizzazione`. `doc_ok` e `doc_no` in `COMANDI_CON_CODICE`. Su Telegram il messaggio che porta un comando va in **testo semplice** — `contieneComandoConCodice` lo decide già da sé guardando il contenuto: **non passare `parse_mode` a mano.**
- [ ] **Step 6: i due test di canale.** Devono provare: il codice **arriva**, è **tappabile**, e tapparlo **fa uscire il documento**. Più il controllo positivo: senza tappare, il documento non esce. **I due test devono mockare lo stesso insieme di moduli**: i test di canale esistenti mockano insiemi diversi e per questo non sono confrontabili (vedi `note-task-6.md`).
- [ ] **Step 7: aggiornare `messaggioBlocco`** perché il codice ci finisca dentro, e perché la frase «dimmelo e lo genero comunque» diventi **vera**: `Per generarlo comunque → /doc_ok_<codice>`. Niente underscore nel resto del testo (il Markdown li mangia) — l'invariante è già testata.
- [ ] **Step 8: suite + typecheck + mutazione** (fai valere l'autorizzazione per qualunque contenuto: devono morire i controlli positivi 3 e 5)
- [ ] **Step 9: commit** — `git commit -m "il blocco si puo' sciogliere con un codice tappabile, una volta, per quel documento"`

---

### Task 13: la marcatura massiva rifiuta sempre — e per il motivo sbagliato

**Trovato in produzione il 12 set 2026**, leggendo `cervellone_tool_calls` e `messages`
dopo una segnalazione di Raffaele. Dettaglio completo in
`.superpowers/sdd/2026-09-12-guardia-dati-societari/diagnosi-limongi-modalita-pagamento.md`.

**Il difetto, in due parti che si sommano.**

`src/lib/fic-pagamenti.ts:268-291`, `cercaFattureRicevute`:

```ts
const r = await ficGet(`/c/${company.id}/received_documents`, {
  type: 'expense', q: filtroData(...), per_page: 100, sort: '-date', fieldset: 'detailed',
})                                        // ← nessun filtro fornitore nella query
const documenti = cercato ? lista.filter(d => …entity.name…includes(cercato)) : lista
const ultima = numero(oggetto(r.data).last_page) ?? 1
return { ok: true, valore: { documenti, altre_pagine: ultima > 1 } }   // ← paginazione dell'insieme NON filtrato
```

1. **Rifiuta sempre.** Restruktura riceve più di 100 fatture in un anno →
   `last_page > 1` → `altre_pagine = true` → `fic-write-tools.ts:711` rifiuta, anche per
   7 fatture. **Il tool consegnato la mattina del 12 set era inutilizzabile**, e in
   produzione Raffaele ci ha sbattuto contro.
2. **Potrebbe mostrare un insieme incompleto.** Il filtro gira **in memoria sulla prima
   pagina**: le fatture di quel fornitore che stanno a pagina 2 **non si vedono**. Se il
   rifiuto non scattasse, una conferma unica coprirebbe un sottoinsieme presentato come
   l'insieme — che è **esattamente** quello che il commento del file dichiara inaccettabile:
   *«un elenco incompleto che sembra completo è la cosa peggiore che possa precedere una
   conferma unica per tutte»*. **Il ragionamento era giusto e l'implementazione lo viola.**

E il messaggio di rifiuto (`fic-write-tools.ts:711-717`) usa **un solo testo per due cause
diverse** — «sono troppe» e «non le vedo tutte» — quindi con 7 fatture diceva *«la selezione
tocca più di 7 fatture, oltre il tetto di 50»*. Il bot l'ha riferito a Raffaele come
*«7 non supera 50, il messaggio sembra incoerente/bacato»*. Aveva ragione.

**Files:**
- Modify: `src/lib/fic-pagamenti.ts` — `cercaFattureRicevute` (`:268-291`), `PER_PAGE` (`:247`)
- Modify: `src/lib/fic-write-tools.ts:711-717` — il rifiuto, due messaggi invece di uno
- Test: `src/lib/fic-pagamenti.paginazione.test.ts` (creare)

**Interfaces:**
```ts
export async function cercaFattureRicevute(
  filtri: FiltriRicerca,
  societa: CodiceSocieta,
): Promise<EsitoFic<{
  documenti: Record<string, unknown>[]
  /** Vero solo se abbiamo esaurito il tetto di pagine SENZA finire l'elenco. */
  elenco_troncato: boolean
  /** Quante pagine abbiamo letto: va nel messaggio, cosi' il limite e' visibile. */
  pagine_lette: number
}>>
```
`altre_pagine` → **`elenco_troncato`**, perché il nome vecchio descriveva la paginazione di
FIC e quello nuovo descrive **la nostra completezza**, che è la cosa che conta.

**Il disegno: si cammina sulle pagine, non si scommette su un filtro non documentato.**

⚠️ Ricerca già fatta (fonte: `github.com/fattureincloud/openapi-fattureincloud`, docs
`developers.fattureincloud.it/docs/basics/filter-results/queries/`): la grammatica di `q`
è documentata (`and`, `contains`, `=`, ecc.) **ma NON esiste alcuna fonte ufficiale che
elenchi i campi filtrabili di `received_documents`**. `entity.name` ed `entity.id` come
campi filtrabili su quell'endpoint sono **inferenza, non documentazione**. `per_page`
massimo **100** (questo è documentato).

Quindi **non** si fa dipendere la correttezza da un comportamento non documentato:

1. si cammina sulle pagine (`current_page` → `last_page`) con `per_page: 100`, fino a un
   tetto di pagine (`MAX_PAGINE = 10`, cioè 1.000 fatture: abbondante per un anno)
2. si filtra il fornitore **in memoria su tutte le pagine lette**, non solo sulla prima
3. `elenco_troncato` è vero **solo** se il tetto di pagine è stato raggiunto **e**
   `last_page` è ancora oltre: allora sì, l'elenco potrebbe essere incompleto e lo si dice
4. **in più**, come ottimizzazione e non come garanzia: si può provare ad aggiungere il
   filtro fornitore alla `q`. Se si fa, va **verificato** che abbia morso confrontando
   `total` con e senza filtro, e il camminamento sulle pagine resta comunque. Un filtro
   server-side che non funziona deve degradare in lentezza, **non** in un elenco incompleto.
   Se non vuoi aggiungere questa parte, **non aggiungerla**: il punto 1-3 è sufficiente e
   non dipende da nulla di incerto.

- [ ] **Step 1: i test che falliscono**

```ts
it('IL DIFETTO: con piu di una pagina di fatture, oggi rifiuta anche per 7 risultati filtrati', async () => {
  // mock ficGet: pagina 1 con 100 documenti di cui 7 del fornitore, last_page: 3
  // PRIMA: altre_pagine === true → il chiamante rifiuta
  // DOPO: cammina su 3 pagine, trova tutte le fatture del fornitore, elenco_troncato === false
})

it('CONTROLLO POSITIVO — le fatture del fornitore a pagina 2 e 3 vengono trovate', async () => {
  // mock: il fornitore ha 2 fatture in pagina 1, 3 in pagina 2, 1 in pagina 3 → devono essere 6
  // E' la prova che l'insieme non e' piu' incompleto.
})

it('elenco_troncato e vero SOLO se il tetto di pagine non basta', async () => {
  // mock: last_page = 20, MAX_PAGINE = 10 → elenco_troncato true, pagine_lette 10
})

it('una sola pagina: nessun giro in piu e elenco_troncato falso', async () => {
  // mock: last_page = 1 → una sola chiamata a ficGet (verificare il conteggio delle chiamate)
})

it('i due rifiuti hanno DUE messaggi distinti', async () => {
  // troppe fatture → il messaggio nomina il tetto di 50
  // elenco troncato → il messaggio dice che non le vediamo tutte, e NON nomina il tetto di 50
  // Un rifiuto che dichiara il motivo sbagliato manda a caccia del problema inesistente.
})
```

- [ ] **Step 2: eseguire, verificare il fallimento**
- [ ] **Step 3: implementare** il camminamento sulle pagine e i due messaggi distinti
- [ ] **Step 4: verificare i chiamanti** di `cercaFattureRicevute`: chi leggeva
  `altre_pagine` va aggiornato. Il typecheck è la prova.
- [ ] **Step 5: suite + typecheck**
- [ ] **Step 6: mutazione** — rimettere il filtro sulla sola prima pagina: deve morire il
  controllo positivo delle fatture a pagina 2 e 3. `cp`, `perl -0pi`, **`grep -c` che provi
  il morso**, `md5sum` identico dopo il ripristino.
- [ ] **Step 7: commit** — `git commit -m "la marcatura massiva guardava solo la prima pagina, e rifiutava per il motivo sbagliato"`

---

### Task 14: leggere cosa ha scritto il fornitore sulla fattura

**Il fatto, dal registro di produzione.** Per tre ore il bot ha risposto che sulla fattura
non c'era scritta nessuna modalità di pagamento. L'esercente aveva scritto «pagamento
contanti». `fic_dettaglio_documento` era stato chiamato **29 volte**: non è che non
guardasse — guardava **il campo sbagliato**.

`payments_list[].payment_account` è **il conto con cui NOI registriamo il pagamento**. La
`ModalitaPagamento` dell'XML SDI (MP01 contanti, MP08 carta) è **quello che scrive il
fornitore**. Il bot ha riportato l'assenza del primo come assenza del secondo, e alle 17:44
è arrivato a dire *«nel corpo di questa fattura non c'è scritta nessuna modalità di
pagamento»* — un'affermazione **sul contenuto della fattura**, fatta guardando un campo che
non è il contenuto della fattura.

⚠️ **Ricerca già fatta, e la risposta è NO** (fonti: `openapi-fattureincloud`, schema
`ReceivedDocument.yaml` e `ReceivedDocumentPaymentsListItem.yaml`): la `ModalitaPagamento`
del fornitore **non è esposta da nessun campo** dei documenti ricevuti. Non esistono
`payment_method`, `ei_data`, `ei_raw`, `notes` su `ReceivedDocument`. `ei_payment_method`
esiste ma appartiene a `PaymentMethod`, usato sui documenti **emessi**. E gli endpoint
`e_invoice/xml` esistono **solo** sotto `issued_documents`, non sotto `received_documents`.

**Ma `ReceivedDocument` espone `attachment_url`** (URL temporaneo, `readOnly`), cioè il
file della fattura conservato da FIC. Quella è la strada.

**Files:**
- Modify: `src/lib/drive.ts` — estrarre da `readPdfFromDrive` (`:423`) un helper riusabile
- Create: `src/lib/fic-allegato.ts` — scarica l'allegato e ne estrae il testo
- Modify: `src/lib/fatture-in-cloud.ts` — il tool nuovo, e la **chiarezza** su `mapDoc`
- Test: `src/lib/fic-allegato.test.ts`

**Interfaces:**
```ts
/** Il testo di un PDF, da un buffer. Estratto da readPdfFromDrive per riuso. */
export async function testoDaPdf(buffer: Buffer, nome: string): Promise<{ ok: true; testo: string; pagine: number } | { ok: false; errore: string }>

export type EsitoAllegato =
  | { ok: true; formato: 'xml' | 'pdf' | 'altro'; testo: string; modalita_sdi?: string; modalita_leggibile?: string }
  | { ok: false; motivo: 'nessun_allegato' | 'scaricamento' | 'illeggibile'; messaggio: string }

export async function leggiAllegatoFatturaRicevuta(id: number, societa: CodiceSocieta): Promise<EsitoAllegato>
```

**Tre cose che questo task deve fare, e la terza è la più importante:**

1. **Scaricare e leggere l'allegato.** XML → si estrae `<ModalitaPagamento>` e si traduce
   (`MP01` = contanti, `MP02` = assegno, `MP05` = bonifico, `MP08` = carta di pagamento, e
   si restituisce **anche il codice grezzo** quando non è in tabella: un codice ignoto va
   detto, non nascosto). PDF → si estrae il testo e lo si restituisce, così il modello legge
   «pagamento contanti» dov'è scritto.
2. **Un tool nuovo**, perché *per una funzione nuova serve un tool*: il bot non deve
   indovinare che può scaricare l'allegato. Nome suggerito: `fic_leggi_allegato_fattura`.
3. **`mapDoc` (`fatture-in-cloud.ts:337`) deve NOMINARE la differenza.** Oggi restituisce
   `pagamenti_count: 1` e nient'altro sul pagamento: il modello vede un numero e conclude.
   Deve restituire un campo che dica **che cosa è** e **che cosa non è**, per esempio:
   ```ts
   pagamento_registrato_da_noi: 'Carta di credito (CC Montepruno)' | null,
   modalita_scritta_dal_fornitore: 'non leggibile da questo campo: usa fic_leggi_allegato_fattura',
   ```
   **Questa terza parte è la cura del difetto vero.** Le prime due danno al bot lo
   strumento; questa gli impedisce di **affermare** una cosa che non ha guardato. Senza di
   essa, il prossimo modello rifarà esattamente le stesse tre ore.

- [ ] **Step 1: i test che falliscono** — un XML SDI finto con `<ModalitaPagamento>MP01`
  deve dare `modalita_sdi: 'MP01'` e `modalita_leggibile: 'contanti'`; un codice ignoto
  (`MP99`) deve restituire il codice e dichiararlo non in tabella; nessun allegato →
  `motivo: 'nessun_allegato'` con un messaggio che **dice cosa fare**, non «non trovato»
- [ ] **Step 2: eseguire, verificare il fallimento**
- [ ] **Step 3: `testoDaPdf` estratto da `readPdfFromDrive`** — ⚠️ `readPdfFromDrive` deve
  continuare a funzionare **identico**: è in produzione. Il polyfill di `DOMMatrix` e il
  `parser.destroy()` nel `finally` vanno nell'helper, non persi.
- [ ] **Step 4: `leggiAllegatoFatturaRicevuta`** e il tool nuovo
- [ ] **Step 5: `mapDoc` che nomina la differenza** fra i due campi
- [ ] **Step 6: suite + typecheck**
- [ ] **Step 7: mutazione** — far sparire `modalita_scritta_dal_fornitore` da `mapDoc`:
  deve morire un test. È la parte che impedisce al modello di affermare quello che non sa.
- [ ] **Step 8: commit** — `git commit -m "leggere cosa ha scritto il fornitore sulla fattura, e non spacciare il nostro campo per il suo"`

**Dichiarazione onesta del limite, da riportare nel rapporto:** l'unica verifica che manca è
**cosa contiene davvero `attachment_url`** per una fattura ricevuta via SDI — se l'XML
originale o un PDF di cortesia. Non è verificabile senza un token FIC vero, che in locale
non c'è (le variabili sono *Sensitive* su Vercel e tornano vuote). Il codice va scritto per
gestire **entrambi** i casi e per **dire quale ha trovato**; la prima chiamata vera in
produzione lo dirà. **Non scrivere nel messaggio all'Ingegnere una promessa sul formato.**

---

### Task 15: scremare un gruppo di fatture per la modalità che ha scritto il fornitore

**Le parole di Raffaele, il 12 set 2026 (dopo aver mandato lo screenshot della fattura
2/1144 che riporta `MP01 Contanti`):**

> *«Ovviamente può mettere o contanti, o bonifico, può mettere l'IBAN, può mettere assegno,
> può mettere carta di pagamento, oppure può anche dimenticarsi e non mettere nulla. Però se
> io ti dico di controllare, se c'è, tu devi saperlo fare e dirmelo, in modo da scremare le
> fatture — tipo in quel caso di prima dovevo scremare le fatture che avevano il contante
> perché significa che erano state pagate al momento del ritiro.»*

**Perché il Task 14 non basta.** Il Task 14 dà
`leggiAllegatoFatturaRicevuta(id, societa)`: **una** fattura per chiamata. Per sei fatture
servono sei chiamate, e nulla garantisce che il modello le faccia **tutte** — è esattamente
il tipo di lavoro sistematico che un modello salta quando si annoia, e il difetto sarebbe
peggiore di prima: un elenco **parziale** che sembra completo.

Il verbo che Raffaele usa è **«scremare»**: si parte da un gruppo e si divide in due. È
un'operazione sull'insieme, non sul singolo.

**Files:**
- Modify: `src/lib/fic-allegato.ts` — la funzione sull'insieme
- Modify: `src/lib/fatture-in-cloud.ts` — il tool nuovo
- Modify: `src/lib/fic-write-tools.ts` — il filtro nel tool di marcatura massiva
- Test: `src/lib/fic-allegato.insieme.test.ts`

**Interfaces:**
```ts
/** Una riga del prospetto: cosa ha scritto il fornitore su QUELLA fattura. */
export type ModalitaPerFattura = {
  id: number
  numero: string | null
  data: string | null
  importo: number | null
  /** Il codice SDI grezzo, quando c'e'. */
  codice_sdi: string | null
  /** L'etichetta leggibile, quando il codice e' in tabella. */
  modalita: string | null
  /**
   * TRE esiti distinti, mai schiacciati in uno:
   *  - 'dichiarata'      → il fornitore l'ha scritta, ed e' in `modalita`
   *  - 'non_dichiarata'  → l'abbiamo letta e il fornitore NON l'ha messa
   *  - 'non_leggibile'   → non siamo riusciti a leggere l'allegato (e `perche` lo dice)
   */
  esito: 'dichiarata' | 'non_dichiarata' | 'non_leggibile'
  perche?: string
}

export async function modalitaDichiarateDalFornitore(
  filtri: FiltriRicerca,
  societa: CodiceSocieta,
): Promise<EsitoFic<{ righe: ModalitaPerFattura[]; elenco_troncato: boolean; non_leggibili: number }>>
```

⭐ **`non_dichiarata` e `non_leggibile` sono due cose diverse, e tenerle separate è il punto
di tutto questo task.** «Il fornitore non l'ha scritta» è un **dato** su cui Raffaele
decide; «non sono riuscito a leggere l'allegato» è un **guasto** che deve sapere. Averle
confuse è precisamente ciò che gli è costato tre ore: il bot diceva «non c'è» quando il
significato vero era «non l'ho guardato». Un tool che restituisce `null` per entrambi i casi
ricrea il difetto in forma nuova, e sarebbe peggio perché stavolta l'avremmo scritto
sapendo.

**Il tool:** `fic_modalita_pagamento_fornitore`, con `fornitore`, `anno`, `mese` come
`segna_fatture_ricevute_pagate`, così la stessa selezione si descrive allo stesso modo.

**Il filtro nella marcatura massiva.** `segna_fatture_ricevute_pagate` guadagna
`solo_modalita_fornitore?: string[]` (per esempio `['contanti','carta']`): restringe la
selezione a quelle in cui **il fornitore** ha dichiarato una di quelle modalità.

⚠️ **E qui la regola più importante del task:** se anche **una sola** fattura della
selezione ha `esito: 'non_leggibile'`, il filtro **non si applica in silenzio**. Si
dichiara: *«di N fatture, M non sono leggibili: il filtro le lascia fuori, e non so se
dovevano starci»*. Una scrematura fatta su un insieme che non abbiamo potuto leggere per
intero è una scrematura che sbaglia senza dirlo — e questa volta il risultato non è un
elenco, è una **scrittura su un gestionale fiscale**.

**Cose che vanno riusate, non riscritte:**
- il camminamento sulle pagine del Task 13 (`cercaFattureRicevute`): la selezione si prende
  da lì, così `elenco_troncato` continua a significare «il mio elenco è incompleto»
- `leggiAllegatoFatturaRicevuta` del Task 14 per ogni riga
- il lettore PDF (`testoDaPdf`) e la tabella dei codici SDI già scritti

**Il costo, da dichiarare:** una chiamata di rete per fattura. Per 6 fatture va bene; per 50
no. Quindi un tetto (`MAX_ALLEGATI = 30`) e, se la selezione lo supera, **rifiuto
dichiarato** con il conteggio — non una lettura parziale.
E le letture vanno fatte **a gruppi** (5 alla volta), non tutte in parallelo: un burst di 30
richieste verso FIC è un modo di farsi limitare.

- [ ] **Step 1: i test che falliscono**

```ts
it('CONTROLLO POSITIVO — distingue i TRE esiti sulla stessa selezione', async () => {
  // mock: 3 fatture — una con MP01, una il cui XML non ha DatiPagamento, una il cui
  // scaricamento va in errore
  expect(righe.map(r => r.esito)).toEqual(['dichiarata', 'non_dichiarata', 'non_leggibile'])
  expect(righe[0].modalita).toBe('contanti')
  expect(righe[0].codice_sdi).toBe('MP01')
  expect(righe[1].modalita).toBeNull()        // non dichiarata: un dato, non un guasto
  expect(righe[2].perche).toBeTruthy()        // non leggibile: il perche' si DICE
})

it('il conteggio dei non leggibili e separato, non sommato ai non dichiarati', async () => {
  expect(esito.valore.non_leggibili).toBe(1)
})

it('CONTROLLO POSITIVO — il filtro nella marcatura DICHIARA i non leggibili', async () => {
  // 5 fatture, 1 non leggibile, filtro ['contanti']
  // il messaggio deve nominare quante ne ha lasciate fuori per non averle lette
  expect(msg).toMatch(/non (sono )?leggibil/i)
  expect(msg).toContain('1')
})

it('oltre il tetto di allegati rifiuta dichiarandolo, non legge a meta', async () => { /* … */ })

it('le letture vanno a gruppi, non tutte insieme', async () => {
  // conta le chiamate concorrenti al mock: mai piu' di 5 in volo
})
```

- [ ] **Step 2: eseguire, verificare il fallimento**
- [ ] **Step 3: `modalitaDichiarateDalFornitore`** sopra i pezzi dei Task 13 e 14
- [ ] **Step 4: il tool** `fic_modalita_pagamento_fornitore`
- [ ] **Step 5: `solo_modalita_fornitore`** in `segna_fatture_ricevute_pagate`, con la dichiarazione dei non leggibili
- [ ] **Step 6: suite + typecheck**
- [ ] **Step 7: mutazione** — far restituire `non_dichiarata` anche quando la lettura
  fallisce, cioè **confondere il dato col guasto**. Deve morire il controllo positivo dei tre
  esiti. È la mutazione che conta più di ogni altra in questo task.
- [ ] **Step 8: commit** — `git commit -m "scremare le fatture per la modalita' che ha scritto il fornitore, distinguendo 'non l'ha messa' da 'non l'ho letta'"`
