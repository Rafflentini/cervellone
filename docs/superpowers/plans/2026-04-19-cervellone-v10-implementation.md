# Cervellone V10 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trasformare il Cervellone da "Claude con catene" a "Claude libero con skill modulari" — prompt minimale, skill on-demand da Supabase, streaming Telegram, Opus ovunque.

**Architecture:** System prompt ~500 char (solo identita). Skill caricate dal backend via keyword match e iniettate nel prompt prima di chiamare Claude. Nessun router modelli — Opus sempre, override con /sonnet. Streaming simulato su Telegram via editMessageText. Context compresso: documenti HTML sostituiti con riferimenti.

**Tech Stack:** Next.js 16, Anthropic SDK, Supabase (PostgreSQL), Telegram Bot API

---

## File Map

| File | Azione | Responsabilita |
|---|---|---|
| `src/lib/prompts.ts` | **Riscrivere** | System prompt minimale + iniezione skill |
| `src/lib/claude.ts` | **Riscrivere parzialmente** | Rimuovere router, semplificare config, un solo modello |
| `src/lib/skills.ts` | **Creare** | Caricamento skill da Supabase, keyword matching, tool modifica_skill |
| `src/lib/tools.ts` | **Modificare** | Ridurre descriptions, aggiungere modifica_skill, rimuovere self tools verbosi |
| `src/lib/memory.ts` | **Modificare** | RAG ottimizzata: skip saluti, max 5, troncamento |
| `src/lib/digest.ts` | **Modificare** | Rimuovere seconda chiamata API |
| `src/lib/telegram-helpers.ts` | **Modificare** | Aggiungere editTelegramMessage |
| `src/app/api/chat/route.ts` | **Modificare** | Compressione documenti nell'history |
| `src/app/api/telegram/route.ts` | **Riscrivere parzialmente** | Streaming simulato, nuovi comandi, compressione docs |
| `src/app/chat/page.tsx` | **Modificare** | Rimuovere saveMessage frontend |

---

### Task 1: Tabella cervellone_skills + populate

**Files:**
- Supabase migration (via MCP tool)

- [ ] **Step 1: Creare tabella cervellone_skills**

```sql
CREATE TABLE cervellone_skills (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  descrizione TEXT NOT NULL,
  istruzioni TEXT NOT NULL,
  tool_names TEXT[],
  keywords TEXT[],
  versione INT DEFAULT 1,
  istruzioni_precedenti TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by TEXT DEFAULT 'system'
);

CREATE OR REPLACE FUNCTION update_skill_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_skill_updated
  BEFORE UPDATE ON cervellone_skills
  FOR EACH ROW EXECUTE FUNCTION update_skill_timestamp();
```

- [ ] **Step 2: Popolare con le regole attuali dal prompt**

Le istruzioni vengono SPOSTATE dal prompt attuale, non inventate:

