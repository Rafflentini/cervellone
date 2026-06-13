/**
 * src/lib/auto-debrief.ts — Apprendimento implicito (auto-debrief post-task).
 *
 * Binario A della Fase 2 memoria. A fine di un lavoro documentale, un pass dedicato
 * di distillazione (1 chiamata Sonnet con StructuredOutput forzato) estrae
 * strategia/fonti/preferenze/lezioni dalla conversazione e le scrive in
 * procedures/project_state, con una riga di riepilogo all'utente.
 *
 * TUTTO è FLAG-GATED via `auto_debrief_enabled` in cervellone_config (OFF di default)
 * e TUTTO è best-effort: nessuna funzione lancia mai. `maybeRunDebrief` ritorna void
 * e non blocca mai la risposta.
 *
 * Anti-poisoning (spec §5): le scritture sono taggate `updated_by='cervellone:auto-debrief'`
 * (lato helper working-memory). MAI scrivere in `prompt_extra`.
 *
 * NB anti-ciclo import: `getConfig` da './claude' è importato DINAMICAMENTE dentro
 * runDebrief (claude → tools → auto-debrief → claude creerebbe un ciclo). Stesso
 * pattern del fix storico "071-fix-circular-dep-getconfig-dynamic-import".
 */

import Anthropic from '@anthropic-ai/sdk'
import { getSupabaseServer } from './supabase-server'
import {
  createProcedure,
  addLesson,
  setActiveProject,
  mergeChecklistSteps,
  setOutputPreferences,
  getActiveProject,
  inferTaskType,
  buildProcedureContext,
  setLastDebriefAt,
} from './working-memory'

/**
 * Flag-gate: legge `auto_debrief_enabled` da cervellone_config.
 * Pattern identico a isWorkingMemoryEnabled. Fail-closed (false su errore).
 */
