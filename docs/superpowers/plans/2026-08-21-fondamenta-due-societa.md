# Fondamenta a due società — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere Cervellone capace di lavorare per due società senza mai confondere l'una con l'altra — e rendere impossibile, non solo improbabile, scegliere l'azienda sbagliata.

**Architecture:** Un registro delle società in codice (i segreti restano in variabili d'ambiente, il registro sa solo quale leggere), una società attiva persistita come il progetto attivo, e la sostituzione di ogni selezione implicita con una esplicita: il company id di Fatture in Cloud e le credenziali Google diventano parametri obbligatori, non default comodi.

**Tech Stack:** Next.js 15 (App Router), TypeScript strict, Supabase, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-21-la-real-estate-contabilita-design.md`

## Global Constraints

- Baseline della suite all'inizio: **950 passed, 4 skipped**. Non deve mai calare.
- `npx tsc --noEmit` pulito a ogni task.
- Niente `any` nuovo: il progetto è in strict mode.
- Commit in italiano, all'imperativo, senza accenti nei messaggi git.
- NON eseguire `npm run build`: fallisce per motivi di ambiente ed è atteso.
- **Nessun segreto nel database.** I token di Fatture in Cloud restano in variabili d'ambiente; il registro contiene il NOME della variabile, mai il valore.
- **Nessun default silenzioso.** Dove oggi il codice sceglie da solo (prima azienda della lista, ultima credenziale aggiornata), dopo questo piano deve essere obbligatorio dire quale. Un parametro opzionale con fallback ricrea il difetto.
- Il codice esistente di Restruktura deve continuare a funzionare identico: è in produzione.

## Il difetto che questo piano rimuove

Due selezioni implicite, entrambe non deterministiche:

1. **Azienda Fatture in Cloud** — `FIC_COMPANY_ID` non è configurata in produzione, quindi `getCompanyId()` (`fatture-in-cloud.ts:48-58`) chiede l'elenco delle aziende e prende `companies[0]`. Aggiungere la seconda azienda può dirottare l'emissione delle fatture sulla partita IVA sbagliata.
2. **Account Google** — `getAuthorizedClient()` (`google-oauth.ts:203-277`) prende la riga con `updated_at` più recente. Un listener riscrive `updated_at` a ogni rinnovo automatico del token (righe 224-249): con due caselle collegate, **quale è attiva cambia da solo, in sottofondo**. Serve Drive, Gmail, Calendar e il salvataggio documenti.

Nessuno dei due dà errore quando sbaglia.

---

### Task 1: Il registro delle società

**Files:**
- Create: `src/lib/societa.ts`
- Test: `src/lib/societa.test.ts`

**Interfaces:**
- Produces: `export type CodiceSocieta = 'restruktura' | 'larealestate'`
- Produces: `export interface Societa { codice: CodiceSocieta; denominazione: string; piva: string; ficTokenEnv: string; ficCompanyIdEnv: string; googleAccount: string; aliquotaIvaDefault: number }`
- Produces: `export function getSocieta(codice: CodiceSocieta): Societa`
- Produces: `export function listaSocieta(): Societa[]`
- Produces: `export function risolviSocieta(testo: string): CodiceSocieta | null`

- [ ] **Step 1: Scrivi i test**

```ts
import { describe, it, expect } from 'vitest'
import { getSocieta, listaSocieta, risolviSocieta } from './societa'

describe('registro societa', () => {
  it('conosce le due societa', () => {
    expect(listaSocieta().map(s => s.codice).sort()).toEqual(['larealestate', 'restruktura'])
  })

  it('ogni societa dichiara QUALE variabile leggere, mai il valore', () => {
    for (const s of listaSocieta()) {
      expect(s.ficTokenEnv).toMatch(/^FIC_/)
      // il registro non deve MAI contenere un token: solo il nome della variabile
      expect(JSON.stringify(s)).not.toMatch(/eyJ|Bearer |[a-f0-9]{32}/)
    }
  })

  it('La Real Estate ha partita IVA e casella proprie', () => {
    const s = getSocieta('larealestate')
    expect(s.piva).toBe('02232730768')
    expect(s.googleAccount).toBe('larealestate.amministrazione@gmail.com')
    expect(s.aliquotaIvaDefault).toBe(10)
  })

  it('risolve il nome scritto dall utente, anche parziale', () => {
    expect(risolviSocieta('la real estate')).toBe('larealestate')
    expect(risolviSocieta('LAREALESTATE')).toBe('larealestate')
    expect(risolviSocieta('restruktura srl')).toBe('restruktura')
  })

  it('NON indovina quando il testo e ambiguo', () => {
    expect(risolviSocieta('fattura di agosto')).toBeNull()
    expect(risolviSocieta('')).toBeNull()
  })
})
```

- [ ] **Step 2: Esegui e verifica che falliscono**

Run: `npx vitest run src/lib/societa.test.ts`
Expected: FAIL — il modulo non esiste.

- [ ] **Step 3: Implementa il registro**

```ts
/**
 * src/lib/societa.ts — le società per cui Cervellone tiene la contabilità.
 *
 * Registro in CODICE, non in database, per due motivi: cambia raramente ed è
 * revisionabile in una pull request; e i segreti non devono finire in una
 * tabella. Qui si dichiara QUALE variabile d'ambiente contiene il token,
 * mai il token.
 */

export type CodiceSocieta = 'restruktura' | 'larealestate'

export interface Societa {
  codice: CodiceSocieta
  denominazione: string
  piva: string
  /** Nome della variabile d'ambiente col token FIC. MAI il valore. */
  ficTokenEnv: string
  /** Nome della variabile d'ambiente con l'id azienda FIC. MAI il valore. */
  ficCompanyIdEnv: string
  googleAccount: string
  aliquotaIvaDefault: number
}

const REGISTRO: Record<CodiceSocieta, Societa> = {
  restruktura: {
    codice: 'restruktura',
    denominazione: 'RESTRUKTURA S.r.l.',
    // Verificata nel repo: pdf-generator.ts:28 e tools/studio-tecnico.ts:837
    piva: '02087420762',
    ficTokenEnv: 'FIC_ACCESS_TOKEN',
    ficCompanyIdEnv: 'FIC_COMPANY_ID',
    googleAccount: 'restruktura.drive@gmail.com',
    aliquotaIvaDefault: 22,
  },
  larealestate: {
    codice: 'larealestate',
    denominazione: 'LA REAL ESTATE SRLS',
    piva: '02232730768',
    ficTokenEnv: 'FIC_ACCESS_TOKEN_LAREALESTATE',
    ficCompanyIdEnv: 'FIC_COMPANY_ID_LAREALESTATE',
    googleAccount: 'larealestate.amministrazione@gmail.com',
    aliquotaIvaDefault: 10,
  },
}

/** Alias riconosciuti nel testo dell'utente. Minuscoli, senza punteggiatura. */
const ALIAS: Array<[RegExp, CodiceSocieta]> = [
  [/\breal\s*estate\b|\blarealestate\b/, 'larealestate'],
  [/\brestruktura\b/, 'restruktura'],
]

export function getSocieta(codice: CodiceSocieta): Societa {
  return REGISTRO[codice]
}

export function listaSocieta(): Societa[] {
  return Object.values(REGISTRO)
}

/**
 * Riconosce la società nominata in un testo. Ritorna null se il testo non la
 * nomina: NON deve indovinare, perché una deduzione sbagliata produce un
 * documento fiscale sbagliato senza avvisare nessuno.
 */
export function risolviSocieta(testo: string): CodiceSocieta | null {
  const t = (testo || '').toLowerCase()
  const trovati = ALIAS.filter(([re]) => re.test(t)).map(([, c]) => c)
  const unici = Array.from(new Set(trovati))
  return unici.length === 1 ? unici[0] : null
}
```

Nota per chi implementa: esiste già una costante `RESTRUKTURA` con ragione sociale e partita IVA in `src/v19/agent/subagent-registry.ts:19`. **Verifica se riusarla** invece di duplicare il dato: due fonti per la stessa partita IVA sono due fonti che possono divergere. Se la riusi, il registro importa da lì e il test lo verifica.

- [ ] **Step 4: Esegui i test**

Run: `npx vitest run src/lib/societa.test.ts`
Expected: PASS.

- [ ] **Step 5: Suite, typecheck, commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/lib/societa.ts src/lib/societa.test.ts
git commit -m "feat(societa): registro delle due societa, senza segreti nel registro"
```

---

### Task 2: Il company id di Fatture in Cloud diventa esplicito

Rimuove la selezione `companies[0]`: da qui in avanti l'azienda si dichiara.

**Files:**
- Modify: `src/lib/fatture-in-cloud.ts:20` (cache di modulo), `:48-58` (`getCompanyId`), `:70`, `:110`, `:216-259`
- Modify: `src/lib/fic-write-tools.ts:85`, `:131`
- Modify: `src/lib/riconciliazione-tools.ts:139`, `:158`
- Test: `src/lib/fatture-in-cloud.societa.test.ts`

**Interfaces:**
- Consumes: `getSocieta`, `CodiceSocieta` dal Task 1.
- Produces: `export async function getCompanyId(societa: CodiceSocieta): Promise<{ ok: true; id: string } | { ok: false; error: string }>` — **il parametro è obbligatorio**.
- Produces: `export function getFicToken(societa: CodiceSocieta): string | null`

- [ ] **Step 1: Scrivi i test**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getCompanyId, getFicToken } from './fatture-in-cloud'