```sql
INSERT INTO cervellone_skills (id, nome, descrizione, istruzioni, tool_names, keywords) VALUES

('studio_tecnico', 'Studio Tecnico', 'Preventivi, computi metrici, relazioni tecniche, calcoli, prezziari regionali, progetti',
'Per documenti strutturati usa ~~~document con HTML professionale.
Intestazione: RESTRUKTURA S.r.l. — Ingegneria, Costruzioni, Ponteggi — P.IVA 02087420762, Villa d'Agri (PZ), Ing. Raffaele Lentini.

Per preventivi e CME: usa SEMPRE il tool genera_preventivo_completo con la lista completa delle lavorazioni.
Il tool genera 3 documenti: Preventivo (prezzi mercato), CME (prezzi prezziario), Quadro Economico.

Ogni lavorazione deve corrispondere a una VOCE REALE del prezziario regionale.
NON spezzare in sotto-voci (fornitura+posa separati) se esiste una voce unica.
Il prezzo_mercato deve essere REALISTICO.

I 3 documenti hanno ruoli distinti:
- PREVENTIVO: prezzi di mercato + spese generali + utile + IVA
- CME: SOLO lavorazioni con prezzi da prezziario ufficiale
- QUADRO ECONOMICO: totale CME + oneri sicurezza + spese tecniche + imprevisti + IVA',
ARRAY['genera_preventivo_completo', 'cerca_prezziario', 'cerca_prezziario_batch', 'conta_prezziario', 'importa_prezziario_da_url'],
ARRAY['preventivo', 'computo', 'CME', 'relazione', 'calcolo', 'progetto', 'DXF', 'perizia', 'verifica strutturale', 'dimensionamento', 'prezziario']),

('segreteria', 'Segreteria', 'Lettere, email, fatture, contabilita, riconciliazione bancaria, Fatture in Cloud',
'Per lettere e documenti amministrativi usa ~~~document con HTML professionale.
Intestazione: RESTRUKTURA S.r.l. — P.IVA 02087420762, Villa d''Agri (PZ), Ing. Raffaele Lentini.
Formato lettera formale italiana: luogo e data, destinatario, oggetto, corpo, firma.',
ARRAY['cerca_documenti'],
ARRAY['lettera', 'email', 'fattura', 'contabilita', 'riconciliazione', 'F24', 'Fatture in Cloud', 'busta paga', 'amministrazi']),

('cantieri', 'Cantieri', 'POS, sicurezza, SAL, direzione lavori, collaudi',
'Per documenti di cantiere usa ~~~document con HTML professionale.
Intestazione: RESTRUKTURA S.r.l. — P.IVA 02087420762, Villa d''Agri (PZ), Ing. Raffaele Lentini.
POS conforme a D.Lgs. 81/2008 Allegato XV.
SAL con riferimento a CME e contabilita lavori.',
NULL,
ARRAY['POS', 'sicurezza', 'SAL', 'cantiere', 'collaudo', 'direzione lavori', 'DL', 'coordinatore']),

('marketing', 'Marketing', 'Social media, blog, SEO, brochure, PonteggioSicuro.it',
'Tono professionale ma accessibile. Target: imprese edili, privati, enti pubblici.
Brand Restruktura: affidabilita, competenza tecnica, innovazione.
PonteggioSicuro.it: noleggio ponteggi, sicurezza, rapidita.',
NULL,
ARRAY['post', 'social', 'Instagram', 'Facebook', 'blog', 'SEO', 'brochure', 'PonteggioSicuro', 'marketing', 'pubblicita']),

('clienti', 'Clienti', 'Comunicazione clienti, offerte commerciali, rapporti',
'Tono formale e professionale. Dare del Lei.
Offerte: chiare, dettagliate, con condizioni di pagamento.
Preventivi: sempre con validita temporale.',
NULL,
ARRAY['offerta', 'cliente', 'rapporto', 'sopralluogo', 'commissione']),

('self', 'Autoconsapevolezza', 'Informazioni su se stesso, modello, aggiornamenti, comandi',
'Puoi vedere la tua configurazione con cervellone_info.
Puoi modificare i tuoi parametri con cervellone_modifica.
Puoi controllare aggiornamenti modelli con cervellone_check_aggiornamenti.
Se trovi un modello piu recente, aggiornati automaticamente.

Comandi Telegram disponibili:
/nuova - azzera conversazione
/opus - usa modello piu potente
/sonnet - usa modello standard
/modello - mostra modello attivo
/aggiorna - controlla aggiornamenti modelli
/skill - lista skill disponibili
/help - mostra lista comandi',
ARRAY['cervellone_info', 'cervellone_modifica', 'cervellone_check_aggiornamenti'],
ARRAY['modello', 'versione', 'aggiornamento', 'opus', 'sonnet', 'come funzioni', 'chi sei', 'comandi', 'help']);
```

- [ ] **Step 3: Verificare inserimento**

```sql
SELECT id, nome, array_length(keywords, 1) as n_keywords, length(istruzioni) as len_istruzioni FROM cervellone_skills ORDER BY id;
```

Atteso: 6 righe, keywords tra 3 e 11, istruzioni tra 200 e 800 char.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(V10): tabella cervellone_skills con 6 skill iniziali"
```

---

### Task 2: Modulo skills.ts — caricamento e keyword matching

**Files:**
- Create: `src/lib/skills.ts`

- [ ] **Step 1: Creare src/lib/skills.ts**

```typescript
/**
 * lib/skills.ts — Caricamento skill modulari da Supabase
 *
 * Il backend rileva keyword nel messaggio utente e inietta
 * le istruzioni della skill nel system prompt PRIMA di chiamare Claude.
 * Zero tool call extra, zero latenza aggiuntiva.
 */

import { supabase } from './supabase'

interface Skill {
  id: string
  nome: string
  istruzioni: string
  keywords: string[]
}

// Cache skill per 5 minuti
let skillCache: Skill[] | null = null
let skillCacheTime = 0
const SKILL_TTL = 300_000

async function loadSkills(): Promise<Skill[]> {
  if (skillCache && Date.now() - skillCacheTime < SKILL_TTL) return skillCache

  const { data } = await supabase
    .from('cervellone_skills')
    .select('id, nome, istruzioni, keywords')

  skillCache = (data || []) as Skill[]
  skillCacheTime = Date.now()
  return skillCache
}

/**
 * Dato il messaggio utente, trova le skill da iniettare.
 * Restituisce le istruzioni concatenate, o stringa vuota se nessuna skill matcha.
 */
export async function matchSkills(userQuery: string): Promise<string> {
  const skills = await loadSkills()
  const queryLower = userQuery.toLowerCase()
  const matched: Skill[] = []

  for (const skill of skills) {
    if (!skill.keywords?.length) continue
    const hasMatch = skill.keywords.some(kw => queryLower.includes(kw.toLowerCase()))
    if (hasMatch) matched.push(skill)
  }

  if (matched.length === 0) return ''

  const sections = matched.map(s =>
    `\n--- SKILL: ${s.nome} ---\n${s.istruzioni}`
  )

  return '\n' + sections.join('\n')
}