export async function isAutoDebriefEnabled(): Promise<boolean> {
  try {
    const supabase = getSupabaseServer()
    const { data, error } = await supabase
      .from('cervellone_config')
      .select('value')
      .eq('key', 'auto_debrief_enabled')
      .maybeSingle()
    if (error) {
      console.error('[auto-debrief] flag read:', error.message)
      return false
    }
    return String(data?.value ?? '').replace(/"/g, '') === 'true'
  } catch (e) {
    console.error('[auto-debrief] isAutoDebriefEnabled:', e instanceof Error ? e.message : e)
    return false
  }
}

/* ── Segnali tool del turno (set dagli executor in tools.ts, consumati a fine runAgentJob) ── */

export type ToolSignal = 'pdf_saved' | 'project_closed'

const toolSignals = new Map<string, Set<ToolSignal>>()

/** Marca un segnale tool per la conversazione (chiamato al SUCCESSO reale dell'azione). Best-effort. */
export function markToolSignal(conversationId: string, signal: ToolSignal): void {
  if (!conversationId) return
  const s = toolSignals.get(conversationId) ?? new Set<ToolSignal>()
  s.add(signal)
  toolSignals.set(conversationId, s)
}

/** Consuma (e svuota) i segnali tool accumulati per la conversazione. */
export function consumeToolSignals(conversationId: string): Set<ToolSignal> {
  const s = toolSignals.get(conversationId) ?? new Set<ToolSignal>()
  toolSignals.delete(conversationId)
  return s
}

/* ── Approval (regex ancorata a frase breve, no match dentro frasi lunghe interrogative) ── */

const APPROVAL_RE =
  /^\s*(perfetto|ottimo|perfetto grazie|ok cos[iì]|va bene cos[iì]|cos[iì] va bene|benissimo|esatto|👍|top)\s*[.!…]*\s*$/i

export function isApproval(text: string): boolean {
  return !!text && APPROVAL_RE.test(text.trim())
}

/* ── Gate anti-spreco + dedup (puri, testabili) ── */

export interface DebriefSignals {
  pdfSaved: boolean
  projectClosed: boolean
  approval: boolean
}

/**
 * Passa il gate se evento certo (pdf/close) OPPURE approval con contesto reale
 * (progetto attivo o task_type ≠ altro). "Perfetto" in chat casuale senza
 * progetto → niente debrief → costo zero.
 */
export function passesGate(sig: DebriefSignals, hasActiveProject: boolean, taskType: string): boolean {
  if (sig.pdfSaved || sig.projectClosed) return true
  if (sig.approval && (hasActiveProject || (!!taskType && taskType !== 'altro'))) return true
  return false
}

/** Cooldown: niente secondo debrief se l'ultimo è < COOLDOWN_MIN minuti fa. */
export const DEBRIEF_COOLDOWN_MIN = 10

export function inCooldown(lastDebriefAtIso: string | null | undefined, nowMs: number): boolean {
  if (!lastDebriefAtIso) return false
  const t = Date.parse(lastDebriefAtIso)
  if (Number.isNaN(t)) return false
  return nowMs - t < DEBRIEF_COOLDOWN_MIN * 60_000
}

/* ── Distillazione (1 chiamata Sonnet, StructuredOutput forzato) ── */

export interface DebriefResult {
  task_type: string
  is_new_type: boolean
  strategy_steps: string[]
  sources: Record<string, string>
  save_location?: string
  output_preferences: string[]
  lessons: string[]
  confidence: {
    strategy_steps?: number
    sources?: number
    output_preferences?: number
    lessons?: number
  }
}

/** Schema input del tool StructuredOutput: garantisce JSON valido dal modello (spec §2). */
const DEBRIEF_SCHEMA = {
  type: 'object' as const,
  properties: {
    task_type: { type: 'string', description: 'slug del tipo-documento (es. pos, preventivo, cme)' },
    is_new_type: { type: 'boolean', description: 'true se è un tipo non ancora conosciuto' },
    strategy_steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'passi reali seguiti per produrre il documento (la strategia)',
    },
    sources: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'dove hai preso i documenti/info: nome → riferimento (drive://, sheet://, mail...)',
    },
    save_location: { type: 'string', description: 'percorso/cartella dove è stato salvato' },
    output_preferences: {
      type: 'array',
      items: { type: 'string' },
      description: 'formato/stile che l\'utente ha approvato (tabella bordata, firme in fondo, tono formale...)',
    },
    lessons: {
      type: 'array',
      items: { type: 'string' },
      description: 'correzioni ricevute, da ricordare la prossima volta',
    },
    confidence: {
      type: 'object',
      properties: {
        strategy_steps: { type: 'number' },
        sources: { type: 'number' },
        output_preferences: { type: 'number' },
        lessons: { type: 'number' },
      },
      description: 'confidence 0-1 per ogni gruppo: alta solo se evidente dal testo',
    },
  },
  required: ['task_type', 'is_new_type'],
}

const DEBRIEF_SYSTEM = `Sei un distillatore. Dalla conversazione di un lavoro documentale appena concluso estrai SOLO ciò che è stato realmente fatto/approvato, per ricordarlo la prossima volta. NON inventare. Restituisci via lo strumento StructuredOutput: task_type (slug), is_new_type, strategy_steps (passi reali seguiti), sources (dove hai preso i documenti: nome→riferimento), save_location, output_preferences (formato/stile che l'utente ha approvato), lessons (correzioni ricevute). confidence 0-1 per ogni gruppo: alta solo se evidente dal testo.`

/**
 * Una chiamata Sonnet (modelAudit) con tool_choice forzato su StructuredOutput.
 * Best-effort: errore / nessun tool_use → null.
 */
