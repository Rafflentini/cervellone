// src/lib/audit-collector.ts — 5 funzioni raccolta dati per self-audit settimanale
// Spec: docs/superpowers/specs/2026-05-07-cervellone-self-audit-design.md §4
// Aggregazioni in TS (Supabase v2 non supporta GROUP BY via client)

import { supabase } from '@/lib/supabase'

// ── Result type uniforme ──────────────────────────────────────────────────────

export interface DimensionResult<T> {
  ok: boolean
  data?: T
  error?: string
}

/** Eta massima dell'heartbeat di un cron gmail prima di dirlo fermo. Vedi nota in collectGmailHealth. */
const HEARTBEAT_MAX_AGE_H = 96

// ── Helper: ISO date string per N giorni fa ───────────────────────────────────

function daysAgoISO(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString()
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function dateISO(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// ── D1: Model Health ─────────────────────────────────────────────────────────

export interface ModelHealthRow {
  model: string
  outcome: string
  n: number
}

export interface ModelHealthData {
  rows: ModelHealthRow[]
  total: number
  mitigated_count: number
  error_rate: number
  hallucination_rate: number
  /** Errori in numero, non in percentuale: sotto campione e' l'unico dato che regge. */
  error_count: number
  hallucination_count: number
}

/**
 * Raccoglie errori modello (non-canary) degli ultimi 7 giorni.
 * Query §4 D1. Aggregazione group by (model, outcome) in TS.
 */
export async function collectModelHealth(): Promise<DimensionResult<ModelHealthData>> {
  const since = daysAgoISO(7)

  const { data, error } = await supabase
    .from('model_health')
    .select('model, outcome')
    .eq('is_canary', false)
    .gte('ts', since)
    .order('ts', { ascending: false })

  if (error) return { ok: false, error: error.message }

  const rows = data ?? []
  const total = rows.length

  // Aggregazione: group by (model, outcome)
  const countMap = new Map<string, number>()
  for (const r of rows) {
    const key = `${r.model}||${r.outcome}`
    countMap.set(key, (countMap.get(key) ?? 0) + 1)
  }

  const aggregated: ModelHealthRow[] = []
  for (const [key, n] of countMap) {
    const [model, outcome] = key.split('||')
    aggregated.push({ model, outcome, n })
  }

  const errorCount = rows.filter(r => r.outcome === 'api_error' || r.outcome === 'timeout').length
  const mitigatedCount = rows.filter(r => r.outcome === 'empty' || r.outcome === 'force_text').length
  const hallucinationCount = rows.filter(r => r.outcome === 'hallucination').length

  const error_rate = total > 0 ? errorCount / total : 0
  const hallucination_rate = total > 0 ? hallucinationCount / total : 0

  return {
    ok: true,
    data: {
      rows: aggregated,
      total,
      mitigated_count: mitigatedCount,
      error_rate,
      hallucination_rate,
      error_count: errorCount,
      hallucination_count: hallucinationCount,
    },
  }
}

// ── D2: Circuit Breaker Events ────────────────────────────────────────────────

export interface BreakerEvent {
  model: string
  outcome: string
  details: unknown
  ts: string
}

export interface BreakerEventsData {
  events: BreakerEvent[]
  trip_count: number
  recovery_count: number
}

/**
 * Raccoglie eventi canary (api_error, timeout, empty) degli ultimi 7 giorni.
 * Query §4 D2.
 */
export async function collectBreakerEvents(): Promise<DimensionResult<BreakerEventsData>> {
  const since = daysAgoISO(7)

  const { data, error } = await supabase
    .from('model_health')
    .select('model, outcome, details, ts')
    .eq('is_canary', true)
    .gte('ts', since)
    .in('outcome', ['api_error', 'timeout', 'empty'])
    .order('ts', { ascending: false })

  if (error) return { ok: false, error: error.message }

  const events = (data ?? []) as BreakerEvent[]
  const trip_count = events.filter(e => ['api_error', 'timeout'].includes(e.outcome)).length
  const recovery_count = events.filter(e => e.outcome === 'empty').length

  return {
    ok: true,
    data: { events, trip_count, recovery_count },
  }
}

// ── D3: Gmail Health ──────────────────────────────────────────────────────────

export interface GmailDayRow {
  bot_action: string
  day: string // YYYY-MM-DD
  n: number
}

export interface GmailHealthData {
  rows: GmailDayRow[]
  alertsCronRecent: boolean
  summaryCronRecent: boolean
}

/**
 * Raccoglie elaborazioni mail degli ultimi 7 giorni.
 * Query §4 D3. Aggregazione group by (bot_action, day) in TS.
 * Graceful: tabella potrebbe non esistere.
 */
export async function collectGmailHealth(): Promise<DimensionResult<GmailHealthData>> {
  const since = daysAgoISO(7)

  const { data, error } = await supabase
    .from('gmail_processed_messages')
    .select('bot_action, ts')
    .gte('ts', since)
    .order('ts', { ascending: false })

  if (error) return { ok: false, error: error.message }

  const rows = data ?? []

  // Aggregazione: group by (bot_action, day in Rome time approx UTC+2)
  const countMap = new Map<string, number>()
  for (const r of rows) {
    // Approssimazione Rome: UTC+2 (accettato 1h drift per MVP)
    const d = new Date(r.ts)
    d.setHours(d.getHours() + 2)
    const day = dateISO(d)
    const key = `${r.bot_action}||${day}`
    countMap.set(key, (countMap.get(key) ?? 0) + 1)
  }

  const aggregated: GmailDayRow[] = []
  for (const [key, n] of countMap) {
    const [bot_action, day] = key.split('||')
    aggregated.push({ bot_action, day, n })
  }

  // Ordina per day DESC
  aggregated.sort((a, b) => b.day.localeCompare(a.day))

  // Heartbeat cron: gmail-alerts/gmail-morning aggiornano un timestamp di ultima
  // esecuzione su cervellone_config ad OGNI run, anche nei giorni "silenti" (nessuna
  // mail critica / nessuna non letta). Leggerlo evita i falsi positivi GMAIL_*_DEAD.
  // Soglia 96h, non 48h: NESSUNO dei due cron gira nel fine settimana.
  //   gmail-alerts  */30 7-16 * * 1-5 → ultimo giro possibile venerdi 16:30
  //   gmail-morning 0 6 * * 1-5       → ultimo giro possibile venerdi 06:00
  //   self-audit    0 6 * * 1         → legge lunedi alle 06:00
  // Il vuoto legittimo del fine settimana vale quindi fino a 72h, e con 48h
  // l'allarme GMAIL_ALERTS_DEAD scattava OGNI lunedi per costruzione; per
  // gmail-morning era testa o croce, secondo quale dei due cron delle 06:00
  // partiva per primo. 96h stanno sopra il vuoto vero e sotto la settimana,
  // quindi un cron davvero fermo viene comunque colto al giro dopo.
  let alertsCronRecent = false
  let summaryCronRecent = false
  const { data: cfgRows } = await supabase
    .from('cervellone_config')
    .select('key, value')
    .in('key', ['gmail_alert_check_last_run', 'gmail_summary_last_run'])
    .order('key')
  if (cfgRows) {
    const cutoff = Date.now() - HEARTBEAT_MAX_AGE_H * 60 * 60 * 1000
    const isRecent = (v: unknown): boolean => {
      if (typeof v !== 'string') return false
      const t = Date.parse(v)
      return !Number.isNaN(t) && t >= cutoff
    }
    const byKey = new Map<string, unknown>()
    for (const r of cfgRows as Array<{ key?: string; value?: unknown }>) {
      if (r && typeof r.key === 'string') byKey.set(r.key, r.value)
    }
    alertsCronRecent = isRecent(byKey.get('gmail_alert_check_last_run'))
    summaryCronRecent = isRecent(byKey.get('gmail_summary_last_run'))
  }

  return { ok: true, data: { rows: aggregated, alertsCronRecent, summaryCronRecent } }
}

// ── D4: Memoria Runs ──────────────────────────────────────────────────────────

export interface MemoriaRunRow {
  date_processed: string
  status: string
  conversations_count: number | null
  entities_count: number | null
  llm_cost_estimate_usd: number | null
  error_message: string | null
}

export interface MemoriaRunsData {
  runs: MemoriaRunRow[]
  ok_count: number
  error_count: number
  /** Run che hanno scartato contenuto illeggibile: memoria persa, ma non un errore. */
  partial_count: number
  missing_dates: string[]
  /**
   * Giornate CON messaggi il cui riassunto non dice niente.
   *
   * E' il controllo che per tre mesi e' mancato: l'audit verificava che i run
   * esistessero e fossero `ok`, non che avessero prodotto qualcosa. Misurato a
   * mano il 3 set 2026: 30 giornate con messaggi, 28 col riassunto "Nessuna
   * attività rilevante", 927 messaggi archiviati come giornate vuote — e ogni
   * singolo run era `ok`.
   *
   * Il filtro guarda il CONTENUTO: quelle righe non sono vuote, contengono 26
   * caratteri che dicono una cosa falsa. Un controllo su null/'' non ne
   * troverebbe nemmeno una. [[feedback_misura_non_e_dato]]
   */
  giornate_senza_riassunto: string[]
  /** Messaggi complessivi in quelle giornate: 2 giornate e 927 messaggi non pesano uguale. */
  messaggi_senza_riassunto: number
}

/** La stringa che una giornata scrive quando non e' successo davvero niente. */
const RIASSUNTO_VUOTO = 'Nessuna attività rilevante'

/** True se il riassunto di una giornata non contiene nulla di utile. */
export function riassuntoSenzaContenuto(summaryText: string | null | undefined): boolean {
  const t = String(summaryText ?? '')
  if (t.startsWith('⚠️ Estrazione non riuscita')) return true
  // Le parti vengono unite con " | ": una giornata puo' essere fatta di N
  // "Nessuna attività rilevante" in fila.
  return t.replace(new RegExp(`${RIASSUNTO_VUOTO}( \\| )?`, 'g'), '').trim() === ''
}

/**
 * Raccoglie run memoria-extract degli ultimi 7 giorni.
 * Calcola date mancanti rispetto ai 7gg attesi.
 * Query §4 D4.
 */
export async function collectMemoriaRuns(): Promise<DimensionResult<MemoriaRunsData>> {
  const today = todayISO()
  const since7 = new Date()
  // -8 e non -7: il controllo dei buchi sotto guarda fino a oggi-8, e un giorno
  // che la query non chiede non puo' risultare presente. Con -7 il giorno di
  // confine risultava mancante OGNI settimana, comunque fossero andate le cose.
  since7.setUTCDate(since7.getUTCDate() - 8)
  const sinceStr = dateISO(since7)

  const { data, error } = await supabase
    .from('cervellone_memoria_extraction_runs')
    .select('date_processed, status, conversations_count, entities_count, llm_cost_estimate_usd, error_message')
    .gte('date_processed', sinceStr)
    .order('date_processed', { ascending: false })

  if (error) return { ok: false, error: error.message }

  const runs = (data ?? []) as MemoriaRunRow[]
  const ok_count = runs.filter(r => r.status === 'ok').length
  const error_count = runs.filter(r => r.status === 'error').length
  // 'partial' non e ne ok ne error: senza questo conteggio sparirebbe dalla vista.
  const partial_count = runs.filter(r => r.status === 'partial').length

  // Calcola date mancanti: la run per D avviene D+1 alle 21:30 Europe/Rome,
  // quindi today-1 non è ancora dovuta durante l'audit del mattino.
  const foundDates = new Set(runs.map(r => r.date_processed))
  const missing_dates: string[] = []
  for (let i = 2; i <= 8; i++) {
    const d = new Date()
    d.setUTCDate(d.getUTCDate() - i)
    const ds = dateISO(d)
    if (ds < today && !foundDates.has(ds)) {
      missing_dates.push(ds)
    }
  }

  // Il controllo che mancava: non "il run e' girato", ma "ne e' uscito qualcosa".
  // Volutamente su TUTTO lo storico e non sui 7 giorni: l'arretrato non si
  // riduce da solo, e un numero che scompare dalla finestra torna invisibile.
  let giornate_senza_riassunto: string[] = []
  let messaggi_senza_riassunto = 0
  const { data: sommari } = await supabase
    .from('cervellone_summary_giornaliero')
    .select('data, message_count, summary_text')
    .gt('message_count', 0)
    .order('data', { ascending: false })
  for (const r of (sommari ?? []) as Array<{ data: string; message_count: number; summary_text: string }>) {
    if (riassuntoSenzaContenuto(r.summary_text)) {
      giornate_senza_riassunto.push(r.data)
      messaggi_senza_riassunto += r.message_count ?? 0
    }
  }
  // Le piu' recenti per prime: sono quelle che si rielaborano meglio.
  giornate_senza_riassunto = giornate_senza_riassunto.slice(0, 60)

  return {
    ok: true,
    data: {
      runs, ok_count, error_count, partial_count, missing_dates,
      giornate_senza_riassunto, messaggi_senza_riassunto,
    },
  }
}

// ── D5: Cost Estimate ─────────────────────────────────────────────────────────

export interface CostEstimateData {
  memoria_7d: number
  canary_fixed: number
  total_7d: number
  avg_per_day: number
}

/**
 * Stima costo Anthropic degli ultimi 7 giorni.
 * Somma llm_cost_estimate_usd da memoria runs + stima fissa canary ($0.34/settimana).
 * Query §4 D5.
 */
export async function collectCostEstimate(): Promise<DimensionResult<CostEstimateData>> {
  const since7 = new Date()
  since7.setDate(since7.getDate() - 7)
  const sinceStr = dateISO(since7)

  const { data, error } = await supabase
    .from('cervellone_memoria_extraction_runs')
    .select('date_processed, llm_cost_estimate_usd')
    .gte('date_processed', sinceStr)
    .order('date_processed', { ascending: false })

  if (error) return { ok: false, error: error.message }

  const rows = data ?? []
  const memoria_7d = rows.reduce((sum: number, r: { llm_cost_estimate_usd: number | null }) => {
    return sum + (Number(r.llm_cost_estimate_usd) || 0)
  }, 0)

  const canary_fixed = 0.34 // stima fissa cron canary (~$0.34/settimana)
  const total_7d = parseFloat((memoria_7d + canary_fixed).toFixed(6))
  const avg_per_day = parseFloat((total_7d / 7).toFixed(6))

  return {
    ok: true,
    data: { memoria_7d, canary_fixed, total_7d, avg_per_day },
  }
}

// ── D6: Scadenze attive ma gia' passate ───────────────────────────────────────

export interface ScadenzaScadutaRow {
  id: string
  soggetto: string
  tipo_documento: string | null
  data_scadenza: string
  giorni_fa: number
}

export interface ScadenzeScaduteData {
  righe: ScadenzaScadutaRow[]
}

/**
 * Scadenze ancora `attivo` la cui data e' gia' passata.
 *
 * Sono INVISIBILI a tutto il resto del sistema. Il cron dei promemoria filtra
 * `.gte('data_scadenza', today)`: una scadenza registrata con una data gia'
 * passata non viene mai letta — nessun promemoria, nessun avviso, per sempre.
 *
 * Non e' un caso di scuola. Al 3 set 2026 c'era in tabella "Nomina Medico
 * Competente" con scadenza **17 maggio**, registrata il **4 giugno** — cioe'
 * nata gia' scaduta — ancora `attivo`, con `reminders_sent` VUOTO. Tre mesi e
 * mezzo di silenzio su un adempimento di sicurezza, e nessuno poteva
 * accorgersene perche' nessun controllo guardava indietro.
 *
 * Sta nell'audit settimanale e non nella mail giornaliera dei promemoria: e' una
 * cosa da sistemare una volta (marcare `sostituito`/`archiviato`), non da
 * ricordare ogni mattina.
 */
export async function collectScadenzeScadute(): Promise<DimensionResult<ScadenzeScaduteData>> {
  const today = todayISO()

  const { data, error } = await supabase
    .from('cervellone_scadenze')
    .select('id, soggetto, tipo_documento, data_scadenza')
    .eq('stato', 'attivo')
    .lt('data_scadenza', today)
    .order('data_scadenza', { ascending: true })

  if (error) return { ok: false, error: error.message }

  const oggiMs = Date.parse(`${today}T00:00:00Z`)
  const righe: ScadenzaScadutaRow[] = (data ?? []).map((r: {
    id: string; soggetto: string; tipo_documento: string | null; data_scadenza: string
  }) => ({
    id: r.id,
    soggetto: r.soggetto,
    tipo_documento: r.tipo_documento,
    data_scadenza: r.data_scadenza,
    giorni_fa: Math.round((oggiMs - Date.parse(`${r.data_scadenza}T00:00:00Z`)) / (24 * 60 * 60 * 1000)),
  }))

  return { ok: true, data: { righe } }
}
