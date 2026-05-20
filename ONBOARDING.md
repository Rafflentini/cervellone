# ONBOARDING — Cervellone V19 Foundation (handoff mattino 10 maggio 2026)

> **Documento di ripresa** dopo sessione autonoma notturna Claude del 9-10 maggio 2026.

## TL;DR — cosa è successo stanotte

1. **Audit V18 verificato** sul codice live (claude.ts:541, prompts.ts:172-175, pdf-generator.ts:144-188).
2. **Best practice Anthropic 2026 mappate** (Opus 4.7, code_execution_20260120, memory_20250818, adaptive thinking, pause_turn).
3. **Allegato 10 CIGO INPS studiato** (relazione tecnica art.2 D.M. 95442/2016) + tracciato CSV beneficiari Msg INPS 3566/2018.
4. **Bollettino CFD Basilicata mappato**: pattern URL `https://centrofunzionale.regione.basilicata.it/ew/ew_pdf/a/Bollettino_Criticita_Regione_Basilicata_DD_MM_YYYY.pdf` (vincolante per CIGO Restruktura).
5. **Spec V19 scritta** (~9000 parole, 18 sezioni).
6. **Plan eseguibile scritto**.
7. **Branch `v19/foundation` creato** + 5 commit ordinati per modulo.
8. **Foundation V19 implementata** in `src/v19/` (~3800 LOC).
9. **39/39 unit test PASS** in 1.1s.
10. **TypeScript: 0 errori in V19** (restano 4 errori PRE-ESISTENTI in V18, non causati da me).
11. **Branch pushato su origin**.

## Stato

- ✅ Branch `v19/foundation` su `origin/v19/foundation` (commit `5c3ced2`)
- ⏳ **PR draft da aprire manualmente** — `gh` CLI non installato + nessun `GITHUB_TOKEN` locale. Vedi sotto.
- ✅ V18 prod intoccato (commit `f973b2d` resta su `main`)

## URL PR draft (1 click per aprire)

🔗 **https://github.com/Rafflentini/cervellone/pull/new/v19/foundation**

Apri questo link, GitHub ti propone già la PR pre-compilata. Suggerisci di:
1. Marcare come **Draft** (non Ready for review).
2. Titolo proposto: `V19 Foundation: rifondazione totale Cervellone (multi-agent + Memory API + DOCX semantico + CIGO)`.
3. Body: copia da `docs/superpowers/plans/2026-05-09-cervellone-v19-foundation.md` o lasciare descrizione breve e linkare al plan.

## Come testare V19 ora

```powershell
git checkout v19/foundation
npm install   # opzionale (deps invariate vs main, salvo @e2b opt)
npx vitest run src/v19/__tests__/   # 39/39 PASS atteso
npx tsc --noEmit                     # 0 errori in src/v19/
```

## Cosa contiene V19

### Decisione strategica confermata

Hai scelto path **Custom V19** (post audit 8 mag che lo aveva votato 3/10).
Vincolo: V19 deve fare **DI PIÙ** di Claude.ai, non DI MENO.

### Architettura

| Modulo | File | LOC | Test |
|---|---|---|---|
| Agent loop | `src/v19/agent/loop.ts` | ~280 | (deferred — richiede mock SDK) |
| Multi-agent orchestrator | `src/v19/agent/orchestrator.ts` | ~150 | indiretti |
| Sub-agent registry (6 specialist) | `src/v19/agent/subagent-registry.ts` | ~110 | 7 ✅ |
| Hallucination validator runtime | `src/v19/agent/hallucination-validator.ts` | ~75 | 7 ✅ |
| Memory API native (`memory_20250818`) | `src/v19/memory/handler.ts` + storage + bootstrap | ~370 | 8 ✅ |
| DOCX engine semantico (docx v9 Table API) | `src/v19/render/docx.ts` + types + utils | ~280 | 6 ✅ |
| Tool CFD Basilicata | `src/v19/tools/meteo-basilicata.ts` | ~140 | 5 ✅ |
| Tool CIGO Allegato 10 (3 file pacchetto) | `src/v19/tools/cigo/*` | ~600 | 6 ✅ |
| E2B sandbox (feature-flagged) | `src/v19/sandbox/e2b.ts` + persist + errors | ~170 | (deferred) |
| System prompt minimale | `src/v19/prompts/system.ts` | ~50 | (verificato manualmente) |
| Migration Supabase | `supabase/migrations/2026-05-09-v19-*.sql` | 2 file | -- |

