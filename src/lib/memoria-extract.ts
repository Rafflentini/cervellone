// src/lib/memoria-extract.ts — Orchestrator cron memoria-extract
// Eseguito dal cron giornaliero per estrarre fatti e entità dalle conversazioni del giorno precedente.
// Spec: docs/superpowers/plans/2026-05-07-cervellone-memoria-persistente.md §Task 6

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '@/lib/supabase'
import { getActiveModel } from '@/lib/circuit-breaker'

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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractResult {
  ok: boolean
  skipped?: boolean
  conversations: number
  entities: number
  tokens: number
  cost_usd: number
  error?: string
}

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

    const msgList = msgs ?? []

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
    const groups = new Map<string, typeof msgList>()
    for (const msg of msgList) {
      const key = (msg as any).conversation_id ?? 'unknown'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(msg)
    }

    // Step 6: determina modello — Sonnet 4.6 per default, fallback via Circuit Breaker
    const circuitModel = await getActiveModel()
    // Per extraction usiamo sempre Sonnet (costo) ma rispettiamo fallback a stable
    // se il Circuit Breaker è in ROLLED_BACK e il modello stable è < Opus, usiamo Sonnet comunque.
    const model = circuitModel.includes('opus') ? 'claude-sonnet-4-6' : circuitModel

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const allEntita: Array<{ name: string; type: string; context: string }> = []
    const allSummaries: string[] = []
    let totalInputTokens = 0
    let totalOutputTokens = 0

    // Step 6 (cont.): Per ogni gruppo → call Anthropic
    for (const [convId, convMsgs] of groups.entries()) {
      const transcript = convMsgs
        .map((m: any) => `[${m.role}]: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
        .join('\n')

      try {
        const resp = await client.messages.create({
          model,
          max_tokens: 1024,
          system: EXTRACTION_PROMPT,
          messages: [
            {
              role: 'user',
              content: `Conversazione (${convId}):\n${transcript}`,
            },
          ],
        })

        totalInputTokens += resp.usage?.input_tokens ?? 0
        totalOutputTokens += resp.usage?.output_tokens ?? 0

        const textBlock = resp.content.find((b: any) => b.type === 'text')
        if (textBlock && textBlock.type === 'text') {
          try {
            const parsed = JSON.parse((textBlock as any).text)
            if (parsed.summary) allSummaries.push(parsed.summary)
            if (Array.isArray(parsed.entita)) allEntita.push(...parsed.entita)
          } catch {
            // JSON malformato: skip questa conversazione, log warning
            console.warn(`[memoria-extract] JSON parse error for conv ${convId} — skipping`)
          }
        }
      } catch (err) {
        // Errore LLM per questa conversazione: propaga come errore totale (spec: step 10)
        throw err
      }
    }

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

    // Step 8: UPDATE runs status='ok'
    await supabase.from('cervellone_memoria_extraction_runs').update({
      status: 'ok',
      completed_at: new Date().toISOString(),
      conversations_count: conversationIds.length,
      entities_count: entitaDeduplicate.size,
      llm_cost_estimate_usd: costUsd,
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