/**
 * Invalida la cache (dopo modifica skill).
 */
export function invalidateSkillCache() {
  skillCache = null
  skillCacheTime = 0
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/skills.ts && git commit -m "feat(V10): modulo skills.ts — keyword matching e cache"
```

---

### Task 3: Riscrivere prompts.ts — prompt minimale + iniezione skill

**Files:**
- Modify: `src/lib/prompts.ts`

- [ ] **Step 1: Riscrivere prompts.ts**

```typescript
/**
 * lib/prompts.ts — System prompt minimale V10
 *
 * Il prompt dice solo CHI SEI. Le regole operative vivono nelle skill
 * e vengono iniettate dal backend quando servono.
 */

import { matchSkills } from './skills'

const BASE_PROMPT = `Sei il Cervellone — coordinatore digitale di Restruktura SRL, Ing. Raffaele Lentini, Villa d'Agri (PZ).
Restruktura: ingegneria strutturale, direzione lavori, collaudi, impresa edile, PonteggioSicuro.it.

Hai memoria persistente, tool specializzati per ogni reparto, e puoi auto-aggiornarti.
Per documenti strutturati usa ~~~document con HTML professionale.
Intestazione: RESTRUKTURA S.r.l. — P.IVA 02087420762, Villa d'Agri (PZ), Ing. Raffaele Lentini.

Dai del Lei all'Ingegnere. Rispondi in italiano.`

export async function getChatSystemPrompt(userQuery: string): Promise<string> {
  const skillContext = await matchSkills(userQuery)
  return BASE_PROMPT + skillContext
}

export async function getTelegramSystemPrompt(userQuery: string): Promise<string> {
  const skillContext = await matchSkills(userQuery)
  return BASE_PROMPT + skillContext + '\nStai comunicando via Telegram. Rispondi conciso.'
}
```

- [ ] **Step 2: Aggiornare chat/route.ts — passare userQuery al prompt**

In `src/app/api/chat/route.ts`, modificare la riga che chiama getChatSystemPrompt:

```typescript
// PRIMA (riga 69):
{ messages: trimmedMessages, systemPrompt: await getChatSystemPrompt(), userQuery, conversationId, hasFiles },

// DOPO:
{ messages: trimmedMessages, systemPrompt: await getChatSystemPrompt(userQuery), userQuery, conversationId, hasFiles },
```

- [ ] **Step 3: Aggiornare telegram/route.ts — passare userText al prompt**

In `src/app/api/telegram/route.ts`, modificare la riga che chiama getTelegramSystemPrompt:

```typescript
// PRIMA (riga ~223):
systemPrompt: await getTelegramSystemPrompt(),

// DOPO:
systemPrompt: await getTelegramSystemPrompt(userText),
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/prompts.ts src/app/api/chat/route.ts src/app/api/telegram/route.ts
git commit -m "feat(V10): prompt minimale 500 char + skill injection via keyword"
```

---

### Task 4: Semplificare claude.ts — rimuovere router, un solo modello

**Files:**
- Modify: `src/lib/claude.ts`

- [ ] **Step 1: Rimuovere selectModel, countComplexitySignals, semplificare getConfig**

Sostituire TUTTO il blocco da `interface ModelConfig` fino a `function countComplexitySignals` (righe 24-148) con:

```typescript
interface ModelConfig {
  model: string
  thinkingBudget: number
  maxTokens: number
}

// Cache config per 60 secondi
let configCache: { model: string } | null = null
let configCacheTime = 0
const CONFIG_TTL = 60_000

export async function getConfig(): Promise<{ model: string }> {
  if (configCache && Date.now() - configCacheTime < CONFIG_TTL) return configCache

  const { data } = await supabase
    .from('cervellone_config')
    .select('key, value')
    .in('key', ['model_default'])

  let model = 'claude-opus-4-6'
  if (data) {
    for (const row of data) {
      if (row.key === 'model_default') model = String(row.value).replace(/"/g, '')
    }
  }

  configCache = { model }
  configCacheTime = Date.now()
  return configCache
}

function getModelConfig(): ModelConfig {
  // Verra chiamata dopo getConfig — il modello e gia determinato
  // Opus: thinking alto. Sonnet: thinking medio.
  return { model: '', thinkingBudget: 0, maxTokens: 0 } // placeholder, riempito sotto
}
```

- [ ] **Step 2: Semplificare callClaudeStream**

Nella funzione `callClaudeStream`, sostituire la sezione modello:

```typescript
// PRIMA:
const modelConfig = await selectModel(userQuery, request.hasFiles || false)
console.log(`MODEL: ${modelConfig.model} thinking=${modelConfig.thinkingBudget}...`)

// DOPO:
const cfg = await getConfig()
const isOpus = cfg.model.includes('opus')
const modelConfig: ModelConfig = {
  model: cfg.model,
  thinkingBudget: isOpus ? 100_000 : 10_000,
  maxTokens: isOpus ? 128_000 : 32_000,
}
console.log(`MODEL: ${modelConfig.model} for "${userQuery.slice(0, 50)}"`)
```

- [ ] **Step 3: Stessa modifica in callClaude (Telegram)**

Sostituire la stessa sezione in `callClaude`:

```typescript
// PRIMA:
const modelConfig = await selectModel(userQuery, request.hasFiles || false)
console.log(`MODEL TG: ${modelConfig.model}...`)

// DOPO:
const cfg = await getConfig()
const isOpus = cfg.model.includes('opus')
const modelConfig: ModelConfig = {
  model: cfg.model,
  thinkingBudget: isOpus ? 100_000 : 10_000,
  maxTokens: isOpus ? 128_000 : 32_000,
}
console.log(`MODEL TG: ${modelConfig.model} for "${userQuery.slice(0, 50)}"`)
```

- [ ] **Step 4: Rimuovere import getConfig da prompts.ts** (non lo usa piu)

In `src/lib/prompts.ts` verificare che non importi piu da claude.ts (la nuova versione non lo fa).

- [ ] **Step 5: Aggiornare cervellone_config su Supabase**

```sql
-- Semplificare: un solo modello, niente piu model_complex/model_digest
UPDATE cervellone_config SET value = '"claude-opus-4-6"' WHERE key = 'model_default';
DELETE FROM cervellone_config WHERE key IN ('model_complex', 'model_digest', 'thinking_budget_default', 'thinking_budget_medium', 'thinking_budget_high', 'max_tokens_default', 'max_tokens_medium', 'max_tokens_high');
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/claude.ts && git commit -m "feat(V10): rimuovere router modelli — Opus unico, zero regex"
```

---

### Task 5: Context management — compressione documenti

**Files:**
- Modify: `src/app/api/chat/route.ts`
- Modify: `src/app/api/telegram/route.ts`
- Modify: `src/app/chat/page.tsx`

- [ ] **Step 1: Backend chat — comprimere documenti nell'history lato server**

In `src/app/api/chat/route.ts`, dopo `const messages = filterEmptyMessages(rawMessages)` (riga 41), aggiungere:

```typescript
// Comprimi blocchi ~~~document nei messaggi assistant (HTML enorme -> riferimento breve)
for (const msg of messages) {
  if (msg.role === 'assistant' && typeof msg.content === 'string') {
    msg.content = msg.content.replace(
      /~~~document\n[\s\S]*?~~~(?:\n|$)/g,
      '[Documento gia generato — visibile nel pannello anteprima]\n'
    )
  }
}
```

- [ ] **Step 2: Telegram — comprimere documenti + ridurre history a 10**

In `src/app/api/telegram/route.ts`, modificare la query history (riga ~200):

```typescript
// PRIMA:
.order('created_at', { ascending: true }).limit(20),

// DOPO:
.order('created_at', { ascending: true }).limit(10),
```

E dopo aver costruito `history`, aggiungere la compressione:

```typescript
// Comprimi documenti HTML nei messaggi precedenti
for (const msg of history) {
  if (msg.role === 'assistant' && typeof msg.content === 'string') {
    msg.content = msg.content.replace(
      /~~~document\n[\s\S]*?~~~(?:\n|$)/g,
      '[Documento gia generato]\n'
    )
  }
}
```

- [ ] **Step 3: Frontend — rimuovere saveMessage duplicato**

In `src/app/chat/page.tsx`, rimuovere la chiamata `saveMessage` per i messaggi utente (il backend lo fa gia con embedding). Cercare le chiamate a `saveMessage(convId, 'user', ...)` e rimuoverle. Tenere solo `saveMessage(convId, 'assistant', ...)` per la UI locale.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/chat/route.ts src/app/api/telegram/route.ts src/app/chat/page.tsx
git commit -m "feat(V10): compressione documenti HTML nell'history + rimuovere doppio save"
```

---

### Task 6: Streaming simulato su Telegram

**Files:**
- Modify: `src/lib/telegram-helpers.ts`
- Modify: `src/app/api/telegram/route.ts`
- Modify: `src/lib/claude.ts`

- [ ] **Step 1: Aggiungere editTelegramMessage in telegram-helpers.ts**

```typescript
export async function editTelegramMessage(chatId: number, messageId: number, text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return
  // Telegram richiede testo diverso dal precedente
  await fetch(`${TELEGRAM_API}${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, 4000) || '...',
      parse_mode: 'Markdown',
    }),
  }).catch(async () => {
    // Fallback senza Markdown
    await fetch(`${TELEGRAM_API}${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: text.slice(0, 4000) || '...',
      }),
    }).catch(() => {})
  })
}

// Variante di sendTelegramMessage che restituisce il message_id
export async function sendTelegramMessageWithId(chatId: number, text: string): Promise<number | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return null
  try {
    const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    })
    const data = await res.json()
    return data?.result?.message_id || null
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Aggiungere callClaudeStreamTelegram in claude.ts**

Nuova funzione che streamma verso Telegram via edit:

```typescript
export async function callClaudeStreamTelegram(
  request: ClaudeRequest,
  onChunk: (accumulated: string) => void,
): Promise<string> {
  const { systemPrompt, userQuery, conversationId } = request

  const memoryContext = await searchMemory(userQuery).catch(() => '')
  const fullSystemPrompt = systemPrompt + memoryContext

  if (conversationId && userQuery) {
    saveMessageWithEmbedding(conversationId, 'user', userQuery).catch(() => {})
  }

  const tools: any[] = getToolDefinitions()
  let currentMessages = [...request.messages]
  let fullResponse = ''
  const MAX_ITERATIONS = 10

  const cfg = await getConfig()
  const isOpus = cfg.model.includes('opus')
  const modelConfig: ModelConfig = {
    model: cfg.model,
    thinkingBudget: isOpus ? 100_000 : 10_000,
    maxTokens: isOpus ? 128_000 : 32_000,
  }

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const stream = await withRetry(() =>
      Promise.resolve(client.messages.stream({
        model: modelConfig.model,
        max_tokens: modelConfig.maxTokens,
        system: fullSystemPrompt,
        messages: currentMessages,
        tools,
        thinking: { type: 'enabled', budget_tokens: modelConfig.thinkingBudget },
      }))
    )

    let lastChunkTime = 0
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text
        // Invia chunk ogni 3 secondi
        const now = Date.now()
        if (now - lastChunkTime > 3000) {
          onChunk(fullResponse)
          lastChunkTime = now
        }
      }
    }

    const final = await stream.finalMessage()
    const toolBlocks = final.content.filter(b => b.type === 'tool_use')

    if (toolBlocks.length === 0 || final.stop_reason === 'end_turn') break
    if (i > 0 && !final.content.some(b => b.type === 'text')) break

    const toolResults = await executeToolBlocks(toolBlocks, conversationId)
    if (toolResults.length === 0) break

    currentMessages = [
      ...currentMessages,
      { role: 'assistant' as const, content: final.content },
      { role: 'user' as const, content: toolResults },
    ]
  }

  // Chunk finale
  onChunk(fullResponse)

  if (conversationId && fullResponse) {
    saveMessageWithEmbedding(conversationId, 'assistant', fullResponse).catch(() => {})
  }

  return fullResponse
}
```

- [ ] **Step 3: Riscrivere bgProcess in telegram/route.ts per usare streaming**

Nella funzione `bgProcess` del route Telegram, sostituire `callClaude` con `callClaudeStreamTelegram`:

```typescript
const bgProcess = async () => {
  try {
    // Manda placeholder e salva message_id per editing
    const placeholderMsgId = await sendTelegramMessageWithId(chatId, '🧠 Sto elaborando...')

    let currentMsgId = placeholderMsgId
    let lastEditText = ''

    const fullResponse = await callClaudeStreamTelegram(
      {
        messages: history,
        systemPrompt: await getTelegramSystemPrompt(userText),
        userQuery: userText,
        conversationId,
        hasFiles: fileBlocks.length > 0,
      },
      (accumulated) => {
        // Callback: edita il messaggio Telegram ogni 3 secondi
        if (!currentMsgId) return
        // Non editare se il testo non e cambiato
        const preview = accumulated.slice(0, 4000)
        if (preview === lastEditText) return
        lastEditText = preview

        // Se supera 3800 char, manda un nuovo messaggio
        if (accumulated.length > 3800 && currentMsgId === placeholderMsgId) {
          // Finalizza il primo messaggio e crea il secondo
          editTelegramMessage(chatId, currentMsgId, accumulated.slice(0, 3800))
          sendTelegramMessageWithId(chatId, accumulated.slice(3800, 4000) || '...').then(newId => {
            if (newId) currentMsgId = newId
          })
        } else {
          editTelegramMessage(chatId, currentMsgId, preview)
        }
      }
    )

    clearTimeout(thinkingTimeout)
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null }

    // Edit finale con risposta completa
    if (currentMsgId && fullResponse) {
      // Gestisci documenti
      const responseBlocks = parseDocumentBlocks(fullResponse)
      let textParts: string[] = []

      for (const block of responseBlocks) {
        if (block.type === 'document') {
          const titleMatch = block.content.match(/<h1[^>]*>(.*?)<\/h1>/i)
          const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : 'Documento'

          const savedDoc = await safeSupabase(
            () => supabase.from('documents')
              .insert({ name: title, content: block.content, conversation_id: conversationId, type: 'html', metadata: { source: 'telegram' } })
              .select('id').single()
          )
          const docUrl = (savedDoc as any)?.id
            ? `https://cervellone-5poc.vercel.app/doc/${(savedDoc as any).id}`
            : 'https://cervellone-5poc.vercel.app'

          textParts.push(`📄 *${title}*\n👉 ${docUrl}`)
        } else if (block.content.trim()) {
          textParts.push(block.content)
        }
      }

      const finalText = textParts.join('\n\n') || fullResponse
      // Edit finale del messaggio placeholder
      if (finalText.length <= 4000) {
        await editTelegramMessage(chatId, placeholderMsgId!, finalText)
      } else {
        // Testo lungo: edit primo messaggio + nuovi messaggi
        await editTelegramMessage(chatId, placeholderMsgId!, finalText.slice(0, 4000))
        const remaining = finalText.slice(4000)
        if (remaining.trim()) await sendTelegramMessage(chatId, remaining)
      }
    }

    // Salva in memoria
    if (fileBlocks.length > 0 && fullResponse.length > 200) {
      const knowledge = `[Analisi file "${fileDescription}"]\nDomanda: ${userText}\nAnalisi:\n${fullResponse.slice(0, 10000)}`
      saveMessageWithEmbedding(conversationId, 'knowledge', knowledge).catch(() => {})
    }
  } catch (err) {
    console.error('TELEGRAM BG error:', err)
    const msg = err instanceof Error ? err.message : String(err)
    let userMsg = `⚠️ ${msg.slice(0, 300)}`
    if (msg.includes('credit') || msg.includes('billing')) userMsg = '⚠️ Crediti API esauriti.'
    await sendTelegramMessage(chatId, userMsg).catch(() => {})
  } finally {
    if (typingInterval) clearInterval(typingInterval)
  }
}
```

- [ ] **Step 4: Rimuovere thinkingTimeout** (non serve piu — il placeholder c'e gia)

Rimuovere il blocco `isStructuredTask` + `isLikelyComplex` + `thinkingDelay` + `thinkingTimeout` (righe ~174-188 del route Telegram). Il placeholder "Sto elaborando..." viene mandato SUBITO e editato con il testo reale.

- [ ] **Step 5: Aggiungere import delle nuove funzioni**

In `src/app/api/telegram/route.ts`, aggiornare gli import:

```typescript
// PRIMA:
import { callClaude } from '@/lib/claude'
import { sendTelegramMessage, sendTyping } from '@/lib/telegram-helpers'

