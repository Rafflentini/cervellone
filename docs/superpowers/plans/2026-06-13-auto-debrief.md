# Auto-debrief (apprendimento implicito) — Implementation Plan

> **For agentic workers:** eseguito da SUBAGENTI Claude (edit-only o queue), un task per volta. Claude rivede ogni diff, typecheck+test, audit, merge, deploy. TDD dove indicato. Steps con checkbox.

**Goal:** A fine di un lavoro documentale, un pass automatico distilla strategia/fonti/preferenze/lezioni dalla conversazione e le scrive in `procedures`/`project_state`, con riga di riepilogo all'utente. Cervellone impara da solo, senza che Raffaele glielo dica.

**Spec di riferimento:** `docs/superpowers/specs/2026-06-10-cervellone-auto-debrief-design.md` (design + decisioni approvate). Questo piano è l'esecuzione.

**Architettura:** Hook best-effort a fine `runAgentJob` → `maybeRunDebrief` (rileva segnali, gate anti-spreco, dedup) → se candidato, `runDebrief` (1 chiamata Sonnet con `tool_choice` forzato su `StructuredOutput` → JSON) → applica scritture (soglia confidence ≥0.6, tag `updated_by='cervellone:auto-debrief'`) riusando gli helper esistenti → riga riepilogo. **Flag-gated `auto_debrief_enabled` default OFF.** NON tocca `claude.ts`.

**Tech Stack:** Next.js 16, Supabase (`procedures`/`project_state`/`cervellone_config`), `@anthropic-ai/sdk` (Sonnet `modelAudit`), vitest.

**Decisioni di design (oltre la spec):**
- **Cattura segnali tool senza toccare claude.ts:** `auto-debrief.ts` espone una Map modulo-level `markToolSignal(conversationId, signal)` / `consumeToolSignals(conversationId)`. Gli executor di `salva_bozza_pdf` e `chiudi_progetto` (in `tools.ts`) chiamano `markToolSignal` al successo; `maybeRunDebrief` consuma a fine turno (stessa invocazione serverless → la Map persiste). Best-effort.
- **StructuredOutput forzato:** `tool_choice: { type: 'tool', name: 'StructuredOutput' }` per JSON garantito (più robusto del parse-da-testo di `memoria-extract.ts`).
- **Migration applicata da Cowork:** flag resta OFF finché le colonne non esistono. Il codice degrada con grazia se le colonne mancano (read best-effort).

---

## File Structure

| File | Responsabilità | Tipo |
|------|----------------|------|
| `supabase/migrations/2026-06-13-procedures-output-preferences.sql` | +`procedures.output_preferences text[]`,`updated_by text`; +`project_state.last_debrief_at timestamptz`,`updated_by text`; seed flag `auto_debrief_enabled='false'` | NEW |
| `src/lib/auto-debrief.ts` | `isAutoDebriefEnabled`, `markToolSignal`/`consumeToolSignals`, `detectSignals`, `passesGate`, `maybeRunDebrief`, `runDebrief`, `applyDebrief` | NEW |
| `src/lib/auto-debrief.test.ts` | unit (segnali, gate, dedup, parse+confidence, provenienza, merge) | NEW |
| `src/lib/working-memory.ts` | +`output_preferences` (write in createProcedure, read in buildProcedureContext); +`setLastDebriefAt`; +`updated_by` tagging; +`setOutputPreferences`/`mergeChecklist` helper | MODIFY |
| `src/lib/agent-job.ts` | hook `maybeRunDebrief(ctx)` a riga ~214 (best-effort) | MODIFY |
| `src/lib/tools.ts` | `markToolSignal` nei due executor (salva_bozza_pdf, chiudi_progetto) al successo | MODIFY |

---

## Task 1 — Migration schema (NEW file)

**Files:** Create `supabase/migrations/2026-06-13-procedures-output-preferences.sql`

