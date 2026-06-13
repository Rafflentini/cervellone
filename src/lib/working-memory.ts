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
 * Schema tabella `procedures` (già esistente, con colonna keywords aggiunta da
 * migration 2026-06-06-procedures-keywords.sql):
 *   id, task_type (unique), title, checklist jsonb [{step, source}], output_spec,
 *   save_location, lessons jsonb [], keywords jsonb [], updated_at
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
  keywords: string[]
  output_preferences?: string[]
  updated_at?: string
}

/* ─── Cache per il lookup data-driven di procedures (keyword matching) ─── */
interface ProcedureCacheEntry {
  rows: Array<{ task_type: string; keywords: string[] }>
  cachedAt: number
}

const PROCEDURE_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minuti
let procedureCache: ProcedureCacheEntry | null = null

/** Invalida la cache in-memory (chiamata dopo ogni write su procedures). */
export function invalidateProcedureCache(): void {
  procedureCache = null
}

/**
 * Fallback: inferenza tipo-task SOLO via regex hardcoded (7 tipi storici).
 * Continua a funzionare anche se la tabella procedures non è raggiungibile.
 *
 * REPLICA della logica di `inferDocumentType` in document-saver.ts: NON importiamo
 * document-saver perché tira dentro googleapis (pesante) — qui ci serve solo la
 * piccola funzione regex, replicata 1:1.
 */
/**
 * Normalizza un task_type: trim, lowercase, solo [a-z0-9_-].
 * Stessa logica usata storicamente inline da createProcedure. Riusata dai nuovi
 * helper (setOutputPreferences/mergeChecklistSteps) così la chiave di match è coerente.
 */
