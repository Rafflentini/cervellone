# Privacy documenti — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rendere `/doc/[id]` privato (gate sul cookie di sessione esistente) e permettere la condivisione deliberata via link firmati HMAC a scadenza, generati da un tool bot con conferma.

**Architecture:** Helper puro `doc-access.ts` (token sessione + firma/verifica share token); gate sull'API `/api/doc/[id]` (la pagina è client-side e fa fetch a quell'API, quindi il gate sull'API copre tutto); tool `genera_link_condivisione` che crea una proposta (tabella `cervellone_share_proposte`) confermata via `/condividi_ok_<uuid>` nel route Telegram, che firma e restituisce l'URL.

**Tech Stack:** Next.js 16 (App Router), TypeScript, Node `crypto` (HMAC, timingSafeEqual), Supabase, vitest.

**Spec:** `docs/superpowers/specs/2026-06-10-cervellone-privacy-doc-design.md`

**Branch:** `feat/privacy-doc`. NB: NON deployare senza security-review + audit adversarial PRIMA (lezione 10 giu).

---

## File Structure

- `src/lib/doc-access.ts` — **nuovo**: `getAuthToken`, `isAuthedCookie`, `signShareToken`, `verifyShareToken`, `isDocAccessAllowed`. Helper puri (solo `crypto` + env), zero I/O.
- `src/lib/doc-access.test.ts` — **nuovo**.
- `src/app/api/auth/route.ts` — usa `getAuthToken` da doc-access (no duplicazione segreto).
- `src/app/api/doc/[id]/route.ts` — gate (cookie o share token valido) → altrimenti 401.
- `src/app/doc/[id]/page.tsx` — inoltra `t`/`exp` all'API; distingue 401 (privato) da 404.
- `supabase/migrations/2026-06-10-share-proposte.sql` — **nuovo**: tabella `cervellone_share_proposte`.
- `src/lib/share-proposte.ts` — **nuovo**: `createShareProposal`, `confirmShareProposal`.
- `src/lib/share-proposte.test.ts` — **nuovo**.
- `src/lib/tools.ts` — tool `genera_link_condivisione` + executor.
- `src/app/api/telegram/route.ts` — handler `/condividi_ok_<uuid>`.
- `src/lib/prompts.ts` — regola prompt: condividere solo su richiesta esplicita.

---

## Task 1: Helper `doc-access.ts` (puro, testabile)

**Files:**
- Create: `src/lib/doc-access.ts`
- Test: `src/lib/doc-access.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/doc-access.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { getAuthToken, isAuthedCookie, signShareToken, verifyShareToken, isDocAccessAllowed } from './doc-access'

beforeAll(() => { process.env.AUTH_SECRET = 'test-secret' })

describe('doc-access', () => {
  it('isAuthedCookie: solo il token di sessione corretto passa', () => {
    expect(isAuthedCookie(getAuthToken())).toBe(true)
    expect(isAuthedCookie('sbagliato')).toBe(false)
    expect(isAuthedCookie(undefined)).toBe(false)
  })

  it('verifyShareToken: valido entro scadenza, no se scaduto o manomesso', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const tok = signShareToken('doc1', exp)
    expect(verifyShareToken('doc1', tok, exp)).toBe(true)
    expect(verifyShareToken('doc1', tok, Math.floor(Date.now() / 1000) - 1)).toBe(false) // scaduto
    expect(verifyShareToken('doc2', tok, exp)).toBe(false) // id diverso
    expect(verifyShareToken('doc1', 'deadbeef', exp)).toBe(false) // token finto
  })

  it('isDocAccessAllowed: cookie OPPURE share token', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const tok = signShareToken('d', exp)
    expect(isDocAccessAllowed({ id: 'd', cookieToken: getAuthToken() })).toBe(true)
    expect(isDocAccessAllowed({ id: 'd', shareToken: tok, exp })).toBe(true)
    expect(isDocAccessAllowed({ id: 'd' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/doc-access.test.ts`
Expected: FAIL — modulo inesistente.

- [ ] **Step 3: Implementare**