describe('company id per societa', () => {
  beforeEach(() => {
    process.env.FIC_COMPANY_ID = '111'
    process.env.FIC_COMPANY_ID_LAREALESTATE = '222'
    process.env.FIC_ACCESS_TOKEN = 'token-restruktura'
    process.env.FIC_ACCESS_TOKEN_LAREALESTATE = 'token-larealestate'
  })

  it('legge l id azienda della societa richiesta, non il primo della lista', async () => {
    expect(await getCompanyId('restruktura')).toEqual({ ok: true, id: '111' })
    expect(await getCompanyId('larealestate')).toEqual({ ok: true, id: '222' })
  })

  it('usa il token della societa richiesta', () => {
    expect(getFicToken('restruktura')).toBe('token-restruktura')
    expect(getFicToken('larealestate')).toBe('token-larealestate')
  })

  it('se la variabile manca FALLISCE invece di ripiegare sulla prima azienda', async () => {
    delete process.env.FIC_COMPANY_ID_LAREALESTATE
    const r = await getCompanyId('larealestate')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('FIC_COMPANY_ID_LAREALESTATE')
  })
})
```

- [ ] **Step 2: Esegui e verifica che falliscono**

Expected: FAIL — oggi `getCompanyId()` non accetta parametri.

- [ ] **Step 3: Riscrivi `getCompanyId` e aggiungi `getFicToken`**

```ts
import { getSocieta, type CodiceSocieta } from './societa'