function normalizeTaskType(taskType: string): string {
  return (taskType || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
}

export function inferTaskTypeRegex(userQuery: string): ProcedureTaskType {
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
 * Inferenza tipo-task data-driven: prima prova il DB (task_type + keywords),
 * con cache in-memory TTL 5 min; in caso di errore/tabella vuota cade sul
 * fallback regex hardcoded (i 7 tipi storici restano sempre raggiungibili).
 *
 * La funzione è ASYNC per il lookup DB. buildProcedureContext è già async.
 *
 * @deprecated Il nome `inferTaskType` sincronico era usato solo nei test storici.
 *   I test ora importano `inferTaskType` che è questa versione async.
 */
export async function inferTaskType(userQuery: string): Promise<string> {
  const text = (userQuery || '').toLowerCase()
  try {
    // Usa la cache se ancora valida
    if (!procedureCache || Date.now() - procedureCache.cachedAt > PROCEDURE_CACHE_TTL_MS) {
      const supabase = getSupabaseServer()
      const { data, error } = await supabase
        .from('procedures')
        .select('task_type, keywords')

      if (error) {
        console.error('[working-memory] inferTaskType load failed:', error.message)
        // fallback regex
        return inferTaskTypeRegex(userQuery)
      }

      procedureCache = {
        rows: (data ?? []).map((r: { task_type: string; keywords?: unknown }) => ({
          task_type: r.task_type,
          keywords: Array.isArray(r.keywords) ? (r.keywords as string[]) : [],
        })),
        cachedAt: Date.now(),
      }
    }

    // Escape completo dei metacaratteri regex (incluso trattino, punto, parentesi, ecc.)
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

    // Match: task_type come parola o ognuna delle keywords
    for (const row of procedureCache.rows) {
      const type = row.task_type.toLowerCase()
      const typeRegex = new RegExp(`\\b${esc(type)}\\b`, 'i')
      if (typeRegex.test(text)) return row.task_type
      for (const kw of row.keywords) {
        if (!kw) continue
        const kwLower = kw.toLowerCase()
        const kwRegex = new RegExp(`\\b${esc(kwLower)}\\b`, 'i')
        if (kwRegex.test(text)) return row.task_type
      }
    }
  } catch (err) {
    console.error('[working-memory] inferTaskType error:', err instanceof Error ? err.message : err)
  }

  // Fallback regex (7 tipi storici)
  return inferTaskTypeRegex(userQuery)
}

/**
 * Crea una procedura NUOVA (tipo-documento non ancora conosciuto).
 * Ritorna false se esiste già (usa registra_apprendimento per aggiungere lezioni).
 *
 * Normalizza taskType: lowercase, trim, solo [a-z0-9_-].
 * Non lancia mai: best-effort.
 */
export async function createProcedure(input: {
  taskType: string
  title: string
  keywords?: string[]
  checklist?: string[]
  outputSpec?: string
  saveLocation?: string
}): Promise<boolean> {
  try {
    const taskType = normalizeTaskType(input.taskType)
    if (!taskType || !input.title?.trim()) {
      console.warn('[working-memory] createProcedure: taskType o title mancante')
      return false
    }

    const supabase = getSupabaseServer()

    // Verifica esistenza
    const { data: existing, error: selErr } = await supabase
      .from('procedures')
      .select('id')
      .eq('task_type', taskType)
      .maybeSingle()

    if (selErr) {
      console.error('[working-memory] createProcedure select failed:', selErr.message)
      return false
    }
    if (existing) {
      console.warn(`[working-memory] createProcedure: task_type="${taskType}" esiste già`)
      return false
    }

    // Costruisci la checklist nel formato [{step, source?}]
    const checklist: ChecklistStep[] = (input.checklist ?? []).map((s) => ({ step: s }))

    // Normalizza keywords: lowercase + trim, scarta vuote
    const normalizedKeywords = (input.keywords ?? [])
      .map((k) => k.toLowerCase().trim())
      .filter((k) => k.length > 0)

    const row: Record<string, unknown> = {
      task_type: taskType,
      title: input.title.trim(),
      checklist,
      lessons: [],
      keywords: normalizedKeywords,
      updated_at: new Date().toISOString(),
    }
    if (input.outputSpec !== undefined) row.output_spec = input.outputSpec
    if (input.saveLocation !== undefined) row.save_location = input.saveLocation

    const { error: insErr } = await supabase.from('procedures').insert(row)
    if (insErr) {
      console.error('[working-memory] createProcedure insert failed:', insErr.message)
      return false
    }

    // Invalida la cache così inferTaskType vede subito il nuovo tipo
    invalidateProcedureCache()
    return true
  } catch (err) {
    console.error('[working-memory] createProcedure error:', err instanceof Error ? err.message : err)
    return false
  }
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
      .select('id, task_type, title, checklist, output_spec, save_location, lessons, keywords, output_preferences, updated_at')
      .eq('task_type', taskType)
      .maybeSingle()

    if (error) {
      console.error('[working-memory] getProcedure read failed:', error.message)
      return null
    }
    if (!data) return null

    const checklist = Array.isArray(data.checklist) ? (data.checklist as ChecklistStep[]) : []
    const lessons = Array.isArray(data.lessons) ? (data.lessons as string[]) : []
    const keywords = Array.isArray(data.keywords) ? (data.keywords as string[]) : []
    // Degrada con grazia se la colonna manca (campo undefined) → array vuoto.
    const outputPreferences = Array.isArray(data.output_preferences)
      ? (data.output_preferences as string[])
      : []
    return {
      id: data.id,
      task_type: data.task_type,
      title: data.title,
      checklist,
      output_spec: data.output_spec ?? null,
      save_location: data.save_location ?? null,
      lessons,
      keywords,
      output_preferences: outputPreferences,
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
    invalidateProcedureCache()
    return true
  } catch (err) {
    console.error('[working-memory] addLesson error:', err instanceof Error ? err.message : err)
    return false
  }
}

/** Imposta output_preferences su una procedura (auto-debrief). Best-effort. */
export async function setOutputPreferences(
  taskType: string,
  prefs: string[],
  updatedBy = 'cervellone:auto-debrief',
): Promise<boolean> {
  try {
    if (!taskType || !prefs?.length) return false
    const supabase = getSupabaseServer()
    const { error } = await supabase
      .from('procedures')
      .update({ output_preferences: prefs, updated_by: updatedBy, updated_at: new Date().toISOString() })
      .eq('task_type', normalizeTaskType(taskType))
    if (error) {
      console.error('[working-memory] setOutputPreferences:', error.message)
      return false
    }
    invalidateProcedureCache()
    return true
  } catch (e) {
    console.error('[working-memory] setOutputPreferences err:', e instanceof Error ? e.message : e)
    return false
  }
}

/** Aggiunge step alla checklist di una procedura senza duplicati (per `step`). Best-effort. */
export async function mergeChecklistSteps(
  taskType: string,
  steps: string[],
  updatedBy = 'cervellone:auto-debrief',
): Promise<boolean> {
  try {
    if (!taskType || !steps?.length) return false
    const supabase = getSupabaseServer()
    const tt = normalizeTaskType(taskType)
    const { data } = await supabase.from('procedures').select('checklist').eq('task_type', tt).maybeSingle()
    const existing = Array.isArray((data as { checklist?: unknown } | null)?.checklist)
      ? (data as { checklist: Array<{ step?: string }> }).checklist
      : []
    const existingSteps = new Set(
      existing.map((c) => (c?.step ?? '').trim().toLowerCase()).filter(Boolean),
    )
    const toAdd = steps
      .map((s) => s.trim())
      .filter((s) => s && !existingSteps.has(s.toLowerCase()))
      .map((s) => ({ step: s }))
    if (!toAdd.length) return true
    const { error } = await supabase
      .from('procedures')
      .update({ checklist: [...existing, ...toAdd], updated_by: updatedBy, updated_at: new Date().toISOString() })
      .eq('task_type', tt)
    if (error) {
      console.error('[working-memory] mergeChecklistSteps:', error.message)
      return false
    }
    invalidateProcedureCache()
    return true
  } catch (e) {
    console.error('[working-memory] mergeChecklistSteps err:', e instanceof Error ? e.message : e)
    return false
  }
}

/** Segna l'ultimo debrief sul progetto attivo (dedup). Best-effort. */
export async function setLastDebriefAt(conversationId: string, whenIso: string): Promise<boolean> {
  try {
    if (!conversationId) return false
    const supabase = getSupabaseServer()
    const { error } = await supabase
      .from('project_state')
      .update({ last_debrief_at: whenIso, updated_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
    if (error) {
      console.error('[working-memory] setLastDebriefAt:', error.message)
      return false
    }
    return true
  } catch (e) {
    console.error('[working-memory] setLastDebriefAt err:', e instanceof Error ? e.message : e)
    return false
  }
}

/**
 * Costruisce il blocco "PROCEDURA OBBLIGATORIA" da iniettare nel system come blocco
 * NON cachato. Best-effort: qualsiasi errore (o task 'altro', o procedura assente) → ''.
 */
export async function buildProcedureContext(userQuery: string): Promise<string> {
  try {
    const taskType = await inferTaskType(userQuery)
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
    // Degrada con grazia se la colonna manca/è vuota: salta la riga.
    if (proc.output_preferences && proc.output_preferences.length > 0) {
      lines.push(`Formato preferito da Raffaele per questo tipo: ${proc.output_preferences.join(', ')}`)
    }
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

/* ===========================================================================
 * FASE 2 — Memoria di PROGETTO ATTIVO (continuità conversazionale)
 *
 * Bug risolto: il bot "perde il filo" di cosa stiamo facendo tra un messaggio
 * e l'altro. Teniamo UN progetto attivo per conversation_id nella tabella
 * `project_state` (migration già pronta). Ogni turno iniettiamo nel system un
 * promemoria di cosa è stato fatto / cosa manca / quali file usare.
 *
 * Tutto best-effort: qualsiasi errore → '' / null / false / no-op.
 *
 * Schema tabella `project_state` (già esistente):
 *   conversation_id text, channel text, project_name, cliente, cantiere,
 *   task_type, status ('active'|'done'), key_files jsonb {}, done jsonb [],
 *   pending jsonb [], decisions jsonb [], updated_at.
 *   Indice unico parziale: un solo status='active' per conversation_id.
 * =========================================================================== */

export interface ProjectState {
  conversation_id: string
  channel?: string | null
  project_name?: string | null
  cliente?: string | null
  cantiere?: string | null
  task_type?: string | null
  status: string
  key_files: Record<string, unknown>
  done: string[]
  pending: string[]
  decisions: string[]
  last_debrief_at?: string | null
  updated_at?: string
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).map((v) => String(v)) : []
}

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Ritorna il progetto attivo (status='active') per quella conversazione, o null.
 * Best-effort: errore/assenza → null. Normalizza i campi jsonb.
 */
export async function getActiveProject(conversationId: string): Promise<ProjectState | null> {
  try {
    if (!conversationId) return null
    const supabase = getSupabaseServer()
    const { data, error } = await supabase
      .from('project_state')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('status', 'active')
      .maybeSingle()

    if (error) {
      console.error('[working-memory] getActiveProject read failed:', error.message)
      return null
    }
    if (!data) return null

    return {
      conversation_id: data.conversation_id,
      channel: data.channel ?? null,
      project_name: data.project_name ?? null,
      cliente: data.cliente ?? null,
      cantiere: data.cantiere ?? null,
      task_type: data.task_type ?? null,
      status: data.status ?? 'active',
      key_files: toObject(data.key_files),
      done: toStringArray(data.done),
      pending: toStringArray(data.pending),
      decisions: toStringArray(data.decisions),
      // Degrada con grazia se la colonna manca (campo undefined) → null.
      last_debrief_at: data.last_debrief_at ?? null,
      updated_at: data.updated_at,
    }
  } catch (err) {
    console.error('[working-memory] getActiveProject error:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * Crea o aggiorna il progetto attivo per la conversazione.
 *
 * - Se esiste già un progetto attivo → UPDATE in MERGE: i campi non passati NON
 *   vengono azzerati. Per gli array (done/pending/decisions): se passati,
 *   SOSTITUISCONO l'esistente; se assenti, restano invariati. Per key_files:
 *   MERGE shallow con l'esistente. Aggiorna sempre updated_at.
 * - Se non esiste → INSERT con conversation_id + fields (status default 'active').
 *
 * Best-effort: ritorna true/false, non lancia mai.
 */
export async function setActiveProject(
  conversationId: string,
  fields: Partial<{
    project_name: string | null
    cliente: string | null
    cantiere: string | null
    task_type: string | null
    channel: string | null
  }> & {
    key_files?: Record<string, unknown>
    done?: string[]
    pending?: string[]
    decisions?: string[]
  },
): Promise<boolean> {
  try {
    if (!conversationId) return false
    const supabase = getSupabaseServer()
    const existing = await getActiveProject(conversationId)
    const now = new Date().toISOString()

    if (existing) {
      // MERGE: parti dai soli campi passati per non azzerare quelli omessi.
      const patch: Record<string, unknown> = { updated_at: now }
      if (fields.project_name !== undefined) patch.project_name = fields.project_name
      if (fields.cliente !== undefined) patch.cliente = fields.cliente
      if (fields.cantiere !== undefined) patch.cantiere = fields.cantiere
      if (fields.task_type !== undefined) patch.task_type = fields.task_type
      if (fields.channel !== undefined) patch.channel = fields.channel
      // array: SOSTITUISCONO se passati
      if (fields.done !== undefined) patch.done = fields.done
      if (fields.pending !== undefined) patch.pending = fields.pending
      if (fields.decisions !== undefined) patch.decisions = fields.decisions
      // key_files: MERGE shallow con l'esistente
      if (fields.key_files !== undefined) {
        patch.key_files = { ...existing.key_files, ...fields.key_files }
      }

      const { error } = await supabase
        .from('project_state')
        .update(patch)
        .eq('conversation_id', conversationId)
        .eq('status', 'active')

      if (error) {
        console.error('[working-memory] setActiveProject update failed:', error.message)
        return false
      }
      return true
    }

    // INSERT nuovo progetto attivo
    const insertRow: Record<string, unknown> = {
      conversation_id: conversationId,
      status: 'active',
      updated_at: now,
    }
    if (fields.project_name !== undefined) insertRow.project_name = fields.project_name
    if (fields.cliente !== undefined) insertRow.cliente = fields.cliente
    if (fields.cantiere !== undefined) insertRow.cantiere = fields.cantiere
    if (fields.task_type !== undefined) insertRow.task_type = fields.task_type
    if (fields.channel !== undefined) insertRow.channel = fields.channel
    if (fields.key_files !== undefined) insertRow.key_files = fields.key_files
    if (fields.done !== undefined) insertRow.done = fields.done
    if (fields.pending !== undefined) insertRow.pending = fields.pending
    if (fields.decisions !== undefined) insertRow.decisions = fields.decisions

    const { error } = await supabase.from('project_state').insert(insertRow)
    if (error) {
      console.error('[working-memory] setActiveProject insert failed:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.error('[working-memory] setActiveProject error:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Chiude il progetto attivo (status='active' → 'done') per la conversazione.
 * Best-effort: ritorna true/false, non lancia mai.
 */
export async function closeActiveProject(conversationId: string): Promise<boolean> {
  try {
    if (!conversationId) return false
    const supabase = getSupabaseServer()
    const { error } = await supabase
      .from('project_state')
      .update({ status: 'done', updated_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .eq('status', 'active')

    if (error) {
      console.error('[working-memory] closeActiveProject update failed:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.error('[working-memory] closeActiveProject error:', err instanceof Error ? err.message : err)
    return false
  }
}

/** 7 giorni: oltre questa soglia un progetto 'active' dimenticato non viene più iniettato.
 *  Audit 6 giu (P1): un progetto 'active' dimenticato sopravvive a /nuova per sempre
 *  (conversationId deterministico); oltre 7gg di inattività non viene più iniettato. */
const STALE_PROJECT_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Costruisce il blocco "PROGETTO ATTIVO" da iniettare nel system (NON cachato).
 * Best-effort: nessuna conversazione / nessun progetto attivo / errore → ''.
 */
export async function buildActiveProjectContext(conversationId?: string): Promise<string> {
  try {
    if (!conversationId) return ''
    const proj = await getActiveProject(conversationId)
    if (!proj) return ''

    // Stale filter: progetto non aggiornato da più di 7 giorni → non iniettare.
    // Fail-open: se updated_at mancante, lasciamo passare (non sappiamo quando è stato toccato).
    if (proj.updated_at) {
      const age = Date.now() - new Date(proj.updated_at).getTime()
      if (age > STALE_PROJECT_MS) return ''
    }

    const lines: string[] = []
    lines.push('=== PROGETTO ATTIVO (continua questo lavoro) ===')

    const head: string[] = []
    if (proj.project_name) head.push(`Progetto: ${proj.project_name}`)
    if (proj.cliente) head.push(`Cliente: ${proj.cliente}`)
    if (proj.cantiere) head.push(`Cantiere: ${proj.cantiere}`)
    if (proj.task_type) head.push(`Tipo: ${proj.task_type}`)
    if (head.length > 0) lines.push(head.join(' — '))

    const fileEntries = Object.entries(proj.key_files)
    if (fileEntries.length > 0) {
      const filesStr = fileEntries.map(([k, v]) => `${k}=${String(v)}`).join(', ')
      lines.push(`File chiave: ${filesStr}`)
    }
    if (proj.done.length > 0) lines.push(`Fatto: ${proj.done.join('; ')}`)
    if (proj.pending.length > 0) lines.push(`Manca: ${proj.pending.join('; ')}`)
    if (proj.decisions.length > 0) lines.push(`Decisioni: ${proj.decisions.join('; ')}`)

    lines.push('Aggiorna lo stato con aggiorna_progetto man mano che procedi.')
    lines.push('=== fine progetto attivo ===')

    return lines.join('\n')
  } catch (err) {
    console.error('[working-memory] buildActiveProjectContext error:', err instanceof Error ? err.message : err)
    return ''
  }
}

/**
 * Contesto completo di working-memory: progetto attivo + procedura obbligatoria.
 * Concatena i blocchi non vuoti con doppio newline. Entrambi best-effort.
 */
export async function buildWorkingContext(userQuery: string, conversationId?: string): Promise<string> {
  const blocks: string[] = []
  try {
    const projectBlock = await buildActiveProjectContext(conversationId)
    if (projectBlock) blocks.push(projectBlock)
  } catch (err) {
    console.error('[working-memory] buildWorkingContext project error:', err instanceof Error ? err.message : err)
  }
  try {
    const procedureBlock = await buildProcedureContext(userQuery)
    if (procedureBlock) blocks.push(procedureBlock)
  } catch (err) {
    console.error('[working-memory] buildWorkingContext procedure error:', err instanceof Error ? err.message : err)
  }
  return blocks.join('\n\n')
}
