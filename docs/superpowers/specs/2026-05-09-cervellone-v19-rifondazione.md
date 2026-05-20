# Cervellone V19 — Rifondazione totale

**Data:** 9 maggio 2026
**Autore:** Claude (sessione autonoma notturna, multi-agent)
**Stato:** Design v1
**Branch target:** `v19/foundation`
**Decisione strategica:** confermata utente (path Custom V19 dopo audit 8 mag che aveva votato 3/10)

---

## 1. Contesto e motivazione

### 1.1 Perché V19

V18 LIVE PROD-TESTED dall'8 maggio 2026 (commit `f973b2d` su `81781d9`), smoke prod 3/3 PASS (PDF/DOCX/XLSX), genera DDT visivamente corretti via Puppeteer. Subito dopo, primo uso reale ha esposto la gap: l'utente chiede l'Allegato 10 INPS (CIGO Aprile) e Cervellone V18 fallisce 5 cose separate sullo stesso task:

1. Hallucination link Drive (URL inventato per file inesistente, in violazione della propria "REGOLA ASSOLUTA SUI FILE" in `prompts.ts:172-175`).
2. Loop "🔍 Cerco informazioni" senza chiusura.
3. Cartella Drive sbagliata (Studio Tecnico invece di IMPRESA EDILE/RELAZIONI CIG).
4. Tool `genera_docx` inadeguato: il parser HTML appiattisce le tabelle.
5. Stack confusion Python vs Node (utente ha proposto python-docx; Cervellone è Node.js only).

Audit multi-agent serale dell'8 maggio ha quantificato:
- **7 limiti tecnici** confermati su file:line del codice corrente.
- **39% completamento** della visione iniziale (10 pillar architetturali).
- **109 ore di gap** per chiudere la visione W1-W12.

Il giudizio sintetico: V18 è **Claude.ai depotenziato**. Stesso modello Opus 4.7 sotto, ma con capacità tecniche minori per scelte architetturali consapevoli (Vercel timeout, MVP, ridotto thinking budget post-V10 incidente).

Path strategici valutati: A (chiusura, Claude.ai puro), E (Hybrid: Claude.ai per reasoning + Cervellone come gateway), Custom V19. L'utente sceglie Custom V19 dopo notte di lucidità il 9 mag mattina, accettando il rischio "stesso pattern errato torna".

### 1.2 Vincolo non negoziabile

> **Cervellone V19 deve fare DI PIÙ di Claude.ai, non DI MENO.**
> Stesso Opus 4.7 sotto, identica qualità di ragionamento, **PIÙ** Telegram, Gmail proattivo, Drive scrittura, cron 24/7, sandbox proprio, memoria persistente cross-sessione, integrazioni italiane (CIGO/Bollettino Basilicata/Cassa Edile/Normattiva), Quality Gate documenti.

