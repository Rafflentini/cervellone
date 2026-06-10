# Privacy documenti — `/doc` privato + condivisione firmata

**Data:** 2026-06-10
**Origine:** audit privacy (item E). `/api/doc/[id]` e `/doc/[id]` servono QUALSIASI documento
in base all'id, **senza autenticazione** (la web chat è protetta da password, `/doc` no — nessun
middleware). Gli id sono UUID ma il bot manda i link in chiaro su Telegram → "sicurezza per
oscurità". Dentro `documents` ora ci sono anche bozze, auto-bozze (lettere/mail composte) e
record `mail-inviata` con indirizzi clienti + oggetti.

**Decisioni brainstorming (Raffaele, 10 giu):** accesso **misto** (privato di default + link
condivisibili apposta) · condivisione via **comando bot + doppia conferma**, scadenza default
7 giorni · **nessuna** auto-cancellazione (l'accesso controllato basta; la retention aggressiva
cozzerebbe con la memoria del bot).

## Stato attuale (verificato)

- `src/app/api/doc/[id]/route.ts`: `GET` legge `documents.content` per id e lo restituisce come
  `text/html`, **zero auth**.
- `src/app/doc/[id]/page.tsx`: pagina che mostra il documento (server component).
- `src/app/api/auth/route.ts`: login web chat. `POST {password}` → se `=== APP_PASSWORD` setta
  cookie httpOnly `cervellone_auth = HMAC(AUTH_SECRET, 'cervellone_v2')`, `sameSite lax`,
  `maxAge` 30 giorni. `DELETE` cancella il cookie. È **single-user** (token statico).
- Nessun `middleware.ts`.
- Il bot NON usa `/doc` (legge il DB diretto via `ritrova_bozza`/`getDraft`) → gating /doc non
  rompe il bot.

## Design

### 1. `/doc` privato di default

Helper condiviso `src/lib/doc-access.ts`:
- `getAuthToken(): string` — stessa derivazione di `api/auth` (`HMAC(AUTH_SECRET||'cervellone',
  'cervellone_v2')`). Estratto qui e **riusato** da `api/auth` per non duplicare il segreto.
- `isAuthedCookie(token: string | undefined): boolean` — confronto **constant-time**
  (`crypto.timingSafeEqual`) tra il cookie `cervellone_auth` e `getAuthToken()`.
- `verifyShareToken(id, token, expSec): boolean` — vedi §2.
- `isDocAccessAllowed({ id, cookieToken, shareToken, exp }): boolean` — true se cookie valido
  OPPURE share token valido e non scaduto.

Applicazione:
- `src/app/api/doc/[id]/route.ts`: legge cookie `cervellone_auth` (da `cookies()`/request) e i
  query param `t`/`exp`; se `!isDocAccessAllowed(...)` → `401` (senza rivelare se il doc esiste).
  Altrimenti serve come oggi.
- `src/app/doc/[id]/page.tsx`: stesso controllo; se non autorizzato → schermata minimale
  "🔒 Documento privato. Accedi a Cervellone e riapri questo link." (niente redirect complicato;
  login una tantum per dispositivo → cookie 30 giorni). NON fetchare il content se non autorizzato.

### 2. Link di condivisione firmati a scadenza

- URL: `https://cervellone-five.vercel.app/doc/<id>?t=<token>&exp=<unixSeconds>`.
- `token = HMAC(shareSecret, "<id>.<exp>")` in hex, dove `shareSecret = (AUTH_SECRET||'cervellone')
  + ':doc_share'` (etichetta dedicata → **nessuna nuova env var**, e un token di share non vale
  come cookie di sessione e viceversa).
- `verifyShareToken(id, token, expSec)`: `expSec > nowSec` AND `timingSafeEqual(token,
  HMAC(shareSecret, "<id>.<expSec>"))`. Qualsiasi manomissione di id/exp invalida l'HMAC.
- `/doc` (api + pagina) accetta il token come alternativa al cookie.

### 3. Tool bot `genera_link_condivisione` con doppia conferma

- Nuovo tool: `genera_link_condivisione(doc_id: string, giorni?: number = 7)` (clamp giorni 1–30).
- **Doppia conferma**: riusa il pattern già presente nel progetto (vedi `conferma proposte
  dispatcher` / FIC `/fic_ok_` / drive-policy `/accesso_ok_`). Flusso: il tool NON restituisce
  subito il link; prepara una proposta ("Sto per creare un link condivisibile **N giorni** per
  «<titolo>». Chi ha il link vedrà il documento. Confermi con `/condividi_ok_<code>`?") e SOLO
  alla conferma genera `exp = now + giorni*86400`, calcola il token e restituisce l'URL firmato.
- Motivo: generare il link è innocuo in sé (è solo un HMAC), ma una volta dato a un esterno il
  documento è visibile → la conferma evita di crearlo/inoltrarlo per sbaglio su dati riservati.
- Regola prompt: il bot NON condivide documenti senza che l'utente lo chieda esplicitamente
  (coerente con il wording "NON inviarla/consegnarla senza richiesta esplicita" già introdotto).

### 4. Copertura automatica degli artefatti sensibili

auto-bozze (`type='auto-bozza'`) e record `mail-inviata` stanno in `documents` → il gate di §1 li
protegge **senza codice aggiuntivo**. Nessuna modifica a `artifact-capture`/`sent-mail`.

### 5. Cosa NON si fa (YAGNI / deciso)

- Niente auto-cancellazione/retention (i documenti restano: servono alla memoria del bot).
- Niente nuova env var.
- Niente middleware globale (gate mirato sui soli `/doc`).
- Nessuna modifica al flusso bot esistente (legge il DB diretto).

## File toccati

- `src/lib/doc-access.ts` — **nuovo**: helper auth/share + `getAuthToken` (estratto).
- `src/lib/doc-access.test.ts` — **nuovo**.
- `src/app/api/auth/route.ts` — usa `getAuthToken` da `doc-access` (no duplicazione segreto).
- `src/app/api/doc/[id]/route.ts` — gate.
- `src/app/doc/[id]/page.tsx` — gate + schermata "documento privato".
- `src/lib/tools.ts` — tool `genera_link_condivisione` + executor (doppia conferma) + definizione.
- `src/lib/prompts.ts` — regola: condividere solo su richiesta esplicita; come si crea un link.
- (Eventuale) wiring nel dispatcher di conferma proposte esistente.

## Testing

Unit: `isAuthedCookie` (match/no-match/undefined), `verifyShareToken` (valido/scaduto/manomesso
su id o exp), `isDocAccessAllowed` (cookie-only, token-only, nessuno), generazione URL firmato del
tool (token verificabile). Route: 401 senza auth, 200 con cookie, 200 con token valido, 401 con
token scaduto/manomesso. Doppia conferma: link generato SOLO dopo `/condividi_ok_<code>`.

**Sicurezza (lezione 10 giu): security-review + audit adversarial PRIMA del deploy** —
constant-time compare, nessun leak "doc esiste/non esiste", AUTH_SECRET presente in prod
(già, la web chat funziona), share token ≠ cookie di sessione.

## Rollout

I link `/doc` già inviati su Telegram richiederanno il login (one-time per dispositivo, cookie 30
giorni). Nessun flag necessario; è un endpoint a sé. Rollback = revert del commit.
