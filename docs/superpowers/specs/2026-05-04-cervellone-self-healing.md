# Cervellone Self-Healing — design spec

**Data:** 4 maggio 2026
**Stato:** approvato in backlog, da implementare dopo Bug 5 + Bug 1
**Stima:** 1 giornata di lavoro

## Problema

Cervellone oggi auto-modifica solo skill (Supabase) e config (cervellone_config). Per fixare bug nel codice TypeScript (esempio: Bug 4 PDF worker missing, Bug 5 stream truncation) serve intervento di Code/Cowork → Raffaele rimane bloccato fino a intervento esterno.

L'utente nella conversazione del 4 maggio ha esplicitamente richiesto la capacità di self-healing del codice. Questa spec definisce come abilitarla in modo sicuro.

## Principi vincolanti

1. **Human-in-the-loop obbligatorio** — il bot propone, l'umano approva. MAI push diretto su `main`.
2. **No esecuzione shell** — niente `npm install`, niente comandi di sistema. Solo manipolazione file.
3. **Audit trail completo** — ogni proposta di fix lascia una PR con autore "Cervellone", motivazione esplicita, link al bug.
4. **Reversibilità** — ogni PR può essere chiusa senza side-effect; ogni merge è revertibile via git.

## 3 tool da aggiungere

### 1. `github_read_file(path)`

```ts
{
  name: 'github_read_file',
  description: 'Legge il contenuto di un file dal repo Rafflentini/cervellone su GitHub. Usa per ispezionare il proprio codice quando l\'utente segnala un bug o chiede come funziona una feature.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relativo al root del repo, es. "src/lib/claude.ts"' },
      ref: { type: 'string', description: 'Branch/commit (default: main)' },
    },
    required: ['path'],
  },
}
```

Implementation: `GET https://api.github.com/repos/Rafflentini/cervellone/contents/{path}?ref={ref}` con header `Authorization: Bearer {GITHUB_TOKEN}`. Decodifica base64. Cap a 100KB per file (oltre, troncare e avvisare).

### 2. `github_propose_fix(path, content, branch_name, pr_title, pr_body)`

```ts
{
  name: 'github_propose_fix',
  description: 'Propone una modifica al codice creando un branch + commit + PR su GitHub. NON pusha su main direttamente — Raffaele deve approvare la PR. Usa SOLO per fix concreti con motivazione tecnica chiara basata su log di errore o bug riprodotto.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path del file da modificare' },
      content: { type: 'string', description: 'Contenuto NUOVO completo del file (non diff)' },
      branch_name: { type: 'string', description: 'Nome del branch, es. "fix/bug-7-streaming-edge-case"' },
      pr_title: { type: 'string', description: 'Titolo PR, max 70 char, formato "fix(area): cosa"' },
      pr_body: { type: 'string', description: 'Markdown: ## Problema (cosa) + ## Causa (perché) + ## Fix (come) + ## Test (come verificare). Cita log Vercel se disponibili.' },
    },
    required: ['path', 'content', 'branch_name', 'pr_title', 'pr_body'],
  },
}
```

Implementation:
1. `GET /contents/{path}` per ottenere SHA del file corrente su main
2. `GET /git/refs/heads/main` per SHA HEAD main
3. `POST /git/refs` con `ref: refs/heads/{branch_name}, sha: HEAD_SHA` — crea branch
4. `PUT /contents/{path}` con `branch, content (base64), sha (file SHA), message: pr_title` — commit
5. `POST /pulls` con `title, body, head: branch_name, base: main` — apre PR
6. Ritorna URL della PR

Errori da gestire: file non trovato, branch esistente, permessi insufficienti.

### 3. `vercel_deploy_status(commit_sha)`

```ts
{
  name: 'vercel_deploy_status',
  description: 'Verifica lo stato del deploy Vercel per un commit specifico. Usa dopo aver visto un merge della tua PR per confermare che il fix è andato live.',
  input_schema: {
    type: 'object',
    properties: {
      commit_sha: { type: 'string', description: 'SHA completo del commit da verificare' },
    },
    required: ['commit_sha'],
  },
}
```

