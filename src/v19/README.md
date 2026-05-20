# Cervellone V19 — Rifondazione totale

**Branch:** `v19/foundation`
**Data inizio:** 9 maggio 2026
**Stato:** in costruzione (foundation), NON usato in produzione

## Cos'è

Rifondazione totale di Cervellone (Restruktura SRL) che vive **in parallelo** a V18 (`src/lib/`).
V18 resta in produzione su `https://cervellone-5poc.vercel.app` finché V19 non sarà
verificata e l'utente non darà il via al cutover.

## Architettura

Vedi spec completa: `docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md`
Vedi plan eseguibile: `docs/superpowers/plans/2026-05-09-cervellone-v19-foundation.md`

## Struttura cartelle

- `agent/` — loop reasoning V19 (adaptive thinking, MAX_ITER 30, NO_TEXT 8, pause_turn, code_execution capture)
- `agent/orchestrator.ts` — pattern multi-agent (parent + sub-agent specialist)
- `memory/` — handler `memory_20250818` Anthropic native + bootstrap user memory
- `render/` — DOCX/XLSX/PDF semantici (input JSON, output deterministico, no HTML strip)
- `tools/` — tool registry V19, modulare (1 file per tool)
- `tools/cigo/` — pacchetto CIGO Eventi Meteo (Allegato 10 + CSV beneficiari + SR41 + bollettino CFD Basilicata)
- `sandbox/` — E2B integration (feature-flagged off finché `E2B_FEATURE=on`)
- `prompts/` — system prompt V19 minimale + subagent system prompts
- `__tests__/` — test Vitest

## Principi V19 (mantenere)

1. **Claude Opus 4.7 al 100%** — niente regole procedurali nel system prompt
2. **Cervellone deve fare DI PIÙ di Claude.ai**, non DI MENO
3. **Multi-agent**: orchestrator delega a sub-agent specialist (parsing/numerical/document/domain)
4. **Memory persistente nativa** + working memory `memory_20250818`
5. **Code execution con output catturato**, container persistence cross-request
6. **Hallucination validator runtime** su URL Drive
7. **Tool dominio italiano** (CFD Basilicata, INPS Allegato 10, Cassa Edile, Normattiva)

## Cosa NON fare

- ❌ Modificare `src/lib/*` (V18 intoccabile finché cutover)
- ❌ Aggiungere regole procedurali nel system prompt
- ❌ Custom tool per cose Claude fa già (web search, parsing PDF nativo)
- ❌ Intercettare file lato server (Claude legge nativamente)

## Test

```bash
npm run test src/v19/__tests__/
npm run build  # deve passare senza rompere V18
```

## Riferimenti

- Spec: `docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md`
- Plan: `docs/superpowers/plans/2026-05-09-cervellone-v19-foundation.md`
- Memory: `cervellone-v19-stato.md`
- ONBOARDING: `ONBOARDING.md`
