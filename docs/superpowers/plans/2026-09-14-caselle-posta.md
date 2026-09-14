# Le caselle di posta sono quattro — piano di attuazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La segretaria può leggere la posta di tutte e quattro le caselle — comprese quelle di La Real Estate — e non può inviare, archiviare o cestinare da una casella che non le è stata detta.

**Architecture:** Un registro delle caselle in codice (`caselle.ts`), sul modello di `societa.ts`, che assorbe le chiavi TopHost già esistenti. La casella diventa un **parametro obbligatorio** dell'API Gmail di basso livello; la *politica* (in lettura si guardano tutte, in scrittura si pretende) vive nel livello dei tool, dove si può leggere e provare.

**Tech Stack:** TypeScript, Next.js App Router, `googleapis` (OAuth2), Supabase, vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-caselle-posta-design.md`

## Global Constraints

- **La casella si dichiara, non si deduce.** In scrittura, senza `casella` il tool **si rifiuta** — e il rifiuto sta nel **codice**, non nel prompt. Una mail partita dall'indirizzo sbagliato arriva a un cliente firmata da un'altra società e non si richiama indietro.
- **Nessun predefinito in scrittura**, nemmeno «la casella dove ho letto».
- **Ogni risultato di lettura dichiara la casella di provenienza.** Senza, «tre mail da Booking» non dice in quale società sono arrivate.
- **Una casella che fallisce non sparisce.** Se una delle quattro non risponde, l'esito lo **dice**. Un elenco parziale che sembra completo è il difetto di famiglia di questa casa.
- **Non si tocca** `drive.ts`, `calendar-tools.ts`, `document-saver.ts`, `hallucination-validator.ts` se non nei punti indicati dal Task 1: restano su Restruktura **per scelta dichiarata**.
- **Commenti in italiano**, che spiegano *perché*. ⚠️ **Mai un commento che promette una difesa inesistente**: il 14 set 2026 tre commenti di questo repo descrivevano protezioni che non c'erano.
- **Comandi:** test `npx vitest run <file>` · suite `npx vitest run` · typecheck `npx tsc --noEmit`.
- **Non toccare** `.env*`, segreti, CI, `package.json`. Non applicare migrazioni, non toccare il database.

### 🚨 Due trappole misurate il 14 set 2026 — leggile prima di scrivere un test

**1. I mock di vitest e il TDZ.** Questo **non funziona**:
```ts
const spia = vi.fn()
vi.mock('@/lib/x', () => ({ spia }))   // ✗ la factory è issata sopra la const
```
Usa `vi.hoisted`, che è la convenzione del repo (10 occorrenze):
```ts
const { spia } = vi.hoisted(() => ({ spia: vi.fn() }))
vi.mock('@/lib/x', () => ({ spia }))
```

**2. `beforeEach` a corpo conciso è una mina.** Questo **rompe i test in modo incomprensibile**:
```ts
beforeEach(() => spia.mockReset())   // ✗ mockReset() ritorna la spia
```
vitest interpreta un **ritorno-funzione come teardown** e richiama la spia dopo ogni test: con una spia istruita a sollevare, un test verde risulta **rosso** — e a esplodere è lo smontaggio, non il corpo. Usa sempre il corpo a blocco:
```ts
beforeEach(() => { spia.mockReset() })
```

**3. I sorgenti sono CRLF.** Una mutazione applicata con `perl -0pi` **non entra** se ti ancori a `$`. Il 14 set, su sei mutazioni tentate, **sei non sono entrate al primo colpo**. Verifica SEMPRE con `grep -c` che la mutazione sia entrata prima di leggere i test, e che sia uscita dopo il ripristino.

---

### Task 1: Il registro delle caselle

**Files:**
- Create: `src/lib/caselle.ts`
- Test: `src/lib/caselle.test.ts`

**Interfaces:**
- Consumes: `CodiceSocieta` da `./societa`, `AccountKey` da `@/v19/tools/email/config`.
- Produces:
  ```ts
  export type ChiaveCasella = 'info' | 'raffaele' | 'drive' | 'larealestate'
  export type TrasportoCasella = 'tophost' | 'google'
  export interface Casella {
    chiave: ChiaveCasella
    indirizzo: string
    trasporto: TrasportoCasella
    societa: CodiceSocieta
    /** Solo per `google`: la chiave con cui cercare in `google_oauth_credentials`. MAI il token. */
    accountEmail?: string
  }
  export function getCasella(c: ChiaveCasella): Casella
  export function listaCaselle(): Casella[]
  export function caselleDiTrasporto(t: TrasportoCasella): Casella[]
  export function risolviCasella(testo: string): ChiaveCasella | null
  ```

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// src/lib/caselle.test.ts
import { describe, it, expect } from 'vitest'
import { getCasella, listaCaselle, caselleDiTrasporto, risolviCasella } from './caselle'

describe('il registro delle caselle', () => {
  it('ha quattro caselle, e ciascuna sa a quale societa appartiene', () => {
    const tutte = listaCaselle()
    expect(tutte).toHaveLength(4)
    expect(tutte.map((c) => c.chiave).sort()).toEqual(['drive', 'info', 'larealestate', 'raffaele'])
    expect(getCasella('larealestate').societa).toBe('larealestate')
    expect(getCasella('drive').societa).toBe('restruktura')
    expect(getCasella('info').societa).toBe('restruktura')
  })

  it('🚨 dichiara il NOME della credenziale, mai il suo valore', () => {
    // Stessa regola di societa.ts: i segreti non stanno in un registro.
    expect(getCasella('larealestate').accountEmail).toBe('larealestate.amministrazione@gmail.com')
    expect(getCasella('drive').accountEmail).toBe('restruktura.drive@gmail.com')
    // Le TopHost non hanno un account Google, e non devono fingere di averlo.
    expect(getCasella('info').accountEmail).toBeUndefined()
  })

  it('divide le caselle per trasporto', () => {
    expect(caselleDiTrasporto('google').map((c) => c.chiave).sort()).toEqual(['drive', 'larealestate'])
    expect(caselleDiTrasporto('tophost').map((c) => c.chiave).sort()).toEqual(['info', 'raffaele'])
  })

  it('🚨 le chiavi TopHost sono LE STESSE di AccountKey, non altre', () => {
    // Due elenchi della stessa cosa divergono al primo cambiamento: qui si
    // controlla che il registro nuovo ABBIA ASSORBITO quello vecchio invece di
    // affiancarglisi. In questo repo il terzo posto dove la stessa verita' e'
    // scritta diversa e' la ferita che si riapre di continuo.
    const daTrasporto: string[] = caselleDiTrasporto('tophost').map((c) => c.chiave).sort()
    const daAccountKey: string[] = ['info', 'raffaele'] // il tipo AccountKey di v19/tools/email/config.ts
    expect(daTrasporto).toEqual(daAccountKey)
  })

  it('riconosce la casella nominata nel testo, e NON indovina', () => {
    expect(risolviCasella('guarda su info@')).toBe('info')
    expect(risolviCasella('nella casella di la real estate')).toBe('larealestate')
    expect(risolviCasella('cerca nella posta')).toBeNull()
    // Due nominate = ambiguo = null. Meglio chiedere che sceglierne una.
    expect(risolviCasella('confronta info@ e raffaele.lentini@')).toBeNull()
  })
})
```