```ts
// src/lib/doc-access.ts
import crypto from 'crypto'

const SESSION_PAYLOAD = 'cervellone_v2'

/** Token di sessione (identico a api/auth). httpOnly cookie `cervellone_auth`. */
export function getAuthToken(): string {
  const secret = process.env.AUTH_SECRET || 'cervellone'
  return crypto.createHmac('sha256', secret).update(SESSION_PAYLOAD).digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
  } catch {
    return false
  }
}

export function isAuthedCookie(cookieToken: string | undefined): boolean {
  if (!cookieToken) return false
  return safeEqualHex(cookieToken, getAuthToken())
}

/** Segreto share separato dalla sessione (un token share non vale come cookie e viceversa). */
function shareSecret(): string {
  return (process.env.AUTH_SECRET || 'cervellone') + ':doc_share'
}

export function signShareToken(docId: string, expSec: number): string {
  return crypto.createHmac('sha256', shareSecret()).update(`${docId}.${expSec}`).digest('hex')
}

export function verifyShareToken(docId: string, token: string | undefined, expSec: number): boolean {
  if (!token || !Number.isFinite(expSec)) return false
  if (expSec <= Math.floor(Date.now() / 1000)) return false // scaduto
  return safeEqualHex(token, signShareToken(docId, expSec))
}

export function isDocAccessAllowed(p: {
  id: string
  cookieToken?: string
  shareToken?: string
  exp?: number
}): boolean {
  if (isAuthedCookie(p.cookieToken)) return true
  if (p.shareToken && typeof p.exp === 'number') return verifyShareToken(p.id, p.shareToken, p.exp)
  return false
}
```

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/lib/doc-access.ts src/lib/doc-access.test.ts
git commit -m "feat(privacy): helper doc-access (sessione + share token firmato)"
```

---

## Task 2: `api/auth` riusa `getAuthToken`

**Files:**
- Modify: `src/app/api/auth/route.ts`

- [ ] **Step 1: Sostituire la funzione locale**

In `src/app/api/auth/route.ts` rimuovere la `getAuthToken` locale e importarla:
```ts
import { getAuthToken } from '@/lib/doc-access'
```
(Il resto invariato: POST confronta `password === APP_PASSWORD`, setta cookie `cervellone_auth = getAuthToken()`.)

- [ ] **Step 2: Verifica** — `npx tsc --noEmit 2>&1 | grep "api/auth"` → nessun errore. Il login web chat deve restare identico (stesso token, stesso cookie).
- [ ] **Step 3: Commit**

```bash
git add src/app/api/auth/route.ts
git commit -m "refactor(auth): riusa getAuthToken condiviso (no duplicazione segreto)"
```

---

## Task 3: Gate sull'API `/api/doc/[id]`

**Files:**
- Modify: `src/app/api/doc/[id]/route.ts`
- Test: `src/app/api/doc/[id]/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/doc/[id]/route.test.ts
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { getAuthToken, signShareToken } from '@/lib/doc-access'

beforeAll(() => { process.env.AUTH_SECRET = 'test-secret' })
vi.mock('@/lib/supabase', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { content: '<h1>ok</h1>' }, error: null }) }) }) }) },
}))

function req(url: string, cookie?: string): any {
  return { url, cookies: { get: (n: string) => (cookie ? { value: cookie } : undefined) } }
}

