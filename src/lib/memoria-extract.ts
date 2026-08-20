// src/lib/memoria-extract.ts — Orchestrator cron memoria-extract
// Eseguito dal cron giornaliero per estrarre fatti e entità dalle conversazioni del giorno precedente.
// Spec: docs/superpowers/plans/2026-05-07-cervellone-memoria-persistente.md §Task 6

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '@/lib/supabase'
import { getActiveModel } from '@/lib/circuit-breaker'
import { logApiUsage } from '@/lib/api-usage'

// ── Prompt extraction conservativa (letterale da spec) ────────────────────────

const EXTRACTION_PROMPT = `Sei un estrattore di FATTI VERIFICABILI da conversazioni di un'agenzia tecnica.
Dalle conversazioni qui sotto, estrai SOLO:
1. Entità named (clienti, cantieri, fornitori menzionati per NOME esplicito)
2. Date e scadenze esplicite ("il 15 maggio", "DURC scade ad agosto", "lunedì 8")
3. Eventi fattuali oggettivi ("ho mandato preventivo", "sopralluogo eseguito", "ricevuto DURC")

NON estrarre:
- Decisioni morbide ("forse passiamo")
- Valutazioni ("Bianchi è cliente difficile")
- Inferenze emotive
- Opinioni o previsioni

Output JSON strutturato:
{
  "summary": "1-2 frasi di sintesi fattuale della giornata",
  "entita": [{"name": "...", "type": "cliente|cantiere|fornitore", "context": "..."}],
  "eventi": [{"data_iso": "YYYY-MM-DD?", "descrizione": "..."}]
}

Se la giornata è vuota o non contiene fatti rilevanti, output: {"summary": "Nessuna attività rilevante", "entita": [], "eventi": []}.`

// ── Costanti estrazione ────────────────────────────────────────────────────────

const CHUNK_CHAR_BUDGET = 40_000
const MAX_OUTPUT_TOKENS = 4096

/** Spezza il transcript sui confini di riga, senza mai superare budget caratteri. */
export function chunkTranscript(transcript: string, budget = CHUNK_CHAR_BUDGET): string[] {
  if (transcript.length <= budget) return [transcript]
  const chunks: string[] = []
  let cur = ''
  for (const rawLine of transcript.split('\n')) {
    const parts = Math.max(1, Math.ceil(rawLine.length / budget))
    for (let i = 0; i < parts; i++) {
      const piece = rawLine.slice(i * budget, (i + 1) * budget)
      if (cur.length + piece.length + 1 > budget && cur.length > 0) {
        chunks.push(cur)
        cur = ''
      }
      cur += (cur ? '\n' : '') + piece
    }
  }
  if (cur) chunks.push(cur)
  return chunks
}

export interface ExtractionPayload {
  summary?: string
  entita?: Array<{ name: string; type: string; context: string }>
  eventi?: Array<{ data_iso?: string; descrizione: string }>
}

/** Legge il JSON anche se il modello lo incornicia o lo fa precedere da testo. Null se irrecuperabile. */
export function parseExtraction(text: string): ExtractionPayload | null {
  const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  try {
    return JSON.parse(cleaned) as ExtractionPayload
  } catch {
    // passa al recupero
  }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as ExtractionPayload
    } catch {
      // irrecuperabile
    }
  }
  return null
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractResult {
  ok: boolean
  skipped?: boolean
  conversations: number
  entities: number
  tokens: number
  cost_usd: number
  error?: string
  skipped_chunks?: number
}

interface MemoriaMessageRow {
  id: string
  conversation_id: string | null
  role: string
  content: unknown
  created_at: string
}

type AnthropicTextBlock = Anthropic.TextBlock

// ── Cost estimate (Sonnet 4.6 pricing) ────────────────────────────────────────
// Formula: (input_tokens * $3/M) + (output_tokens * $15/M)
// Approssimazione con split esatto se disponibile, altrimenti 80/20.

