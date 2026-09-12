# Guardia sui dati societari nei documenti — piano di attuazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nessun documento generato da Cervellone può essere consegnato portando i dati societari di una società diversa da quella attiva, senza che l'Ingegnere lo sappia.

**Architecture:** un modulo nuovo (`guardia-societa.ts`) che cerca nel contenuto solo l'insieme **chiuso** delle nostre partite IVA; la guardia vive **dentro** i due imbuti di generazione (`generatePdfFromHtml`, `generateDocxFromHtml`) così nessun chiamante può dimenticarla; le sei intestazioni cablate diventano dati della società attiva; e le tre catene che oggi trasformano un guasto in «Restruktura» imparano a distinguere un'assenza nota da un errore.

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
| `src/lib/guardia-societa.test.ts` | **nuovo** — controlli negativi (il caso normale passa) e positivi (il caso vero morde) |
| `src/lib/societa-attiva.ts` | `leggiSocietaAttiva` con esito discriminato; `getSocietaAttiva` invariata |
| `src/lib/societa-documenti.ts` | esito discriminato, nessun `catch → undefined` |
| `src/lib/pdf-generator.ts` | `societa` obbligatoria, `SOCIETA_PREDEFINITA` eliminata, guardia nei due imbuti |
| `src/lib/tools/studio-tecnico.ts` | tre intestazioni cablate → società attiva |
| `src/v19/render/utils.ts` | piede Word: nessun predefinito Restruktura |
| `src/lib/prompts.ts` | riga `Intestazione:` condizionata alla società attiva |
| chiamanti (`tools.ts`, `draft-tools.ts`, `sal-tools.ts`, `document-template-tools.ts`) | passano la società e dichiarano il rifiuto |

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

### Task 4: la guardia dentro i due imbuti, e `societa` obbligatoria

**Files:**
- Modify: `src/lib/pdf-generator.ts` (`OpzioniDocumento`, `:59`, `:384`, `:520`, `:409`, `:644`)
- Modify: `src/lib/tools.ts:139-170`, `src/lib/draft-tools.ts:249`, `src/lib/sal-tools.ts:189`, `src/lib/document-template-tools.ts:305,409`
- Test: `src/lib/pdf-generator.guardia.test.ts` (creare)

**Interfaces:**
- Consumes: `verificaDatiSocietari`, `messaggioBlocco` (Task 1), `societaPerDocumento` (Task 3)
- Produces: `generatePdfFromHtml` e `generateDocxFromHtml` **rigettano** (`throw new ErroreDatiSocietari`) quando la guardia blocca; `societa` non è più opzionale.

```ts
/** Rigetto della guardia: distinguibile da un guasto di Chromium. */
export class ErroreDatiSocietari extends Error {
  readonly esito: Extract<EsitoGuardia, { ok: false }>
  constructor(esito: Extract<EsitoGuardia, { ok: false }>) {
    super(messaggioBlocco(esito))
    this.name = 'ErroreDatiSocietari'
    this.esito = esito
  }
}
```

**Perché un `throw` e non un ritorno:** le due funzioni restituiscono `Promise<Buffer>` e hanno cinque chiamanti. Cambiare il tipo di ritorno in un'unione obbligherebbe a toccare tutti e cinque nello stesso commit e a gestire il caso in cinque modi diversi. Un errore tipizzato attraversa il `try/catch` per-tool già presente in `claude.ts:1126`, che consegna il messaggio all'Ingegnere su **entrambi** i canali. → Questo è anche il motivo per cui l'equipollenza è gratuita qui, e va **provata**, non dedotta (Task 5).

- [ ] **Step 1: test che falliscono**

```ts
it('CONTROLLO POSITIVO — PDF con la P.IVA di Restruktura e La Real Estate attiva: RIGETTA', async () => {
  const html = `<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p>`
  await expect(generatePdfFromHtml(html, 'x', { societa: LAREALESTATE }))
    .rejects.toThrow(/02087420762/)
})

it('CONTROLLO NEGATIVO — la guardia NON tocca il caso normale', async () => {
  // stessa societa' attesa: la generazione procede (Chromium mockato)
})

it('lo stesso vale per il Word: due formati dallo stesso HTML non possono divergere', async () => {
  await expect(generateDocxFromHtml(html, 'x', { societa: LAREALESTATE })).rejects.toThrow(/02087420762/)
})

it('la guardia gira PRIMA di Chromium: un documento bloccato non deve costare un browser', async () => {
  // il mock di puppeteer.launch non deve essere stato chiamato
})
```

- [ ] **Step 2: eseguire, verificare il fallimento**
- [ ] **Step 3: implementare** — guardia in cima a entrambe le funzioni, **prima** di `embedDriveImages` e di `getBrowser()`; eliminare `SOCIETA_PREDEFINITA` e i due `?? SOCIETA_PREDEFINITA`; `societa: DatiSocietari` richiesta in `OpzioniDocumento`
- [ ] **Step 4: aggiornare i cinque chiamanti** — ognuno chiama `societaPerDocumento(conversationId)`; su `ok:false` **non genera** e restituisce all'Ingegnere il messaggio d'errore (non un documento, non un silenzio)
- [ ] **Step 5: eseguire suite intera + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: tutto verde. Il typecheck è la prova che nessun chiamante è rimasto senza società.

- [ ] **Step 6: mutazione — rimettere `?? SOCIETA_PREDEFINITA`: almeno un test deve morire**
- [ ] **Step 7: commit**

---

### Task 5: equipollenza — un test per canale

**Files:**
- Test: `src/app/api/chat/route.guardia-societa.test.ts` (creare)
- Test: `src/app/api/telegram/route.guardia-societa.test.ts` (creare)

