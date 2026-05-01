# Fase 1 — Riparazione streaming Telegram + Trigger.dev v3

**Data:** 1 maggio 2026
**Tipo:** Sub-progetto autonomo (Fase 1 di 4 — vedi `memory/cervellone-architettura-target.md`)
**Owner:** Ing. Raffaele Lentini
**Stato:** spec approvata, da implementare

---

## Contesto

Cervellone V10 (deploy 19 aprile 2026) ha rotto lo streaming Telegram: il bot risponde solo "🧠 Sto elaborando..." e poi resta muto.

Inoltre Cervellone deve gestire task lunghi (POS completi, preventivi articolati, perizie, sub-agent CAD) che possono superare i 5 minuti di esecuzione — limite hard di Vercel Functions (`maxDuration: 300`).

Questa fase risolve **entrambi** i problemi simultaneamente: ripara la chat veloce e introduce Trigger.dev v3 come orchestratore di task durable.

## Root cause del bug attuale

`src/lib/claude.ts:241-243` (ramo Telegram, funzione `callClaudeStreamTelegram`):

```ts
const isOpus = cfg.model.includes('opus')
const modelConfig: ModelConfig = {
  model: cfg.model,
  thinkingBudget: isOpus ? 100_000 : 10_000,  // ← problema
  maxTokens: isOpus ? 128_000 : 32_000,
}
```

Il commit `ec2c494` (V10, "prompt minimale + rimuovere router") ha eliminato il routing dinamico precedente che adattava il `thinkingBudget` alla complessità (4k → 32k → 100k). Adesso Opus usa SEMPRE 100k.

Con Opus 4.7 + 100k thinking budget, il modello pensa per molti minuti **prima** di emettere il primo `text_delta`. Il loop di streaming (`claude.ts:258-267`) ignora `thinking_delta` events. Risultato: nessun `editTelegramMessage` viene mai chiamato. Vercel killa la function a 300s. L'utente vede solo il placeholder iniziale.

Inoltre `editTelegramMessage` a `claude.ts:271` è chiamato senza `await` (fire-and-forget): se la function muore subito dopo il loop, gli ultimi edit possono non partire.

**Coerente con i log Vercel:** l'esecuzione raggiunge "EMBEDDING generato" (dentro `searchMemory`) e poi silenzio fino al kill.

## Obiettivi Fase 1