function estimateCost(inputTokens: number, outputTokens: number): number {
  return parseFloat(
    ((inputTokens * 0.000003) + (outputTokens * 0.000015)).toFixed(6)
  )
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Estrae fatti, entità e summary dalle conversazioni di `dateTarget`.
 * Se `dateTarget` non è passato, usa ieri (UTC).
 * Idempotente: se `memoria_extract_last_run` in cervellone_config = dateTarget, skip.
 */
export async function runMemoriaExtract(dateTarget?: string): Promise<ExtractResult> {

  // Step 1: determina target (default: ieri)
  const target = dateTarget ?? (() => {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - 1)
    return d.toISOString().slice(0, 10)
  })()

  // Step 2: idempotency check
  const { data: lastRunRow } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'memoria_extract_last_run')
    .maybeSingle()

  const lastRun = typeof lastRunRow?.value === 'string'
    ? lastRunRow.value.replace(/"/g, '')
    : null

  if (lastRun === target) {
    console.log(`[memoria-extract] idempotency: already ran for ${target}, skip`)
    return { ok: true, skipped: true, conversations: 0, entities: 0, tokens: 0, cost_usd: 0 }
  }

  // Step 3: INSERT run row (status='started')
  const { data: runData, error: runInsertErr } = await supabase
    .from('cervellone_memoria_extraction_runs')
    .insert({ date_processed: target, status: 'started' })
    .select('run_id')

  if (runInsertErr) {
    return { ok: false, conversations: 0, entities: 0, tokens: 0, cost_usd: 0, error: `Insert run: ${runInsertErr.message}` }
  }

  const runId = runData?.[0]?.run_id

  try {
    // Step 4: SELECT messaggi del giorno target
    const startOfDay = `${target}T00:00:00.000Z`
    const endOfDay = `${target}T23:59:59.999Z`

    const { data: msgs, error: msgsErr } = await supabase
      .from('messages')
      .select('id, conversation_id, role, content, created_at')
      .gte('created_at', startOfDay)
      .lte('created_at', endOfDay)
      .order('conversation_id')
      .order('created_at')

    if (msgsErr) throw new Error(`Fetch messages: ${msgsErr.message}`)

    const msgList: MemoriaMessageRow[] = msgs ?? []

    // Giornata vuota
    if (msgList.length === 0) {
      await supabase.from('cervellone_summary_giornaliero').upsert({
        data: target,
        summary_text: 'Nessuna attività rilevante',
        message_count: 0,
        conversations_json: [],
        llm_tokens_used: 0,
      })

      await supabase.from('cervellone_memoria_extraction_runs').update({
        status: 'ok',
        completed_at: new Date().toISOString(),
        conversations_count: 0,
        entities_count: 0,
        llm_cost_estimate_usd: 0,
      }).eq('run_id', runId)

      await supabase.from('cervellone_config').upsert(
        { key: 'memoria_extract_last_run', value: target },
        { onConflict: 'key' }
      )

      return { ok: true, conversations: 0, entities: 0, tokens: 0, cost_usd: 0 }
    }

    // Step 5: Group by conversation_id
    const groups = new Map<string, MemoriaMessageRow[]>()
    for (const msg of msgList) {
      const key = msg.conversation_id ?? 'unknown'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(msg)
    }

    // Step 6: determina modello — Sonnet 4.6 per default, fallback via Circuit Breaker
    const circuitModel = await getActiveModel()
    const { getConfig } = await import('./claude')
    const { modelAudit } = await getConfig()
    // Per extraction usiamo sempre Sonnet (costo) ma rispettiamo fallback a stable
    // se il Circuit Breaker è in ROLLED_BACK e il modello stable è < Opus, usiamo Sonnet comunque.
    const model = circuitModel.includes('opus') ? modelAudit : circuitModel

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const allEntita: Array<{ name: string; type: string; context: string }> = []
    const allSummaries: string[] = []
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCacheReadTokens = 0
    let totalCacheCreationTokens = 0

    // Step 6 (cont.): Per ogni gruppo → spezza in chunk e chiama Anthropic
    let skippedChunks = 0

    for (const [convId, convMsgs] of groups.entries()) {
      const transcript = convMsgs
        .map(m => `[${m.role}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
        .join('\n')

      const chunks = chunkTranscript(transcript)

      for (let i = 0; i < chunks.length; i++) {
        try {
          const resp = await client.messages.create({
            model,
            max_tokens: MAX_OUTPUT_TOKENS,
            system: EXTRACTION_PROMPT,
            messages: [
              {
                role: 'user',
                content: `Conversazione (${convId}) — parte ${i + 1} di ${chunks.length}:\n${chunks[i]}`,
              },
            ],
          })

          totalInputTokens += resp.usage?.input_tokens ?? 0
          totalOutputTokens += resp.usage?.output_tokens ?? 0
          totalCacheReadTokens += (resp.usage as { cache_read_input_tokens?: number })?.cache_read_input_tokens ?? 0
          totalCacheCreationTokens += (resp.usage as { cache_creation_input_tokens?: number })?.cache_creation_input_tokens ?? 0

          const textBlock = resp.content.find((b): b is AnthropicTextBlock => b.type === 'text')
          const parsed = textBlock ? parseExtraction(textBlock.text) : null

          if (!parsed) {
            skippedChunks++
            console.warn(`[memoria-extract] parte ${i + 1}/${chunks.length} di ${convId} illeggibile (stop_reason=${resp.stop_reason}) — scartata`)
            continue
          }
          if (parsed.summary) allSummaries.push(parsed.summary)
          if (Array.isArray(parsed.entita)) {
            allEntita.push(...parsed.entita)
          } else if (parsed.entita !== undefined) {
            // Il modello ha risposto con 'entita' in una forma inattesa (non un array):
            // non va scartata in silenzio, è un'altra porta per la stessa perdita muta.
            skippedChunks++
            console.warn(`[memoria-extract] parte ${i + 1}/${chunks.length} di ${convId}: campo 'entita' non e un array — entita scartate`)
          }
        } catch (err) {
          // Errore LLM su questa singola parte: non deve far cadere l'intera giornata.
          // Allineato al catch esterno (step 10): niente cast incondizionato a Error,
          // altrimenti un rifiuto non-Error (es. null) esplode qui dentro e la giornata
          // collassa comunque — la stessa patologia che questo task doveva eliminare.
          skippedChunks++
          const msg = err instanceof Error ? err.message : String(err)
          console.warn(`[memoria-extract] parte ${i + 1}/${chunks.length} di ${convId} fallita: ${msg}`)
          continue
        }
      }
    }

    await logApiUsage({
      entryPoint: 'cron:memoria',
      model,
      usage: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cache_read_input_tokens: totalCacheReadTokens,
        cache_creation_input_tokens: totalCacheCreationTokens,
      },
      meta: { date: target, run_id: runId, conversations: groups.size },
    })

    // Step 7a: Aggrega summary
    const summaryAggregato = allSummaries.filter(Boolean).join(' | ') || 'Nessuna attività rilevante'
    const conversationIds = Array.from(groups.keys())
    const costUsd = estimateCost(totalInputTokens, totalOutputTokens)

    // Step 7b: INSERT summary_giornaliero (upsert per idempotency)
    await supabase.from('cervellone_summary_giornaliero').upsert({
      data: target,
      summary_text: summaryAggregato,
      message_count: msgList.length,
      conversations_json: conversationIds,
      llm_tokens_used: totalInputTokens + totalOutputTokens,
    })

    // Step 7c: UPSERT entita_menzionate (dedup per name+type)
    const entitaDeduplicate = new Map<string, { name: string; type: string; context: string }>()
    for (const e of allEntita) {
      const key = `${e.name}|||${e.type}`
      if (!entitaDeduplicate.has(key)) entitaDeduplicate.set(key, e)
    }

    for (const e of entitaDeduplicate.values()) {
      // TODO: atomic increment via stored proc per concurrency futura
      // Per ora: upsert con mention_count=1 (overwrite) — sufficiente per single-cron daily.
      await supabase.from('cervellone_entita_menzionate').upsert({
        name: e.name,
        type: e.type,
        last_seen_at: target,
        mention_count: 1,
        contexts_json: [e.context],
      }, { onConflict: 'name,type' })
    }

    // Step 8: UPDATE runs status='ok'/'partial'
    await supabase.from('cervellone_memoria_extraction_runs').update({
      status: skippedChunks > 0 ? 'partial' : 'ok',
      completed_at: new Date().toISOString(),
      conversations_count: conversationIds.length,
      entities_count: entitaDeduplicate.size,
      llm_cost_estimate_usd: costUsd,
      error_message: skippedChunks > 0 ? `${skippedChunks} parti illeggibili scartate` : null,
    }).eq('run_id', runId)

    // Step 9: UPDATE config last_run
    await supabase.from('cervellone_config').upsert(
      { key: 'memoria_extract_last_run', value: target },
      { onConflict: 'key' }
    )

    return {
      ok: true,
      conversations: conversationIds.length,
      entities: entitaDeduplicate.size,
      tokens: totalInputTokens + totalOutputTokens,
      cost_usd: costUsd,
      skipped_chunks: skippedChunks,
    }

  } catch (err) {
    // Step 10: su errore → UPDATE runs status='error'
    const errorMessage = err instanceof Error ? err.message : String(err)
    console.error('[memoria-extract] fatal error:', errorMessage)

    await supabase.from('cervellone_memoria_extraction_runs').update({
      status: 'error',
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
    }).eq('run_id', runId)

    return {
      ok: false,
      conversations: 0,
      entities: 0,
      tokens: 0,
      cost_usd: 0,
      error: errorMessage,
    }
  }
}