- [ ] **Step 1: Scrivi la migration (idempotente, additiva)**
```sql
-- Auto-debrief Fase 2: colonne per preferenze output, dedup, provenienza.
ALTER TABLE procedures    ADD COLUMN IF NOT EXISTS output_preferences text[] NOT NULL DEFAULT '{}';
ALTER TABLE procedures    ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE project_state ADD COLUMN IF NOT EXISTS last_debrief_at timestamptz;
ALTER TABLE project_state ADD COLUMN IF NOT EXISTS updated_by text;

-- Flag (default OFF). Seed solo se assente.
INSERT INTO cervellone_config (key, value)
VALUES ('auto_debrief_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
```
- [ ] **Step 2: Commit** (Claude commit; applicazione da Cowork — il flag resta OFF). Nessun test.

---

## Task 2 — Estensioni `working-memory.ts` (TDD)

**Files:** Modify `src/lib/working-memory.ts`; Test `src/lib/working-memory.test.ts` (estendi l'esistente)

Tutti gli helper best-effort (no-throw, ritornano boolean/'' su errore), coerenti con lo stile del file.

- [ ] **Step 1: `output_preferences` in lettura.** In `buildProcedureContext` (cerca dove formatta lessons/output_spec), se la procedura ha `output_preferences` non vuoto, aggiungi una riga al blocco: `Formato preferito da Raffaele per questo tipo: <join(', ')>`. Leggi il campo nella select della procedura (aggiungi `output_preferences` alle colonne lette). Degrada se la colonna manca (campo undefined → salta).

- [ ] **Step 2: `output_preferences` in scrittura + nuovi helper.** Aggiungi:
```typescript
/** Imposta output_preferences su una procedura (auto-debrief). Best-effort. */
export async function setOutputPreferences(taskType: string, prefs: string[], updatedBy = 'cervellone:auto-debrief'): Promise<boolean> {
  try {
    if (!taskType || !prefs?.length) return false
    const supabase = getSupabaseServer()
    const { error } = await supabase.from('procedures')
      .update({ output_preferences: prefs, updated_by: updatedBy, updated_at: new Date().toISOString() })
      .eq('task_type', normalizeTaskType(taskType))
    if (error) { console.error('[working-memory] setOutputPreferences:', error.message); return false }
    return true
  } catch (e) { console.error('[working-memory] setOutputPreferences err:', e instanceof Error ? e.message : e); return false }
}

/** Aggiunge step alla checklist di una procedura senza duplicati (per `step`). Best-effort. */
export async function mergeChecklistSteps(taskType: string, steps: string[], updatedBy = 'cervellone:auto-debrief'): Promise<boolean> {
  try {
    if (!taskType || !steps?.length) return false
    const supabase = getSupabaseServer()
    const tt = normalizeTaskType(taskType)
    const { data } = await supabase.from('procedures').select('checklist').eq('task_type', tt).maybeSingle()
    const existing = Array.isArray((data as { checklist?: unknown } | null)?.checklist) ? (data as { checklist: Array<{ step?: string }> }).checklist : []
    const existingSteps = new Set(existing.map((c) => (c?.step ?? '').trim().toLowerCase()).filter(Boolean))
    const toAdd = steps.map((s) => s.trim()).filter((s) => s && !existingSteps.has(s.toLowerCase())).map((s) => ({ step: s }))
    if (!toAdd.length) return true
    const { error } = await supabase.from('procedures')
      .update({ checklist: [...existing, ...toAdd], updated_by: updatedBy, updated_at: new Date().toISOString() })
      .eq('task_type', tt)
    if (error) { console.error('[working-memory] mergeChecklistSteps:', error.message); return false }
    return true
  } catch (e) { console.error('[working-memory] mergeChecklistSteps err:', e instanceof Error ? e.message : e); return false }
}

/** Segna l'ultimo debrief sul progetto attivo (dedup). Best-effort. */
export async function setLastDebriefAt(conversationId: string, whenIso: string): Promise<boolean> {
  try {
    if (!conversationId) return false
    const supabase = getSupabaseServer()
    const { error } = await supabase.from('project_state')
      .update({ last_debrief_at: whenIso, updated_at: new Date().toISOString() })
      .eq('conversation_id', conversationId).eq('status', 'active')
    if (error) { console.error('[working-memory] setLastDebriefAt:', error.message); return false }
    return true
  } catch (e) { console.error('[working-memory] setLastDebriefAt err:', e instanceof Error ? e.message : e); return false }
}
```
> NB: `normalizeTaskType` è la funzione interna già usata da `createProcedure`/`addLesson` — riusala (se non esportata, usa lo stesso inline-normalize che usano). Verifica il nome reale leggendo il file.

- [ ] **Step 3: `getActiveProject` esponga `last_debrief_at`.** Aggiungi `last_debrief_at` alle colonne lette e al tipo `ProjectState` (campo `last_debrief_at?: string | null`), così `maybeRunDebrief` può leggere il cooldown.

- [ ] **Step 4: Test** (estendi `working-memory.test.ts`, pattern mock supabase esistente): `setOutputPreferences` chiama update con `output_preferences`+`updated_by`; `mergeChecklistSteps` non duplica step esistenti (case-insensitive); `setLastDebriefAt` filtra `status='active'`. Run: `npx vitest run src/lib/working-memory.test.ts`.

- [ ] **Step 5: Commit.**

---

## Task 3 — `auto-debrief.ts`: flag + segnali + gate + dedup (TDD)

**Files:** Create `src/lib/auto-debrief.ts` (parte 1) + `src/lib/auto-debrief.test.ts`

- [ ] **Step 1: Scaffold + flag + segnali tool (Map modulo-level).**
```typescript
// src/lib/auto-debrief.ts — Apprendimento implicito (auto-debrief post-task). Flag-gated, best-effort.
import { getSupabaseServer } from './supabase-server'

export async function isAutoDebriefEnabled(): Promise<boolean> {
  try {
    const supabase = getSupabaseServer()
    const { data, error } = await supabase.from('cervellone_config').select('value').eq('key', 'auto_debrief_enabled').maybeSingle()
    if (error) { console.error('[auto-debrief] flag read:', error.message); return false }
    return String(data?.value ?? '').replace(/"/g, '') === 'true'
  } catch (e) { console.error('[auto-debrief] isAutoDebriefEnabled:', e instanceof Error ? e.message : e); return false }
}

// ── Segnali tool del turno (set dagli executor in tools.ts, consumati a fine runAgentJob) ──
type ToolSignal = 'pdf_saved' | 'project_closed'
const toolSignals = new Map<string, Set<ToolSignal>>()
export function markToolSignal(conversationId: string, signal: ToolSignal): void {
  if (!conversationId) return
  const s = toolSignals.get(conversationId) ?? new Set<ToolSignal>()
  s.add(signal); toolSignals.set(conversationId, s)
}
export function consumeToolSignals(conversationId: string): Set<ToolSignal> {
  const s = toolSignals.get(conversationId) ?? new Set<ToolSignal>()
  toolSignals.delete(conversationId)
  return s
}

// ── Approval (regex ancorata a frase breve) ──
const APPROVAL_RE = /^\s*(perfetto|ottimo|perfetto grazie|ok cos[iì]|va bene cos[iì]|cos[iì] va bene|benissimo|esatto|👍|top)\s*[.!…]*\s*$/i
export function isApproval(text: string): boolean { return !!text && APPROVAL_RE.test(text.trim()) }
```

- [ ] **Step 2: Test segnali + flag** (`auto-debrief.test.ts`): `markToolSignal`/`consumeToolSignals` (set, consume svuota, conversazioni isolate); `isApproval('perfetto')===true`, `isApproval('mi spieghi se è perfetto fare X?')===false` (frase lunga interrogativa). Mock supabase per `isAutoDebriefEnabled`. Run vitest.

- [ ] **Step 3: Gate + dedup (pure, testabili).**
```typescript
export interface DebriefSignals { pdfSaved: boolean; projectClosed: boolean; approval: boolean }
/** Passa il gate se evento certo (pdf/close) OPPURE approval con contesto reale (progetto attivo o task_type ≠ altro). */
export function passesGate(sig: DebriefSignals, hasActiveProject: boolean, taskType: string): boolean {
  if (sig.pdfSaved || sig.projectClosed) return true
  if (sig.approval && (hasActiveProject || (taskType && taskType !== 'altro'))) return true
  return false
}
/** Cooldown: niente secondo debrief se l'ultimo è < COOLDOWN_MIN minuti fa. */
export const DEBRIEF_COOLDOWN_MIN = 10
export function inCooldown(lastDebriefAtIso: string | null | undefined, nowMs: number): boolean {
  if (!lastDebriefAtIso) return false
  const t = Date.parse(lastDebriefAtIso)
  if (Number.isNaN(t)) return false
  return (nowMs - t) < DEBRIEF_COOLDOWN_MIN * 60_000
}
```
- [ ] **Step 4: Test gate+dedup**: pdf→true sempre; approval senza progetto e task_type='altro'→false; approval con progetto→true; `inCooldown` con last 5min fa→true, 20min→false, null→false. Run vitest. **Commit.**

---

## Task 4 — `auto-debrief.ts`: runDebrief (Sonnet) + applyDebrief (TDD)

**Files:** Modify `src/lib/auto-debrief.ts` + `src/lib/auto-debrief.test.ts`

- [ ] **Step 1: `runDebrief` — chiamata Sonnet StructuredOutput.**
```typescript
import Anthropic from '@anthropic-ai/sdk'
import { getConfig } from './claude' // modelAudit (sonnet)

export interface DebriefResult {
  task_type: string; is_new_type: boolean
  strategy_steps: string[]; sources: Record<string, string>; save_location?: string
  output_preferences: string[]; lessons: string[]
  confidence: { strategy_steps?: number; sources?: number; output_preferences?: number; lessons?: number }
}
const DEBRIEF_SYSTEM = `Sei un distillatore. Dalla conversazione di un lavoro documentale appena concluso estrai SOLO ciò che è stato realmente fatto/approvato, per ricordarlo la prossima volta. NON inventare. Restituisci via lo strumento StructuredOutput: task_type (slug), is_new_type, strategy_steps (passi reali seguiti), sources (dove hai preso i documenti: nome→riferimento), save_location, output_preferences (formato/stile che l'utente ha approvato), lessons (correzioni ricevute). confidence 0-1 per ogni gruppo: alta solo se evidente dal testo.`

export async function runDebrief(transcript: string, currentProcedure: string, projectState: string): Promise<DebriefResult | null> {
  try {
    const { modelAudit } = await getConfig()
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const resp = await client.messages.create({
      model: modelAudit, max_tokens: 2500, system: DEBRIEF_SYSTEM,
      tools: [{ name: 'StructuredOutput', description: 'Ritorna la distillazione.', input_schema: DEBRIEF_SCHEMA }],
      tool_choice: { type: 'tool', name: 'StructuredOutput' },
      messages: [{ role: 'user', content: `TRANSCRIPT (troncato):\n${transcript.slice(0, 35000)}\n\nPROCEDURA ATTUALE:\n${currentProcedure || '(nessuna)'}\n\nSTATO PROGETTO:\n${projectState || '(nessuno)'}` }],
    })
    const tu = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'StructuredOutput')
    if (!tu) return null
    return tu.input as unknown as DebriefResult
  } catch (e) { console.error('[auto-debrief] runDebrief:', e instanceof Error ? e.message : e); return null }
}
```
(Definisci `DEBRIEF_SCHEMA` = l'input_schema JSON con i campi sopra; copia dallo schema nella spec sezione 2.)

- [ ] **Step 2: `applyDebrief` — scritture con soglia confidence + provenienza.**
```typescript
import { createProcedure, addLesson, setActiveProject, mergeChecklistSteps, setOutputPreferences } from './working-memory'
const MIN_CONF = 0.6
export async function applyDebrief(conversationId: string, r: DebriefResult): Promise<string[]> {
  const applied: string[] = []
  try {
    const tt = (r.task_type || 'altro').trim()
    const c = r.confidence ?? {}
    if (r.is_new_type && (c.strategy_steps ?? 0) >= MIN_CONF) {
      await createProcedure({ taskType: tt, title: tt.toUpperCase(), checklist: r.strategy_steps, saveLocation: r.save_location })
      applied.push(`nuova procedura ${tt}`)
    } else if ((c.strategy_steps ?? 0) >= MIN_CONF && r.strategy_steps?.length) {
      await mergeChecklistSteps(tt, r.strategy_steps); applied.push('strategia aggiornata')
    }
    if ((c.lessons ?? 0) >= MIN_CONF) { for (const l of r.lessons ?? []) await addLesson(tt, l); if (r.lessons?.length) applied.push(`${r.lessons.length} lezioni`) }
    if ((c.output_preferences ?? 0) >= MIN_CONF && r.output_preferences?.length) { await setOutputPreferences(tt, r.output_preferences); applied.push('preferenze formato') }
    if ((c.sources ?? 0) >= MIN_CONF && r.sources && Object.keys(r.sources).length) { await setActiveProject(conversationId, { key_files: r.sources }); applied.push('fonti') }
    return applied
  } catch (e) { console.error('[auto-debrief] applyDebrief:', e instanceof Error ? e.message : e); return applied }
}
```
> NB: `createProcedure`/`setActiveProject` non taggano `updated_by` oggi; il tag lo mettono i nuovi helper `mergeChecklistSteps`/`setOutputPreferences`. Per createProcedure/addLesson il tag è opzionale (Task 2 può estenderle se semplice; altrimenti accettabile, l'origine è comunque tracciabile dal contenuto). NON scrivere MAI in `prompt_extra` (anti-poisoning).

- [ ] **Step 3: Test applyDebrief** (mock dei write di working-memory): voce con confidence <0.6 NON scrive; is_new_type→createProcedure; lessons≥0.6→addLesson per ognuna; sources→setActiveProject(key_files). Run vitest. **Commit.**

---

## Task 5 — Orchestrazione `maybeRunDebrief` + wiring (TDD dove possibile)

**Files:** Modify `src/lib/auto-debrief.ts` (maybeRunDebrief) + `src/lib/agent-job.ts` (hook) + `src/lib/tools.ts` (markToolSignal)

- [ ] **Step 1: `maybeRunDebrief` (orchestratore best-effort).**
```typescript
import { getActiveProject, inferTaskType, buildProcedureContext, setLastDebriefAt } from './working-memory'
export interface DebriefCtx { conversationId: string; userText: string; transcript: string; sendSummary?: (line: string) => void }
export async function maybeRunDebrief(ctx: DebriefCtx): Promise<void> {
  try {
    if (!ctx.conversationId) return
    if (!(await isAutoDebriefEnabled())) return
    const sigSet = consumeToolSignals(ctx.conversationId)
    const sig: DebriefSignals = { pdfSaved: sigSet.has('pdf_saved'), projectClosed: sigSet.has('project_closed'), approval: isApproval(ctx.userText) }
    if (!sig.pdfSaved && !sig.projectClosed && !sig.approval) return
    const project = await getActiveProject(ctx.conversationId)
    const taskType = await inferTaskType(ctx.userText)
    if (!passesGate(sig, !!project, taskType)) return
    if (inCooldown(project?.last_debrief_at, Date.now())) return
    const currentProc = await buildProcedureContext(ctx.userText)
    const result = await runDebrief(ctx.transcript, currentProc, project ? JSON.stringify(project) : '')
    if (!result) return
    const applied = await applyDebrief(ctx.conversationId, result)
    await setLastDebriefAt(ctx.conversationId, new Date().toISOString())
    if (applied.length && ctx.sendSummary) ctx.sendSummary(`📝 Ho imparato per i ${result.task_type}: ${applied.join(', ')}. Se sbaglio, dimmelo.`)
  } catch (e) { console.error('[auto-debrief] maybeRunDebrief:', e instanceof Error ? e.message : e) }
}
```
> `Date.now()`/`new Date()` sono OK qui (codice app runtime, non workflow script).

- [ ] **Step 2: Hook in `agent-job.ts`** (riga ~214, dopo `captureImageExtraction(...)`):
```typescript
  maybeRunDebrief({
    conversationId,
    userText,
    transcript: [...(input.history ?? []).map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[blocchi]'}`).join('\n'), `assistant: ${fullResponse}`].join('\n').slice(-35000),
    sendSummary: (line) => { sendTelegramMessage(chatId, line).catch(() => {}) },
  }).catch(() => {})
```
Import `maybeRunDebrief` da `'./auto-debrief'`. Verifica che `chatId` e `sendTelegramMessage` siano in scope in `runAgentJob` (lo sono — usati sopra). Se `chatId` non c'è (path web futuro), passa `sendSummary` undefined.

- [ ] **Step 3: markToolSignal nei due executor** in `src/lib/tools.ts`:
  - Nell'executor di `salva_bozza_pdf` (cerca `salva_bozza_pdf`, in `executeDraftWrapper`): al ritorno di successo (link PDF ottenuto), prima del return aggiungi `import('./auto-debrief').then(m => m.markToolSignal(conversationId ?? '', 'pdf_saved')).catch(() => {})` (o import statico in testa se preferibile).
  - Nell'executor di `chiudi_progetto` (cerca `chiudi_progetto`/`closeActiveProject` nel wrapper working-memory): al successo, `markToolSignal(conversationId ?? '', 'project_closed')`.
  > Usa import statico in testa a tools.ts: `import { markToolSignal } from './auto-debrief'` (evita import dinamici ripetuti). Chiama solo al SUCCESSO reale dell'azione.

- [ ] **Step 4: Test `maybeRunDebrief`** (mock di isAutoDebriefEnabled, getActiveProject, inferTaskType, runDebrief, applyDebrief): flag OFF→nessuna chiamata a runDebrief; nessun segnale→return; approval senza progetto+task altro→no runDebrief; pdf_saved→runDebrief chiamato + setLastDebriefAt + sendSummary; cooldown attivo→skip. Run vitest.

- [ ] **Step 5: Commit.** Typecheck + tutte le suite toccate verdi.

---

## Rollout & verifica
- Flag `auto_debrief_enabled` resta **OFF**. Migration applicata da Cowork. Deploy prod (flag OFF = inerte, zero rischio).
- **Audit adversarial** (multi-agente) PRIMA di proporre flag ON: anti-poisoning (mai prompt_extra), costo (parte solo a lavoro concluso), falsi positivi gate, race sulla Map segnali (multi-utente/serverless), confidence threshold, provenienza.
- Smoke campo (flag ON, deciso da Raffaele): lavoro documentale reale → `project_state` si popola + riga riepilogo + procedura aggiornata.

## Self-Review
1. **Spec coverage:** trigger(3 segnali)+gate ✓Task3/5; distillazione Sonnet StructuredOutput ✓Task4; scritture+confidence+mapping ✓Task4; output_preferences schema+read+write ✓Task1/2/4; avviso riga ✓Task5; anti-poisoning(no prompt_extra, updated_by) ✓Task2/4; dedup/cooldown ✓Task3/5; flag-gated ✓Task3.
2. **Placeholder:** `DEBRIEF_SCHEMA` da definire (copiare schema spec §2) — esplicitato. `normalizeTaskType` nome reale da verificare in working-memory.ts — esplicitato.
3. **Type consistency:** `DebriefSignals`/`DebriefResult`/`DebriefCtx` usati coerenti tra Task3/4/5. `markToolSignal`/`consumeToolSignals` firme coerenti tra auto-debrief.ts e tools.ts. `last_debrief_at` aggiunto a `ProjectState` (Task2) e letto in `maybeRunDebrief` (Task5).