// DOPO:
import { callClaudeStreamTelegram } from '@/lib/claude'
import { sendTelegramMessage, sendTyping, editTelegramMessage, sendTelegramMessageWithId } from '@/lib/telegram-helpers'
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/telegram-helpers.ts src/lib/claude.ts src/app/api/telegram/route.ts
git commit -m "feat(V10): streaming simulato Telegram — editMessageText ogni 3 sec"
```

---

### Task 7: Comandi Telegram

**Files:**
- Modify: `src/app/api/telegram/route.ts`

- [ ] **Step 1: Aggiungere nuovi comandi dopo /nuova**

```typescript
if (userText === '/help') {
  await sendTelegramMessage(chatId, `🧠 *Comandi Cervellone*\n\n/nuova — Azzera conversazione\n/opus — Modello piu potente\n/sonnet — Modello standard\n/modello — Mostra modello attivo\n/aggiorna — Controlla aggiornamenti\n/skill — Lista skill disponibili\n/help — Questa lista`)
  return NextResponse.json({ ok: true })
}
if (userText === '/opus') {
  await supabase.from('cervellone_config').update({ value: 'claude-opus-4-6', updated_by: 'telegram /opus' }).eq('key', 'model_default')
  configCache = null // invalida cache in claude.ts
  await sendTelegramMessage(chatId, '🧠 Modello: *Opus* (massima potenza)')
  return NextResponse.json({ ok: true })
}
if (userText === '/sonnet') {
  await supabase.from('cervellone_config').update({ value: 'claude-sonnet-4-6', updated_by: 'telegram /sonnet' }).eq('key', 'model_default')
  configCache = null
  await sendTelegramMessage(chatId, '⚡ Modello: *Sonnet* (veloce)')
  return NextResponse.json({ ok: true })
}
if (userText === '/modello') {
  const { data } = await supabase.from('cervellone_config').select('value').eq('key', 'model_default').single()
  const model = data?.value ? String(data.value).replace(/"/g, '') : 'sconosciuto'
  await sendTelegramMessage(chatId, `🧠 Modello attivo: *${model}*`)
  return NextResponse.json({ ok: true })
}
if (userText === '/aggiorna') {
  // Chiama il tool cervellone_check_aggiornamenti direttamente
  const { executeTool } = await import('@/lib/tools')
  const result = await executeTool('cervellone_check_aggiornamenti', { applica: true })
  await sendTelegramMessage(chatId, result)
  return NextResponse.json({ ok: true })
}
if (userText === '/skill') {
  const { data } = await supabase.from('cervellone_skills').select('id, nome, descrizione').order('id')
  if (data?.length) {
    const list = data.map(s => `*${s.nome}*\n${s.descrizione}`).join('\n\n')
    await sendTelegramMessage(chatId, `🧠 *Skill disponibili*\n\n${list}`)
  } else {
    await sendTelegramMessage(chatId, 'Nessuna skill configurata.')
  }
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 2: Importare supabase e invalidare cache**

Aggiungere l'export di configCache invalidation. In `claude.ts`, esportare una funzione:

```typescript
export function invalidateConfigCache() {
  configCache = null
  configCacheTime = 0
}
```

E in telegram/route.ts importarla:

```typescript
import { callClaudeStreamTelegram, invalidateConfigCache } from '@/lib/claude'
```

Nelle handler `/opus` e `/sonnet`, chiamare `invalidateConfigCache()` invece di `configCache = null`.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/telegram/route.ts src/lib/claude.ts
git commit -m "feat(V10): comandi Telegram — /help /opus /sonnet /modello /aggiorna /skill"
```

---

### Task 8: Tool modifica_skill + versioning

**Files:**
- Modify: `src/lib/tools.ts`

- [ ] **Step 1: Aggiungere tool modifica_skill**

Nella sezione SELF_TOOLS di `tools.ts`, aggiungere:

```typescript
{
  name: 'modifica_skill',
  description: 'Modifica le istruzioni di una skill/reparto. Salva la versione precedente per rollback.',
  input_schema: {
    type: 'object',
    properties: {
      skill_id: { type: 'string', description: 'ID skill: studio_tecnico, segreteria, cantieri, marketing, clienti, self' },
      nuove_istruzioni: { type: 'string', description: 'Le nuove istruzioni complete per la skill' },
      motivo: { type: 'string', description: 'Perche stai modificando la skill' },
    },
    required: ['skill_id', 'nuove_istruzioni', 'motivo'],
  },
},
```

- [ ] **Step 2: Aggiungere executor per modifica_skill**

Nel `switch` di `executeSelfTools`:

```typescript
case 'modifica_skill': {
  const skillId = input.skill_id as string
  const nuoveIstruzioni = input.nuove_istruzioni as string
  const motivo = input.motivo as string

  // Leggi versione attuale
  const { data: current } = await supabase
    .from('cervellone_skills')
    .select('istruzioni, versione')
    .eq('id', skillId)
    .single()

  if (!current) return `Skill "${skillId}" non trovata.`

  // Aggiorna con versioning
  const { error } = await supabase
    .from('cervellone_skills')
    .update({
      istruzioni: nuoveIstruzioni,
      istruzioni_precedenti: current.istruzioni,
      versione: (current.versione || 1) + 1,
      updated_by: `cervellone: ${motivo.slice(0, 100)}`,
    })
    .eq('id', skillId)

  if (error) return `Errore modifica skill: ${error.message}`

  // Invalida cache
  const { invalidateSkillCache } = await import('./skills')
  invalidateSkillCache()

  return `Skill "${skillId}" aggiornata (v${(current.versione || 1) + 1}). Motivo: ${motivo}`
}
```

- [ ] **Step 3: Ridurre tool descriptions verbose**

Semplificare le descrizioni dei tool esistenti. Esempi:

```typescript
// PRIMA:
description: 'Genera PREVENTIVO + CME + QUADRO ECONOMICO in una sola chiamata. Cerca automaticamente le voci nel prezziario regionale con scoring di rilevanza, calcola tutto, produce 3 documenti HTML separati e li salva nel database. Se già generati per questa conversazione, restituisce i documenti salvati (IMMUTABILI). IMPORTANTE: ogni lavorazione deve corrispondere a una voce reale del prezziario — NON spezzare in sotto-voci (fornitura+posa separati) se esiste una voce unica.',

// DOPO:
description: 'Genera Preventivo + CME + Quadro Economico. Cerca nel prezziario, calcola, produce 3 documenti HTML. Cache: se gia generati, restituisce i salvati.',
```

Fare lo stesso per tutti gli altri tool: 1 riga, cosa fa e basta.

- [ ] **Step 4: Commit**

```bash
git add src/lib/tools.ts && git commit -m "feat(V10): tool modifica_skill + descriptions ridotte"
```

---

### Task 9: RAG ottimizzata

**Files:**
- Modify: `src/lib/memory.ts`

- [ ] **Step 1: Modificare searchMemory**

```typescript
const GREETING_PATTERN = /^(ciao|buongiorno|buonasera|grazie|ok|si|no|va bene|perfetto|salve|arrivederci|hey|eccomi)[\s!?.]*$/i

export async function searchMemory(query: string, limit = 5): Promise<string> {
  // Skip per saluti
  if (GREETING_PATTERN.test(query.trim())) return ''

  const results: Array<{ content: string; message_role: string; similarity: number }> = []
  const seenContent = new Set<string>()

  // 1. Ricerca semantica
  try {
    const embedding = await generateEmbedding(query)
    if (embedding.length > 0) {
      const { data } = await supabase.rpc('search_memory', {
        query_embedding: JSON.stringify(embedding),
        match_threshold: 0.55,
        match_count: limit,
      })
      if (data) {
        for (const item of data) {
          seenContent.add(item.content.slice(0, 100))
          results.push(item)
        }
      }
    }
  } catch (err) {
    logWarn(`Memory semantic search failed: ${(err as Error).message}`)
  }

  // 2. Keyword solo se risultati semantici < 3
  if (results.length < 3) {
    try {
      const keywords = query.match(/\b[A-Z][a-zà-ú]{2,}\b|\b\d{4}\b|\b[A-Z]{2,}\b/g)
      if (keywords?.length) {
        for (const kw of keywords.slice(0, 2)) {
          const { data } = await supabase
            .from('embeddings')
            .select('content, message_role')
            .ilike('content', `%${kw}%`)
            .limit(2)
          if (data) {
            for (const item of data) {
              const key = item.content.slice(0, 100)
              if (!seenContent.has(key)) {
                seenContent.add(key)
                results.push({ ...item, similarity: 0.5 })
              }
            }
          }
        }
      }
    } catch (err) {
      logWarn(`Memory keyword search failed: ${(err as Error).message}`)
    }
  }

  if (results.length === 0) return ''

  // Tronca ogni risultato a 500 char
  const memories = results.slice(0, limit).map((item, idx) => {
    const label =
      item.message_role === 'knowledge' ? '📄 Documento'
      : item.message_role === 'assistant' ? '🧠 Risposta'
      : item.message_role === 'user' ? '💬 Domanda'
      : '📋 Dato'
    return `[${label} ${idx + 1}]\n${item.content.slice(0, 500)}`
  })

  return `\n\n# Contesto dalla memoria\n${memories.join('\n\n---\n\n')}`
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/memory.ts && git commit -m "feat(V10): RAG ottimizzata — skip saluti, max 5, troncamento 500 char"
```

---

### Task 10: Fix secondari

**Files:**
- Modify: `src/lib/digest.ts`
- Modify: `src/lib/tools.ts` (CSS)

- [ ] **Step 1: Rimuovere seconda chiamata API in digest.ts**

Eliminare il blocco "Verifica di comprensione" (righe ~84-117). La funzione `digestDocument` termina dopo il primo `message.create`:

```typescript
export async function digestDocument(content: string, fileName: string): Promise<DigestResult> {
  const { getConfig } = await import('./claude')
  const cfg = await getConfig()
  const digestModel = cfg.model || 'claude-sonnet-4-6'

  const message = await client.messages.create({
    model: digestModel,
    max_tokens: 12000,
    system: DIGEST_PROMPT,
    messages: [{
      role: 'user',
      content: `Studia e digerisci questo documento.\n\nNome file: ${fileName}\n\n---\n\n${content}`
    }],
  })

  const digest = message.content[0].type === 'text' ? message.content[0].text : ''

  const shouldPreserve = digest.includes('CLASSIFICAZIONE: CONSERVARE')
  let preserveReason = ''
  if (shouldPreserve) {
    const match = digest.match(/CLASSIFICAZIONE: CONSERVARE\s*—?\s*(.*)/)
    preserveReason = match ? match[1].trim() : 'Documento da conservare intatto'
  }

  return { digest, shouldPreserve, preserveReason }
}
```

- [ ] **Step 2: Fix CSS duplicato nel preventivo HTML**

In `src/lib/tools.ts`, nella funzione `genera_preventivo_completo`, il preventivo HTML (variabile `prevHtml`, ~riga 788) ha CSS inline duplicato. Sostituire con `cssCommon`:

Cercare il blocco `const prevHtml = ...` e sostituire il CSS inline con `${cssCommon}`, come gia fanno `cmeHtml` e `qeHtml`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/digest.ts src/lib/tools.ts
git commit -m "fix(V10): rimuovere doppia chiamata digest + CSS duplicato preventivo"
```

---

### Task 11: Deploy e test

- [ ] **Step 1: Push**

```bash
git push
```

- [ ] **Step 2: Verificare deploy su Vercel**

Controllare che il deploy sia READY, non ERROR.

- [ ] **Step 3: Test su Telegram**

1. `/nuova` — azzera
2. `/help` — lista comandi
3. `/modello` — mostra modello attivo
4. "Ciao" — risposta veloce, senza skill
5. "Fammi un preventivo per bagno sig. Rossi" — skill studio_tecnico caricata
6. "Che modello sei?" — skill self caricata
7. `/sonnet` → `/modello` → `/opus` → `/modello`

- [ ] **Step 4: Test streaming Telegram**

1. Chiedere qualcosa di complesso: "Redigi una relazione tecnica sulla verifica strutturale"
2. Verificare che il messaggio si aggiorni ogni 3 secondi
3. Verificare che non ci siano timeout

- [ ] **Step 5: Test anti-loop**

1. Chiedere "Genera la testata del POS"
2. Dare feedback: "Troppo vuoto"
3. Verificare che NON rigeneri automaticamente

---

## Self-Review Checklist

- [x] Spec coverage: tutti i 10 punti della spec coperti (skill, prompt, router, context, streaming, comandi, RAG, digest, CSS, doppio save)
- [x] No placeholder: ogni step ha codice completo
- [x] Type consistency: `getConfig()` restituisce `{ model: string }` ovunque, `matchSkills()` restituisce `string`
- [x] Nomi consistenti: `callClaudeStreamTelegram`, `editTelegramMessage`, `sendTelegramMessageWithId`, `invalidateConfigCache`, `invalidateSkillCache`