export async function runDebrief(
  transcript: string,
  currentProcedure: string,
  projectState: string,
): Promise<DebriefResult | null> {
  try {
    // Dynamic import per evitare il ciclo claude → tools → auto-debrief → claude.
    const { getConfig } = await import('./claude')
    const { modelAudit } = await getConfig()
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const resp = await client.messages.create({
      model: modelAudit,
      max_tokens: 2500,
      system: DEBRIEF_SYSTEM,
      tools: [{ name: 'StructuredOutput', description: 'Ritorna la distillazione.', input_schema: DEBRIEF_SCHEMA }],
      tool_choice: { type: 'tool', name: 'StructuredOutput' },
      messages: [
        {
          role: 'user',
          content: `TRANSCRIPT (troncato):\n${transcript.slice(0, 35000)}\n\nPROCEDURA ATTUALE:\n${
            currentProcedure || '(nessuna)'
          }\n\nSTATO PROGETTO:\n${projectState || '(nessuno)'}`,
        },
      ],
    })
    const tu = resp.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'StructuredOutput',
    )
    if (!tu) return null
    return tu.input as unknown as DebriefResult
  } catch (e) {
    console.error('[auto-debrief] runDebrief:', e instanceof Error ? e.message : e)
    return null
  }
}

/* ── Applicazione scritture (soglia confidence + provenienza) ── */

const MIN_CONF = 0.6

/**
 * Applica le scritture distillate riusando gli helper di working-memory.
 * Solo le voci con confidence ≥ MIN_CONF entrano. Best-effort: non lancia mai.
 *
 * IMPORTANTE: normalizza il task_type UNA volta (`tt`) e lo usa per TUTTI gli helper.
 * Motivo: addLesson NON normalizza il task_type internamente (gli altri sì), quindi
 * senza normalizzare scriverebbe su una chiave diversa (es. "POS" vs "pos").
 *
 * Ritorna la lista delle voci applicate (per la riga di riepilogo).
 */
export async function applyDebrief(conversationId: string, r: DebriefResult): Promise<string[]> {
  const applied: string[] = []
  try {
    const tt = (r.task_type || 'altro').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'altro'
    const c = r.confidence ?? {}

    if (r.is_new_type && (c.strategy_steps ?? 0) >= MIN_CONF) {
      await createProcedure({
        taskType: tt,
        title: tt.toUpperCase(),
        checklist: r.strategy_steps,
        saveLocation: r.save_location,
      })
      applied.push(`nuova procedura ${tt}`)
    } else if ((c.strategy_steps ?? 0) >= MIN_CONF && r.strategy_steps?.length) {
      await mergeChecklistSteps(tt, r.strategy_steps)
      applied.push('strategia aggiornata')
    }

    if ((c.lessons ?? 0) >= MIN_CONF && r.lessons?.length) {
      for (const l of r.lessons) await addLesson(tt, l)
      applied.push(`${r.lessons.length} lezioni`)
    }

    if ((c.output_preferences ?? 0) >= MIN_CONF && r.output_preferences?.length) {
      await setOutputPreferences(tt, r.output_preferences)
      applied.push('preferenze formato')
    }

    if ((c.sources ?? 0) >= MIN_CONF && r.sources && Object.keys(r.sources).length) {
      await setActiveProject(conversationId, { key_files: r.sources })
      applied.push('fonti')
    }

    return applied
  } catch (e) {
    console.error('[auto-debrief] applyDebrief:', e instanceof Error ? e.message : e)
    return applied
  }
}

/* ── Orchestratore best-effort (hook a fine runAgentJob) ── */

export interface DebriefCtx {
  conversationId: string
  userText: string
  transcript: string
  sendSummary?: (line: string) => void
}

/**
 * Orchestratore: rileva segnali → gate → cooldown → distilla → applica → riga riepilogo.
 * Best-effort: ritorna void, non lancia mai, non blocca la risposta. Flag-gated.
 */
export async function maybeRunDebrief(ctx: DebriefCtx): Promise<void> {
  try {
    if (!ctx.conversationId) return
    if (!(await isAutoDebriefEnabled())) return

    const sigSet = consumeToolSignals(ctx.conversationId)
    const sig: DebriefSignals = {
      pdfSaved: sigSet.has('pdf_saved'),
      projectClosed: sigSet.has('project_closed'),
      approval: isApproval(ctx.userText),
    }
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
    if (applied.length && ctx.sendSummary) {
      ctx.sendSummary(`📝 Ho imparato per i ${result.task_type}: ${applied.join(', ')}. Se sbaglio, dimmelo.`)
    }
  } catch (e) {
    console.error('[auto-debrief] maybeRunDebrief:', e instanceof Error ? e.message : e)
  }
}