/**
 * Id azienda su Fatture in Cloud per la società indicata.
 *
 * NON esiste piu il ripiego su `/user/companies` con `companies[0]`: con due
 * aziende nello stesso account quel ripiego sceglieva in base all'ordine
 * restituito dall'API, cioe emetteva fatture da una partita IVA non decisa da
 * nessuno. Meglio fallire e dirlo.
 */
export async function getCompanyId(
  societa: CodiceSocieta,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const s = getSocieta(societa)
  const id = process.env[s.ficCompanyIdEnv]
  if (!id) {
    return { ok: false, error: `${s.ficCompanyIdEnv} non configurata per ${s.denominazione}` }
  }
  return { ok: true, id }
}

/** Token FIC della società indicata. Null se la variabile non e configurata. */
export function getFicToken(societa: CodiceSocieta): string | null {
  return process.env[getSocieta(societa).ficTokenEnv] || null
}
```

Rimuovi la cache di modulo `_companyId` (riga 20) e ogni suo uso: con due società una cache globale restituirebbe l'id dell'altra.

- [ ] **Step 4: Propaga il parametro ai chiamanti**

Ogni funzione che oggi chiama `getCompanyId()` senza argomenti deve ricevere la società come parametro e passarla. I punti sono, esattamente: `fatture-in-cloud.ts:70` (`creaDocumentoFIC`), `:110` (`eliminaDocumentoFIC`), `:216-259` (`executeFicTool`), `fic-write-tools.ts:85` (`resolveVatId`), `:131` (`resolveClientEntity`), `riconciliazione-tools.ts:139` (`getOpenInvoices`), `:158` (`getInvoiceDetail`).

Anche `ficGet` e le chiamate autenticate devono usare `getFicToken(societa)` invece di leggere direttamente `process.env.FIC_ACCESS_TOKEN`.

Dove la società non è ancora disponibile (i tool esposti al modello), passa `'restruktura'` **esplicitamente** e lascia un commento: verrà collegata alla società attiva nel Task 4. Non mettere un valore di default nella firma.

- [ ] **Step 5: Esegui test e typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Se qualche test esistente si rompe perché chiamava `getCompanyId()` senza argomenti, aggiornalo passando `'restruktura'`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fatture-in-cloud.ts src/lib/fic-write-tools.ts src/lib/riconciliazione-tools.ts src/lib/fatture-in-cloud.societa.test.ts
git commit -m "fix(fic): l azienda non e piu la prima della lista, si dichiara"
```

