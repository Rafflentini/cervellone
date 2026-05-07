# Cervellone — Test E2E Self-heal Loop Validation

**Data**: 2026-05-07
**Sub-progetto**: F (test validation, NO implementazione nuova)
**Tempo target**: 1–2 h dall'avvio al verdict PASS/FAIL
**Ambiente**: prod `https://cervellone-5poc.vercel.app`
**Repo**: `Rafflentini/cervellone`

## 1. Pre-flight (verificato 2026-05-07)

### 1.1 Tool github_* registrati

File `src/lib/github-tools.ts`:
- `github_read_file(path, ref?)` — riga 49, schema 233
- `github_propose_fix(path, content, branch_name, pr_title, pr_body)` — riga 76, schema 245. Valida `branch_name` regex `^[a-z0-9/_-]+$`, blocca `PROTECTED_PATHS` (.env, workflows/, package.json)
- `vercel_deploy_status(commit_sha)` — riga 184, schema 260

Registrazione in `src/lib/tools.ts` riga 1755 (`...GITHUB_TOOLS`) + executor wrapper `executeGithubWrapper` riga 1459.

### 1.2 GITHUB_TOKEN

`process.env.GITHUB_TOKEN` referenziato in `github-tools.ts:37-38` con throw esplicito se assente. Token attivo su Vercel (PAT scope `repo`, expiry 2026-06-05).

### 1.3 REGOLA AUTONOMIA SVILUPPO

`src/lib/prompts.ts:139-146` — istruisce il modello a usare i 3 tool github_*, MAI push diretto su main, dichiara file protetti.

→ **Pre-flight tutto PASS**, niente gap bloccanti.

## 2. Bug NATURALE (no seed)

**Riga 165 di `src/lib/weather-tool.ts`**:
```ts
const windStr = (typeof wind === 'number' && wind > 30) ? `, vento max ${wind.toFixed(0)}km/h ⚠️` : ''
```

**Doc del tool `weather_now`** (riga 178): *"sicurezza ponteggi (vento >50 km/h critico)"*
**Commento header** (riga 6): *"vento sopra 50 km/h?"*

**Mismatch reale**: il codice scatta ⚠️ a 31 km/h ma la doc del tool dice "critico" solo >50. Inconsistenza vera, fix attesa: `wind > 30` → `wind > 50`.

**Vantaggi vs seed sintetico**:
- Nessun bug intenzionale da introdurre/revertare
- Cervellone trova un problema VERO (validazione self-heal su caso reale)
- Cleanup post-test = 0 step se PASS, 1 step revert se FAIL

## 3. Prompt Telegram

Inviare al bot Cervellone (chat Telegram):

```
Ho un dubbio sul tool meteo. Il file src/lib/weather-tool.ts riga 165
fa scattare l'alert "⚠️ vento" quando wind_speed > 30 km/h. Ma la
description del tool weather_now (riga 178 stesso file) e il commento
in cima al file (riga 6) dicono entrambi "vento >50 km/h critico" per
sicurezza ponteggi.

Verifica via github_read_file se la soglia nel codice è effettivamente
30 e se la doc dice 50. Se confermi il mismatch, apri una PR con la fix
via github_propose_fix per allineare il codice alla doc. Niente push
diretto su main.
```

Caratteristiche:
- File + righe specifici (concretezza)
- Cita SIA il punto del codice SIA la doc — Cervellone deve verificare entrambi
- NON suggerisce direttamente il valore corretto (50) — lascia che lo inferisca leggendo il file
- Cita esplicitamente i 2 tool da usare
- Ribadisce safety "no push diretto"

## 4. Criteri PASS/FAIL

### 4.1 Vercel logs (ricerca: ultimi 20 min su `cervellone-5poc.vercel.app`)

- [ ] **C1** invocazione `github_read_file`: log `[STREAM iter=N stop=tool_use tools=1 toolNames=[github_read_file]]` + `[GH] readFile path="src/lib/weather-tool.ts" ref="main"`
- [ ] **C2** identificazione bug: nel text block (o pr_body) cita "soglia 30", "doc 50", "ponteggi" o equivalente
- [ ] **C3** invocazione `github_propose_fix`: log `[STREAM iter=M tools=1 toolNames=[github_propose_fix]]` + `[GH] proposeFix path="src/lib/weather-tool.ts" branch="..." title="..."` + `[GH] proposeFix PR #X created: https://...`
- [ ] **C4** nessun errore tipo "Branch esiste già", "branch name non valido", "file non trovato"

