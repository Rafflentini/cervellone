// src/lib/audit-runner.ts — Orchestrator cron self-audit settimanale
// Spec: docs/superpowers/specs/2026-05-07-cervellone-self-audit-design.md §2
// Pattern identico a memoria-extract.ts

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '@/lib/supabase'
import {
  collectModelHealth,
  collectBreakerEvents,
  collectGmailHealth,
  collectMemoriaRuns,
  collectCostEstimate,
} from './audit-collector'
import { analyze, formatReport } from './audit-analyzer'
import type { AnalysisInput } from './audit-analyzer'
import { sendTelegramMessage } from './telegram-helpers'

// ── Helper: ISO Week string ───────────────────────────────────────────────────

/**
 * Calcola ISO week number (ISO 8601).
 * Settimana 1 = settimana che contiene il primo giovedì dell'anno.
 */
export function getISOWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7 // Converti domenica da 0 a 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  const year = d.getUTCFullYear()
  return `${year}-W${String(weekNo).padStart(2, '0')}`
}

// ── Cost estimate (Sonnet 4.6 pricing) ───────────────────────────────────────

function estimateCost(inputTokens: number, outputTokens: number): number {
  return parseFloat(((inputTokens * 0.000003) + (outputTokens * 0.000015)).toFixed(6))
}

// ── Result type ───────────────────────────────────────────────────────────────