**Interfaces:** consuma il comportamento dei Task 1-4. Nessun codice di produzione nuovo: se per far passare questi test servisse toccare la produzione, **è un difetto trovato** — riferirlo, non aggirarlo.

Lo schema dei test di canale esistenti sta in `src/app/api/chat/route.comandi.test.ts` e `src/app/api/telegram/route.comandi.test.ts`: seguirlo.

- [ ] **Step 1: i due test**

Per **ciascun** canale, con La Real Estate attiva e un tool che genera un documento intestato Restruktura:
1. il messaggio di blocco **arriva all'Ingegnere** (sul web: nella risposta salvata; su Telegram: in una `sendMessage` effettiva, verificata sulla chiamata al mock — non sulla variante fire-and-forget)
2. il messaggio **contiene entrambe** le partite IVA
3. **nessun documento** viene consegnato o salvato

- [ ] **Step 2: eseguire, verificare il fallimento** (prima dei Task 1-4, oppure con un fixture che li aggira)
- [ ] **Step 3: far passare** — senza toccare la produzione
- [ ] **Step 4: CONTROLLO POSITIVO di canale** — con la società **giusta**, su entrambi i canali il documento esce e nessun blocco appare. Un test che dice «bloccato» su ogni input non misura niente.
- [ ] **Step 5: commit** — `git commit -m "la guardia parla identica su chat web e Telegram, provato per canale"`

---

### Task 6: le sei intestazioni cablate

**Files:**
- Modify: `src/lib/tools/studio-tecnico.ts:837`, `:857`, e il piede del Quadro Economico (`Restruktura S.r.l. — Le percentuali sono indicative`, ~`:970`)
- Modify: `src/v19/render/utils.ts:110`
- Modify: `src/lib/prompts.ts:134`
- Test: aggiornare `src/lib/tools/studio-tecnico.characterization.test.ts`

**Interfaces:** consuma `societaPerDocumento` (Task 3). `executeStudioTecnico` ha già `conversationId` in firma (`:147`).

**Attenzione allo snapshot:** `studio-tecnico.characterization.test.ts` snapshotta l'output di `genera_preventivo_completo`. L'intestazione **cambia** per costruzione. Lo snapshot va aggiornato **dopo** aver letto il diff e verificato che cambi **solo** l'intestazione: uno snapshot aggiornato senza guardare è un test che ha smesso di misurare.

- [ ] **Step 1: la riproduzione del difetto** — un test che, con La Real Estate attiva, prova che il preventivo di **oggi** contiene `02087420762`. Questo test è la prova che il difetto era vero: va scritto **prima** del fix, deve **passare** prima e **fallire** dopo, e poi va invertito nella sua forma definitiva (con La Real Estate attiva il preventivo contiene `02232730768` e **non** `02087420762`)
- [ ] **Step 2: eseguire la riproduzione, verificare che PASSI** (il difetto è vivo)
- [ ] **Step 3: intestazione e piede dalla società attiva** in tutti e quattro i punti HTML/Word; su `ok:false` il preventivo **non si genera**
- [ ] **Step 4: `prompts.ts:134`** — la riga `Intestazione:` si costruisce dalla società attiva. Se il prompt suggerisce Restruktura mentre la guardia blocca, il bot combatte contro se stesso e l'Ingegnere vede solo un rifiuto
- [ ] **Step 5: invertire la riproduzione** nella forma definitiva; eseguire suite + typecheck
- [ ] **Step 6: `grep -rn "02087420762" src --include=*.ts | grep -v test`** — devono restare **solo** `societa.ts` e `identita.ts`. Ogni altra occorrenza è un punto che il piano non ha visto: riferirla
- [ ] **Step 7: commit**

---

### Task 7: la lista tarata degli audit, e i punti aperti

**Files:**
- Modify: `docs/superpowers/audit-checklist-tarata.md`
- Modify: `docs/superpowers/specs/2026-09-12-guardia-dati-societari-design.md` (sezione «punti aperti», se i task ne hanno scoperti)

*«Fix, poi imparo e prossima volta calibro gli audit per scovare il problema in fase di creazione»* — un fix non è finito finché la classe non è nella lista.

- [ ] **Step 1: aggiungere le voci**, ognuna con il difetto vero e la data che l'ha generata:
  - **A7 (grep):** `grep -rn "<numero di 11 cifre>" src --include=*.ts | grep -v test` — un dato societario riscritto a mano fuori dal registro. *Difetto: 12 set 2026, sei intestazioni Restruktura cablate; un preventivo de La Real Estate usciva con la P.IVA di Restruktura.*
  - **A8 (grep):** un parametro `opzioni.X ?? COSTANTE` dove `COSTANTE` è un dato di un'entità reale. *Difetto: 12 set 2026, `pdf-generator.ts:59` e `v19/render/utils.ts:110`.*
  - **B10:** una funzione che restituisce un dato su cui si costruisce un documento, un pagamento o una dichiarazione **non può** avere lo stesso valore di ritorno per «assenza nota» e per «guasto». Terza ricorrenza (mail pending, prefissi UUID, società attiva).
  - **C6:** una guardia va valutata su **due** prove, mai una: il caso vero morde **e** il caso normale passa. *Difetto: guardia `.docx`, che bloccava il caso normale.*
  - **B11:** una guardia che confronta il contenuto con un valore «atteso» va valutata anche su **come si ottiene l'atteso**. Una guardia che si fida di un dato indovinato timbra l'errore invece di trovarlo.
- [ ] **Step 2: commit** — `git add docs/ && git commit -m "la lista tarata impara la classe dei dati societari indovinati"`