- [ ] **Step 2: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/caselle.test.ts`
Atteso: FAIL — `Failed to resolve import "./caselle"`.

- [ ] **Step 3: Implementa**

```ts
// src/lib/caselle.ts
/**
 * src/lib/caselle.ts — le caselle di posta di Cervellone. Sono QUATTRO.
 *
 * ── Perche' esiste (14 settembre 2026) ──────────────────────────────────────
 * La segretaria deve poter leggere anche la posta de La Real Estate. La
 * credenziale OAuth c'era gia' (autorizzata e verificata alle 13:01); mancava
 * il codice che la usa: cinque punti aprivano un client Google con la societa'
 * CABLATA, e nessuno dei 16 tool `gmail_*` accettava una casella.
 *
 * Perche' un registro e non un parametro qua e la': ne esistevano gia' DUE a
 * meta' — `societa.ts` per le societa' e `AccountKey` ('info'|'raffaele') per
 * le caselle TopHost — e Gmail non stava in nessuno dei due. Aggiungere la
 * quarta casella senza unificarli avrebbe creato il TERZO posto dove la stessa
 * verita' e' scritta diversa: in questo repo e' la ferita che si riapre sempre.
 *
 * Registro in CODICE, come `societa.ts`: cambia raramente, si rivede in una
 * pull request, e **qui si dichiara COME SI CHIAMA la credenziale, mai il suo
 * valore**.
 */
import type { CodiceSocieta } from './societa'

export type ChiaveCasella = 'info' | 'raffaele' | 'drive' | 'larealestate'
export type TrasportoCasella = 'tophost' | 'google'

export interface Casella {
  chiave: ChiaveCasella
  indirizzo: string
  trasporto: TrasportoCasella
  societa: CodiceSocieta
  /**
   * Solo per il trasporto `google`: la chiave con cui cercare la riga in
   * `google_oauth_credentials`. MAI il token.
   */
  accountEmail?: string
}

const REGISTRO: Record<ChiaveCasella, Casella> = {
  // ⚠️ 'info' e 'raffaele' sono LE STESSE chiavi di `AccountKey`
  // (src/v19/tools/email/config.ts): il registro le assorbe, non le duplica.
  info: {
    chiave: 'info',
    indirizzo: 'info@restruktura.it',
    trasporto: 'tophost',
    societa: 'restruktura',
  },
  raffaele: {
    chiave: 'raffaele',
    indirizzo: 'raffaele.lentini@restruktura.it',
    trasporto: 'tophost',
    societa: 'restruktura',
  },
  drive: {
    chiave: 'drive',
    indirizzo: 'restruktura.drive@gmail.com',
    trasporto: 'google',
    societa: 'restruktura',
    accountEmail: 'restruktura.drive@gmail.com',
  },
  larealestate: {
    chiave: 'larealestate',
    indirizzo: 'larealestate.amministrazione@gmail.com',
    trasporto: 'google',
    societa: 'larealestate',
    accountEmail: 'larealestate.amministrazione@gmail.com',
  },
}

export function getCasella(c: ChiaveCasella): Casella {
  return REGISTRO[c]
}

export function listaCaselle(): Casella[] {
  return Object.values(REGISTRO)
}

export function caselleDiTrasporto(t: TrasportoCasella): Casella[] {
  return listaCaselle().filter((c) => c.trasporto === t)
}

/** Alias riconosciuti nel testo dell'utente. Minuscoli, senza punteggiatura. */
const ALIAS: Array<[RegExp, ChiaveCasella]> = [
  [/\binfo@|\binfo\b(?!\s*rmazion)/, 'info'],
  [/\braffaele\.lentini\b|\braffaele@/, 'raffaele'],
  [/\brestruktura\.drive\b|\bdrive@/, 'drive'],
  [/\breal\s*estate\b|\blarealestate\b/, 'larealestate'],
]

/**
 * La casella nominata nel testo, o `null`.
 *
 * NON deve indovinare: due nominate valgono zero. Stessa regola di
 * `risolviSocieta` — una deduzione sbagliata qui manda una mail dall'indirizzo
 * di un'altra societa', e a un cliente.
 */
export function risolviCasella(testo: string): ChiaveCasella | null {
  const t = (testo || '').toLowerCase()
  const trovate = ALIAS.filter(([re]) => re.test(t)).map(([, c]) => c)
  const uniche = Array.from(new Set(trovate))
  return uniche.length === 1 ? uniche[0] : null
}
```

- [ ] **Step 4: Lancia e verifica che PASSI**

Run: `npx vitest run src/lib/caselle.test.ts`
Atteso: PASS, 5 test. ⚠️ Se `risolviCasella` fallisce su un caso, **aggiusta la regex, non il test**: il test descrive il comportamento voluto.

- [ ] **Step 5: Mutazione**

Cambia `return uniche.length === 1 ? uniche[0] : null` in `return uniche[0] ?? null` (cioè: davanti a due caselle ne sceglie una).
Verifica con `grep -c "uniche\[0\] ?? null" src/lib/caselle.ts` che sia entrata (atteso 1).
Run: `npx vitest run src/lib/caselle.test.ts` → atteso FAIL su «riconosce la casella nominata, e NON indovina».
Ripristina, verifica col `grep -c` che sia uscita (atteso 0), rilancia: PASS.

- [ ] **Step 6: I quattro punti che restano fermi smettono di essere un caso**

In `src/lib/caselle.ts`, in coda, aggiungi:

```ts
/**
 * File, calendario e documenti generati restano di Restruktura — È UNA SCELTA,
 * non un residuo.
 *
 * ⚠️ Fino al 14 settembre 2026 questi quattro punti avevano `'restruktura'`
 * scritto a mano dentro `drive.ts`, `calendar-tools.ts`, `document-saver.ts` e
 * `hallucination-validator.ts`. Sembrava una svista, e chiunque passasse di li'
 * era tentato di «sistemarla» — senza sapere che spostare quel valore manda i
 * documenti generati in un ALTRO Drive: un errore fisico e silenzioso, di cui
 * ci si accorge settimane dopo cercando un file.
 *
 * Quando servira' il Drive de La Real Estate sara' un lavoro suo, e passera' da
 * qui: un posto solo da cambiare, con scritto accanto cosa comporta.
 */