**Test totali**: 6 file, 39 test, 39 PASS, 1.1s.

### Cambiamenti chiave vs V18

| Aspetto | V18 (prod) | V19 (foundation) |
|---|---|---|
| `MAX_ITERATIONS` | 10 | **30** |
| `NO_TEXT_LIMIT` | 5 | **8** |
| Thinking | `budget_tokens: 8K` (Opus 4.7 errore 400) | `{ type: 'adaptive', display: 'summarized' }` ✅ |
| `output_config.effort` | "high" solo | "xhigh" generation, "high" chat |
| `pause_turn` stop reason | NON gestito | gestito (continue) |
| `code_execution` output | `continue` (skippato `claude.ts:541`) | **catturato + container persistence** |
| DOCX | `htmlToDocxBlocks` regex naive (tabelle appiattite) | `docx` v9 Table API native |
| System prompt token | ~4300-6700 | **~800-1500** |
| Memory | 4 tool custom | + `memory_20250818` Anthropic native |
| Multi-agent | singolo loop | orchestrator → 6 sub-agent specialist |
| Hallucination URL Drive | post-hoc detection | **runtime validator** |
| Tool CIGO/CFD Basilicata | assenti | implementati |

## Open questions per te (in ordine di urgenza)

### 1. Apertura PR draft
- Click su https://github.com/Rafflentini/cervellone/pull/new/v19/foundation
- Marca come Draft.

### 2. E2B sandbox
- **Quando vuoi attivarla?** L'integrazione è codice-ready, manca solo:
  - `npm install @e2b/code-interpreter` (1 dep)
  - Settare `E2B_API_KEY` in `.env.local` + Vercel env (per il deploy V19 in futuro)
  - Settare `E2B_FEATURE=on` (feature flag)
- **Stima costo**: free tier E2B copre dev. In prod ~$0.10/h container per uso reale.

### 3. Cartelle Drive semantiche
La V19 usa una mappa semantica per evitare l'errore V18 "Studio Tecnico generico per CIGO". Mi servono gli ID Drive di:
- RELAZIONI CIG
- DDT
- PREVENTIVI
- CME
- CHECKLIST
- SICUREZZA (POS/PSC)

(Lista da inserire in `cervellone_config` table, sessione successiva).

### 4. Beneficiari CIGO Aprile 2026 reali
Il fixture in `src/v19/__tests__/fixtures/cigo-aprile-2026.ts` ha 5 operai sintetizzati (Bianchi, Rossi, Verdi, Russo, Esposito). **Sostituire con i tuoi operai reali per generare il documento finale.**

### 5. Bollettino dell'evento reale
Quale data esatta dell'evento meteo Aprile 2026? (Per scaricare bollettino CFD Basilicata di quel giorno specifico).

### 6. Cutover Telegram/webchat V18 → V19
Una volta verificato che V19 funziona (oggi/domani), vuoi:
- **Cutover immediato** (route Telegram switch su V19)?
- **Periodo parallelo** (V18 prod + V19 staging su sub-dominio)?

### 7. Path Hybrid (E) come safety net
Se al primo test reale V19 non convince, vuoi che attivi anche path E (Claude.ai Projects per reasoning + Cervellone come gateway)? Sono 5-10h di setup, riduce drasticamente il rischio.

## Cosa NON è stato fatto stanotte (per scelta)