describe('GET /api/doc/[id]', () => {
  it('401 senza auth', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('https://x/api/doc/d'), { params: Promise.resolve({ id: 'd' }) })
    expect(res.status).toBe(401)
  })
  it('200 con cookie valido', async () => {
    const { GET } = await import('./route')
    const res = await GET(req('https://x/api/doc/d', getAuthToken()), { params: Promise.resolve({ id: 'd' }) })
    expect(res.status).toBe(200)
  })
  it('200 con share token valido', async () => {
    const { GET } = await import('./route')
    const exp = Math.floor(Date.now() / 1000) + 3600
    const tok = signShareToken('d', exp)
    const res = await GET(req(`https://x/api/doc/d?t=${tok}&exp=${exp}`), { params: Promise.resolve({ id: 'd' }) })
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run test** → FAIL (oggi non c'è gate, 401 non avviene).

- [ ] **Step 3: Implementare il gate**

```ts
// src/app/api/doc/[id]/route.ts
import { NextRequest } from 'next/server'
import { supabase } from '@/lib/supabase'
import { isDocAccessAllowed } from '@/lib/doc-access'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const cookieToken = request.cookies.get('cervellone_auth')?.value
  const url = new URL(request.url)
  const shareToken = url.searchParams.get('t') ?? undefined
  const expRaw = url.searchParams.get('exp')
  const exp = expRaw ? Number(expRaw) : undefined

  if (!isDocAccessAllowed({ id, cookieToken, shareToken, exp })) {
    return new Response('Accesso non autorizzato', { status: 401 })
  }

  const { data, error } = await supabase.from('documents').select('content').eq('id', id).single()
  if (error || !data) return new Response('Documento non trovato', { status: 404 })
  return new Response(data.content, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}
```

- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit**

```bash
git add "src/app/api/doc/[id]/route.ts" "src/app/api/doc/[id]/route.test.ts"
git commit -m "feat(privacy): gate /api/doc su cookie sessione o share token"
```

---

## Task 4: Pagina `/doc/[id]` — inoltra share param + stato "privato"

**Files:**
- Modify: `src/app/doc/[id]/page.tsx`

- [ ] **Step 1: Inoltrare `t`/`exp` e distinguere 401**

Nella `useEffect` che fa `fetch('/api/doc/${id}')`, propagare i query param correnti e gestire 401:
```ts
const [authNeeded, setAuthNeeded] = useState(false)
useEffect(() => {
  const qs = window.location.search // include ?t=&exp= se presente
  fetch(`/api/doc/${id}${qs}`)
    .then(res => {
      if (res.status === 401) { setAuthNeeded(true); throw new Error('auth') }
      if (!res.ok) throw new Error()
      return res.text()
    })
    .then(setHtml)
    .catch(() => { /* error gestito sotto via authNeeded/error */ })
}, [id])
```
Aggiungere, PRIMA del ramo `if (error)`:
```tsx
if (authNeeded) {
  return (
    <div className="flex items-center justify-center h-screen bg-gray-50">
      <div className="text-center">
        <p className="text-6xl mb-4">🔒</p>
        <p className="text-xl font-semibold text-gray-700">Documento privato</p>
        <p className="text-gray-400 mt-2">Accedi a Cervellone (la stessa password della chat) e riapri questo link.</p>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verifica** — `npx tsc --noEmit 2>&1 | grep "doc/\[id\]/page"` → nessun errore. (Test E2E manuale in security-review.)
- [ ] **Step 3: Commit**

```bash
git add "src/app/doc/[id]/page.tsx"
git commit -m "feat(privacy): pagina /doc inoltra share param + schermata documento privato"
```

---

## Task 5: Tabella + logica proposte di condivisione

**Files:**
- Create: `supabase/migrations/2026-06-10-share-proposte.sql`
- Create: `src/lib/share-proposte.ts`
- Test: `src/lib/share-proposte.test.ts`

- [ ] **Step 1: Migration**

```sql
-- supabase/migrations/2026-06-10-share-proposte.sql
create table if not exists cervellone_share_proposte (
  id uuid primary key default gen_random_uuid(),
  document_id text not null,
  giorni int not null default 7,
  stato text not null default 'in_attesa', -- in_attesa | confermata | annullata
  created_at timestamptz not null default now()
);
alter table cervellone_share_proposte enable row level security;
```

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/share-proposte.test.ts
import { describe, it, expect, vi, beforeAll } from 'vitest'
beforeAll(() => { process.env.AUTH_SECRET = 'test-secret'; process.env.APP_BASE_URL = 'https://cervellone-five.vercel.app' })
const store: any = {}
vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      insert: (r: any) => ({ select: () => ({ single: async () => { store.row = { id: 'p1', ...r }; return { data: { id: 'p1' }, error: null } } }) }),
      select: () => ({ eq: () => ({ single: async () => ({ data: store.row, error: null }) }) }),
      update: (u: any) => ({ eq: () => { store.row = { ...store.row, ...u }; return Promise.resolve({ error: null }) } }),
    }),
  }),
}))

describe('share-proposte', () => {
  it('createShareProposal salva e ritorna id; confirmShareProposal ritorna URL firmato verificabile', async () => {
    const { createShareProposal, confirmShareProposal } = await import('./share-proposte')
    const id = await createShareProposal('doc-9', 7)
    expect(id).toBe('p1')
    const url = await confirmShareProposal('p1')
    expect(url).toContain('/doc/doc-9?t=')
    expect(url).toContain('exp=')
    const { verifyShareToken } = await import('./doc-access')
    const u = new URL(url!)
    expect(verifyShareToken('doc-9', u.searchParams.get('t')!, Number(u.searchParams.get('exp')))).toBe(true)
  })
})
```

- [ ] **Step 3: Run test** → FAIL (modulo inesistente).

- [ ] **Step 4: Implementare**

```ts
// src/lib/share-proposte.ts
import { getSupabaseServer } from './supabase-server'
import { signShareToken } from './doc-access'

const BASE_URL = process.env.APP_BASE_URL || 'https://cervellone-five.vercel.app'

export async function createShareProposal(documentId: string, giorni: number): Promise<string | null> {
  const g = Math.min(30, Math.max(1, Math.round(giorni || 7)))
  const supabase = getSupabaseServer()
  const { data, error } = await supabase
    .from('cervellone_share_proposte')
    .insert({ document_id: documentId, giorni: g, stato: 'in_attesa' })
    .select('id').single()
  if (error || !data) return null
  return (data as { id: string }).id
}

export async function confirmShareProposal(proposalId: string): Promise<string | null> {
  const supabase = getSupabaseServer()
  const { data, error } = await supabase
    .from('cervellone_share_proposte').select('*').eq('id', proposalId).single()
  if (error || !data) return null
  const p = data as { document_id: string; giorni: number; stato: string }
  if (p.stato !== 'in_attesa') return null
  const exp = Math.floor(Date.now() / 1000) + p.giorni * 86400
  const token = signShareToken(p.document_id, exp)
  await supabase.from('cervellone_share_proposte').update({ stato: 'confermata' }).eq('id', proposalId)
  return `${BASE_URL}/doc/${p.document_id}?t=${token}&exp=${exp}`
}
```

- [ ] **Step 5: Run tests** → PASS.
- [ ] **Step 6: Commit**

```bash
git add src/lib/share-proposte.ts src/lib/share-proposte.test.ts supabase/migrations/2026-06-10-share-proposte.sql
git commit -m "feat(privacy): proposte di condivisione (create/confirm → URL firmato)"
```

---

## Task 6: Tool `genera_link_condivisione`

**Files:**
- Modify: `src/lib/tools.ts` (aggiungere la definizione tool + il caso nell'executor che ha `conversationId`)

- [ ] **Step 1: Definizione tool** (aggiungere all'array di tool appropriato, es. accanto a DRAFT_TOOLS)

```ts
{
  name: 'genera_link_condivisione',
  description: "Prepara un link CONDIVISIBILE (a scadenza) per un documento/bozza, da dare a un cliente/ente esterno. NON genera subito: crea una proposta che l'utente DEVE confermare. Usalo SOLO se l'utente chiede esplicitamente di condividere.",
  input_schema: {
    type: 'object' as const,
    properties: {
      doc_id: { type: 'string', description: 'id del documento (come da lista_bozze/ritrova_bozza).' },
      giorni: { type: 'number', description: 'Giorni di validità del link (default 7, max 30).' },
    },
    required: ['doc_id'],
  },
},
```

- [ ] **Step 2: Executor** (nel wrapper che riceve `conversationId`, es. `executeDraftWrapper` o un nuovo caso)

```ts
if (name === 'genera_link_condivisione') {
  const { createShareProposal } = await import('./share-proposte')
  const docId = String(input.doc_id || '').trim()
  if (!docId) return 'Errore: doc_id richiesto.'
  const giorni = typeof input.giorni === 'number' ? input.giorni : 7
  const propId = await createShareProposal(docId, giorni)
  if (!propId) return 'Non sono riuscito a preparare la condivisione (documento non trovato o errore).'
  return `Sto per creare un link CONDIVISIBILE valido ${Math.min(30, Math.max(1, Math.round(giorni)))} giorni per questo documento. Chi avrà il link potrà vederlo. Confermi rispondendo: /condividi_ok_${propId}`
}
```

- [ ] **Step 3: Test** — aggiungere a un test esistente dei tool (mock di createShareProposal) un caso che verifica il messaggio di conferma con `/condividi_ok_`. Esempio in `src/lib/tools.share.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
vi.mock('@/lib/share-proposte', () => ({ createShareProposal: vi.fn(async () => 'P1') }))
// chiamare l'executor con name='genera_link_condivisione', input {doc_id:'d', giorni:7}
// assert: ritorno contiene '/condividi_ok_P1' e 'Confermi'
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit**

```bash
git add src/lib/tools.ts src/lib/tools.share.test.ts
git commit -m "feat(privacy): tool genera_link_condivisione (crea proposta + chiede conferma)"
```

---

## Task 7: Handler conferma `/condividi_ok_<uuid>` nel route Telegram

**Files:**
- Modify: `src/app/api/telegram/route.ts` (accanto agli altri handler `_ok_`, es. dopo `/accesso_ok_`)

- [ ] **Step 1: Aggiungere il match + esecuzione**

```ts
// dopo gli altri match _ok_ (es. riga ~395)
const mShareOk = userText.match(/^\/condividi_ok_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)
if (mShareOk) {
  const { confirmShareProposal } = await import('@/lib/share-proposte')
  const url = await confirmShareProposal(mShareOk[1])
  const msg = url
    ? `🔗 Link di condivisione (scade tra i giorni indicati):\n${url}\n\nChi ha il link vede il documento finché non scade.`
    : '⚠️ Proposta di condivisione non trovata, già usata o scaduta.'
  await sendTelegramMessage(chatId, msg)
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Verifica** — `npx tsc --noEmit 2>&1 | grep "telegram/route"` → nessun errore. Pattern UUID identico agli altri handler `_ok_`.
- [ ] **Step 3: Commit**

```bash
git add src/app/api/telegram/route.ts
git commit -m "feat(privacy): conferma /condividi_ok_ → genera e invia link firmato"
```

---

## Task 8: Regola prompt

**Files:**
- Modify: `src/lib/prompts.ts` (dentro `BASE_PROMPT`, vicino alle regole GESTIONE BOZZE)

- [ ] **Step 1: Aggiungere la regola**

Aggiungere al `BASE_PROMPT`:
```
CONDIVISIONE DOCUMENTI: i link /doc sono PRIVATI. Per dare un documento a un esterno (cliente/ente) usa genera_link_condivisione(doc_id, giorni) SOLO se l'utente lo chiede esplicitamente; il bot poi conferma con /condividi_ok_. NON condividere né proporre di condividere documenti di tua iniziativa.
```

- [ ] **Step 2: Verifica** — `npx tsc --noEmit` invariato (è una costante stringa). Attenzione: il `BASE_PROMPT` è il blocco cachato a 1h → modificarlo invalida la cache UNA volta (atteso, è statico).
- [ ] **Step 3: Commit**

```bash
git add src/lib/prompts.ts
git commit -m "feat(privacy): regola prompt — condividere documenti solo su richiesta esplicita"
```

---

## Self-Review (Claude, prima del merge)

1. **Spec coverage:** /doc privato (T3,T4) ✓ · riuso cookie esistente (T1,T2) ✓ · share token firmato a scadenza (T1,T5) ✓ · tool bot + doppia conferma (T6,T7) ✓ · auto-bozze/mail-inviata protette dallo stesso gate (T3, gratis) ✓ · niente retention/env (rispettato) ✓ · regola prompt (T8) ✓.
2. **Type consistency:** `signShareToken(docId, expSec)`/`verifyShareToken(docId, token, expSec)`/`isDocAccessAllowed({id,cookieToken,shareToken,exp})` definiti in T1, usati identici in T3/T5. `createShareProposal(documentId, giorni)→id` / `confirmShareProposal(id)→url` T5 usati in T6/T7. ✓
3. **Placeholder:** nessuno; il test T6 ha lo scheletro dell'executor — chi implementa colloca il caso nel wrapper reale con conversationId (executeDraftWrapper o nuovo), segnalando nel PR se l'aggancio non è banale.

## Sicurezza & deploy (VINCOLANTE)

PRIMA del deploy: `security-review` + audit adversarial (constant-time già in T1; verificare: nessun leak esistenza-doc su 401, AUTH_SECRET presente in prod, share token ≠ cookie, RLS sulla nuova tabella). Migration `share-proposte` applicata in prod via MCP. Smoke: link bot → tap senza login = 🔒; con login = doc; link condivisione = doc finché non scade.

## Ordine

T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → security-review/audit → migration → deploy.
