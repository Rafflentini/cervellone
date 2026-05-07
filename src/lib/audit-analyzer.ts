// src/lib/audit-analyzer.ts — Analisi thresholds + format report self-audit
// Pure logic: nessuna dipendenza Supabase o Anthropic.
// Spec: docs/superpowers/specs/2026-05-07-cervellone-self-audit-design.md §4-5

import type { DimensionResult, ModelHealthData, BreakerEventsData, GmailHealthData, MemoriaRunsData, CostEstimateData } from './audit-collector'

// ── Types pubblici ─────────────────────────────────────────────────────────────

export type Severity = 'high' | 'medium' | 'info'

export interface Anomaly {
  code: string
  severity: Severity
  description: string
  proposed_action: string
  raw?: unknown
}

export interface AnalysisInput {
  modelHealth: DimensionResult<ModelHealthData>
  breakerEvents: DimensionResult<BreakerEventsData>
  gmailHealth: DimensionResult<GmailHealthData>
  memoriaRuns: DimensionResult<MemoriaRunsData>
  costEstimate: DimensionResult<CostEstimateData>
}

export interface AnalysisResult {
  anomalies: Anomaly[]
  summary: {
    error_rate_pct: number
    hallucination_rate_pct: number
    total_cost: number
    avg_per_day: number
    breaker_events: number
    gmail_actions_count: number
    memoria_ok_count: number
    memoria_error_count: number
    anomalies_count: number
  }
}

// ── Thresholds ─────────────────────────────────────────────────────────────────

const THRESHOLD_MODEL_ERROR_RATE = 0.05      // 5%
const THRESHOLD_HALLUCINATION_RATE = 0.02    // 2%
const THRESHOLD_GMAIL_DEAD_DAYS = 5          // 5 giorni senza attività = anomalia
const THRESHOLD_GMAIL_FLOOD_PER_DAY = 20    // >20 critici/giorno = flood
const THRESHOLD_COST_PER_DAY = 1.0          // $1/giorno
const THRESHOLD_COST_BUDGET_7D = 10.0       // $10 in 7 giorni

// ── analyze ───────────────────────────────────────────────────────────────────

/**
 * Analizza l'input raccolto e produce Anomaly[] + summary.
 * Funzione pura: stesso input → stesso output.
 */
