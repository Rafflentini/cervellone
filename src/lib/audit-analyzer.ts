// src/lib/audit-analyzer.ts — Analisi thresholds + format report self-audit
// Pure logic: nessuna dipendenza Supabase o Anthropic.
// Spec: docs/superpowers/specs/2026-05-07-cervellone-self-audit-design.md §4-5

import type { DimensionResult, ModelHealthData, BreakerEventsData, GmailHealthData, MemoriaRunsData, CostEstimateData, ScadenzeScaduteData } from './audit-collector'

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
  /** Scadenze ancora attive ma gia' passate: invisibili al cron dei promemoria. */
  scadenzeScadute?: DimensionResult<ScadenzeScaduteData>
}

export interface AnalysisResult {
  anomalies: Anomaly[]
  summary: {
    error_rate_pct: number
    hallucination_rate_pct: number
    /** Denominatore della percentuale: senza, "err 100%" non si puo' interpretare. */
    model_calls_total: number
    model_error_count: number
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

// Sotto questo numero di chiamate una percentuale non e' una misura: con UNA
// chiamata sola, un errore fa "100%" e supera qualunque soglia. E' esattamente
// quello che ha fatto il report del 2026-W36 in una settimana di ferie. Sotto il
// minimo si guardano gli errori in numero, che restano veri a ogni campione.
const MIN_SAMPLE_MODEL = 20
// Quanti errori in assoluto meritano comunque una riga, anche a campione piccolo.
const THRESHOLD_MODEL_ERROR_BURST = 3
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
  let model_calls_total = 0
  let model_error_count = 0

  if (input.modelHealth.ok && input.modelHealth.data) {
    const d = input.modelHealth.data
    error_rate_pct = parseFloat((d.error_rate * 100).toFixed(2))
    hallucination_rate_pct = parseFloat((d.hallucination_rate * 100).toFixed(2))

    const campioneSufficiente = d.total >= MIN_SAMPLE_MODEL

    if (campioneSufficiente && d.error_rate > THRESHOLD_MODEL_ERROR_RATE) {
      anomalies.push({
        code: 'MODEL_ERROR_HIGH',
        severity: 'high',
        description: `Tasso errori modello ${error_rate_pct}% (soglia 5%). ${d.total} chiamate analizzate.`,
        proposed_action: 'Verifica log model_health per errori ricorrenti. Valuta rollback modello.',
        raw: { error_rate: d.error_rate, total: d.total },
      })
    }

    // Campione troppo piccolo per una percentuale, ma gli errori restano contabili:
    // tacere del tutto rifarebbe l'errore opposto, cioe' un audit che non vigila.
    if (!campioneSufficiente && (d.error_count ?? 0) >= THRESHOLD_MODEL_ERROR_BURST) {
      anomalies.push({
        code: 'MODEL_ERROR_BURST',
        severity: 'medium',
        description: `${d.error_count} errori modello su ${d.total} chiamate. Troppe poche chiamate per un tasso (minimo ${MIN_SAMPLE_MODEL}), ma sono molti in assoluto.`,
        proposed_action: 'Ispeziona le singole righe model_health: a questo volume vanno lette una per una, non mediate.',
        raw: { error_count: d.error_count, total: d.total },
      })
    }

    if (campioneSufficiente && d.hallucination_rate > THRESHOLD_HALLUCINATION_RATE) {
      anomalies.push({
        code: 'MODEL_HALLUCINATION',
        severity: 'high',
        description: `Tasso allucinazioni ${hallucination_rate_pct}% (soglia 2%). Possibile degradazione qualità output.`,
        proposed_action: 'Ispeziona conversazioni con outcome=hallucination. Revisiona prompt di sistema.',
        raw: { hallucination_rate: d.hallucination_rate },
      })
    }

    model_calls_total = d.total
    model_error_count = d.error_count ?? 0
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
    const d = input.gmailHealth.data
    const rows = d.rows
    gmail_actions_count = rows.reduce((sum, r) => sum + r.n, 0)

    // Conta giorni distinti con notified_critical
    const criticalDays = new Set(
      rows.filter(r => r.bot_action === 'notified_critical').map(r => r.day)
    )
    // Conta giorni distinti con in_summary
    const summaryDays = new Set(
      rows.filter(r => r.bot_action === 'in_summary').map(r => r.day)
    )

    if (criticalDays.size === 0 && !d.alertsCronRecent) {
      anomalies.push({
        code: 'GMAIL_ALERTS_DEAD',
        severity: 'high',
        description: `Nessuna mail critica notificata negli ultimi 7 giorni. Possibile malfunzionamento cron gmail-alerts.`,
        proposed_action: 'Verifica cron gmail-alerts in Vercel. Controlla autorizzazione Gmail OAuth. Testa manualmente /api/cron/gmail-alerts.',
        raw: { critical_days: 0 },
      })
    }

    if (summaryDays.size === 0 && !d.summaryCronRecent) {
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

    // Un run 'partial' ha scartato contenuto illeggibile: memoria gia persa.
    // Severity high, non medium: e' il difetto che e' rimasto invisibile per tre
    // mesi perche' il run si dichiarava comunque riuscito.
    if ((d.partial_count ?? 0) > 0) {
      const partialRun = d.runs.find(r => r.status === 'partial')
      anomalies.push({
        code: 'MEMORIA_PARZIALE',
        severity: 'high',
        // Il dettaglio (quante parti, quanti caratteri) va in faccia a chi legge:
        // senza, "quella memoria e' persa" suona identico per 29 caratteri e per
        // una giornata intera, e la severita alta diventa impossibile da tarare.
        description: `${d.partial_count} run memoria-extract hanno scartato contenuto illeggibile: quella memoria e' persa.${partialRun?.error_message ? ` Ultimo: ${partialRun.error_message}.` : ''}`,
        proposed_action: 'Controlla error_message dei run parziali. Se ricorre, abbassa CHUNK_CHAR_BUDGET in memoria-extract.ts o verifica le risposte del modello.',
        raw: { partial_count: d.partial_count, last_partial: partialRun?.error_message },
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

    // Il controllo che per tre mesi e' mancato. L'audit verificava che i run
    // esistessero e fossero 'ok', non che avessero prodotto qualcosa: al 3 set
    // 2026 c'erano 28 giornate con messaggi archiviate come vuote, 927 messaggi,
    // e OGNI run era 'ok'. Severita' alta: non e' un allarme su un rischio, e'
    // memoria che manca adesso.
    // Difensivo con intenzione: un campo assente (dato vecchio, chiamante che
    // non lo passa) non deve poter far collassare TUTTO l'audit — e' la
    // patologia che questo file esiste per curare, un piano piu' in basso.
    const giornateVuote = d.giornate_senza_riassunto ?? []
    if (giornateVuote.length > 0) {
      anomalies.push({
        code: 'MEMORIA_VUOTA',
        severity: 'high',
        // Il numero di MESSAGGI e' la parte che rende il dato interpretabile:
        // "2 giornate" e "927 messaggi" non sono la stessa perdita, e senza
        // quel numero l'audit le annuncerebbe con la stessa voce.
        description: `${giornateVuote.length} giornate con messaggi non hanno prodotto alcun riassunto (${d.messaggi_senza_riassunto ?? 0} messaggi archiviati come "nessuna attività"): ${giornateVuote.slice(0, 3).join(', ')}${giornateVuote.length > 3 ? '...' : ''}.`,
        proposed_action: 'Chiedi al bot "quali giornate sono da rielaborare" e poi "rielabora <data>", una per volta (tool memoria_giornate_da_rielaborare / memoria_rielabora).',
        raw: { giornate: giornateVuote.slice(0, 20), messaggi: d.messaggi_senza_riassunto ?? 0 },
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

  // ── D6: scadenze attive ma gia' passate ─────────────────────────────────────
  //
  // Sono INVISIBILI al resto del sistema: il cron dei promemoria filtra
  // `.gte('data_scadenza', today)`, quindi una scadenza registrata con una data
  // gia' passata non viene mai letta. Nessun promemoria, nessun avviso, per
  // sempre — e resta `attivo`, quindi sembra tutto a posto.
  //
  // Caso reale che ha fatto aggiungere questo controllo (3 set 2026): "Nomina
  // Medico Competente", scadenza 17 maggio, registrata il 4 giugno — nata gia'
  // scaduta — ancora attiva dopo tre mesi e mezzo, con `reminders_sent` VUOTO.
  // Un adempimento di sicurezza rimasto muto perche' nessun controllo guardava
  // indietro. [[feedback_misura_non_e_dato]]
  if (input.scadenzeScadute?.ok && input.scadenzeScadute.data) {
    const righe = input.scadenzeScadute.data.righe ?? []
    if (righe.length > 0) {
      const piuVecchia = righe[0]
      anomalies.push({
        code: 'SCADENZE_SCADUTE_ATTIVE',
        severity: 'high',
        // Il "da quanto" e' la parte che rende il dato interpretabile: una
        // scadenza passata ieri e una passata da tre mesi non sono la stessa cosa.
        description: `${righe.length} scadenz${righe.length === 1 ? 'a' : 'e'} risulta${righe.length === 1 ? '' : 'no'} ancora attiv${righe.length === 1 ? 'a' : 'e'} ma è già passata. La più vecchia: "${piuVecchia.soggetto.slice(0, 60)}" (${piuVecchia.tipo_documento ?? 'documento'}), scaduta il ${piuVecchia.data_scadenza}, ${piuVecchia.giorni_fa} giorni fa. Il cron dei promemoria non le vede: guarda solo in avanti.`,
        proposed_action: 'Verificare se sono state rinnovate: in quel caso marcare la riga vecchia come "sostituito"/"archiviato". Se non lo sono, è un adempimento scoperto.',
        raw: { righe: righe.slice(0, 10) },
      })
    }
  }

  return {
    anomalies,
    summary: {
      error_rate_pct,
      hallucination_rate_pct,
      model_calls_total,
      model_error_count,
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

  // Model summary. La percentuale si mostra SOLO col denominatore accanto, e sotto
  // campione minimo non si mostra affatto: "err 100%" su una chiamata sola ha
  // fatto sembrare un guasto quello che era un errore isolato in una settimana
  // di ferie. Il numero di errori, invece, e' vero a qualunque campione.
  const chiamate = `${s.model_calls_total} ${s.model_calls_total === 1 ? 'chiamata' : 'chiamate'}`
  const errori = `${s.model_error_count} ${s.model_error_count === 1 ? 'errore' : 'errori'}`
  let modelSummary: string
  if (s.model_calls_total === 0) {
    modelSummary = 'nessuna chiamata registrata'
  } else if (s.model_calls_total < MIN_SAMPLE_MODEL) {
    modelSummary = `${errori} su ${chiamate} (campione sotto il minimo per una percentuale)`
  } else {
    modelSummary = `err ${s.error_rate_pct}% su ${chiamate}`
  }

  // Gmail summary
  const gmailSummary = `${s.gmail_actions_count} azioni`

  return `*🧠 Self-audit Cervellone — settimana ${isoWeek}*

📊 *Sintesi*
${narrative}

🔍 *Dimensioni monitorate*
• Modelli: ${modelSummary}
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