export interface RunAuditResult {
  ok: boolean
  run_id?: string
  anomalies_count?: number
  iso_week?: string
  error?: string
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * runAudit(): orchestrator self-audit settimanale.
 * 1. Legge audit_model da cervellone_config
 * 2. INSERT audit_runs (status='started')
 * 3. Promise.allSettled 5 collector
 * 4. analyze → AnalysisResult
 * 5. Sonnet narrative (try/catch → fallback statico)
 * 6. formatReport
 * 7. sendTelegramMessage
 * 8. UPDATE audit_runs status='ok'
 */
export async function runAudit(): Promise<RunAuditResult> {
  const isoWeek = getISOWeek(new Date())

  // Step 1: leggi audit_model da config (default claude-sonnet-4-6)
  let auditModel = 'claude-sonnet-4-6'
  try {
    const { data: configRow } = await supabase
      .from('cervellone_config')
      .select('value')
      .eq('key', 'audit_model')
      .maybeSingle()

    if (configRow?.value) {
      const parsed = typeof configRow.value === 'string'
        ? configRow.value.replace(/"/g, '')
        : configRow.value
      if (parsed && typeof parsed === 'string') auditModel = parsed
    }
  } catch {
    // fallback silenzioso
  }

  // Step 2: INSERT audit_runs (status='started')
  const { data: runData, error: runInsertErr } = await supabase
    .from('cervellone_audit_runs')
    .insert({ iso_week: isoWeek, status: 'started' })
    .select('run_id')

  if (runInsertErr) {
    return { ok: false, error: `Insert audit run: ${runInsertErr.message}` }
  }

  const runId: string = runData?.[0]?.run_id ?? 'unknown'

  try {
    // Step 3: Promise.allSettled 5 collector (paralleli)
    const [mhResult, beResult, ghResult, mrResult, ceResult] = await Promise.allSettled([
      collectModelHealth(),
      collectBreakerEvents(),
      collectGmailHealth(),
      collectMemoriaRuns(),
      collectCostEstimate(),
    ])

    // Estrai valori, log warn per falliti
    function settle<T>(res: PromiseSettledResult<T>, name: string): T | { ok: false; error: string } {
      if (res.status === 'fulfilled') return res.value
      console.warn(`[audit-runner] collector ${name} failed:`, res.reason)
      return { ok: false, error: String(res.reason) }
    }

    const analysisInput: AnalysisInput = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      modelHealth: settle(mhResult, 'modelHealth') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      breakerEvents: settle(beResult, 'breakerEvents') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gmailHealth: settle(ghResult, 'gmailHealth') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      memoriaRuns: settle(mrResult, 'memoriaRuns') as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      costEstimate: settle(ceResult, 'costEstimate') as any,
    }

    // Step 4: analyze
    const analysisResult = analyze(analysisInput)
    const { anomalies, summary } = analysisResult

    // Step 5: Sonnet narrative (try/catch → fallback statico)
    let narrative: string
    let llmTokensUsed = 0
    let llmCostUsd = 0

    try {
      const client = new Anthropic()
      const llmResponse = await client.messages.create({
        model: auditModel,
        max_tokens: 400,
        messages: [
          {
            role: 'user',
            content: `Sei un assistente che produce sintesi tecniche concise.
Dato l'input strutturato, genera 2-4 frasi in italiano che descrivono
lo stato della settimana, indicando anomalie principali se presenti.
NON inventare anomalie: usa solo quelle nell'input. Tono neutro fattuale.
Input: ${JSON.stringify({ iso_week: isoWeek, anomalies: anomalies.map(a => ({ code: a.code, severity: a.severity, description: a.description })), summary })}
Output: solo testo markdown-safe, no JSON, no code block.`,
          },
        ],
      })

      const textBlock = llmResponse.content.find((b: { type: string }) => b.type === 'text') as { type: 'text'; text: string } | undefined
      narrative = textBlock?.text ?? (anomalies.length > 0
        ? `Settimana con ${anomalies.length} anomalie rilevate (vedi sotto).`
        : 'Settimana stabile, nessuna anomalia.')

      llmTokensUsed = (llmResponse.usage?.input_tokens ?? 0) + (llmResponse.usage?.output_tokens ?? 0)
      llmCostUsd = estimateCost(llmResponse.usage?.input_tokens ?? 0, llmResponse.usage?.output_tokens ?? 0)
    } catch (err) {
      console.warn('[audit-runner] LLM narrative fallita:', err instanceof Error ? err.message : err)
      narrative = anomalies.length > 0
        ? `Settimana con ${anomalies.length} anomalie rilevate (vedi sotto).`
        : 'Settimana stabile, nessuna anomalia.'
    }

    // Step 6: formatReport
    const reportText = formatReport(analysisResult, isoWeek, narrative, runId)

    // Step 7: sendTelegramMessage
    const chatId = parseInt(process.env.TELEGRAM_ALLOWED_IDS!.split(',')[0], 10)
    await sendTelegramMessage(chatId, reportText)

    // Step 8: UPDATE audit_runs status='ok'
    await supabase
      .from('cervellone_audit_runs')
      .update({
        status: 'ok',
        completed_at: new Date().toISOString(),
        anomalies_count: anomalies.length,
        dimensions_json: {
          modelHealth: analysisInput.modelHealth.ok ? analysisInput.modelHealth.data : null,
          breakerEvents: analysisInput.breakerEvents.ok ? analysisInput.breakerEvents.data : null,
          gmailHealth: analysisInput.gmailHealth.ok ? analysisInput.gmailHealth.data : null,
          memoriaRuns: analysisInput.memoriaRuns.ok ? analysisInput.memoriaRuns.data : null,
          costEstimate: analysisInput.costEstimate.ok ? analysisInput.costEstimate.data : null,
        },
        anomalies_json: anomalies,
        report_text: reportText,
        llm_tokens_used: llmTokensUsed,
        llm_cost_estimate_usd: llmCostUsd,
      })
      .eq('run_id', runId)

    return {
      ok: true,
      run_id: runId,
      anomalies_count: anomalies.length,
      iso_week: isoWeek,
    }

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    console.error('[audit-runner] runAudit failed:', errorMsg)

    // UPDATE status='error'
    await supabase
      .from('cervellone_audit_runs')
      .update({ status: 'error', error_message: errorMsg })
      .eq('run_id', runId)

    return { ok: false, run_id: runId, error: errorMsg }
  }
}