export function analyze(input: AnalysisInput): AnalysisResult {
  const anomalies: Anomaly[] = []

  // ── D1: Model Health ────────────────────────────────────────────────────────
  let error_rate_pct = 0
  let hallucination_rate_pct = 0

  if (input.modelHealth.ok && input.modelHealth.data) {
    const d = input.modelHealth.data
    error_rate_pct = parseFloat((d.error_rate * 100).toFixed(2))
    hallucination_rate_pct = parseFloat((d.hallucination_rate * 100).toFixed(2))

    if (d.error_rate > THRESHOLD_MODEL_ERROR_RATE) {
      anomalies.push({
        code: 'MODEL_ERROR_HIGH',
        severity: 'high',
        description: `Tasso errori modello ${error_rate_pct}% (soglia 5%). ${d.total} chiamate analizzate.`,
        proposed_action: 'Verifica log model_health per errori ricorrenti. Valuta rollback modello.',
        raw: { error_rate: d.error_rate, total: d.total },
      })
    }

    if (d.hallucination_rate > THRESHOLD_HALLUCINATION_RATE) {
      anomalies.push({
        code: 'MODEL_HALLUCINATION',
        severity: 'high',
        description: `Tasso allucinazioni ${hallucination_rate_pct}% (soglia 2%). Possibile degradazione qualità output.`,
        proposed_action: 'Ispeziona conversazioni con outcome=hallucination. Revisiona prompt di sistema.',
        raw: { hallucination_rate: d.hallucination_rate },
      })
    }
  }

  // ── D2: Circuit Breaker ─────────────────────────────────────────────────────
  let breaker_events = 0

  if (input.breakerEvents.ok && input.breakerEvents.data) {
    const d = input.breakerEvents.data
    breaker_events = d.events.length

    if (d.trip_count >= 1) {
      anomalies.push({
        code: 'BREAKER_TRIP',
        severity: 'medium',
        description: `${d.trip_count} evento/i trip circuit breaker negli ultimi 7 giorni (api_error/timeout).`,
        proposed_action: 'Controlla stato API Anthropic. Verifica ANTHROPIC_API_KEY. Monitora canary nelle prossime 24h.',
        raw: { trip_count: d.trip_count, events: d.events.slice(0, 3) },
      })
    }

    if (d.recovery_count >= 1) {
      anomalies.push({
        code: 'BREAKER_RECOVERY',
        severity: 'info',
        description: `${d.recovery_count} recovery circuit breaker (empty response) negli ultimi 7 giorni.`,
        proposed_action: 'Monitoraggio informativo. Nessuna azione urgente richiesta.',
        raw: { recovery_count: d.recovery_count },
      })
    }
  }

  // ── D3: Gmail Health ────────────────────────────────────────────────────────
  let gmail_actions_count = 0

  if (input.gmailHealth.ok && input.gmailHealth.data) {
    const rows = input.gmailHealth.data.rows
    gmail_actions_count = rows.reduce((sum, r) => sum + r.n, 0)

    // Conta giorni distinti con notified_critical
    const criticalDays = new Set(
      rows.filter(r => r.bot_action === 'notified_critical').map(r => r.day)
    )
    // Conta giorni distinti con in_summary
    const summaryDays = new Set(
      rows.filter(r => r.bot_action === 'in_summary').map(r => r.day)
    )

    if (criticalDays.size === 0) {
      anomalies.push({
        code: 'GMAIL_ALERTS_DEAD',
        severity: 'high',
        description: `Nessuna mail critica notificata negli ultimi 7 giorni. Possibile malfunzionamento cron gmail-alerts.`,
        proposed_action: 'Verifica cron gmail-alerts in Vercel. Controlla autorizzazione Gmail OAuth. Testa manualmente /api/cron/gmail-alerts.',
        raw: { critical_days: 0 },
      })
    }

    if (summaryDays.size === 0) {
      anomalies.push({
        code: 'GMAIL_MORNING_DEAD',
        severity: 'high',
        description: `Nessun riepilogo mattutino inviato negli ultimi 7 giorni. Possibile malfunzionamento cron gmail-morning.`,
        proposed_action: 'Verifica cron gmail-morning in Vercel. Controlla autorizzazione Gmail OAuth. Testa manualmente /api/cron/gmail-morning.',
        raw: { summary_days: 0 },
      })
    }

    // Spike: giorno con >20 notified_critical
    const floodDay = rows.find(r => r.bot_action === 'notified_critical' && r.n > THRESHOLD_GMAIL_FLOOD_PER_DAY)
    if (floodDay) {
      anomalies.push({
        code: 'GMAIL_ALERT_FLOOD',
        severity: 'medium',
        description: `Flood alert: ${floodDay.n} mail critiche notificate il ${floodDay.day} (soglia 20/gg).`,
        proposed_action: 'Verifica filtri gmail-classifier. Possibile spam o regole troppo aggressive.',
        raw: { day: floodDay.day, n: floodDay.n },
      })
    }
  }

  // ── D4: Memoria Runs ────────────────────────────────────────────────────────
  let memoria_ok_count = 0
  let memoria_error_count = 0

  if (input.memoriaRuns.ok && input.memoriaRuns.data) {
    const d = input.memoriaRuns.data
    memoria_ok_count = d.ok_count
    memoria_error_count = d.error_count

    if (d.error_count >= 1) {
      const errRun = d.runs.find(r => r.status === 'error')
      anomalies.push({
        code: 'MEMORIA_ERROR',
        severity: 'high',
        description: `${d.error_count} run memoria-extract fallita/e negli ultimi 7 giorni.`,
        proposed_action: 'Controlla log memoria-extract. Verifica connessione Supabase e credenziali Anthropic.',
        raw: { error_count: d.error_count, last_error: errRun?.error_message },
      })
    }

    if (d.missing_dates.length > 0) {
      anomalies.push({
        code: 'MEMORIA_GAP',
        severity: 'medium',
        description: `${d.missing_dates.length} giorno/i senza run memoria-extract: ${d.missing_dates.slice(0, 3).join(', ')}${d.missing_dates.length > 3 ? '...' : ''}.`,
        proposed_action: 'Verifica cron memoria-extract. Possibile run saltata per silenzio o errore non registrato.',
        raw: { missing_dates: d.missing_dates },
      })
    }
  }

  // ── D5: Costo ───────────────────────────────────────────────────────────────
  let total_cost = 0
  let avg_per_day = 0

  if (input.costEstimate.ok && input.costEstimate.data) {
    const d = input.costEstimate.data
    total_cost = d.total_7d
    avg_per_day = d.avg_per_day

    if (d.avg_per_day > THRESHOLD_COST_PER_DAY) {
      anomalies.push({
        code: 'COST_HIGH',
        severity: 'medium',
        description: `Costo medio $${d.avg_per_day.toFixed(3)}/giorno (soglia $1.00). Totale 7gg: $${d.total_7d.toFixed(3)}.`,
        proposed_action: 'Analizza distribuzione costi per cron. Valuta riduzione frequenza o ottimizzazione prompt.',
        raw: { avg_per_day: d.avg_per_day, total_7d: d.total_7d },
      })
    }

    if (d.total_7d > THRESHOLD_COST_BUDGET_7D) {
      anomalies.push({
        code: 'COST_BUDGET_BREACH',
        severity: 'high',
        description: `Costo totale settimanale $${d.total_7d.toFixed(3)} supera budget $10/settimana.`,
        proposed_action: 'Azione immediata: rivedi automazioni attive. Disabilita temporaneamente cron non critici.',
        raw: { total_7d: d.total_7d },
      })
    }
  }

  return {
    anomalies,
    summary: {
      error_rate_pct,
      hallucination_rate_pct,
      total_cost,
      avg_per_day,
      breaker_events,
      gmail_actions_count,
      memoria_ok_count,
      memoria_error_count,
      anomalies_count: anomalies.length,
    },
  }
}

