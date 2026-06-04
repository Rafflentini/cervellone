/**
 * src/lib/working-memory.ts — FASE 1 Memoria procedurale (playbook per tipo-documento)
 *
 * Tutto FLAG-GATED via `working_memory_enabled` in cervellone_config (OFF di default).
 * Con flag OFF, `buildProcedureContext` non viene mai chiamato dai due entry-point e
 * il comportamento resta INVARIATO.
 *
 * Idea: quando parte un task documentale (POS, preventivo, CME, perizia, ...), carichiamo
 * dalla tabella `procedures` una "checklist obbligatoria" che dice al modello DOVE prendere
 * i dati (DVR/PSC/contratto su Drive) PRIMA di chiedere all'utente. Così il bot non si blocca
 * a chiedere dati che potrebbe leggere da solo dalle fonti.
 *
 * Tutto è best-effort e non bloccante: qualsiasi errore → ritorna '' / null / no-op.
 *
 * Schema tabella `procedures` (già esistente, NON la tocchiamo):
 *   id, task_type (unique), title, checklist jsonb [{step, source}], output_spec,
 *   save_location, lessons jsonb [], updated_at
 */

import { getSupabaseServer } from './supabase-server'

export type ProcedureTaskType =
  | 'pos'
  | 'preventivo'
  | 'cme'
  | 'perizia'
  | 'relazione'
  | 'scia'
  | 'cila'
  | 'altro'

interface ChecklistStep {
  step: string
  source?: string
}

export interface Procedure {
  id: string
  task_type: string
  title: string
  checklist: ChecklistStep[]
  output_spec: string | null
  save_location: string | null
  lessons: string[]
  updated_at?: string
}

/**
 * Inferenza tipo-task dalla richiesta utente.
 *
 * REPLICA della logica di `inferDocumentType` in document-saver.ts: NON importiamo
 * document-saver perché tira dentro googleapis (pesante) — qui ci serve solo la
 * piccola funzione regex, replicata 1:1.
 */
export function inferTaskType(userQuery: string): ProcedureTaskType {
  const text = (userQuery || '').toLowerCase()
  // Ordine importante: pattern più specifici prima (identico a inferDocumentType)
  if (/\bpiano\s+operativo\s+(?:di\s+)?sicurezza|\bp\.?o\.?s\.?\b/i.test(text)) return 'pos'
  if (/\bcomputo\s+metric|\bc\.?m\.?e\.?\b/i.test(text)) return 'cme'
  if (/\bperizia/i.test(text)) return 'perizia'
  if (/\brelazione\s+(?:di\s+)?(?:calcol|tecnic|geologic)/i.test(text)) return 'relazione'
  if (/\bscia\b|segnalazione\s+certif/i.test(text)) return 'scia'
  if (/\bcila\b|comunicazione\s+inizio\s+lavori/i.test(text)) return 'cila'
  if (/\bpreventiv|\bofferta\b/i.test(text)) return 'preventivo'
  return 'altro'
}

/**
 * Flag-gate: legge `working_memory_enabled` da cervellone_config.
 * Pattern identico a should-use-durable.ts. Fail-closed (false su errore).
 */
export async function isWorkingMemoryEnabled(): Promise<boolean> {
  try {
    const supabase = getSupabaseServer()
    const { data, error } = await supabase
      .from('cervellone_config')
      .select('value')
      .eq('key', 'working_memory_enabled')
      .maybeSingle()

    if (error) {
      console.error('[working-memory] working_memory_enabled read failed:', error.message)
      return false
    }
    return String(data?.value ?? '').replace(/"/g, '') === 'true'
  } catch (err) {
    console.error('[working-memory] isWorkingMemoryEnabled error:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Ritorna la procedura con quel task_type, o null. Best-effort.
 */
export async function getProcedure(taskType: string): Promise<Procedure | null> {
  try {
    const supabase = getSupabaseServer()
    const { data, error } = await supabase
      .from('procedures')
      .select('id, task_type, title, checklist, output_spec, save_location, lessons, updated_at')
      .eq('task_type', taskType)
      .maybeSingle()

    if (error) {
      console.error('[working-memory] getProcedure read failed:', error.message)
      return null
    }
    if (!data) return null

    const checklist = Array.isArray(data.checklist) ? (data.checklist as ChecklistStep[]) : []
    const lessons = Array.isArray(data.lessons) ? (data.lessons as string[]) : []
    return {
      id: data.id,
      task_type: data.task_type,
      title: data.title,
      checklist,
      output_spec: data.output_spec ?? null,
      save_location: data.save_location ?? null,
      lessons,
      updated_at: data.updated_at,
    }
  } catch (err) {
    console.error('[working-memory] getProcedure error:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Appende `lesson` all'array `lessons` della procedura (read-modify-write).
 * Best-effort, non lancia mai.
 */
export async function addLesson(taskType: string, lesson: string): Promise<boolean> {
  try {
    const clean = (lesson || '').trim()
    if (!clean) return false

    const supabase = getSupabaseServer()
    const { data, error } = await supabase
      .from('procedures')
      .select('lessons')
      .eq('task_type', taskType)
      .maybeSingle()

    if (error) {
      console.error('[working-memory] addLesson read failed:', error.message)
      return false
    }
    if (!data) {
      console.warn(`[working-memory] addLesson: nessuna procedura per task_type="${taskType}"`)
      return false
    }

    const current = Array.isArray(data.lessons) ? (data.lessons as string[]) : []
    const next = [...current, clean]

    const { error: upErr } = await supabase
      .from('procedures')
      .update({ lessons: next, updated_at: new Date().toISOString() })
      .eq('task_type', taskType)

    if (upErr) {
      console.error('[working-memory] addLesson update failed:', upErr.message)
      return false
    }
    return true
  } catch (err) {
    console.error('[working-memory] addLesson error:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Costruisce il blocco "PROCEDURA OBBLIGATORIA" da iniettare nel system come blocco
 * NON cachato. Best-effort: qualsiasi errore (o task 'altro', o procedura assente) → ''.
 */
export async function buildProcedureContext(userQuery: string): Promise<string> {
  try {
    const taskType = inferTaskType(userQuery)
    if (taskType === 'altro') return ''

    const proc = await getProcedure(taskType)
    if (!proc) return ''

    const lines: string[] = []
    lines.push(`=== PROCEDURA OBBLIGATORIA: ${proc.title} ===`)
    lines.push(
      'Prima di CHIEDERE qualsiasi dato all\'utente, procurati i dati dalle fonti indicate (es. leggi il DVR/PSC su Drive con i tool che hai). Segui questa checklist in ordine:'
    )
    proc.checklist.forEach((c, i) => {
      const src = c.source ? ` — FONTE: ${c.source}` : ''
      lines.push(`${i + 1}. ${c.step}${src}`)
    })
    if (proc.output_spec) lines.push(`OUTPUT richiesto: ${proc.output_spec}`)
    if (proc.save_location) lines.push(`DOVE SALVARE: ${proc.save_location}`)
    if (proc.lessons.length > 0) {
      lines.push('APPRENDIMENTI (rispettali): ')
      for (const l of proc.lessons) lines.push(`- ${l}`)
    }
    lines.push('Chiedi all\'utente SOLO i dati che restano mancanti DOPO aver consultato tutte le fonti.')
    lines.push('=== fine procedura ===')

    return lines.join('\n')
  } catch (err) {
    console.error('[working-memory] buildProcedureContext error:', err instanceof Error ? err.message : err)
    return ''
  }
}