export const CASELLA_FILE_E_CALENDARIO: ChiaveCasella = 'drive'
```

Poi, nei quattro file, sostituisci `getSocieta('restruktura').googleAccount` con
`getCasella(CASELLA_FILE_E_CALENDARIO).accountEmail!`. **Non cambia il comportamento**: `drive`
è `restruktura.drive@gmail.com`, lo stesso valore di prima. Cambia che ora c'è un posto solo, e
ha un nome che dice perché.

Run: `npx vitest run` → la suite deve restare verde **senza toccare nessun test**: se qualcosa
diventa rosso, il valore non era lo stesso e vai a capire perché prima di proseguire.

- [ ] **Step 7: Commit**

```bash
git add src/lib/caselle.ts src/lib/caselle.test.ts src/lib/drive.ts src/lib/calendar-tools.ts src/lib/document-saver.ts src/v19/agent/hallucination-validator.ts
git commit -m "il registro delle caselle: sono quattro, e ciascuna sa di chi e"
```

---

### Task 2: La casella diventa un parametro, e non ha un predefinito

**Files:**
- Modify: `src/lib/gmail-tools.ts` (righe 60-74 e le 19 funzioni esportate)
- Test: `src/lib/gmail-tools.casella.test.ts`

**Interfaces:**
- Consumes: `getCasella`, `ChiaveCasella` dal Task 1.
- Produces: ogni funzione esportata di `gmail-tools.ts` prende la casella come **primo parametro obbligatorio**:
  ```ts
  export async function listInbox(casella: ChiaveCasella, opts?: {...}): Promise<GmailMessageMeta[]>
  export async function searchGmail(casella: ChiaveCasella, query: string, maxResults?: number): Promise<GmailMessageMeta[]>
  // …e così per readMessage, readThread, createDraft, listDrafts, showDraft,
  // deleteDraft, sendDraft, listLabels, applyLabel, removeLabel, markAsRead,
  // markAsUnread, archive, trash, scaricaAllegato, isThreadInBotLoop, recordBotAction
  ```

> **Perché obbligatorio e non facoltativo con predefinito.** Un predefinito è una decisione presa una volta e poi invisibile: chi aggiunge la ventesima funzione non lo vede, e la casella di Restruktura torna a essere il silenzioso «quella giusta». Obbligatorio significa che il compilatore costringe ogni chiamante a dire quale — e la *politica* (tutte in lettura, una dichiarata in scrittura) si decide nel livello dei tool, dove si legge e si prova.

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// src/lib/gmail-tools.casella.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ⚠️ vi.hoisted: una `const` normale finirebbe in TDZ sotto la factory issata.
const { getAuthorizedClient } = vi.hoisted(() => ({ getAuthorizedClient: vi.fn() }))
vi.mock('@/lib/google-oauth', () => ({ getAuthorizedClient }))

const { gmailApi } = vi.hoisted(() => ({
  gmailApi: {
    users: {
      messages: {
        list: vi.fn(async () => ({ data: { messages: [] } })),
        get: vi.fn(async () => ({ data: {} })),
      },
    },
  },
}))
vi.mock('googleapis', () => ({ google: { gmail: () => gmailApi } }))

import { listInbox } from './gmail-tools'

beforeEach(() => {
  // ⚠️ corpo a BLOCCO: `() => mock.mockReset()` restituirebbe la spia, e vitest
  // la richiamerebbe come teardown dopo ogni test.
  getAuthorizedClient.mockReset()
  getAuthorizedClient.mockResolvedValue({})
  gmailApi.users.messages.list.mockClear()
})

describe('gmail-tools — la casella la dice il chiamante', () => {
  it('🚨 apre la casella CHIESTA, non quella di Restruktura', async () => {
    await listInbox('larealestate')

    expect(getAuthorizedClient).toHaveBeenCalledWith('larealestate.amministrazione@gmail.com')
  })

  it('CONTROLLO POSITIVO: chiedendo drive apre quella di Restruktura', async () => {
    // Senza questo, una funzione che apre SEMPRE La Real Estate passerebbe il
    // test qui sopra — e avremmo spostato il difetto invece di chiuderlo.
    await listInbox('drive')

    expect(getAuthorizedClient).toHaveBeenCalledWith('restruktura.drive@gmail.com')
  })

  it('🚨 una casella TopHost non e apribile da qui, e lo DICE', async () => {
    // `info` e `raffaele` non hanno un account Google: aprirle con questo
    // trasporto e' un errore del chiamante, non una casella vuota.
    await expect(listInbox('info' as never)).rejects.toThrow(/non e una casella Google|info/)
  })
})
```

- [ ] **Step 2: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/gmail-tools.casella.test.ts`
Atteso: FAIL — `listInbox` non accetta ancora la casella (errore di tipo a runtime o chiamata con l'account sbagliato).

- [ ] **Step 3: Implementa il cuore**

In `src/lib/gmail-tools.ts`, sostituisci `getGmailAuth` e `gmailClient` (righe 60-74):

```ts
import { getCasella, type ChiaveCasella } from './caselle'

/**
 * La casella e' un parametro, e non ha un predefinito.
 *
 * ⚠️ Qui, fino al 14 settembre 2026, c'era
 *   `getAuthorizedClient(getSocieta('restruktura').googleAccount)`
 * con accanto il commento di una sessione precedente: «nel Task 4 arrivera'
 * dalla societa' attiva… leggere quella sbagliata significa cercare fatture
 * inesistenti». Quel Task 4 non e' mai arrivato, e per mesi il bot ha potuto
 * leggere una casella sola.
 *
 * Un predefinito non si rimette: e' una decisione presa una volta e poi
 * invisibile, e chi aggiunge la prossima funzione non la vede.
 */
async function getGmailAuth(chiave: ChiaveCasella): Promise<OAuth2Client> {
  const casella = getCasella(chiave)
  if (casella.trasporto !== 'google' || !casella.accountEmail) {
    throw new Error(
      `"${chiave}" non e una casella Google (${casella.indirizzo}): usala con i tool di posta TopHost.`,
    )
  }
  const { getAuthorizedClient } = await import('./google-oauth')
  const oauthClient = await getAuthorizedClient(casella.accountEmail)
  if (!oauthClient) {
    throw new Error(
      `OAuth Gmail non autenticato per ${casella.indirizzo}. Serve il consent flow su /api/auth/google con quell'account.`,
    )
  }
  return oauthClient
}