// ── formatReport ──────────────────────────────────────────────────────────────

/**
 * Produce report Markdown dal template spec §5.
 * Funzione pura: output dipende solo dagli argomenti.
 */
export function formatReport(
  result: AnalysisResult,
  isoWeek: string,
  narrative: string,
  runId: string,
): string {
  const s = result.summary
  const anomalies = result.anomalies

  // Sezione anomalie
  let anomaliesSection: string
  if (anomalies.length === 0) {
    anomaliesSection = 'Nessuna anomalia rilevata.'
  } else {
    anomaliesSection = anomalies
      .map((a, i) => `${i + 1}. *[${a.severity}]* ${a.code}: ${a.description}\n   → Proposta: ${a.proposed_action}`)
      .join('\n\n')
  }

  // Model summary
  const modelSummary = s.error_rate_pct > 0
    ? `err ${s.error_rate_pct}%`
    : 'ok'

  // Gmail summary
  const gmailSummary = `${s.gmail_actions_count} azioni`

  return `*🧠 Self-audit Cervellone — settimana ${isoWeek}*

📊 *Sintesi*
${narrative}

🔍 *Dimensioni monitorate*
• Modelli: ${modelSummary} (err ${s.error_rate_pct}%)
• Circuit breaker: ${s.breaker_events} eventi
• Mail: ${gmailSummary}
• Memoria: ${s.memoria_ok_count}/7 ok, costo $${s.total_cost.toFixed(3)}
• Costo totale 7gg: $${s.total_cost.toFixed(3)}

⚠️ *Anomalie rilevate (${anomalies.length})*
${anomaliesSection}

🛠 *Per autorizzare un'azione*
Rispondi con: \`apri PR su anomalia <numero>\` oppure \`ignora anomalia <numero>\`
o \`silenzia audit per N giorni\`.

_Run id: ${runId}_`
}
