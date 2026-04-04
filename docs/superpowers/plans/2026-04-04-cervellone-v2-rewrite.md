# Cervellone V2 — Riscrittura Route Critiche

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Riscrivere le route Telegram e Chat eliminando TUTTA la complessità inutile, lasciando Claude essere Claude.

**Architecture:** Claude riceve file come document/image blocks (come fa claude.ai), una sola chiamata API con max 2 tool use iterations. No pdf-parse, no router Haiku, no auto-detect. System prompt ridotto a 15 righe. Unico tool custom: `calcola_preventivo`.

**Tech Stack:** Next.js 16, Anthropic SDK, Supabase, Telegram Bot API

---

### Task 1: Riscrittura `/api/telegram/route.ts`

**Files:**
- Rewrite: `src/app/api/telegram/route.ts`

**Principi:**
- PDF → document block a Claude (come claude.ai)
- Foto → image block a Claude
- Word → testo estratto con mammoth
- UNA sola chiamata Claude, max 2 iterazioni tool use
- Sempre Sonnet (veloce per Telegram)
- No thinking (troppo lento per Telegram)
- No memory search nel percorso critico (solo salvataggio asincrono)
- System prompt 10 righe
- Errori sempre comunicati all'utente

**Cosa MANTENERE dal vecchio:**
- `chatIdToUuid()` — funziona
- `sendTelegramMessage()` — funziona
- `sendTyping()` — funziona  
- `downloadTelegramFile()` — funziona
- `transcribeAudio()` — funziona
- Dedup con `telegram_dedup` — funziona
- Salvataggio documenti HTML su Supabase — funziona
- `parseDocumentBlocks()` per estrarre ~~~document — funziona

**Cosa RIMUOVERE:**
- pdf-parse server-side (lascia Claude leggere i PDF)
- Loop 6 iterazioni (max 2)
- `searchMemory()` nel percorso critico
- Tool custom (verifica/scarica/importa_prezziario, read_webpage)
- System prompt procedurale (63→10 righe)
- Auto-detect prezziario
- Router modello (sempre Sonnet)

---

### Task 2: Semplificazione `/api/chat/route.ts`

**Files:**
- Modify: `src/app/api/chat/route.ts`

**Cosa RIMUOVERE:**
- `chooseModel()` router Haiku (sempre Opus)
- `detectAndImportSkills()` auto-detect
- Auto-detect prezziario PDF
- Tool custom tranne `calcola_preventivo`
- System prompt procedurale (63→15 righe)

**Cosa MANTENERE:**
- Streaming con ReadableStream
- Context window safeguard  
- `searchMemory()` (la chat web ha tempo)
- `saveMessageWithEmbedding()` asincrono
- Salvataggio knowledge per file analizzati
- Gestione errori con messaggi operativi

**Cosa CAMBIARE:**
- Thinking SEMPRE abilitato (anche con file)
- Ridurre loop da 15 a 5 iterazioni
- System prompt corto

---

### Task 3: Semplificazione `tools.ts`

**Files:**
- Rewrite: `src/lib/tools.ts`

**Tenere SOLO:**
- `calcola_preventivo` — l'unico tool che fa qualcosa che Claude non può fare da solo

**Rimuovere:**
- `read_webpage` — Claude ha web_search built-in
- `verifica_prezziario` — inutile, Claude cerca sul web
- `scarica_prezziario` — inutile, Claude cerca sul web
- `importa_prezziario` — inutile se Claude legge i PDF direttamente

---

### Task 4: Commit, deploy e verifica

- Build locale
- Commit
- Push
- Verifica deploy READY su Vercel
- Test WebFetch su login e doc pages