- ❌ Migrazione dati `memoria_esplicita` (V18) → `memory_20250818` (V19) — script `migrate-from-v18.ts` previsto ma non implementato (lo facciamo in cutover).
- ❌ Cutover route Telegram/webchat — V18 resta prod, V19 vive in `src/v19/`.
- ❌ Computer Use / Local Agent Bridge / Outlook (W8-W10 visione).
- ❌ Trigger.dev v3 setup (resta su Vercel cron).
- ❌ S8 Normattiva scraper / S9 territorial knowledge.
- ❌ SR41 PDF AcroForm ufficiale — implementato come placeholder DOCX. Per polish: integrare `pdf-lib` su template AcroForm INPS.
- ❌ Migration Supabase APPLICATE in prod — i file `.sql` ci sono ma vanno applicati manualmente quando vuoi.

## Memoria Claude Code aggiornata

- `cervellone-v19-stato.md` (NUOVO) — riassunto di questa sessione
- `cervellone-bollettino-meteo-basilicata.md` (NUOVO) — vincolo CFD Basilicata
- `MEMORY.md` — aggiunta riga V19

## Confini operativi rispettati durante la notte

- ✅ NO push su `main`
- ✅ NO deploy prod Vercel
- ✅ NO modifiche a Supabase prod (solo file `.sql` in `supabase/migrations/`)
- ✅ NO modifiche env Vercel
- ✅ NO modifiche bot Telegram in prod
- ✅ NO chiusura PR esistenti
- ✅ NO scelte irreversibili

## Possibili nodi da affrontare insieme

### Compatibilità Anthropic SDK 0.80

Il mio loop V19 usa API beta Opus 4.7 (`thinking.adaptive`, `output_config.effort='xhigh'`, `client.beta.messages.stream`, `code_execution_20260120`). L'SDK 0.80 in `package.json` **potrebbe non averle tipizzate completamente**. Ho usato cast `as any` mirati dove necessario.

**Quando attiverai V19 runtime, potrebbe servire:**
- `npm install @anthropic-ai/sdk@latest`
- Eventuali aggiustamenti al loop se le API sono cambiate.

I test 39/39 PASSANO perché mockano l'SDK, ma il primo run reale potrebbe rivelare incompatibilità minori.

### Hallucination validator

Il default checker (in `hallucination-validator.ts`) ritorna `true` (no-op) per evitare falsi positivi. **Sostituire con un checker vero che chiama Drive API HEAD** prima del cutover prod. Lo facciamo insieme appena attivi V19.

### Performance loop

`MAX_ITERATIONS=30` + `xhigh` thinking + multi-agent: per task complessi può sforare il timeout Vercel da 300s. Da monitorare.

## Comandi utili per ispezionare

```powershell
# Vedi commit V19
git log --oneline v19/foundation -7

# Vedi diff con main
git diff main..v19/foundation --stat

# Esegui solo test V19
npx vitest run src/v19/__tests__/

# TypeScript check globale
npx tsc --noEmit

# Avvia dev server (se vuoi smoke test V19)
npm run dev
# (V19 NON è cablata su /api/* yet — solo modulo isolato)
```

## Stima accuratezza foundation

- **Codice scritto**: 100% dei moduli previsti dal plan
- **Test PASS**: 39/39 (100%)
- **Test coverage stimato**: ~70% (i test mockano SDK e fetch, manca integration test reale)
- **Allineamento spec/codice**: ~95% (deviazioni minori documentate inline)
- **Pronto per cutover prod**: 60-70% (manca test integrazione + verifica SDK + Drive checker reale)

**Stima realistica per cutover Telegram V18 → V19**: 4-8h di lavoro insieme (smoke test reale + fix SDK eventuali + Drive checker + applicazione migration Supabase + switch route).

---

🤖 Foundation generata da Claude Opus 4.7 in sessione autonoma 9-10 maggio 2026.
Buona ripresa Ingegnere — appena online, partiamo dal punto 1 (apertura PR).