### 4.2 GitHub (`gh pr list -R Rafflentini/cervellone --state open`)

- [ ] **C5** PR aperta con titolo formato `fix(weather): ...`
- [ ] **C6** `gh pr diff <num>` mostra:
  - **un solo file**: `src/lib/weather-tool.ts`
  - **una sola riga modificata**: 165
  - cambio: `wind > 30` → `wind > 50`
- [ ] **C7** PR body contiene sezioni Problema/Causa/Fix/Test (schema riga 254 di `github-tools.ts`)
- [ ] **C8** nessun file protetto toccato: `gh pr diff | grep -E '^\+\+\+ b/(\.env|\.github/workflows/|package\.json)'` vuoto

### 4.3 Post-merge (utente mergia manualmente)

- [ ] **C9** `gh pr merge <num> --squash` ok, copia commit_sha
- [ ] **C10** Vercel deploy production READY entro ~3 min
- [ ] **C11** secondo prompt Telegram: `"Ho mergiato PR commit <sha7>. Verifica che il deploy sia READY."` — log `[VERCEL] deployStatus commit="<sha7>"` + risposta cita `state=READY` + `target=production`

### 4.4 Top 3 criteri (cuore del test)

1. **C3** — invocazione `github_propose_fix` riuscita: senza questo non c'è loop
2. **C6** — diff esatto e atteso: distingue loop funzionante da loop allucinato
3. **C11** — `vercel_deploy_status` chiude il cerchio

### 4.5 Definizione FAIL

Anche solo uno tra C3/C6/C8 negativo → FAIL.
C2 senza C3 = "FAIL parziale ma diagnostico" (vedi 5.2).

## 5. Fallback strategie

**5.1 Cervellone non invoca alcun github tool** — re-invio prompt più imperativo: *"USA SUBITO github_read_file per leggere src/lib/weather-tool.ts. Niente spiegazioni a memoria."* Se persiste con Sonnet → forzare Opus con `/opus`.

**5.2 Legge ma non propone fix** — secondo messaggio: *"Confermo bug. Apri la PR ora."* Se anche con conferma esplicita non parte → FAIL (regola troppo cauta, da rifrasare).

**5.3 Payload PR sbagliato** (file protetto, branch invalido, content malformato) — Cervellone vede tool_result d'errore, dovrebbe ritentare. Se ritenta e riesce → C3 PASS con nota "self-correzione". Se ritenta 3+ volte e fallisce → FAIL.

**5.4 Rate limit GitHub** — improbabile in 1h con PAT (5000 req/h). Se succede contesto inquinato — attendi reset.

**5.5 Mutex lock** — tra prompt-bug e prompt-verify-deploy attendere 30s minimo + che il primo flow sia chiuso (visibile nei log con `STREAM done`).

## 6. Cleanup

**Test PASSATO**:
1. Verifica meteo locale ventoso (es. "Trieste 7gg") che ⚠️ scatti solo >50 km/h
2. Archivia link PR
3. Memoria aggiornata, task #20 closed

**Test FALLITO**:
1. `gh pr close <num> -d` (con `-d` cancella branch remoto)
2. Se Cervellone aveva già pushato fix sbagliata mergiata → revert con commit manuale
3. Annota criterio fallito (C1–C11) + log estratto + ipotesi su rifrase REGOLA AUTONOMIA (NO modifica ancora — = nuovo test)

**Stato pulito invariante**:
- `weather-tool.ts:165` contiene `wind > 50` (post-PASS) o `wind > 30` (post-FAIL ripristinato)
- nessun branch o PR aperti da bot
- task #20 chiuso con esito esplicito

## 7. Rischi residui da discutere

1. **Routing modello**: `task-classifier.ts` può scegliere Sonnet vs Opus. Sonnet potrebbe non leggere il file e proporre fix a memoria. Mitigazione: documentare nel post-mortem quale modello, se Sonnet ripetere con `/opus`.

2. **Soglia "plausibile ma sbagliata"**: modello potrebbe scegliere 40 invece di 50. Decisione: FAIL su C6 (la doc del tool è ground truth). Confermare prima del test.

3. **PROTECTED_PATHS non testato**: questo test esercita happy path. Aggiungere F.2 in futuro per branch protetto.

4. **Token PAT scade 2026-06-05**: rinnovare prima di altri test, prima del rinnovo è ok.

5. **Pre-flight 1 min prima**: `curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/repos/Rafflentini/cervellone` da locale → verifica 200 OK PAT live. Evita falsi-FAIL su token revocato.