---

### Task 3: Le credenziali Google diventano per casella

**Files:**
- Modify: `src/lib/google-oauth.ts:203-277` (`getAuthorizedClient`)
- Modify: i cinque chiamanti — `src/lib/drive.ts:18`, `src/lib/gmail-tools.ts:61`, `src/lib/calendar-tools.ts:33`, `src/lib/document-saver.ts:83`, `src/v19/agent/hallucination-validator.ts:111`
- Test: `src/lib/google-oauth.account.test.ts`

**Interfaces:**
- Produces: `export async function getAuthorizedClient(accountEmail: string): Promise<OAuth2Client | null>` — **parametro obbligatorio**.

- [ ] **Step 1: Scrivi il test che riproduce il difetto**

```ts
it('sceglie la casella richiesta, non l ultima aggiornata', async () => {
  // due credenziali: quella di restruktura aggiornata PRIMA, quella
  // dell altra DOPO (come accade a ogni rinnovo automatico del token)
  seedCredenziali([
    { account_email: 'restruktura.drive@gmail.com', refresh_token: 'R', updated_at: '2026-08-01T00:00:00Z' },
    { account_email: 'larealestate.amministrazione@gmail.com', refresh_token: 'L', updated_at: '2026-08-20T00:00:00Z' },
  ])

  await getAuthorizedClient('restruktura.drive@gmail.com')

  // deve aver usato il refresh token di restruktura, non quello piu recente
  expect(refreshTokenUsato()).toBe('R')
})
```

- [ ] **Step 2: Esegui e verifica che fallisce**

Expected: FAIL — oggi ordina per `updated_at` e prende la prima, quindi userebbe `'L'`.

- [ ] **Step 3: Implementa la selezione per email**

Sostituisci la query a `google-oauth.ts:205-210`:

```ts
    .from('google_oauth_credentials')
    .select('refresh_token, access_token, access_token_expires_at')
    .eq('account_email', accountEmail)
    .maybeSingle()
```

e se non trova nulla, ritorna `null` con un `console.warn` che nomina la casella mancante — non un ripiego su un'altra casella.

Nel listener che riscrive i token (righe 224-249), il match resta su `refresh_token`: è già corretto e non tocca le altre righe.

- [ ] **Step 4: Aggiorna i cinque chiamanti**

Ognuno deve dire quale casella vuole. Dove la società non è ancora disponibile, passa esplicitamente `getSocieta('restruktura').googleAccount` con un commento, come nel Task 2.

- [ ] **Step 5: Esegui test e typecheck, poi commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/lib/google-oauth.ts src/lib/drive.ts src/lib/gmail-tools.ts src/lib/calendar-tools.ts src/lib/document-saver.ts src/v19/agent/hallucination-validator.ts src/lib/google-oauth.account.test.ts
git commit -m "fix(google): le credenziali si scelgono per casella, non per ultimo aggiornamento"
```

---

### Task 4: La società attiva

Ricalca il pattern del progetto attivo, già collaudato.

**Files:**
- Create: `supabase/migrations/2026-08-21-societa-attiva.sql`
- Create: `src/lib/societa-attiva.ts`
- Modify: `src/app/api/telegram/route.ts` — nuovo comando `/societa`, accanto agli altri (blocco che inizia a riga 411)
- Test: `src/lib/societa-attiva.test.ts`

**Interfaces:**
- Produces: `export async function getSocietaAttiva(conversationId: string): Promise<CodiceSocieta>` — **default `'restruktura'`** se non impostata, per non cambiare il comportamento attuale.
- Produces: `export async function setSocietaAttiva(conversationId: string, societa: CodiceSocieta): Promise<void>`
- Produces: `export function bloccoSocietaAttiva(s: Societa): string` — il testo iniettato nel prompt.

- [ ] **Step 1: Migration**

```sql
create table if not exists public.cervellone_societa_attiva (
  conversation_id uuid primary key,
  societa text not null check (societa in ('restruktura', 'larealestate')),
  updated_at timestamptz not null default now()
);
```

Il vincolo `check` è deliberato: un codice società non previsto deve essere rifiutato dal database, non scritto e scoperto dopo.

- [ ] **Step 2: Scrivi i test**

```ts
it('senza impostazione la societa e Restruktura, come oggi', async () => {
  expect(await getSocietaAttiva('conv-nuova')).toBe('restruktura')
})