1. **Riparare la chat conversazionale Telegram** (task <2 min, 95% dei casi d'uso)
2. **Introdurre Trigger.dev v3** come orchestratore di task durable
3. **Spostare i task lunghi** (POS, preventivi completi, perizie) su workflow durable
4. **Mostrare progresso visivo** durante l'esecuzione (heartbeat + streaming testuale)
5. **Crash-safe:** se la function/workflow muore, il task riprende o l'utente è notificato

## Non-obiettivi Fase 1

- Cron schedulati (Fase 2)
- Vercel Sandbox per esecuzione codice (Fase 3)
- Local Agent sul PC (Fase 4)
- Riscrittura del modulo skills (resta com'è)
- Cambio del modello AI o del prompt minimale (resta Opus 4.7 + V10 prompt)

## Architettura proposta

### Flusso conversazionale (chat veloce, <2 min)

Webhook Telegram → Vercel Function (route `/api/telegram`) →
**classifica task** → se chat veloce: `callClaudeStreamTelegram` riparato →
streaming `text_delta` + `thinking_delta` → `editMessageText` ogni 3-5s.

### Flusso task durable (>2 min)

Webhook Telegram → Vercel Function → classifica come task lungo →
`tasks.trigger("cervellone.long-task", { conversationId, userQuery, history })` →
**risposta immediata** all'utente: "🛠️ Lavoro avviato. Aggiornamenti a breve."
→ Trigger.dev v3 task durable esegue Claude con tool/skills →
durante l'esecuzione: `metadata.set({ status, progress })` →
**listener** Trigger.dev pubblica heartbeat su Telegram via `editMessageText` →
quando inizia il testo: switch a streaming continuo →
documento finale: salvato su Supabase + URL inviato.

### Classificazione "veloce vs lungo"

**Approccio:** classificazione semplice basata su keyword + lunghezza prompt.
- Keyword "redigi", "preventivo completo", "POS", "perizia", "computo" → task lungo
- File allegato (PDF/immagine) di dimensione >100KB → task lungo (digestione + analisi)
- Default → chat veloce

In Fase 3 si può sostituire con classificazione AI dedicata se serve.

## Componenti

### 1. `src/lib/claude.ts` — fix streaming Telegram

**Modifiche:**

- Riduzione thinking budget: Opus `100_000 → 8_000`, Sonnet `10_000 → 4_000`
- Aggiungi handling di `thinking_delta` events: accumula testo "thinking" e invia heartbeat ogni 5s con counter token
- `await` esplicito sull'edit finale dopo il loop (`onChunk(fullResponse)`)
- Stesso fix anche nel ramo `callClaude` (Telegram non-streaming) e `callClaudeStream` (web)

**Fix minimo riusabile:**

```ts
let lastThinkingEdit = 0
let thinkingTokens = 0
for await (const event of stream) {
  if (event.type === 'content_block_delta') {
    if (event.delta.type === 'text_delta') {
      fullResponse += event.delta.text
      const now = Date.now()
      if (now - lastChunkTime > 3000) {
        await onChunk(fullResponse)
        lastChunkTime = now
      }
    } else if (event.delta.type === 'thinking_delta' && fullResponse === '') {
      thinkingTokens += event.delta.thinking?.length || 0
      const now = Date.now()
      if (now - lastThinkingEdit > 5000) {
        await onChunk(`🧠 Sto pensando... (${thinkingTokens} char)`)
        lastThinkingEdit = now
      }
    }
  }
}
```

### 2. Trigger.dev v3 — setup

**Installazione:**
```bash
npm install @trigger.dev/sdk@latest
npx trigger.dev@latest init
```

Crea cartella `trigger/` con configurazione e definizioni task.

**File:** `trigger.config.ts` — config base, project ref, retries default.

**File:** `trigger/cervellone-long-task.ts`

```ts
import { task, metadata } from "@trigger.dev/sdk/v3"
import { callClaudeStreamTelegram } from "@/lib/claude"
import { sendHeartbeatToTelegram } from "@/lib/telegram-helpers"

export const cervelloneLongTask = task({
  id: "cervellone.long-task",
  maxDuration: 60 * 60, // 1 ora hard cap (configurabile per task type)
  retry: { maxAttempts: 2 },
  run: async (payload: {
    conversationId: string
    chatId: number
    placeholderMsgId: number
    userQuery: string
    history: any[]
    systemPrompt: string
  }) => {
    metadata.set("status", "elaborazione iniziata")

    const fullResponse = await callClaudeStreamTelegram(
      { messages: payload.history, systemPrompt: payload.systemPrompt, userQuery: payload.userQuery, conversationId: payload.conversationId },
      async (accumulated) => {
        metadata.set("progress", accumulated.slice(-200))
        await sendHeartbeatToTelegram(payload.chatId, payload.placeholderMsgId, accumulated)
      }
    )

    return { ok: true, length: fullResponse.length }
  }
})
```

### 3. `src/app/api/telegram/route.ts` — classificazione + dispatch

Sostituisce il blocco `bgProcess()` con:

```ts
const isLongTask = classifyTask(userText, fileBlocks)
if (isLongTask) {
  const placeholderMsgId = await sendTelegramMessageWithId(chatId, "🛠️ Avvio elaborazione lunga... Le invio aggiornamenti durante il lavoro.")
  await tasks.trigger<typeof cervelloneLongTask>("cervellone.long-task", {
    conversationId, chatId, placeholderMsgId,
    userQuery: userText, history,
    systemPrompt: await getTelegramSystemPrompt(userText),
  })
} else {
  // chat veloce — bgProcess esistente con waitUntil()
  waitUntil(bgProcess())
}
return NextResponse.json({ ok: true })
```

### 4. `src/lib/task-classifier.ts` — classificazione task

```ts
const LONG_TASK_KEYWORDS = [
  /redig\w+/i, /prepar\w+/i, /elabor\w+/i,
  /preventiv\w+/i, /comput\w+/i, /\bcme\b/i, /\bsal\b/i,
  /\bpos\b/i, /perizi\w+/i, /relazion\w+/i,
  /pratic\w+/i, /computo metric\w+/i
]

export function classifyTask(userText: string, fileBlocks: any[]): boolean {
  if (LONG_TASK_KEYWORDS.some(re => re.test(userText))) return true
  if (fileBlocks.length > 0 && JSON.stringify(fileBlocks).length > 100_000) return true
  return false
}
```

### 5. Variabili d'ambiente

Aggiunte a Vercel:
- `TRIGGER_API_KEY` — chiave API Trigger.dev
- `TRIGGER_PROJECT_REF` — riferimento progetto

### 6. Configurazione Trigger.dev

- Account Trigger.dev creato
- Progetto `cervellone-prod`
- Free tier: 10k task run/mese (ampiamente sufficiente)
- Webhook tra Trigger.dev e Telegram via funzione di Cervellone

## Schema dati Telegram durante task durable

| Tempo | Stato Telegram |
|-------|---------------|
| t=0 | "🛠️ Avvio elaborazione lunga..." (sendMessage) |
| t=5s | "🧠 Sto pensando... (1.2k char)" (editMessage) |
| t=30s | "🧠 Sto pensando... (8.5k char)" (editMessage) |
| t=60s | Inizio testo: "**Premessa**\n\nIl presente POS..." (editMessage, content cresce) |
| t=300s | Testo completo o quasi, `editMessage` continua |
| t=fine | "📄 *POS Cantiere Rossi*\n👉 https://cervellone-5poc.vercel.app/doc/abc123" (editMessage o sendMessage finale) |

Limite Telegram: 4096 char per messaggio. Per documenti lunghi → primo messaggio è il summary + URL al doc completo, non l'intero HTML.

## Error handling

| Situazione | Comportamento |
|-----------|---------------|
| Trigger.dev down | Fallback: webhook Telegram esegue task in `waitUntil()` come prima (max 300s) + warning all'utente "modalità degradata, task molto lunghi potrebbero non completarsi" |
| Task fallisce dopo retry | Trigger.dev manda evento `failed` → callback Telegram pubblica errore + suggerimento operativo |
| Anthropic 429/500 | Retry built-in di Trigger.dev (already handled) |
| Telegram editMessage fallisce | Fallback già presente (parse_mode disabilitato, retry) |
| Function Vercel killata mid-classification | Idempotenza dedup messaggi già attiva |

## Testing & verifica

**Pre-deploy (locale):**
1. Test unit `classifyTask()` con esempi reali ("ciao", "che ora è", "redigi un POS", file PDF allegato)
2. Test che il fix `thinking_delta` non rompa lo streaming web esistente
3. Smoke test Trigger.dev: trigger task locale, verifica esecuzione

**Post-deploy (produzione):**
1. Telegram: `/start` → risposta immediata
2. Telegram: `ciao` → chat veloce, streaming text_delta visibile
3. Telegram: domanda con thinking lungo → vedi heartbeat "Sto pensando..."
4. Telegram: `devo redigere un POS per cantiere X` → vedi "Avvio elaborazione lunga", poi heartbeat ogni 5-10s, poi documento
5. Verifica dashboard Trigger.dev: il task appare, mostra step, log, durata
6. Test fallimento: simula Anthropic down → verifica che Trigger.dev faccia retry, poi notifica errore Telegram

**Definition of done:**
- Telegram risponde a "ciao" in <10 secondi con messaggio reale (non solo placeholder)
- Telegram esegue "redigi un POS" e completa con URL documento entro 30 minuti
- Dashboard Trigger.dev mostra il task come `completed`
- Log Vercel mostrano "MODEL TG: ..." dopo ogni richiesta (fix logging)
- Nessun timeout silenzioso

## Rischi e mitigazioni

| Rischio | Probabilità | Mitigazione |
|---------|-------------|-------------|
| Trigger.dev SDK non compatibile con Next.js 16 | Bassa | Verifica preventiva nei docs ufficiali; in fallback uso Inngest (drop-in alternative) |
| Free tier Trigger.dev insufficiente | Bassa | 10k run/mese; se serve, upgrade a $20/mese |
| Trigger.dev down → degrado servizio | Bassa | Fallback in-process per task brevi (già implementato), accept rischio per task molto lunghi |
| Classificazione "veloce vs lungo" sbaglia | Media | Comando manuale `/long` per forzare task durable; raffinare regole nel tempo |
| Costo extra Anthropic per task lunghi | Media | Già normale; thinking budget ridotto a 8k aiuta; `maxTokens` configurabile per task |
| Migrazione storia conversazione tra contesti | Bassa | Conversazione su Supabase, accessibile da entrambi i contesti |

## Stima tempi

- Setup Trigger.dev account + SDK: 1h
- Fix `claude.ts` (thinking_delta + budget): 2h
- Implementazione `task-classifier.ts`: 1h
- Refactor `route.ts` per dispatch: 2h
- Definizione `cervelloneLongTask`: 2h
- Helper Telegram per heartbeat: 1h
- Testing locale: 2h
- Deploy + smoke test produzione: 1h

**Totale stimato: 12h di lavoro effettivo, distribuibili in 2-3 giorni.**

## File toccati

| File | Tipo modifica |
|------|---------------|
| `src/lib/claude.ts` | edit — fix thinking_delta + budget |
| `src/app/api/telegram/route.ts` | edit — classificazione + dispatch |
| `src/lib/telegram-helpers.ts` | edit — `sendHeartbeatToTelegram` helper |
| `src/lib/task-classifier.ts` | nuovo |
| `trigger.config.ts` | nuovo |
| `trigger/cervellone-long-task.ts` | nuovo |
| `package.json` | edit — aggiungi `@trigger.dev/sdk` |
| `.env.local` + Vercel env | edit — `TRIGGER_API_KEY`, `TRIGGER_PROJECT_REF` |

## Riferimenti

- Memoria architettura target: `memory/cervellone-architettura-target.md`
- Spec V10 precedente: `docs/superpowers/specs/2026-04-18-cervellone-v10-skill-modulari.md`
- Documentazione Trigger.dev v3: https://trigger.dev/docs/v3
- Vercel `waitUntil()` reference: https://vercel.com/docs/functions/functions-api-reference#waituntil