Questo vincolo è il filtro per ogni scelta in questa spec. Se una decisione di V19 produce qualcosa **inferiore** a Claude.ai, è sbagliata. Se produce qualcosa **uguale**, è inutile (l'utente userebbe Claude.ai). Se produce qualcosa **superiore**, è giusta.

### 1.3 Errori storici da non ripetere (referenza `cervellone-errori-completi.md`)

Sintesi a 5 punti:

- **NON limitare Claude** con regole procedurali nel system prompt (un solo prompt minimale, "fai tutto come su claude.ai").
- **NON costruire tool custom per cose che Claude fa già** (web search, parsing PDF, ragionare).
- **NON intercettare/parsare file prima di darli a Claude**.
- **NON decidere noi quale modello usare** con router/regex/classificatori.
- **NON accumulare patch su patch** sopra V18; V19 nasce pulito.

---

## 2. Obiettivi V19 — cosa deve fare DI PIÙ di Claude.ai

### 2.1 Capacità che Claude.ai NON ha (queste sono le ragioni di esistenza di V19)

| Capacità | Stato V18 | Target V19 |
|---|---|---|
| Telegram bot mobile per Restruktura | ✅ ma streaming fragile | ✅ con `pause_turn` gestito + thinking summary streaming |
| Gmail R+W proattivo (cron mattina + alert urgenti) | ✅ (V12) | ✅ + classificazione semantica + auto-routine pre-autorizzate |
| Drive R+W (lettura + upload binari + creazione cartelle + Sheets) | ✅ | ✅ + selezione cartella semantica (mai più "Studio Tecnico" per CIGO) |
| Cron 24/7 (canary, Gmail, memoria, audit) | ✅ Vercel cron | ✅ + Trigger.dev v3 per task durable >2 min |
| Memoria persistente vera (cross-sessione, semantica + esplicita) | ✅ Supabase + pgvector + 4 tool memoria | ✅ + Memory API nativa Anthropic (`memory_20250818`) come strato working |
| Sandbox code execution con filesystem persistente | ❌ `code_execution` SKIPPATO server-side (claude.ts:541) | ✅ Anthropic `code_execution_20260120` (output catturato) + E2B per Node/lunga durata |
| Integrazioni italiane (CIGO/Bollettino Basilicata/CdL/INPS) | ❌ assente | ✅ tool dominio: bollettino CFD Basilicata, generatore Allegato 10, compilatore SR41, CSV beneficiari Msg 3566/2018, knowledge norme INPS |
| Quality Gate documenti (audit, versioning, firma giuridica) | ❌ assente | ✅ stati documento (draft/review/firmato), audit_log, tool `richiedi_review()` |
| DOCX/XLSX semantici (tabelle native, header colorati, content controls) | ❌ DOCX appiattito (pdf-generator.ts:144-188) | ✅ `docx` v9 con `Table`/`TableRow`/`TableCell` + content controls |
| Multi-agent orchestrator (capo + sub-agent specialist) | ❌ singolo loop | ✅ pattern parent → subagent con summary-only return |
| Self-healing GitHub (legge/propose_fix/deploy/merge) | ⚠️ parziale (4 tool ma flusso fragile) | ✅ resi affidabili, autonomia completa controllata |
| Verifica norme italiane vigenti (Normattiva) | ❌ | ✅ scraper Normattiva + cron G.U. (W3-W4 visione) |
| Local Agent Bridge (Excel/AutoCAD/Outlook PC ufficio) | ❌ | rimandato (W8-W10) ma spec V19 prevede contract |

### 2.2 Capacità di Claude.ai che V19 deve garantire al 100% (mai depotenziare)

| Capacità Claude.ai | Garanzia V19 |
|---|---|
| Reasoning xhigh con thinking esteso | `thinking: { type: "adaptive" }` + `output_config: { effort: "xhigh" }` per generation, `effort: "high"` per chat |
| Lettura file complessi (PDF >100 pagine, DOCX, XLSX, ODS, CSV, immagini, audio) | File pipeline ELIMINATA. File passati direttamente a Claude via `container_upload` o image_block — nessuna intercettazione server-side |
| Web search e web fetch native | Tool built-in `web_search` + `web_fetch` (no skip server-side, no loop hardcoded) |
| Code execution con persistence di stato | `code_execution_20260120` (REPL persistence, container riusabile cross-request) |
| Multi-step reasoning lungo | MAX_ITERATIONS=30 (era 10), NO_TEXT_LIMIT=8 (era 5) |
| Niente "non posso" — fallback a cascata | System prompt minimale ribadisce "fai tutto come su claude.ai", logica di cascading nei tool (mai un singolo metodo, sempre A→B→C→...) |

### 2.3 Test di accettazione V19

V19 si dichiara "complete" se e solo se passa **tutti** questi test:

1. **Allegato 10 CIGO Aprile 2026 ground-truth**: genera 3 file (Allegato10_RelazioneTecnica.docx + ElencoBeneficiari.csv + SR41.pdf) con dati operai sintetizzati realistici, layout fedele al fac-simile INPS, scarica bollettino CFD Basilicata della data evento e lo allega. Confronto visivo: V19 ≥ Claude.ai.
2. **Smoke V18**: tutti i test prod passati l'8 mag (DDT/DOCX/XLSX) continuano a passare. Zero regressioni.
3. **Multi-agent test**: dato un input "fai 3 cose in parallelo X, Y, Z" il capo agent spawna 3 sub-agent, ognuno ritorna summary, parent compone risposta. Telegram mostra streaming progress 3 sub-agent.
4. **Memory cross-session**: in conversazione A salva un fatto via Memory API; in conversazione B (giorno dopo) lo richiama senza che l'utente lo riproponga.
5. **Code execution persistence**: chiede a Cervellone di "calcola X, salvalo, in messaggio successivo riprendi quel valore"; il container riutilizzato preserva stato.
6. **Hallucination zero**: 50 messaggi consecutivi senza un singolo link Drive inventato (validatore runtime su URL prodotti).

---

## 3. Architettura ad alto livello

```
                                 +---------------------------+
                                 |    INTERFACCE UTENTE      |
                                 | Telegram | Webchat | Cron  |
                                 +-------------+-------------+
                                               |
                                               v
                                 +-------------+-------------+
                                 |    ORCHESTRATOR AGENT     |  <- Claude Opus 4.7 + tool minimi
                                 |  (capo agent, planning)   |     (sa CHE tool ha, non COME)
                                 +---+------+------+------+--+
                                     |      |      |      |
                          +----------+      |      |      +----------+
                          v                 v      v                 v
                 +--------+--------+  +-----+----+ |          +-------+--------+
                 | SUB-AGENT       |  | SUB-AGENT |  ...      | SUB-AGENT      |
                 | parsing-files   |  | numerical | (spawn    | document-render |
                 | (PDF/DOCX/img)  |  | (Python)  |  parallel)| (DOCX/XLSX/PDF) |
                 +--------+--------+  +-----+----+            +-------+--------+
                          |                 |                         |
                          v                 v                         v
                 +--------+-------------------+----------------------+----------+
                 |              TOOL LAYER (50+ tool, registrati centralmente)  |
                 +--------+----+-------+-------+--------+--------+---------+----+
                          |    |       |       |        |        |         |
                       Drive Gmail  Calendar Memory  Allegato CFD-Bas  Sandbox
                       APIs   APIs   API   (memory_   10 INPS  PCDP    (E2B
                                            20250818)         Basili.   + Anth.
                                            + pgvector                 code_exec)

                                 +---------------------------+
                                 |    PERSISTENCE LAYER      |
                                 | Supabase (DB+Storage)     |
                                 | + Trigger.dev (cron)      |
                                 +---------------------------+
```

### 3.1 Differenze chiave vs V18

| Aspetto | V18 | V19 |
|---|---|---|
| Reasoning loop | Singolo, 10 iter, no `pause_turn`, no orchestrator | Orchestrator → sub-agent (parallel), 30 iter, `pause_turn` gestito |
| `code_execution` | `continue` (skippato a `claude.ts:541`) | `code_execution_20260120` con file capture, container persistence |
| DOCX | `htmlToDocxBlocks` regex naive, tabelle appiattite | `docx` v9 Table API + parser JSON semantico (no HTML strip) |
| System prompt | ~4.300-6.700 token con 14 sezioni di regole | ~800-1.500 token: identità + profilo + memoria + "fai tutto come su claude.ai" |
| Memory | 4 tool custom (`ricorda`, `richiama_memoria`, `riepilogo_giorno`, `lista_entita`) | + Memory API nativa Anthropic `memory_20250818` (Supabase Storage backend) come working layer |
| Streaming | Edit Telegram ogni 3s, "🔍 Cerco" hardcoded | Streaming nativo `pause_turn` aware, thinking summary streaming, no message hardcoded |
| Tool dominio italiano | 0 (oltre weather generico) | 8+ tool dedicati: bollettino CFD Basilicata, Allegato 10 CIGO, SR41, beneficiari CSV INPS, ecc. |
| File pipeline | Intercetta lato server, decode/parse PDF/DOCX/XLSX prima di Claude | ELIMINATA. File passati direttamente a Claude (container_upload o image_block). Claude fa il parsing dentro `code_execution`. |
| Tool registry | `tools.ts` 1963 LOC monolitico, 8 executor sequenziali | `src/v19/tools/` modulare: 1 file per tool, registry auto-discovery |
| Schema Supabase | `messages`, `conversations`, `memoria_esplicita`, `gmail_*`, ecc. | + `agent_runs`, `sub_agent_jobs`, `document_renders`, `memories` (per `memory_20250818`) |

### 3.2 Confini di V19 stanotte (foundation, non polish)

**IN** stanotte:
- Loop reasoning V19 (`src/v19/agent/loop.ts`) con tutte le novità Opus 4.7
- Orchestrator multi-agent (`src/v19/agent/orchestrator.ts`)
- Memory API native handler (`src/v19/memory/`)
- DOCX engine semantico (`src/v19/render/docx.ts`)
- Tool `scarica_bollettino_meteo_basilicata` (`src/v19/tools/meteo.ts`)
- Tool `genera_allegato10_cigo`, `compila_sr41`, `genera_beneficiari_csv` (`src/v19/tools/cigo.ts`)
- E2B integration ready-to-use (con feature flag, key da settare)
- Migration Supabase evolutive (file `.sql`, NON applicate)
- System prompt V19 minimale (`src/v19/prompts/system.ts`)
- Test ground-truth Allegato 10 CIGO (`src/v19/__tests__/cigo.spec.ts`)
- Branch `v19/foundation` + commit ordinati per modulo + 1 PR draft
- Documentazione: ONBOARDING.md, memoria progetto, plan eseguibile

**OUT** stanotte (resta in plan per sessioni successive):
- Computer Use / Local Agent Bridge / Outlook integration
- Trigger.dev v3 setup completo (resta su Vercel cron)
- S8 verifica norme Normattiva (scraper)
- S9 territorial knowledge persistence
- Migrazione UI webchat (resta puntando a V18 fino a switch deliberato)
- Cutover Telegram (resta su V18 fino a green light utente)
- Rimozione codice V18 (V19 vive in parallelo `src/v19/` finché V18 non è dismesso)

---

## 4. Stack tecnologico

### 4.1 Confermato (invariato vs V18)

- **Framework**: Next.js 16.2.1 (App Router, TypeScript 5.x, Tailwind CSS v4, Turbopack)
- **Runtime**: Vercel Functions, Node.js 22+
- **Database**: Supabase (PostgreSQL + pgvector + Storage)
- **AI provider**: Anthropic via `@anthropic-ai/sdk` 0.80+ (aggiornare a ultima compatibile Opus 4.7)
- **Modello**: `claude-opus-4-7` (default), no alias `*-latest`
- **Auth**: Cookie httpOnly webchat, TELEGRAM_ALLOWED_IDS Telegram, OAuth Google per Drive/Gmail
- **Cron**: Vercel cron (canary, gmail-morning, gmail-alerts, ecc.)

### 4.2 Aggiunto in V19

- **`docx`** v9.6.1 (già in package.json, ora usato nativamente con Table API)
- **`@e2b/code-interpreter`** (nuovo): sandbox Node/Bun per task >5 min o non-Python
- **Anthropic beta headers**:
  - `code-execution-2025-08-25`
  - `files-api-2025-04-14`
  - eventualmente `task-budgets-2026-03-13` (sperimentale)
- **Trigger.dev v3** già in package.json (`@trigger.dev/sdk@4.4.5`), in V19 si inizia a usarlo per task durable

### 4.3 Rimosso/deprecato in V19

- **`jspdf`** 4.2.1 — dead code post V18, eliminato
- **`mammoth`** 1.12.0 — non più necessario (parsing fatto da Claude via code_execution)
- **`pdf-parse`** 2.4.5 — idem (Claude legge PDF nativamente)
- **`htmlToDocxBlocks`** in `pdf-generator.ts:144-188` — sostituito da `src/v19/render/docx.ts`

### 4.4 Da decidere (non bloccante stanotte)

- **Anthropic SDK version exact**: verificare la versione che supporta `output_config.effort = "xhigh"` e `thinking.type = "adaptive"` senza warning. Se 0.80 non basta, bumpare alla minor che li supporta.
- **Trigger.dev cutover**: fase 2 (post-foundation), non stanotte.

---

## 5. Loop reasoning V19 (file: `src/v19/agent/loop.ts`)

### 5.1 Cambiamenti vs V18 `claude.ts`

| Parametro | V18 (file:line) | V19 |
|---|---|---|
| `MAX_ITERATIONS` | 10 (`claude.ts:179, 258, 333`) | **30** |
| `NO_TEXT_LIMIT` | 5 (`claude.ts:340`) | **8** |
| `thinking.budget_tokens` | 8K Opus / 4K Sonnet (`claude.ts:185, 264, 353`) | **rimosso** — usa `thinking: { type: "adaptive", display: "summarized" }` |
| `output_config.effort` | "high" (solo per modelli con adaptive) | "xhigh" per generation/agentic, "high" per chat conversazionale |
| `temperature/top_p/top_k` | non settati ma codice li referenzia | **mai settati** (Opus 4.7 errori 400) |
| `max_tokens` | 32K Opus, 16K altri | 64K Opus (alza per nuovo tokenizer ~30% più verboso vs 4.6) |
| `code_execution` handling | `continue` (`claude.ts:541`) | **CATTURA OUTPUT**: itera sui `code_execution_tool_result` block, salva file generati via `client.beta.files.download` |
| `web_search` handling | `continue` (`claude.ts:541`) | unchanged (è server-side built-in) ma nessun "🔍 Cerco" hardcoded |
| `pause_turn` stop_reason | non gestito | **gestito**: append assistant content e re-invoca senza modifiche |
| Beta headers | `files-api-2025-04-14` | `code-execution-2025-08-25,files-api-2025-04-14` (+ memory beta header se SDK lo richiede) |
| Container persistence | non gestito | `containerId` salvato in `agent_runs.container_id`, riusato cross-request per stesso `conversation_id` |
| Streaming Telegram | edit ogni 3s, "🧠 Sto pensando..." hardcoded, "🔍 Cerco" hardcoded | edit ogni 3s, thinking summary stream nativo (no hardcoded), pause_turn fa apparire "⏸ pausa" 1 sola volta |
| Hallucination detection | post-hoc su risposta finale (`claude.ts:512-530`) | **runtime**: validator URL Drive PRIMA di emit (regex `https?://drive\.google\.com/...` → verifica esistenza tramite `drive_*` tool prima di confermare al utente) |

### 5.2 Pseudo-codice loop V19

```typescript
// src/v19/agent/loop.ts
const MAX_ITERATIONS = 30
const NO_TEXT_LIMIT = 8

export async function runAgent(req: AgentRequest): Promise<AgentResponse> {
  const { conversationId, messages, system, telegramStream } = req
  let containerId = await loadContainerId(conversationId) // null se nuovo
  let consecutiveNoText = 0
  let fullResponse = ''

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const stream = await client.beta.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 64_000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: req.intent === 'generation' ? 'xhigh' : 'high' },
      system,
      messages,
      tools: getToolDefinitions(req),
      ...(containerId && { container: containerId }),
      betas: ['code-execution-2025-08-25', 'files-api-2025-04-14'],
    })

    let textInIter = false
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
        fullResponse += ev.delta.text
        textInIter = true
        telegramStream?.push(ev.delta.text)
      }
      if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta') {
        telegramStream?.thinking(ev.delta.thinking)
      }
    }

    const final = await stream.finalMessage()
    containerId = final.container?.id ?? containerId
    messages.push({ role: 'assistant', content: final.content })

    // 1. Gestione code_execution output (NON skippare!)
    const codeExecBlocks = final.content.filter(b => b.type === 'code_execution_tool_result')
    for (const block of codeExecBlocks) {
      const files = block.content?.content?.filter(c => c.type === 'file') ?? []
      for (const f of files) {
        const buf = await client.beta.files.download(f.file_id)
        await persistArtifact(conversationId, f.file_id, buf)
      }
    }

    // 2. pause_turn
    if (final.stop_reason === 'pause_turn') continue

    // 3. end_turn
    if (final.stop_reason === 'end_turn') break

    // 4. tool_use client-side
    if (final.stop_reason === 'tool_use') {
      const clientTools = final.content.filter(
        b => b.type === 'tool_use' && !isServerSideTool(b.name)
      )
      if (clientTools.length === 0) {
        // Tutti server-side (web_search/code_execution/memory). Continua loop.
        continue
      }
      const toolResults = await executeTools(clientTools, conversationId)
      messages.push({ role: 'user', content: toolResults })
    }

    // 5. NO_TEXT_LIMIT
    consecutiveNoText = textInIter ? 0 : consecutiveNoText + 1
    if (consecutiveNoText >= NO_TEXT_LIMIT) {
      // force-text con tool_choice none
      messages.push({ role: 'user', content: 'Sintetizza risposta finale ora.' })
      const synth = await client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 8_000,
        system, messages,
        tool_choice: { type: 'none' },
      })
      fullResponse += extractText(synth.content)
      break
    }
  }

  await saveContainerId(conversationId, containerId)
  await runHallucinationValidator(fullResponse, req)
  return { text: fullResponse, containerId }
}
```

### 5.3 Hallucination validator runtime (nuovo)

```typescript
// src/v19/agent/hallucination-validator.ts
const DRIVE_URL_RE = /https:\/\/drive\.google\.com\/(file\/d\/|open\?id=|drive\/folders\/)([^\s"')]+)/g

export async function runHallucinationValidator(text: string, req: AgentRequest): Promise<void> {
  const matches = [...text.matchAll(DRIVE_URL_RE)]
  for (const [url, _kind, id] of matches) {
    const exists = await checkDriveFileExists(id, req.userId)
    if (!exists) {
      // Logga l'allucinazione, sostituisci nel testo, segnala a Sentry o equivalente
      await recordHallucination(req.conversationId, url, 'drive_file_not_found')
      throw new HallucinationError(`Link Drive inventato: ${url}`)
    }
  }
}
```

L'errore viene catturato dal route handler e trasformato in un re-prompt automatico al modello: "Hai citato un link Drive che non esiste. Rigenera la risposta SENZA inventare URL".

---

## 6. Multi-agent orchestrator (file: `src/v19/agent/orchestrator.ts`)

### 6.1 Pattern

L'orchestrator è il **capo agent** (Claude Opus 4.7 con tool ridotti). Quando gli viene assegnato un task complesso, ha accesso a un tool speciale `spawn_subagent` che gli permette di delegare sotto-task a sub-agent specializzati. I sub-agent girano in **contesti isolati** (nuova istanza Claude, prompt sistema diverso, tool ridotti al loro dominio) e ritornano **solo un summary** all'orchestrator (non il full transcript).

Questo pattern previene il context bloat: se il sub-agent fa 50 chiamate per parsare 10 PDF, il parent vede solo "Ho parsato 10 PDF, ecco i dati estratti come JSON: {...}".

### 6.2 Sub-agent specialist definiti

| Sub-agent | Dominio | Tool disponibili | System prompt focus |
|---|---|---|---|
| `parsing-files` | Estrai dati da PDF/DOCX/XLSX/immagini ricevuti | `web_fetch`, `code_execution`, drive_read_* | "Sei specializzato in estrazione dati strutturati da file. Restituisci JSON pulito." |
| `numerical-engine` | Calcoli ingegneria, statistica, prezziari, finanza | `code_execution` (Python: numpy/scipy/pandas), `cerca_prezziario` | "Sei specializzato in calcoli numerici esatti per ingegneria/edilizia. Mostra ragionamento step-by-step e ritorna numeri esatti." |
| `document-render` | Genera DOCX/XLSX/PDF semanticamente corretti | `genera_docx_v19`, `genera_xlsx_v19`, `genera_pdf_v19`, drive_upload_binary | "Sei specializzato in produzione documenti professionali Restruktura. Layout fedele, font corretti, header/footer sempre presenti." |
| `domain-italiano` | Conoscenza norme italiane (CIGO, INPS, IVA, edilizia, sicurezza) | `web_search` (limitato a inps.it/lavoro.gov.it/normattiva.it), `richiama_memoria` | "Sei specializzato in normativa italiana edilizia/lavoro/fiscale. Cita sempre la fonte. Mai inventare numeri di legge." |
| `web-research` | Ricerca web profonda multi-fonte | `web_search`, `web_fetch` | "Conduci ricerche web approfondite su 5+ fonti. Cita sempre URL." |
| `gmail-router` | Smistamento mail mattutine, classificazione semantica, drafting risposte | `gmail_*` (read-only + create_draft) | "Classifica le mail per urgenza e tipo. Crea bozze di risposta in italiano formale (Lei). Mai inviare." |

### 6.3 Tool `spawn_subagent`

```typescript
// Definizione tool che orchestrator vede
{
  name: 'spawn_subagent',
  description: 'Spawn parallel sub-agent per task indipendente. Ritorna SOLO summary, non transcript completo. Usa per task che richiedono >3 step o tool molto specializzati.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['parsing-files', 'numerical-engine', 'document-render', 'domain-italiano', 'web-research', 'gmail-router'] },
      task: { type: 'string', description: 'Descrizione completa task da delegare. Includi tutto il contesto necessario, perché il sub-agent NON vede il resto della conversazione.' },
      input_files: { type: 'array', items: { type: 'string' }, description: 'Eventuali file_id Anthropic da passare al sub-agent.' },
    },
    required: ['kind', 'task'],
  },
}
```

### 6.4 Pseudo-codice spawn

```typescript
// src/v19/agent/orchestrator.ts
export async function spawnSubagent(input: SpawnInput, parentRunId: string): Promise<SubagentResult> {
  const subRunId = await dbInsertSubAgentJob(parentRunId, input.kind, input.task)
  const subSystem = getSubagentSystemPrompt(input.kind) // template per ogni kind
  const subTools = getSubagentTools(input.kind)
  const subMessages: MessageParam[] = [{
    role: 'user',
    content: [
      ...input.input_files.map(fid => ({ type: 'container_upload', file_id: fid })),
      { type: 'text', text: input.task },
    ],
  }]

  // Stesso loop runAgent ma su istanza isolata. Nesting: max 1 livello (no sub-sub-agent).
  const result = await runAgent({
    conversationId: subRunId,
    messages: subMessages,
    system: subSystem,
    intent: 'generation',
    nesting: 1,
    parentRunId,
  })

  await dbUpdateSubAgentJob(subRunId, { status: 'completed', summary: result.text })
  return { summary: result.text, artifacts: result.artifacts ?? [] }
}
```

### 6.5 Anti-pattern da evitare

- **Nesting >2**: parent → child → grandchild = debugging impossibile. Hard-cap a 1 livello.
- **Passing full transcript**: non passare al parent il transcript completo del child, solo `result.text` (summary).
- **State condiviso in-memory**: ogni sub-agent ha contesto isolato. Per condividere stato: usare `agent_runs` table o Anthropic Files API.
- **Spawn senza necessità**: il prompt dell'orchestrator scoraggia spawn per task <3 step. Il default è risolvere inline.

---

## 7. Memory API native + working memory (file: `src/v19/memory/`)

### 7.1 Strato 3-livelli

| Livello | Scope | Storage | Tool exposed |
|---|---|---|---|
| **Short-term (thread)** | Ultimi N messaggi della conversazione corrente | Supabase `messages` table | implicito (parte di `messages` payload) |
| **Working memory (memory_20250818)** | Note/preferenze cross-conversazione, sotto controllo Claude | Supabase Storage `/memories/{userId}/...md` | tool nativo `memory` (view/create/str_replace/insert/delete/rename) |
| **Long-term semantic** | Documenti completi indicizzati (DDT passati, capitolati, prezziari, mail archiviate) | Supabase `embeddings` (pgvector) | `richiama_memoria(query, k)`, `lista_entita(tipo)`, `riepilogo_giorno(data)` |

### 7.2 Configurazione `memory_20250818` (Anthropic native)

```typescript
const tools = [
  { type: 'memory_20250818', name: 'memory' },
  ...domainTools,
]

// Handler client-side
async function handleMemoryToolCall(call: ToolUseBlock, userId: string): Promise<string> {
  const path = call.input.path as string
  if (!path.startsWith(`/memories/${userId}/`)) {
    return `ERROR: path traversal attempt rejected. Must start with /memories/${userId}/`
  }
  const supabasePath = path.replace(/^\/memories\//, '')
  switch (call.input.command) {
    case 'view': return await supabase.storage.from('memories').download(supabasePath)
    case 'create': return await supabase.storage.from('memories').upload(supabasePath, call.input.file_text, { upsert: true })
    case 'str_replace': return await replaceInMemoryFile(supabasePath, call.input.old_str, call.input.new_str)
    case 'insert': return await insertInMemoryFile(supabasePath, call.input.line, call.input.text)
    case 'delete': return await supabase.storage.from('memories').remove([supabasePath])
    case 'rename': return await renameMemoryFile(supabasePath, call.input.new_path)
    default: return `Unknown memory command: ${call.input.command}`
  }
}
```

### 7.3 Bootstrap `/memories/{userId}/` per Raffaele

All'inizializzazione utente Raffaele (`raffaele.lentini@restruktura.it`), V19 popola automaticamente:

```
/memories/raffaele/
├── identita.md         <- "Ing. Raffaele Lentini, CEO Restruktura SRL, P.IVA..."
├── tono.md             <- "Lei formale, niente cortesia ridondante..."
├── ufficio.md          <- "Villa d'Agri (PZ), lat/lon, clima appenninico..."
├── progetti/
│   ├── ponteggiosicuro.md
│   ├── cigo-aprile-2026.md
│   └── ...
├── clienti/
│   └── (popolato dinamicamente quando entità vengono menzionate)
└── preferenze/
    ├── doc-output.md   <- "Default memoria interna, Drive solo se richiesto"
    ├── git-policy.md   <- "Mai amend, mai --no-verify, branch feature/*"
    └── ...
```

Claude legge `/memories/raffaele/` PRIMA di rispondere (auto-prompt nel system) e aggiorna i file quando impara qualcosa di nuovo.

### 7.4 Migrazione dati V18

I 4 tool memoria esistenti (`ricorda`, `richiama_memoria`, `riepilogo_giorno`, `lista_entita`) restano funzionanti in V19. Si aggiunge `memory_20250818` come strato superiore. Migrazione una-tantum:

- Leggi `memoria_esplicita` table V18 → genera `/memories/raffaele/storia/` con un file per memoria.
- Leggi `entities` (cantieri/clienti/fornitori) → genera `/memories/raffaele/clienti/{slug}.md` etc.

Script: `src/v19/memory/migrate-from-v18.ts` (idempotente, può essere ri-eseguito).

---

## 8. DOCX engine semantico (file: `src/v19/render/docx.ts`)

### 8.1 Principio

Claude **NON** genera HTML che noi parsiamo. Claude genera **JSON semantico** che noi rendiamo deterministicamente in DOCX usando l'API nativa di `docx` v9.

```typescript
type DocxDocument = {
  title: string
  sections: DocxSection[]
  footer?: string // se assente, default Restruktura
}

type DocxSection = {
  kind: 'heading' | 'paragraph' | 'table' | 'list' | 'page_break' | 'image'
  // discriminated union
  ...
}

type DocxTable = {
  kind: 'table'
  caption?: string
  columns: { width: 'auto' | number; header: string; align?: 'left'|'center'|'right' }[]
  headerStyle: { bgColor?: string; color?: string; bold?: boolean }
  cellBorders: 'all' | 'horizontal' | 'none'
  rows: DocxCell[][]
}

type DocxCell = string | { text: string; bold?: boolean; align?: string; bgColor?: string }
```

### 8.2 Renderer

```typescript
// src/v19/render/docx.ts
import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, ShadingType, BorderStyle, WidthType, HeadingLevel, AlignmentType } from 'docx'

export async function renderDocx(doc: DocxDocument): Promise<Buffer> {
  const children = doc.sections.flatMap(renderSection)
  children.push(buildFooterParagraph(doc.footer))
  const docxDoc = new Document({
    creator: 'Cervellone V19',
    title: doc.title,
    sections: [{ children }],
  })
  return await Packer.toBuffer(docxDoc)
}

function renderTable(t: DocxTable): Table {
  const headerRow = new TableRow({
    tableHeader: true,
    children: t.columns.map((c) => new TableCell({
      shading: t.headerStyle.bgColor
        ? { type: ShadingType.SOLID, color: t.headerStyle.bgColor, fill: t.headerStyle.bgColor }
        : undefined,
      borders: borderConfig(t.cellBorders),
      children: [new Paragraph({
        alignment: alignFromString(c.align),
        children: [new TextRun({
          text: c.header,
          bold: t.headerStyle.bold ?? true,
          color: t.headerStyle.color ?? 'FFFFFF',
        })],
      })],
    })),
  })
  const dataRows = t.rows.map((row) => new TableRow({
    children: row.map((cell) => renderCell(cell, t.cellBorders)),
  }))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
  })
}

// renderCell, alignFromString, borderConfig, buildFooterParagraph: utility deterministic.
```

### 8.3 Tool `genera_docx_v19`

```typescript
{
  name: 'genera_docx_v19',
  description: 'Genera DOCX da struttura JSON semantica (tabelle native, header colorati, content controls). USARE SEMPRE invece di genera_docx (V18 deprecato). Per Allegato 10 CIGO usare schema specifico documentato in domain-italiano.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      sections: { type: 'array', items: { /* discriminated union */ } },
      folder_id: { type: 'string', description: 'Drive folder. Default: cartella semantica scelta automaticamente.' },
    },
    required: ['title', 'sections'],
  },
}
```

### 8.4 Test ground-truth Allegato 10

`src/v19/__tests__/cigo-allegato10.spec.ts` produce un DOCX con la struttura del fac-simile INPS (vedi sez. 9.1) e verifica:
- ZIP magic bytes
- Presenza di `<w:tbl>` (tabella nativa, non solo `<w:p>`)
- Header dichiarazione sostitutiva con grassetto e centratura
- Footer Restruktura
- Snapshot test: `tests/__snapshots__/allegato10-aprile-2026.docx` (binary diff stable)

---

## 9. Tool dominio italiano (file: `src/v19/tools/`)

### 9.1 Scope CIGO

Per microimpresa edile Restruktura in Appennino Lucano, CIGO causale "Eventi Meteorologici" richiede 3 documenti distinti (e non 1 come V18 supponeva):

1. **Allegato 10 — Relazione tecnica dettagliata art. 2 D.M. 95442/2016** (DOCX→PDF firmato, su CIGOWeb)
2. **Elenco beneficiari** (CSV/XML tracciato Messaggio INPS 3566/2018, allegato a CIGOWeb)
3. **Modello SR41** (PDF compilabile, solo se pagamento diretto INPS)

In più: **bollettino meteo CFD Basilicata** della giornata evento da allegare alla relazione tecnica come prova istituzionale.

### 9.2 Tool `scarica_bollettino_meteo_basilicata`

```typescript
{
  name: 'scarica_bollettino_meteo_basilicata',
  description: 'Scarica il bollettino di criticità ufficiale del Centro Funzionale Decentrato (CFD) Regione Basilicata per una data specifica. Fonte istituzionale per giustificare CIGO Eventi Meteo. Ritorna PDF + URL pubblico + zona di allerta della Basilicata (Bas-A Tirrenico, Bas-B Ionico).',
  input_schema: {
    type: 'object',
    properties: {
      data: { type: 'string', description: 'Data del bollettino in formato YYYY-MM-DD' },
      salva_su_drive: { type: 'boolean', default: true },
      cartella_drive_id: { type: 'string', description: 'Default: cartella RELAZIONI CIG' },
    },
    required: ['data'],
  },
}
```

Implementazione:

```typescript
// src/v19/tools/meteo-basilicata.ts
import { format } from 'date-fns'

export async function scaricaBollettinoBasilicata(data: Date): Promise<BollettinoResult> {
  const ddmmyyyy = format(data, 'dd_MM_yyyy')
  const base = 'https://centrofunzionale.regione.basilicata.it/ew/ew_pdf/a'
  const candidates = [
    `${base}/Bollettino_Criticita_Regione_Basilicata_${ddmmyyyy}.pdf`,
    `${base}/Bollettino_Criticita_Regione_Basilicata_${ddmmyyyy}.PDF`,
  ]
  for (const url of candidates) {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Cervellone-Restruktura/1.0 (CIGO automation)' },
    })
    if (!res.ok) continue
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > 1000 && buf.subarray(0, 4).toString() === '%PDF') {
      return { pdfUrl: url, pdfBuffer: buf, fonte: 'CFD Basilicata' }
    }
  }
  // Fallback: PEC formale alla Protezione Civile per certificato retroattivo
  throw new BollettinoNotFoundError(`Bollettino CFD Basilicata non disponibile per ${ddmmyyyy}. Inviare richiesta PEC: protezionecivile@cert.regione.basilicata.it`)
}
```

### 9.3 Tool `genera_allegato10_cigo`

Genera il DOCX Allegato 10 fedele al fac-simile INPS (D.M. 95442/2016 causale "Eventi Meteorologici"). Input strutturato. Output 3 file (Allegato 10 + Beneficiari CSV + opzionalmente SR41) zippati e caricati su Drive in cartella RELAZIONI CIG.

```typescript
{
  name: 'genera_allegato10_cigo',
  description: 'Genera pacchetto CIGO Eventi Meteo per microimpresa edile (Allegato 10 + CSV beneficiari + bollettino CFD Basilicata). Causale: D.M. 95442/2016. Fonte bollettino: SOLO Centro Funzionale Decentrato Basilicata (vincolante). Output: ZIP su Drive cartella RELAZIONI CIG.',
  input_schema: {
    type: 'object',
    properties: {
      azienda: {
        type: 'object',
        properties: {
          denominazione: { type: 'string' },
          codice_fiscale: { type: 'string' },
          matricola_inps: { type: 'string' },
          unita_produttiva: { type: 'string' },
          data_inizio_attivita: { type: 'string' },
        },
        required: ['denominazione', 'codice_fiscale', 'matricola_inps'],
      },
      legale_rappresentante: {
        type: 'object',
        properties: {
          nome_cognome: { type: 'string' },
          luogo_nascita: { type: 'string' },
          data_nascita: { type: 'string' },
          residenza: { type: 'string' },
          telefono: { type: 'string' },
        },
        required: ['nome_cognome'],
      },
      periodo: {
        type: 'object',
        properties: {
          data_inizio: { type: 'string' },
          data_fine: { type: 'string' },
        },
        required: ['data_inizio', 'data_fine'],
      },
      attivita_svolta: { type: 'string', description: 'Descrizione attività aziendale e fase lavorativa al verificarsi evento' },
      evento_meteo: { type: 'string', description: 'Descrizione evento meteo (pioggia/neve/gelo/vento/temperatura) e orario' },
      conseguenze: { type: 'string', description: 'Conseguenze dellevento sull attività' },
      beneficiari: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            cognome: { type: 'string' },
            nome: { type: 'string' },
            codice_fiscale: { type: 'string' },
            qualifica: { type: 'string' },
            ore_perse_settimana_1: { type: 'number' },
            // ...altre settimane periodo
          },
          required: ['cognome', 'nome', 'codice_fiscale'],
        },
      },
      pagamento_diretto: { type: 'boolean', description: 'Se true, genera anche SR41', default: false },
    },
    required: ['azienda', 'legale_rappresentante', 'periodo', 'attivita_svolta', 'evento_meteo', 'beneficiari'],
  },
}
```

Pipeline interna:
1. Scarica bollettino CFD Basilicata via `scarica_bollettino_meteo_basilicata(periodo.data_inizio)`.
2. Genera Allegato 10 DOCX via `renderDocx(buildAllegato10Doc(input))`.
3. Genera CSV beneficiari via `buildBeneficiariCsv(input.beneficiari, input.periodo)` rispettando tracciato Msg INPS 3566/2018.
4. (Se `pagamento_diretto`) Compila SR41 PDF da template Word INPS via `compilaSr41(input)`.
5. Crea ZIP con i 3 (o 2) file + bollettino.
6. Upload ZIP su Drive cartella RELAZIONI CIG (`folder_id` configurato in `cervellone_config`).

### 9.4 Schema CSV beneficiari (Msg INPS 3566/2018)

```
Cognome;Nome;CodiceFiscale;DataAssunzione;TipoContratto;OreContrattuali;TipoIntegrazione;DataInizio;DataFine;OreCIG;Importo
```

(Il tracciato esatto è specificato nel Messaggio INPS 3566/2018, ulteriori chiarimenti Msg 2489/2020 e 1185/2025. Da rifinire in fase di implementazione consultando il PDF ufficiale.)

### 9.5 Cartelle Drive semantiche

V18 sbagliava cartella perché non aveva semantic folder selection. V19 introduce in `cervellone_config` una mappa:

| Tipo documento | Drive folder ID |
|---|---|
| `cigo` | `<id RELAZIONI CIG>` |
| `ddt` | `<id DDT>` |
| `preventivo` | `<id PREVENTIVI>` |
| `cme` | `<id CME>` |
| ... | ... |

Tool `salva_documento_su_drive_v19(tipo, file, ...)` consulta la mappa. Niente più "Studio Tecnico" generico.

---

## 10. System prompt V19 minimale (file: `src/v19/prompts/system.ts`)

### 10.1 Principio

V18 prompt: 184 righe, 14 sezioni, ~4.300-6.700 token. V19 prompt: ~50 righe, ~800-1.500 token.

Le 14 sezioni di regole hardcoded V18 vengono **rimosse o spostate in `/memories/raffaele/preferenze/`**, dove Claude le legge solo se rilevanti per il task corrente. Il system prompt V19 contiene SOLO l'identità e la regola universale.

### 10.2 Testo prompt V19 (draft)

```
Sei Claude Opus 4.7 al 100% delle tue capacità.
Puoi fare TUTTO quello che fai su claude.ai, e DI PIÙ.
Non dire MAI "non posso". Fallo e basta. Se non hai un tool, usa github_propose_fix per aggiungerlo.

Contesto operativo:
Sei il CEO digitale di Restruktura SRL (P.IVA 02087420762, Villa d'Agri PZ, Italia).
L'utente principale è l'Ing. Raffaele Lentini (raffaele.lentini@restruktura.it).
Tono: Lei formale, pragmatico, conciso. Niente cortesia ridondante.

Memoria persistente:
Hai accesso a /memories/raffaele/ (tool nativo `memory`). Leggilo a inizio sessione.
Aggiornalo quando impari fatti nuovi. Mai inventare quello che non c'è.

Tool a disposizione:
Hai >50 tool registrati. Sai CHE cosa fanno (descrizione), non COME (implementazione).
Per task complessi (>3 step indipendenti) usa `spawn_subagent` invece di farli tu.

Documenti:
Per generare DOCX/XLSX/PDF, usa SEMPRE `genera_docx_v19`/`genera_xlsx_v19`/`genera_pdf_v19`
(input JSON semantico, output deterministico, tabelle native).
Mai HTML strip. Mai jsPDF.

Salvataggio:
Default: memoria interna conversazione (non scrivi su Drive).
Solo se l'utente dice "salva su Drive"/"archivia"/"manda a [persona]" → upload.
Cartella Drive: usa `salva_documento_su_drive_v19(tipo, ...)` che sceglie la cartella semantica corretta.
MAI inventare URL Drive. Se non hai un link concreto da un tool, dichiaralo onestamente.

Data e ora: usa `weather_now` o `currentDateTimeContext()`. Mai memoria.

Autonomia git/PR: vedi /memories/raffaele/preferenze/git-policy.md.
```

### 10.3 Ciò che è stato RIMOSSO dal V18 prompt e dove è andato

| V18 sezione | V19 destino |
|---|---|
| Tool Gmail rules (9 righe) | spostato in `/memories/raffaele/preferenze/gmail-policy.md` (Claude lo legge se task tocca Gmail) |
| Tool Drive rules (10 righe) | rimosse (Claude usa drive_* perché lo sa, niente regole) |
| Tool Memoria rules (7 righe) | rimosse (Claude usa `memory` nativo + 4 tool legacy senza istruzioni) |
| Tool File Pipeline rules (10 righe) | rimosse (file passati direttamente a Claude, Claude decide) |
| REGOLA ASSOLUTA SUI FILE (4 righe) | sostituita da: validator runtime hallucination + 1 riga "MAI inventare URL Drive" |
| REGOLA AUTONOMIA LOOP (7 righe) | spostato in `/memories/raffaele/preferenze/git-policy.md` |
| REGOLA AUTONOMIA PROACTIVE (7 righe) | spostato in `/memories/raffaele/preferenze/git-policy.md` |
| REGOLA AUTONOMIA SVILUPPO (8 righe) | spostato in `/memories/raffaele/preferenze/git-policy.md` |
| Tono / Profilo utente (5 righe) | restano (1-2 righe) + dettagli in `/memories/raffaele/identita.md` |
| Coordinate ufficio (5 righe) | spostato in `/memories/raffaele/ufficio.md` |
| Regole conversazionali (6 righe) | rimosse (Claude lo sa fare nativamente) |

---

## 11. E2B sandbox integration (file: `src/v19/sandbox/e2b.ts`)

### 11.1 Quando usare E2B vs `code_execution_20260120`

| Caso | Engine raccomandato |
|---|---|
| Calcolo Python pandas/numpy/openpyxl/python-docx (stretto) | `code_execution_20260120` (gratis 1.550h/mese, preinstallato) |
| Generazione DOCX/XLSX/PDF Python | `code_execution_20260120` (preinstallato python-docx, openpyxl, reportlab) |
| File <5 GiB, durata <5 min | `code_execution_20260120` |
| Node.js / Bun runtime | E2B |
| Network outbound controllato (es. scraper) | E2B (con whitelist) |
| Persistence >1 ora cross-conversation | E2B |
| Compilazione/test progetti software | E2B |
| GPU compute | E2B (template GPU) |

Per Cervellone V19 stanotte: E2B è in **codice ready, feature-flagged off**. La key (`E2B_API_KEY`) sarà settata dall'utente domattina.

### 11.2 Wrapper

```typescript
// src/v19/sandbox/e2b.ts
import { Sandbox } from '@e2b/code-interpreter'

let cachedSandbox: Sandbox | null = null

export async function getOrCreateSandbox(conversationId: string): Promise<Sandbox> {
  if (process.env.E2B_FEATURE !== 'on') {
    throw new SandboxDisabledError('E2B disabilitato (E2B_FEATURE!=on). Set env per abilitare.')
  }
  if (!process.env.E2B_API_KEY) {
    throw new SandboxKeyMissingError('E2B_API_KEY non settata su Vercel + .env.local.')
  }
  // Tenta riuso da DB
  const savedId = await loadSandboxId(conversationId)
  if (savedId) {
    try {
      return await Sandbox.connect(savedId, { apiKey: process.env.E2B_API_KEY })
    } catch (e) {
      // sandbox scaduta, ne creiamo una nuova
    }
  }
  const sbx = await Sandbox.create({
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 600_000, // 10 min
  })
  await saveSandboxId(conversationId, sbx.sandboxId)
  return sbx
}

export async function runCodeInSandbox(conversationId: string, code: string, opts?: { onStdout?: (l: string) => void }) {
  const sbx = await getOrCreateSandbox(conversationId)
  const exec = await sbx.runCode(code, { onStdout: opts?.onStdout })
  return {
    stdout: exec.logs.stdout.join(''),
    stderr: exec.logs.stderr.join(''),
    files: await sbx.files.list('/home/user'),
  }
}
```

### 11.3 Tool `run_node_sandbox` (esposto solo se E2B attivo)

Il system prompt V19 NON dichiara questo tool finché `E2B_FEATURE !== 'on'`. Quando attivo, Claude lo vede e può usarlo. Dichiarazione condizionale evita confusione del modello.

---

## 12. Schema DB Supabase evolutivo

### 12.1 Tabelle nuove V19 (file: `supabase/migrations/2026-05-09-v19-foundation.sql`)

```sql
-- Run di un agent V19 (parent o sub)
create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  parent_run_id uuid references agent_runs(id) on delete cascade,
  kind text not null, -- 'orchestrator' | 'parsing-files' | 'numerical-engine' | ... | 'document-render' etc.
  intent text not null, -- 'chat' | 'generation' | 'agentic'
  status text not null default 'running', -- running | completed | failed | paused
  container_id text, -- Anthropic code_execution container id (riusabile)
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  iterations int default 0,
  tokens_input bigint default 0,
  tokens_output bigint default 0,
  thinking_tokens bigint default 0,
  error_message text,
  summary text -- output summary del run (per sub-agent: ritornato al parent)
);

create index if not exists agent_runs_conversation_idx on agent_runs(conversation_id, started_at desc);
create index if not exists agent_runs_parent_idx on agent_runs(parent_run_id);

-- Sub-agent jobs (specializzazione di agent_runs per la coda spawn_subagent)
create table if not exists sub_agent_jobs (
  run_id uuid primary key references agent_runs(id) on delete cascade,
  task text not null,
  input_files jsonb not null default '[]'::jsonb,
  artifacts jsonb default '[]'::jsonb -- file_id Anthropic prodotti
);

-- Document renders (audit trail Quality Gate)
create table if not exists document_renders (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  run_id uuid references agent_runs(id),
  kind text not null, -- 'docx' | 'xlsx' | 'pdf'
  semantic_input jsonb not null, -- input JSON semantico passato al renderer
  drive_file_id text, -- ID file Google Drive risultante
  drive_url text,
  state text not null default 'draft', -- draft | review | firmato | archiviato
  created_at timestamptz not null default now(),
  signed_at timestamptz,
  audit_log jsonb default '[]'::jsonb
);

create index if not exists document_renders_conversation_idx on document_renders(conversation_id);
create index if not exists document_renders_state_idx on document_renders(state);

-- E2B sandbox tracking (per riuso cross-request)
create table if not exists e2b_sandboxes (
  conversation_id text primary key,
  sandbox_id text not null,
  created_at timestamptz not null default now(),
  last_used timestamptz not null default now(),
  killed_at timestamptz
);

-- RLS DISABLED (allineato al pattern V18 — admin only)
alter table agent_runs disable row level security;
alter table sub_agent_jobs disable row level security;
alter table document_renders disable row level security;
alter table e2b_sandboxes disable row level security;
```

### 12.2 Storage bucket `memories`

```sql
-- supabase/migrations/2026-05-09-v19-memories-bucket.sql
insert into storage.buckets (id, name, public)
values ('memories', 'memories', false)
on conflict do nothing;

-- Solo service role accede; client non scrive direttamente
create policy "Service role full access on memories"
  on storage.objects for all
  using (bucket_id = 'memories' and auth.role() = 'service_role')
  with check (bucket_id = 'memories' and auth.role() = 'service_role');
```

### 12.3 Migration legacy V18 → V19

Nessun DROP, nessun ALTER su tabelle V18 esistenti. V19 vive in parallelo. Quando V19 sarà cutover (sessione successiva), si valuterà cleanup.

---

## 13. Test ground-truth Allegato 10 CIGO Aprile 2026

### 13.1 Dati operai sintetizzati realistici

```typescript
// src/v19/__tests__/fixtures/cigo-aprile-2026.ts
export const fixtureCigoAprile2026: Allegato10Input = {
  azienda: {
    denominazione: 'RESTRUKTURA S.r.l.',
    codice_fiscale: '02087420762',
    matricola_inps: '7654321/00',
    unita_produttiva: 'Cantiere Villa d\'Agri (PZ)',
    data_inizio_attivita: '2018-03-12',
  },
  legale_rappresentante: {
    nome_cognome: 'Lentini Raffaele',
    luogo_nascita: 'Potenza',
    data_nascita: '1985-06-15',
    residenza: 'Villa d\'Agri (PZ), Via Roma 1',
    telefono: '0975 123456',
  },
  periodo: { data_inizio: '2026-04-08', data_fine: '2026-04-12' },
  attivita_svolta: 'Costruzione di edificio bifamiliare in c.a. fase: getto solaio piano primo, posa armatura, casseratura...',
  evento_meteo: 'Pioggia continua dal 8 al 12 aprile 2026 con accumuli giornalieri 18-32 mm (soglia INPS 2 mm per costruzione e carpenteria superata in tutti i giorni del periodo). Sospensione lavori per inagibilità area cantiere e rischio sicurezza per lavori in altezza.',
  conseguenze: 'Sospensione totale operai presenti in cantiere. Recupero settimana successiva. Slittamento cronoprogramma di 5 gg.',
  beneficiari: [
    { cognome: 'Bianchi', nome: 'Mario', codice_fiscale: 'BNCMRA80A01F104X', qualifica: 'Operaio specializzato', ore_perse_settimana_1: 32 },
    { cognome: 'Rossi', nome: 'Giuseppe', codice_fiscale: 'RSSGPP82C15F104Y', qualifica: 'Operaio qualificato', ore_perse_settimana_1: 32 },
    { cognome: 'Verdi', nome: 'Antonio', codice_fiscale: 'VRDNTN85E20F104Z', qualifica: 'Operaio comune', ore_perse_settimana_1: 32 },
    { cognome: 'Russo', nome: 'Luca', codice_fiscale: 'RSSLCU90H10F104W', qualifica: 'Apprendista', ore_perse_settimana_1: 28 },
    { cognome: 'Esposito', nome: 'Carmine', codice_fiscale: 'SPSCMN78D03F104V', qualifica: 'Capo squadra', ore_perse_settimana_1: 32 },
  ],
  pagamento_diretto: false, // anticipo 40% solo se richiesto
}
```

### 13.2 Test runtime

```typescript
// src/v19/__tests__/cigo-allegato10.spec.ts
import { describe, it, expect } from 'vitest'
import { genera_allegato10_cigo } from '@/v19/tools/cigo'
import { fixtureCigoAprile2026 } from './fixtures/cigo-aprile-2026'
import JSZip from 'jszip'

describe('Allegato 10 CIGO Aprile 2026', () => {
  it('produce 3 file (docx + csv + bollettino_pdf)', async () => {
    const result = await genera_allegato10_cigo(fixtureCigoAprile2026, { dryRun: true /* no Drive upload */ })
    expect(result.files).toHaveLength(3)
    expect(result.files.map(f => f.name)).toContain('Allegato10_RelazioneTecnica.docx')
    expect(result.files.map(f => f.name)).toContain('ElencoBeneficiari.csv')
    expect(result.files.map(f => f.name)).toMatch(/Bollettino_Criticita.*\.pdf/i)
  })

  it('Allegato 10 DOCX contiene tabella nativa per box DATI AZIENDA', async () => {
    const result = await genera_allegato10_cigo(fixtureCigoAprile2026, { dryRun: true })
    const docx = result.files.find(f => f.name === 'Allegato10_RelazioneTecnica.docx')!
    const zip = await JSZip.loadAsync(docx.buffer)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:tbl>') // tabella nativa, non solo paragrafi
    expect(xml).toContain('RESTRUKTURA') // nome azienda
    expect(xml).toContain('02087420762') // P.IVA
  })

  it('CSV beneficiari rispetta tracciato Msg INPS 3566/2018', async () => {
    const result = await genera_allegato10_cigo(fixtureCigoAprile2026, { dryRun: true })
    const csv = result.files.find(f => f.name === 'ElencoBeneficiari.csv')!.buffer.toString('utf-8')
    expect(csv.split('\n')[0]).toBe('Cognome;Nome;CodiceFiscale;DataAssunzione;TipoContratto;OreContrattuali;TipoIntegrazione;DataInizio;DataFine;OreCIG;Importo')
    expect(csv).toMatch(/Bianchi;Mario;BNCMRA80A01F104X/)
  })

  it('Bollettino CFD Basilicata scaricato è PDF valido', async () => {
    const result = await genera_allegato10_cigo(fixtureCigoAprile2026, { dryRun: true })
    const bol = result.files.find(f => /Bollettino/i.test(f.name))!
    expect(bol.buffer.subarray(0, 4).toString()).toBe('%PDF')
    expect(bol.buffer.length).toBeGreaterThan(1000)
  })
})
```

### 13.3 Confronto V19 vs Claude.ai

In sessione successiva (utente presente), Claude.ai genera la stessa Allegato 10 con le stesse fixture. Confronto visivo (apertura DOCX su Word, screenshot affiancati). V19 deve essere **almeno equivalente, idealmente superiore** (perché V19 ha bollettino integrato auto-scaricato + CSV pronto).

---

## 14. Sicurezza e confini operativi

### 14.1 Confini stanotte (autonomia notturna Claude)

- ✅ Lavoro su branch `v19/foundation`
- ✅ Commit ordinati per modulo
- ✅ 1 PR draft "V19 Foundation" su GitHub (NO merge)
- ✅ File migration `.sql` in `supabase/migrations/` (NON applicate)
- ✅ Code commentato dove necessario (Why, non What)
- ❌ NO push su `main`
- ❌ NO deploy prod Vercel
- ❌ NO modifiche a Supabase prod (solo file)
- ❌ NO modifiche env Vercel
- ❌ NO modifica bot Telegram in prod
- ❌ NO chiusura PR esistenti
- ❌ NO scelte irreversibili

### 14.2 Confini di V19 (runtime, una volta deployata)

- **Tool destruction guard**: tool che cancellano (Drive trash, Gmail trash, Supabase delete) richiedono `confirm: true` esplicito dall'utente o sono dietro `/conferma`.
- **Path traversal memory**: `/memories/{userId}/` validato server-side.
- **Hallucination URL**: validator runtime su URL Drive prodotti (sez. 5.3).
- **Subagent nesting cap**: max 1 livello.
- **Rate limit tool esterni**: CFD Basilicata 1 req/sec, Gmail API rispetta quota Google, GitHub API rispetta rate limit token.
- **Audit trail**: ogni `agent_runs` row registrata con tokens, kind, parent.

### 14.3 Confini etico-legali

- **CFD Basilicata**: uso istituzionale interno (allegato CIGO) — autorizzato. NO redistribuzione massiva pubblica.
- **Gmail**: send sempre dietro `/conferma` esplicito (eccetto routine pre-autorizzate fase 2).
- **Drive**: scrittura solo su cartelle Restruktura legittime.
- **No scraping**: Catasto/Sister/portali vincolati restano fuori (solo APIs ufficiali o contratti).

---

## 15. Roadmap implementativa

### 15.1 Foundation (stanotte, 9 mag 2026)

Ordine task (vedi plan dettagliato):

1. Branch `v19/foundation` setup
2. Loop reasoning V19 (`src/v19/agent/loop.ts`) + test base
3. Orchestrator multi-agent (`src/v19/agent/orchestrator.ts`)
4. Memory API native handler (`src/v19/memory/`)
5. DOCX engine semantico (`src/v19/render/docx.ts`)
6. Tool `scarica_bollettino_meteo_basilicata` (`src/v19/tools/meteo-basilicata.ts`)
7. Tool `genera_allegato10_cigo` + sotto-componenti (`src/v19/tools/cigo.ts`)
8. E2B integration (`src/v19/sandbox/e2b.ts`) — feature-flagged
9. Migration Supabase (file `.sql`)
10. System prompt V19 minimale (`src/v19/prompts/system.ts`)
11. Test ground-truth Allegato 10 CIGO
12. Commit ordinati + PR draft
13. ONBOARDING.md + memory update

### 15.2 Polish (sessioni successive con utente)

- Cutover Telegram da V18 a V19 (route `/api/telegram` switch)
- Cutover webchat
- Migrazione dati V18 → memory_20250818
- Dismissione `pdf-generator.ts:144-188` (DOCX naive)
- Setup Trigger.dev v3 per task durable
- Trigger E2B (aggiungi `E2B_API_KEY`, abilita feature flag)

### 15.3 Visione completa (W3-W12 secondo `cervellone-architettura-target.md`)

- W3-W4: S8 verifica norme Normattiva + S9 territorial knowledge persistence
- W5-W6: Vercel Sandbox custom (alternativa/complementare a E2B per Python heavy)
- W7: Quality Gate completo (stati doc + audit firmato + UI review)
- W8-W10: Local Agent Bridge (PC ufficio Restruktura)
- W11: Document Pipeline branding completo
- W12: Resilience Layer (multi-provider AI, backup off-site, cap costi)

---

## 16. Anti-pattern da evitare in V19

Sintesi della memoria storica `cervellone-errori-completi.md` filtrata per V19:

### 16.1 Evita SEMPRE

- **Custom tool per cose Claude fa già** (web search nativo OK, web search reimplementato NO)
- **System prompt procedurale**: niente "PRIMA fai X POI fai Y". Una sola regola universale.
- **Disabilitare thinking**: V19 usa adaptive sempre.
- **Router modello con regex**: V19 usa Opus 4.7 ovunque, no Haiku/Sonnet override.
- **Patch su patch su V18**: V19 nasce in `src/v19/` pulito.
- **UUID type mismatch** (es. `telegram_${chatId}` in colonna UUID): V19 usa text type per IDs custom.
- **Salvataggio messaggio prima della history** (race condition): V19 ordina sempre history → save.
- **Memory leak setInterval Telegram**: V19 cleanup interval in finally + idle timeout.
- **searchMemory threshold 0.40 (troppo basso)**: V19 usa 0.55+ con re-rank.
- **File whitelist rigida**: V19 accetta tutto e lascia decidere a Claude.
- **PDF >600 pagine direttamente all'API**: V19 usa Files API + container_upload + chunking lato Claude.

### 16.2 Lezioni recenti (4-9 maggio 2026)

- **Vercel binary tracing** (`feedback_vercel_binary_tracing.md`): per qualsiasi package con binari nativi, `serverExternalPackages` NON basta su Turbopack. SEMPRE aggiungere `outputFileTracingIncludes`. Per `@e2b/code-interpreter` valutare se serve tracing esplicito.
- **TS Buffer.from overload** (`feedback_typescript_buffer_overload.md`): union `ArrayBuffer | Buffer` richiede annotation + cast esplicito. Applicabile in `code_execution` file capture.
- **Context bias tool errors** (`feedback_context_bias_tool_errors.md`): bot resta ancorato a tool failures cached. V19 reset cache circuit breaker più aggressivo + re-prompt imperativo dopo errore.
- **Vercel UI Run now su cron** (`feedback_vercel_cron_run_now.md`): non inietta Bearer CRON_SECRET. V19 documenta in ONBOARDING che cron smoke veri solo via curl.
- **PR loop chiuso end-to-end** (`feedback_pr_loop_chiuso.md`): `github_merge_pr` + REGOLA AUTONOMIA COMPLETA. V19 mantiene tool ma con confini chiari.
- **Pre-flight verification** (`feedback_pre_flight_verification.md`): SEMPRE `npm run build` locale prima di push. V19 aggiunge pre-commit hook se non già presente.
- **Principio fondamentale violato** (`feedback_principio_fondamentale_violato.md`): prima di proporre sub-progetti, chiedersi "Claude lo fa già?". V19 spec applica questo filtro a ogni nuovo tool.

---

## 17. Riferimenti

### 17.1 Memoria Claude Code

- `cervellone-decisioni-8-9-mag-2026.md` — decisione strategica V19
- `cervellone-errori-completi.md` — 20 errori da non ripetere
- `cervellone-principio-fondamentale.md` — Claude al 100%
- `cervellone-standard.md` — fare DI PIÙ di Claude.ai
- `cervellone-architettura-target.md` — 9 sistemi 12 settimane
- `cervellone-bollettino-meteo-basilicata.md` — vincolo CFD Basilicata
- `cervellone-pdf-puppeteer-v18.md` — stato V18

### 17.2 Spec storiche (reference)

- `2026-05-04-cervellone-circuit-breaker-design.md`
- `2026-05-05-cervellone-gmail-rw-design.md`
- `2026-05-08-cervellone-pdf-puppeteer-design.md`

### 17.3 Documentazione esterna

- [Anthropic Opus 4.7 What's new](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7)
- [Adaptive thinking](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking)
- [Code execution tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)
- [Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Building agents with Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)
- [docx library v9 tables](https://github.com/dolanmiu/docx/blob/master/docs/usage/tables.md)
- [E2B Code Interpreter](https://e2b.dev/)
- [CFD Basilicata bollettini](https://centrofunzionale.regione.basilicata.it/it/bollettini-tutti.php)
- [Modello Allegato 10 fac-simile](https://www.fiscal-focus.it/all/CIGO._Relazione_tecnica_per_eventi_meteorologici.pdf)
- [Modello SR41 INPS](https://www.studio74.it/images/pdf-modulistica/inps/inps-cig-cartacei-sr41-pospetto-per-pagamento-diretto-integrazioni-salariali.pdf)
- [Manuale CIGOWeb INPS](https://servizi2.inps.it/servizi/CIGOWeb2010/Download/Manuale%20Utente%20CIGO%20ver%201.pdf)

---

## 18. Open questions per utente (al risveglio)

Domande rimaste aperte dopo questa sessione autonoma. Domattina, prima del cutover V19 → V18, l'utente deve rispondere:

1. **E2B_API_KEY**: dove preferisci settarla? (Vercel env + .env.local?)
2. **Cartelle Drive semantiche**: hai gli ID delle cartelle target? (RELAZIONI CIG, DDT, PREVENTIVI, CME, ecc.) Lista da fornire per `cervellone_config`.
3. **Beneficiari CIGO Aprile 2026 reali**: quando vuoi sostituire i fixture con i dati reali dei tuoi operai? Posso creare un comando Telegram `/cigo aprile-2026 con-dati-veri`.
4. **Bollettino dell'evento reale**: il bollettino CFD Basilicata di che data esatta? (8 aprile? 10 aprile? gli accumuli che vuoi citare nella relazione?)
5. **Cutover Telegram**: vuoi che V19 sostituisca V18 sul bot @CervelloneBot subito, o vuoi periodo parallelo (V18 prod + V19 staging) per smoke?
6. **Path Hybrid (E)**: nel caso V19 non convinca al primo test domattina, vuoi che attivi anche il path Hybrid (Claude.ai Projects per reasoning + Cervellone come gateway) come safety net?

---

**Fine spec V19. Status: ready to implement. Plan separato in `docs/superpowers/plans/2026-05-09-cervellone-v19-foundation.md`.**