it('ricorda la societa scelta', async () => {
  await setSocietaAttiva('conv-1', 'larealestate')
  expect(await getSocietaAttiva('conv-1')).toBe('larealestate')
})

it('il blocco iniettato nel prompt NOMINA la societa', () => {
  const testo = bloccoSocietaAttiva(getSocieta('larealestate'))
  expect(testo).toContain('LA REAL ESTATE SRLS')
  expect(testo).toContain('02232730768')
})
```

- [ ] **Step 3: Esegui e verifica che falliscono, poi implementa**

`getSocietaAttiva` legge la tabella e ritorna `'restruktura'` se non trova nulla o se la lettura fallisce: il comportamento attuale non deve cambiare per chi non usa la seconda società.

`bloccoSocietaAttiva` produce un testo delimitato sullo stile di `=== PROGETTO ATTIVO ===`:

```
=== SOCIETA ATTIVA ===
Tutte le operazioni contabili si riferiscono a: LA REAL ESTATE SRLS (P.IVA 02232730768).
Se l'Ingegnere parla di un'altra societa, NON dedurlo: chiedi conferma e invitalo a usare /societa.
=== fine societa attiva ===
```

- [ ] **Step 4: Il comando `/societa`**

In `src/app/api/telegram/route.ts`, accanto agli altri comandi, con lo stesso pattern (`if (userText === ...)`, risposta, `return NextResponse.json({ ok: true })`):

- `/societa` senza argomenti → mostra quella attiva e l'elenco delle disponibili.
- `/societa <nome>` → usa `risolviSocieta`; se ritorna `null` risponde chiedendo di essere espliciti, **senza indovinare**.

- [ ] **Step 5: Inietta il blocco nel contesto**

In `src/lib/agent-job.ts`, accanto a `buildActiveProjectContext` (riga 186), aggiungi il blocco della società attiva al `workingContext`. Stessa cosa nel path web, `src/app/api/chat/route.ts:237`.

- [ ] **Step 6: Suite, typecheck, commit**

```bash
npx vitest run && npx tsc --noEmit
git add supabase/migrations/2026-08-21-societa-attiva.sql src/lib/societa-attiva.ts src/lib/societa-attiva.test.ts src/app/api/telegram/route.ts src/lib/agent-job.ts src/app/api/chat/route.ts
git commit -m "feat(societa): societa attiva selezionabile e dichiarata nel contesto"
```

---

### Task 5: Ogni conferma contabile dice a nome di chi

La difesa vera non è il codice: è che l'Ingegnere legga il nome sbagliato **prima** di confermare.

**Files:**
- Modify: `src/lib/fic-write-tools.ts` — `compilaDocumento` (riga 205), `confirmFicStep1` (riga 297), `confirmFicStep2` (riga 314)
- Test: `src/lib/fic-write-tools.societa.test.ts`

- [ ] **Step 1: Scrivi il test**

```ts
it('la richiesta di conferma nomina la societa e la partita IVA', async () => {
  const msg = await compilaDocumento({ cliente: 'Mario Rossi', righe: [...] }, 'fattura_emessa')
  expect(msg).toContain('LA REAL ESTATE SRLS')
  expect(msg).toContain('02232730768')
})
```

- [ ] **Step 2: Esegui, verifica che fallisce, implementa**

Ogni messaggio di conferma (primo e secondo passaggio) apre con la società e la partita IVA. Non in fondo: in testa, dove si legge.

- [ ] **Step 3: Suite, typecheck, commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/lib/fic-write-tools.ts src/lib/fic-write-tools.societa.test.ts
git commit -m "feat(fic): ogni conferma dichiara societa e partita IVA"
```