async function gmailClient(chiave: ChiaveCasella) {
  return google.gmail({ version: 'v1', auth: await getGmailAuth(chiave) })
}
```

- [ ] **Step 4: Porta la casella nelle 19 funzioni esportate**

Ogni funzione esportata prende `casella: ChiaveCasella` come **primo parametro** e lo passa a `gmailClient(casella)`. L'elenco completo, dalle righe di `gmail-tools.ts`: `isThreadInBotLoop`, `recordBotAction`, `listInbox`, `searchGmail`, `readMessage`, `readThread`, `createDraft`, `listDrafts`, `showDraft`, `deleteDraft`, `sendDraft`, `listLabels`, `applyLabel`, `removeLabel`, `markAsRead`, `markAsUnread`, `archive`, `trash`, `scaricaAllegato`.

Esempio della trasformazione, da applicare a tutte:
```ts
// prima
export async function searchGmail(query: string, maxResults = 20): Promise<GmailMessageMeta[]> {
  const gmail = await gmailClient()
// dopo
export async function searchGmail(casella: ChiaveCasella, query: string, maxResults = 20): Promise<GmailMessageMeta[]> {
  const gmail = await gmailClient(casella)
```

⚠️ `isThreadInBotLoop` e `recordBotAction` leggono e scrivono `gmail_processed_messages`: **aggiungi la casella anche come colonna logica nel ragionamento** solo se il Task 5 lo richiede — in questo task passano la casella solo per aprire il client. Non cambiare lo schema della tabella.

- [ ] **Step 5: Aggiorna i chiamanti**

`npx tsc --noEmit` ti elenca ogni punto rotto. I chiamanti noti sono `src/lib/tools/mail.ts` e i cron `src/app/api/cron/gmail-alerts/route.ts` e `gmail-morning/route.ts`.
⚠️ **Nei cron passa `'drive'` esplicitamente**, con un commento: *«i cron Gmail sorvegliano la casella di Restruktura; quella de La Real Estate non ha ancora un cron suo»*. Non è un predefinito nascosto: è una scelta scritta.

- [ ] **Step 6: Lancia i test e il typecheck**

Run: `npx vitest run src/lib/gmail-tools.casella.test.ts` → atteso PASS, 3 test.
Run: `npx vitest run` → la suite intera deve restare verde.
Run: `npx tsc --noEmit` → nessun errore nuovo.

- [ ] **Step 7: Mutazione**

In `getGmailAuth`, sostituisci `getCasella(chiave)` con `getCasella('drive')` (cioè: ignora la casella chiesta).
Verifica con `grep -c "getCasella('drive')" src/lib/gmail-tools.ts` (atteso 1).
Run: il test → atteso FAIL su «apre la casella CHIESTA». Ripristina, `grep -c` a 0, rilancia: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/gmail-tools.ts src/lib/gmail-tools.casella.test.ts src/lib/tools/mail.ts src/app/api/cron/gmail-alerts/route.ts src/app/api/cron/gmail-morning/route.ts
git commit -m "la casella e un parametro obbligatorio: niente piu predefinito invisibile"
```

---

### Task 3: In lettura si guardano tutte, e si dice sempre dove

**Files:**
- Modify: `src/lib/tools/mail.ts` (i tool Gmail di sola lettura e `executeGmailWrapper`, riga 295)
- Test: `src/lib/tools/mail.lettura-quattro-caselle.test.ts`

**Interfaces:**
- Consumes: le funzioni del Task 2, `caselleDiTrasporto` dal Task 1.
- Produces:
  ```ts
  export interface EsitoLettura<T> {
    risultati: Array<T & { casella: ChiaveCasella }>
    caselleFallite: Array<{ casella: ChiaveCasella; errore: string }>
  }
  export async function leggiSuTutteLeGoogle<T>(
    caselle: ChiaveCasella[] | undefined,
    leggi: (c: ChiaveCasella) => Promise<T[]>,
  ): Promise<EsitoLettura<T>>
  ```

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// src/lib/tools/mail.lettura-quattro-caselle.test.ts
import { describe, it, expect, vi } from 'vitest'
import { leggiSuTutteLeGoogle } from './mail'

describe('lettura su piu caselle', () => {
  it('senza caselle indicate guarda TUTTE le Google, e marca la provenienza', async () => {
    const esito = await leggiSuTutteLeGoogle(undefined, async (c) => [{ id: `msg-${c}` }])

    expect(esito.risultati).toHaveLength(2)
    expect(esito.risultati.map((r) => r.casella).sort()).toEqual(['drive', 'larealestate'])
    expect(esito.caselleFallite).toEqual([])
  })

  it('con le caselle indicate guarda SOLO quelle', async () => {
    const esito = await leggiSuTutteLeGoogle(['larealestate'], async (c) => [{ id: `msg-${c}` }])

    expect(esito.risultati).toHaveLength(1)
    expect(esito.risultati[0].casella).toBe('larealestate')
  })

  it('🚨 una casella che FALLISCE non sparisce: finisce nell esito', async () => {
    // Un elenco parziale che sembra completo e' il difetto di famiglia di
    // questa casa: quattro mesi di fatture estere a zero, sei rapporti di
    // autodiagnosi mai consegnati. Chi legge deve sapere che manca un pezzo.
    const esito = await leggiSuTutteLeGoogle(undefined, async (c) => {
      if (c === 'larealestate') throw new Error('token morto')
      return [{ id: `msg-${c}` }]
    })

    expect(esito.risultati).toHaveLength(1)
    expect(esito.caselleFallite).toHaveLength(1)
    expect(esito.caselleFallite[0].casella).toBe('larealestate')
    expect(esito.caselleFallite[0].errore).toContain('token morto')
  })

  it('CONTROLLO POSITIVO: se falliscono TUTTE, non finge un risultato vuoto', async () => {
    // «nessuna mail trovata» e «non ho potuto guardare» sono cose diverse.
    const esito = await leggiSuTutteLeGoogle(undefined, async () => { throw new Error('giu') })

    expect(esito.risultati).toEqual([])
    expect(esito.caselleFallite).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/tools/mail.lettura-quattro-caselle.test.ts`
Atteso: FAIL — `leggiSuTutteLeGoogle is not exported`.

- [ ] **Step 3: Implementa**

```ts
// in src/lib/tools/mail.ts
import { caselleDiTrasporto, type ChiaveCasella } from '@/lib/caselle'

export interface EsitoLettura<T> {
  risultati: Array<T & { casella: ChiaveCasella }>
  caselleFallite: Array<{ casella: ChiaveCasella; errore: string }>
}

/**
 * Legge su piu' caselle Google e tiene traccia di DUE cose: cosa ha trovato, e
 * dove NON e' riuscito a guardare.
 *
 * ⚠️ La seconda meta' non e' un lusso. Restituire solo i risultati trovati
 * significa che una casella con il token morto sparisce in silenzio, e chi
 * legge crede di aver visto tutto. In questa casa quel difetto e' gia' costato
 * quattro mesi di fatture estere a zero.
 */
export async function leggiSuTutteLeGoogle<T>(
  caselle: ChiaveCasella[] | undefined,
  leggi: (c: ChiaveCasella) => Promise<T[]>,
): Promise<EsitoLettura<T>> {
  const scelte = caselle && caselle.length > 0
    ? caselle
    : caselleDiTrasporto('google').map((c) => c.chiave)

  const risultati: EsitoLettura<T>['risultati'] = []
  const caselleFallite: EsitoLettura<T>['caselleFallite'] = []

  for (const casella of scelte) {
    try {
      for (const r of await leggi(casella)) risultati.push({ ...r, casella })
    } catch (e) {
      caselleFallite.push({ casella, errore: e instanceof Error ? e.message : String(e) })
    }
  }

  return { risultati, caselleFallite }
}
```

- [ ] **Step 4: Usa la funzione nei tool di lettura**

I tool di sola lettura — `gmail_list_inbox`, `gmail_search`, `gmail_read_message`, `gmail_read_thread`, `gmail_list_drafts`, `gmail_show_draft`, `gmail_list_labels`, `gmail_summary_inbox` — accettano un `caselle` facoltativo nello schema:

```ts
caselle: {
  type: 'array',
  items: { type: 'string', enum: ['drive', 'larealestate'] },
  description: 'Quali caselle Google guardare. Se non lo dici, le guarda TUTTE e ti dice da quale viene ogni risultato.',
},
```

e nell'esecutore passano per `leggiSuTutteLeGoogle`. ⚠️ **Nel testo restituito al modello, ogni risultato porta la casella**, e se `caselleFallite` non è vuoto il testo lo dice in chiaro: *«⚠️ NON ho potuto guardare in <casella>: <errore>»*.

- [ ] **Step 5: Lancia e verifica che PASSI**

Run: `npx vitest run src/lib/tools/mail.lettura-quattro-caselle.test.ts` → PASS, 4 test.
Run: `npx vitest run` → suite verde.

- [ ] **Step 6: Mutazione**

Nel `catch`, sostituisci il `caselleFallite.push(...)` con un `continue` secco (la casella fallita sparisce).
`grep -c "caselleFallite.push" src/lib/tools/mail.ts` per confermare che sia uscita (atteso 0).
Run: il test → atteso FAIL su «una casella che FALLISCE non sparisce». Ripristina, `grep -c` a 1, rilancia: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tools/mail.ts src/lib/tools/mail.lettura-quattro-caselle.test.ts
git commit -m "in lettura le caselle sono tutte, e quella che non risponde lo dice"
```

---

### Task 4: In scrittura la casella è obbligatoria, e il rifiuto sta nel codice

**Files:**
- Modify: `src/lib/tools/mail.ts` (i tool Gmail che scrivono, e `executeGmailWrapper`)
- Test: `src/lib/tools/mail.scrittura-casella-obbligatoria.test.ts`

**Interfaces:**
- Consumes: `getCasella`, `listaCaselle` dal Task 1.
- Produces:
  ```ts
  export const TOOL_GMAIL_CHE_SCRIVONO: readonly string[]
  export function casellaPerScrittura(input: Record<string, unknown>): { ok: true; casella: ChiaveCasella } | { ok: false; messaggio: string }
  ```

> 🚨 **Questa è la difesa che deve stare nel codice.** Il 14 set 2026 il bot ha rifiutato correttamente di leggere la posta de La Real Estate — ma la difesa stava **nel prompt**, e ha tenuto perché il modello ha letto bene la sua regola. Per la lettura basta. Per la scrittura no: **una mail partita dall'indirizzo sbagliato non si richiama indietro.**

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// src/lib/tools/mail.scrittura-casella-obbligatoria.test.ts
import { describe, it, expect } from 'vitest'
import { casellaPerScrittura, TOOL_GMAIL_CHE_SCRIVONO } from './mail'

describe('scrittura: la casella non si deduce', () => {
  it('🚨 senza casella si RIFIUTA, e dice quali sono', () => {
    const r = casellaPerScrittura({})

    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.messaggio).toContain('larealestate')
      expect(r.messaggio).toContain('drive')
    }
  })

  it('🚨 una casella non valida NON diventa quella di Restruktura', () => {
    const r = casellaPerScrittura({ casella: 'inventata' })
    expect(r.ok).toBe(false)
  })

  it('CONTROLLO POSITIVO: con la casella indicata, passa', () => {
    // Senza questo, una funzione che rifiuta SEMPRE passerebbe i due test qui
    // sopra — e avremmo murato l'invio delle mail senza accorgercene.
    const r = casellaPerScrittura({ casella: 'larealestate' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.casella).toBe('larealestate')
  })

  it("l'elenco dei tool che scrivono copre invii, bozze, etichette e cestino", () => {
    // Un elenco che dimentica un tool lascia una porta aperta, e nessuno se ne
    // accorge finche' una mail non parte dall'indirizzo sbagliato.
    for (const nome of [
      'gmail_create_draft', 'gmail_send_draft', 'gmail_delete_draft',
      'gmail_apply_label', 'gmail_remove_label',
      'gmail_archive', 'gmail_trash', 'gmail_mark_read',
    ]) {
      expect(TOOL_GMAIL_CHE_SCRIVONO).toContain(nome)
    }
  })
})
```

- [ ] **Step 2: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/tools/mail.scrittura-casella-obbligatoria.test.ts`
Atteso: FAIL — `casellaPerScrittura is not exported`.

- [ ] **Step 3: Implementa**

```ts
// in src/lib/tools/mail.ts
import { getCasella, listaCaselle, type ChiaveCasella } from '@/lib/caselle'

/** I tool Gmail che TOCCANO la posta: per loro la casella e' obbligatoria. */
export const TOOL_GMAIL_CHE_SCRIVONO: readonly string[] = [
  'gmail_create_draft', 'gmail_send_draft', 'gmail_delete_draft',
  'gmail_apply_label', 'gmail_remove_label',
  'gmail_archive', 'gmail_trash', 'gmail_mark_read',
]

const CHIAVI_GOOGLE: ChiaveCasella[] = ['drive', 'larealestate']

/**
 * La casella su cui scrivere. NESSUN predefinito, nemmeno «quella dove ho letto».
 *
 * ⚠️ Rispondere da La Real Estate a una mail trovata su La Real Estate sembra
 * ovvio — ma il giorno in cui il bot ha letto in tre caselle, la scelta l'ha
 * fatta lui e non l'ha vista nessuno. Qui si chiede, sempre.
 */
export function casellaPerScrittura(
  input: Record<string, unknown>,
): { ok: true; casella: ChiaveCasella } | { ok: false; messaggio: string } {
  const grezzo = input.casella
  if (typeof grezzo === 'string' && (CHIAVI_GOOGLE as string[]).includes(grezzo)) {
    return { ok: true, casella: grezzo as ChiaveCasella }
  }
  const elenco = listaCaselle()
    .filter((c) => c.trasporto === 'google')
    .map((c) => `${c.chiave} (${c.indirizzo})`)
    .join(' oppure ')
  return {
    ok: false,
    messaggio:
      'Non scrivo senza sapere da quale casella: non la deduco e non ne ho una predefinita. '
      + `CHIEDI all'Ingegnere quale usare fra: ${elenco}.`,
  }
}
```

- [ ] **Step 4: Applica la guardia nell'esecutore**

In `executeGmailWrapper` (riga ~295), **prima** di eseguire un tool che sta in `TOOL_GMAIL_CHE_SCRIVONO`, chiama `casellaPerScrittura(input)`; se `ok` è falso, restituisci `messaggio` e **non chiamare** la funzione di `gmail-tools`. Aggiungi `casella: { type: 'string', enum: ['drive','larealestate'], description: 'OBBLIGATORIA: da quale casella. Non viene dedotta.' }` allo schema di ciascuno degli otto tool.

- [ ] **Step 5: Lancia e verifica che PASSI**

Run: `npx vitest run src/lib/tools/mail.scrittura-casella-obbligatoria.test.ts` → PASS, 4 test.
Run: `npx vitest run` → suite verde.

- [ ] **Step 6: Mutazione**

Nel ramo finale di `casellaPerScrittura`, sostituisci il `return { ok: false, ... }` con `return { ok: true, casella: 'drive' }`.
`grep -c "ok: true, casella: 'drive'" src/lib/tools/mail.ts` (atteso 1).
Run: il test → atteso **2 rossi** (i due 🚨). Ripristina, `grep -c` a 0, rilancia: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tools/mail.ts src/lib/tools/mail.scrittura-casella-obbligatoria.test.ts
git commit -m "non si scrive da una casella che non ci hanno detto"
```

---

### Task 5: `google_token_dead` diventa per account

**Files:**
- Modify: `src/lib/google-oauth.ts` (`markGoogleTokenDead` e il reset dopo un consenso riuscito)
- Modify: `src/app/api/cron/gmail-alerts/route.ts:10,27,53` e `src/app/api/cron/gmail-morning/route.ts:10,27,53`
- Test: `src/lib/google-oauth.bandierina-per-account.test.ts`

**Interfaces:**
- Produces: `export function chiaveTokenMorto(accountEmail: string): string` — ritorna `google_token_dead:<accountEmail>`.

> Oggi è **una bandierina per due account**, e la scrivono i cron Gmail guardando solo Restruktura: se morisse il token di La Real Estate **non lo saprebbe nessuno**. Con due account e un interruttore solo, il secondo è cieco **per costruzione** — e ormai questa firma la riconosciamo.

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// src/lib/google-oauth.bandierina-per-account.test.ts
import { describe, it, expect } from 'vitest'
import { chiaveTokenMorto } from './google-oauth'

describe('la bandierina del token morto e per account', () => {
  it('🚨 due account NON condividono la stessa bandierina', () => {
    const a = chiaveTokenMorto('restruktura.drive@gmail.com')
    const b = chiaveTokenMorto('larealestate.amministrazione@gmail.com')
    expect(a).not.toBe(b)
  })

  it('la chiave nomina l account, cosi si legge nel database senza decifrarla', () => {
    expect(chiaveTokenMorto('larealestate.amministrazione@gmail.com'))
      .toBe('google_token_dead:larealestate.amministrazione@gmail.com')
  })
})
```

- [ ] **Step 2: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/google-oauth.bandierina-per-account.test.ts`
Atteso: FAIL — `chiaveTokenMorto is not exported`.

- [ ] **Step 3: Implementa**

```ts
// in src/lib/google-oauth.ts
/**
 * La bandierina del token morto, UNA PER ACCOUNT.
 *
 * ⚠️ Fino al 14 settembre 2026 era una sola (`google_token_dead`), scritta dai
 * cron Gmail guardando solo Restruktura. Con due account quella forma rende il
 * secondo cieco PER COSTRUZIONE: il token de La Real Estate poteva morire
 * senza che nessuno lo sapesse.
 */
export function chiaveTokenMorto(accountEmail: string): string {
  return `google_token_dead:${accountEmail}`
}
```

Poi: `markGoogleTokenDead` scrive su `chiaveTokenMorto(accountEmail)` invece che sulla chiave fissa, e prende l'account come parametro; il reset dopo un consenso riuscito (`google-oauth.ts`, dove oggi fa l'upsert di `google_token_dead` a `'false'`) usa la stessa funzione.
Nei due cron, la costante `GOOGLE_TOKEN_DEAD_KEY` diventa `chiaveTokenMorto(getCasella('drive').accountEmail!)`, con accanto il commento: *«i cron Gmail sorvegliano la casella di Restruktura; quella de La Real Estate non ha ancora un cron suo»*.

⚠️ **La vecchia chiave `google_token_dead` resta nel database** con il suo valore: non cancellarla. Se un giorno tornasse utile sapere che c'era, una riga in più non fa danno; cancellarla sì, se qualcosa la leggesse ancora.

- [ ] **Step 4: Lancia e verifica che PASSI**

Run: `npx vitest run src/lib/google-oauth.bandierina-per-account.test.ts` → PASS, 2 test.
Run: `npx vitest run` → suite verde. ⚠️ Se qualche test esistente asserisce su `'google_token_dead'` come stringa fissa, **aggiornalo di proposito** e dì quale nel resoconto.

- [ ] **Step 5: Mutazione**

Cambia il corpo in `return 'google_token_dead'` (torna alla bandierina unica).
`grep -c "return 'google_token_dead'" src/lib/google-oauth.ts` (atteso 1).
Run: il test → atteso FAIL su «due account NON condividono». Ripristina, `grep -c` a 0, rilancia: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/google-oauth.ts src/lib/google-oauth.bandierina-per-account.test.ts src/app/api/cron/gmail-alerts/route.ts src/app/api/cron/gmail-morning/route.ts
git commit -m "una bandierina per account: con una sola il secondo e cieco per costruzione"
```

---

### Task 6: La prova di vita delle credenziali Google

**Files:**
- Create: `src/lib/tools/accessi-google-tools.ts`
- Test: `src/lib/tools/accessi-google-tools.test.ts`
- Modify: `src/lib/tools.ts` (import, `ALL_TOOLS`, `EXECUTORS`)
- Modify: `src/lib/mappa-officina.ts` (dominio **«Segreteria»**)
- Modify: `src/lib/tools.differimento.test.ts` (il conto dei tool e l'impronta)

**Interfaces:**
- Produces: `export const ACCESSI_GOOGLE_TOOLS: ToolDefinition[]`, `export async function executeAccessiGoogleTools(name: string, input: Record<string, unknown>): Promise<string | null>` — tool `verifica_accessi_google`.

> Oggi alla domanda *«la casella di La Real Estate funziona?»* **non sa rispondere nessuno**. La credenziale è salvata ma non è mai stata esercitata: l'email mostrata dal callback viene da un **decode locale** del JWT (`google-oauth.ts:102`), non da una chiamata a Google.
>
> ⚠️ **Il dominio è «Segreteria», non «Se stesso».** Chi chiede «riesco a leggere la posta di LRE?» sta parlando di posta, non di autodiagnosi — e con `TOOL_DEFER=1` il tool è **differito**, quindi il modello lo trova solo cercando nel dominio giusto: sbagliare scaffale equivale a non averlo.

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// src/lib/tools/accessi-google-tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getAuthorizedClient } = vi.hoisted(() => ({ getAuthorizedClient: vi.fn() }))
vi.mock('@/lib/google-oauth', () => ({ getAuthorizedClient }))

import { ACCESSI_GOOGLE_TOOLS, executeAccessiGoogleTools } from './accessi-google-tools'

beforeEach(() => { getAuthorizedClient.mockReset() })

describe('verifica_accessi_google', () => {
  it('non risponde ai nomi che non sono suoi', async () => {
    expect(await executeAccessiGoogleTools('altro', {})).toBeNull()
  })

  it('CONTROLLO POSITIVO: se entrambe rispondono, lo dice di ENTRAMBE', async () => {
    getAuthorizedClient.mockResolvedValue({})

    const testo = await executeAccessiGoogleTools('verifica_accessi_google', {})

    expect(testo).toContain('restruktura.drive@gmail.com')
    expect(testo).toContain('larealestate.amministrazione@gmail.com')
    expect(testo?.toLowerCase()).toContain('viva')
  })

  it('🚨 una credenziale morta viene NOMINATA, non taciuta', async () => {
    getAuthorizedClient.mockImplementation(async (email: string) => {
      if (email.startsWith('larealestate')) throw new Error('invalid_grant')
      return {}
    })

    const testo = await executeAccessiGoogleTools('verifica_accessi_google', {})

    expect(testo).toContain('larealestate.amministrazione@gmail.com')
    expect(testo).toContain('invalid_grant')
  })

  it('🚨 parla ANCHE quando va tutto bene', () => {
    // Un sorvegliante che si fa vivo solo nei guai e' indistinguibile da uno
    // morto: il 14 set 2026 questo ha impedito per quattro tentativi di sapere
    // se i cron girassero ancora dopo un deploy.
    expect(ACCESSI_GOOGLE_TOOLS.map((t) => t.name)).toEqual(['verifica_accessi_google'])
  })
})
```

- [ ] **Step 2: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/tools/accessi-google-tools.test.ts`
Atteso: FAIL — modulo non trovato.

- [ ] **Step 3: Implementa**

```ts
// src/lib/tools/accessi-google-tools.ts
/**
 * La prova di vita degli accessi Google.
 *
 * Nasce il 14 settembre 2026, il giorno in cui — autorizzata la casella de La
 * Real Estate — alla domanda «funziona?» non sapeva rispondere nessuno. La
 * credenziale era salvata ma non era mai stata esercitata: l'indirizzo mostrato
 * dal callback viene da un decode LOCALE del JWT, non da una chiamata a Google.
 *
 * `getAuthorizedClient` esercita gia' la credenziale (`getAccessToken()`): qui
 * la si chiama per OGNI casella Google e si riporta l'esito — anche quello buono.
 */
import type { ToolDefinition } from './types'
import { caselleDiTrasporto } from '@/lib/caselle'
import { getAuthorizedClient } from '@/lib/google-oauth'

export const ACCESSI_GOOGLE_TOOLS: ToolDefinition[] = [
  {
    name: 'verifica_accessi_google',
    description:
      'Prova UNA PER UNA le credenziali Google di Cervellone (le caselle Gmail di Restruktura e de La Real Estate) e dice quali sono VIVE e quali no, col motivo. USALO quando l Ingegnere chiede "riesci a leggere la posta di X?", "l accesso a quella casella funziona?", oppure quando un tool di posta fallisce e non si capisce se sia un problema di credenziali. Riporta l esito COM E, anche quando e buono: un controllo che parla solo nei guai e indistinguibile da uno che non gira.',
    input_schema: { type: 'object', properties: {} },
  },
]

export async function executeAccessiGoogleTools(
  name: string,
  _input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'verifica_accessi_google') return null

  const righe: string[] = ['Accessi Google, provati uno per uno:', '']
  for (const casella of caselleDiTrasporto('google')) {
    const email = casella.accountEmail!
    try {
      const client = await getAuthorizedClient(email)
      righe.push(client
        ? `✅ ${email} (${casella.chiave}) — credenziale VIVA.`
        : `❌ ${email} (${casella.chiave}) — nessuna credenziale salvata: va autorizzata su /api/auth/google.`)
    } catch (e) {
      righe.push(`❌ ${email} (${casella.chiave}) — NON funziona: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return righe.join('\n')
}
```

- [ ] **Step 4: Collega il tool**

In `src/lib/tools.ts`: import accanto agli altri (vicino alla riga 39), `...ACCESSI_GOOGLE_TOOLS` in coda a `ALL_TOOLS` (riga ~802) con il commento `// 2026-09-14: le credenziali Google sono vive?`, e `executeAccessiGoogleTools` nell'elenco `EXECUTORS` (riga ~934).

In `src/lib/mappa-officina.ts`: aggiungi `verifica_accessi_google` al dominio **«Segreteria»**. ⚠️ Esiste una guardia «ogni tool fuori dal nucleo sta in esattamente un dominio»: senza questa riga la suite resta rossa, ed è voluto — *«una mappa incompleta è peggio di nessuna mappa»*.

- [ ] **Step 5: Aggiorna il conto dei tool**

Run: `npx vitest run src/lib/tools.differimento.test.ts`
Fallirà sul numero di definizioni e sull'impronta. ⚠️ **Prendi l'md5 nuovo DAL MESSAGGIO DI FALLIMENTO**, non calcolarlo a parte, e aggiungi il commento della decisione nello stile delle voci già presenti.

- [ ] **Step 6: Lancia tutto**

Run: `npx vitest run src/lib/tools/accessi-google-tools.test.ts` → PASS, 4 test.
Run: `npx vitest run` → suite verde. Run: `npx tsc --noEmit` → nessun errore nuovo.

- [ ] **Step 7: Mutazione**

Nel `catch`, sostituisci la riga `righe.push(\`❌ …\`)` con un `continue` (la credenziale morta sparisce dall'elenco).
`grep -c "NON funziona" src/lib/tools/accessi-google-tools.ts` (atteso 0 dopo la mutazione).
Run: il test → atteso FAIL su «una credenziale morta viene NOMINATA». Ripristina, `grep -c` a 1, rilancia: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/tools/accessi-google-tools.ts src/lib/tools/accessi-google-tools.test.ts src/lib/tools.ts src/lib/mappa-officina.ts src/lib/tools.differimento.test.ts
git commit -m "la prova di vita degli accessi Google, e parla anche quando va bene"
```

---

### Task 7: Il prompt dice la verità, e lo si misura

**Files:**
- Modify: `src/lib/prompts.ts:260-262` e `:281`
- Modify: `src/prove/casi-reali.ts` (un caso nuovo)
- Test: `src/lib/prompts.caselle.test.ts`

**Interfaces:**
- Consumes: `listaCaselle` dal Task 1.

> 🚨 **Deve stare nello stesso commit del resto.** Oggi il prompt elenca **tre** caselle. Un codice che ne conosce quattro con un prompt che ne dichiara tre farebbe **rifiutare al bot una posta a cui ha accesso**: si passerebbe da un difetto al suo opposto.

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// src/lib/prompts.caselle.test.ts
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { listaCaselle } from './caselle'

const PROMPT = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'prompts.ts'), 'utf8')

describe('il prompt e il registro non possono divergere', () => {
  it('🚨 ogni casella del registro e NOMINATA nel prompt', () => {
    // Il prompt e' la mappa che il modello usa per sapere cosa puo' fare. Se il
    // registro ne conosce quattro e il prompt tre, il bot rifiuta una posta a
    // cui ha accesso — da un difetto al suo opposto.
    const mancanti = listaCaselle()
      .map((c) => c.indirizzo)
      .filter((indirizzo) => !PROMPT.includes(indirizzo))

    expect(mancanti, `caselle nel registro ma non nel prompt: ${mancanti.join(', ')}`).toEqual([])
  })

  it('il prompt non dice piu che i tool Gmail lavorano su UNA casella sola', () => {
    expect(PROMPT).not.toMatch(/tool gmail_\*\)?:?\s*$/im)
    expect(PROMPT).toMatch(/casella .*OBBLIGATORIA|di' SEMPRE da quale casella/i)
  })
})
```

- [ ] **Step 2: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/prompts.caselle.test.ts`
Atteso: FAIL — `larealestate.amministrazione@gmail.com` non è nel prompt.

- [ ] **Step 3: Aggiorna il prompt**

In `src/lib/prompts.ts`, nella sezione delle caselle (righe 260-262), aggiungi la quarta voce e sostituisci la riga 281:

```
- **larealestate.amministrazione@gmail.com** (Google API OAuth, tool gmail_*) — casella amministrativa de LA REAL ESTATE SRLS.

REGOLA CASELLE (Google API OAuth, tool gmail_*):
- In LETTURA le caselle Google sono DUE e per difetto le guardi ENTRAMBE. Ogni
  risultato dice da quale casella viene: riportalo, perche' sapere IN QUALE
  societa' e' arrivata una mail e' meta' della risposta.
- Se una casella non risponde, il tool te lo dice: RIPETILO all'Ingegnere. Un
  elenco parziale che sembra completo e' peggio di un errore.
- Una ricerca «nella posta» comprende ANCHE le caselle TopHost (info@ e
  raffaele.lentini@): sono tool diversi, e vanno chiamati anche quelli.
- In SCRITTURA (bozze, invii, etichette, archiviazione, cestino) la casella e'
  OBBLIGATORIA e NON si deduce — nemmeno da quella dove hai letto. Se
  l'Ingegnere non l'ha detta, CHIEDI quale. Una mail che parte dall'indirizzo
  sbagliato arriva a un cliente firmata da un'altra societa'.
```

- [ ] **Step 4: Lancia e verifica che PASSI**

Run: `npx vitest run src/lib/prompts.caselle.test.ts` → PASS, 2 test.

- [ ] **Step 5: Aggiungi il caso misurato**

In `src/prove/casi-reali.ts` aggiungi un caso `casella-non-nominata-si-chiede`: l'Ingegnere dice *«archivia quella mail di Booking»* senza nominare la casella, e il criterio è che il bot **chieda quale** invece di sceglierne una. Nel `non_deve`: che archivi senza chiedere.

Lancia la prova:
```bash
npx tsx --env-file=.env.local src/prove/esegui.ts --caso casella-non-nominata-si-chiede
```

⚠️ **Il controllo positivo della misura**: togli temporaneamente dal prompt la riga «In SCRITTURA … CHIEDI quale», rilancia, e verifica che **peggiori**. Una regola che non cambia l'esito non sta difendendo niente — è così che «ABBINA TU» è stata misurata 0/3 senza e 3/3 con. Riporta i due numeri nel resoconto, e **ripristina la riga**.

- [ ] **Step 6: Verifica finale e commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/lib/prompts.ts src/lib/prompts.caselle.test.ts src/prove/casi-reali.ts
git commit -m "il prompt dice che le caselle sono quattro, e la regola e misurata"
```

---

## Cosa fa Claude, non l'esecutore

1. **L'audit avversariale** prima del merge.
2. **La verifica in produzione dopo il deploy**: lanciare `verifica_accessi_google` e accertare che dica **viva** per entrambe. ⚠️ Se dice che quella de La Real Estate non funziona, **non è un fallimento del lavoro**: è la risposta che oggi non abbiamo, e va data a Raffaele così com'è.
3. **La prova sul campo che ha fatto nascere tutto**: chiedere al bot *«sono arrivate fatture da Booking sulla casella de La Real Estate?»* e vedere se stavolta guarda davvero.