Implementation: `GET https://api.vercel.com/v6/deployments?meta-githubCommitSha={sha}&projectId=cervellone-5poc&teamId=team_QOxzPu6kcaxY8Jdc45arGmgL`. Ritorna `{state, url, createdAt, ready}`.

## Pattern operativo

```
1. Raffaele su Telegram: "il bot non legge i PDF da Drive"
2. Cervellone: chiama vercel_get_runtime_logs (tool esistente o da aggiungere) per cercare errori
3. Cervellone: chiama github_read_file("src/lib/drive.ts") per ispezionare la funzione
4. Cervellone: identifica il bug, prepara il fix
5. Cervellone: chiama github_propose_fix → PR aperta
6. Cervellone su Telegram: "Ho identificato il bug e proposto un fix. Vuole revisionare la PR? [link]"
7. Raffaele: revisiona, approva, merge
8. Cervellone: chiama vercel_deploy_status periodicamente (o usa webhook futuro)
9. Cervellone su Telegram: "Deploy completato. Vuole che ritesti la lettura PDF?"
```

## Env vars necessarie

- `GITHUB_TOKEN` — Personal Access Token con scope `repo` (read+write su Rafflentini/cervellone)
- `VERCEL_TOKEN` — già presente in env per altre integrazioni

## Promemoria di sistema (system prompt patch)

Aggiungere a `prompts.ts` BASE_PROMPT:

> AUTONOMIA SVILUPPO:
> - Quando l'Ingegnere segnala un bug nel TUO comportamento, prima di scusarti DEVI: 1) chiamare vercel_get_runtime_logs per vedere l'errore, 2) chiamare github_read_file per ispezionare il codice, 3) se identifichi la causa, chiamare github_propose_fix per aprire una PR. NON dichiarare di aver fatto modifiche se non hai chiamato i tool.
> - Le PR hanno autore "Cervellone (suggested fix)". L'Ingegnere deve sempre approvare prima del merge.
> - NON puoi installare librerie npm, modificare infrastruttura Vercel, o pushare su main direttamente.

## Rischi e mitigazioni

| Rischio | Mitigazione |
|---|---|
| Bot rompe se stesso ricorsivamente | PR-only, no push diretto. Human approval obbligatorio. |
| Bot apre 100 PR inutili | Rate limit interno: max 3 PR/ora aperte da bot. Tool ritorna errore se superato. |
| Token GitHub leakato | Mai loggare il token. Scope minimo `repo`. Rotazione semestrale. |
| Bot propone fix pericolosi (sec) | PR review umana obbligatoria. Possibile branch protection su main. |
| Costo API GitHub | Limite GitHub: 5000 req/h con PAT. Più che sufficiente. |

## Out of scope (esplicito)

- Esecuzione comandi shell sul server Vercel
- Modifica diretta dei processi runtime
- `npm install` o package.json edit (deve passare comunque per PR)
- Auto-merge: SEMPRE umano approva
- Modifica di file sensibili (.env, secrets, credenziali) — blocklist

## Test plan post-implementazione

1. Telegram: "leggi src/lib/claude.ts riga 388" → verifica github_read_file
2. Telegram: "proponi un fix per cambiare il break a riga 388 in counter consecutivo" → verifica PR creata
3. Verificare che la PR contiene SHA file corretto, branch nuovo, body strutturato
4. Mergiare manualmente → verificare vercel_deploy_status restituisce READY
5. Verificare che bot NON apra PR identica due volte (idempotenza basata su titolo/branch)

## Quando partire

**Dopo Bug 5 (streaming truncation) e Bug 1 (mutex per chat) chiusi.** Quei due bug bloccano l'usabilità reale del bot e devono essere risolti prima di aggiungere capacità.