---

### Task 6: Prima nota e riconciliazione sanno di chi sono

Le tabelle `cervellone_movimenti` e `cervellone_riconciliazioni` **non hanno** una colonna società (verificato) e sono **entrambe vuote** (0 righe): nessuna bonifica da fare.

**Files:**
- Create: `supabase/migrations/2026-08-21-movimenti-societa.sql`
- Modify: `src/lib/prima-nota-tools.ts` — `executePrimaNotaTool` (riga 164) e le scritture su `cervellone_movimenti` (riga 64) e `cervellone_riconciliazioni` (riga 78)
- Modify: `src/lib/riconciliazione-tools.ts` — `executeRiconciliazioneTool` (riga 551)
- Test: `src/lib/prima-nota-tools.societa.test.ts`

- [ ] **Step 1: Migration**

```sql
alter table public.cervellone_movimenti
  add column if not exists societa text not null default 'restruktura'
  check (societa in ('restruktura', 'larealestate'));

alter table public.cervellone_riconciliazioni
  add column if not exists societa text not null default 'restruktura'
  check (societa in ('restruktura', 'larealestate'));

create index if not exists idx_movimenti_societa on public.cervellone_movimenti(societa, data);
```

Il default `'restruktura'` è sicuro perché le tabelle sono vuote; serve solo a non rompere eventuali scritture che non passano ancora la società.

- [ ] **Step 2: Scrivi i test**

```ts
it('un movimento nasce con la societa attiva, non con un default', async () => {
  await setSocietaAttiva('conv-1', 'larealestate')
  await executePrimaNotaTool('registra_movimento', { /* ... */ }, 'conv-1')
  expect(rigaInserita.societa).toBe('larealestate')
})

it('la lettura NON vede i movimenti dell altra societa', async () => {
  seedMovimenti([
    { societa: 'restruktura', descrizione: 'bonifico A' },
    { societa: 'larealestate', descrizione: 'bonifico B' },
  ])
  const res = await executePrimaNotaTool('elenca_movimenti', {}, 'conv-larealestate')
  expect(res).toContain('bonifico B')
  expect(res).not.toContain('bonifico A')
})
```

Il secondo test è il più importante del piano: è quello che dimostra che le due contabilità non si mescolano.

- [ ] **Step 3: Esegui, verifica che falliscono, implementa**

`executePrimaNotaTool` e `executeRiconciliazioneTool` ricevono la conversazione, risolvono la società attiva, e **filtrano ogni lettura** e **valorizzano ogni scrittura** con essa.

- [ ] **Step 4: Suite, typecheck, commit**

```bash
npx vitest run && npx tsc --noEmit
git add supabase/migrations/2026-08-21-movimenti-societa.sql src/lib/prima-nota-tools.ts src/lib/riconciliazione-tools.ts src/lib/prima-nota-tools.societa.test.ts
git commit -m "feat(contabilita): prima nota e riconciliazione separate per societa"
```

---

## Prima di attivare la seconda società — passi non di codice

In quest'ordine, e nessuno è opzionale:

1. **Configurare `FIC_COMPANY_ID` su Vercel con l'id di Restruktura.** Va fatto **subito**, prima ancora di questo piano: finché non c'è, l'azienda è "la prima della lista" e aggiungere La Real Estate può dirottare le fatture.
2. Configurare `FIC_ACCESS_TOKEN_LAREALESTATE` e `FIC_COMPANY_ID_LAREALESTATE`.
3. Correggere su Fatture in Cloud la **tipologia soggetto** de La Real Estate: oggi è "Persona fisica", per una SRLS produce XML malformati.
4. Autorizzare la casella `larealestate.amministrazione@gmail.com` — **solo dopo il Task 3**, altrimenti Cervellone smette di leggere la casella di Restruktura.
5. Far confermare al commercialista il regime IVA al 10%.

## Come si prova che funziona davvero

I test dimostrano che il codice separa le società. Non dimostrano che in produzione la separazione regga: la stessa configurazione — test verdi su un database mockato — il 20 agosto garantiva una riparazione che in produzione era inerte.

Quindi, prima di considerare chiuso questo piano: **registrare un movimento di prova su ciascuna società e verificare nel database che siano finiti dove dovevano**. Su dati veri, non su mock.
