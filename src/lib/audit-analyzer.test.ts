// src/lib/audit-analyzer.test.ts — TDD Task 3 audit-analyzer (pure logic, no mock)
import { describe, it, expect } from 'vitest'
import { analyze, formatReport } from './audit-analyzer'
import type { AnalysisInput } from './audit-analyzer'

// ── Helper: input pulito senza anomalie ───────────────────────────────────────

function cleanInput(): AnalysisInput {
  return {
    modelHealth: {
      ok: true,
      data: {
        rows: [{ model: 'claude-sonnet-4-6', outcome: 'success', n: 100 }],
        total: 100,
        mitigated_count: 0,
        error_rate: 0.01,      // 1% — sotto soglia 5%
        hallucination_rate: 0.01, // 1% — sotto soglia 2%
        error_count: 1,
        hallucination_count: 1,
      },
    },
    breakerEvents: {
      ok: true,
      data: {
        events: [],
        trip_count: 0,
        recovery_count: 0,
      },
    },
    gmailHealth: {
      ok: true,
      data: {
        rows: [
          { bot_action: 'notified_critical', day: '2026-05-06', n: 2 },
          { bot_action: 'notified_critical', day: '2026-05-05', n: 1 },
          { bot_action: 'notified_critical', day: '2026-05-04', n: 3 },
          { bot_action: 'notified_critical', day: '2026-05-03', n: 1 },
          { bot_action: 'notified_critical', day: '2026-05-02', n: 2 },
          { bot_action: 'in_summary', day: '2026-05-06', n: 5 },
          { bot_action: 'in_summary', day: '2026-05-05', n: 3 },
          { bot_action: 'in_summary', day: '2026-05-04', n: 4 },
          { bot_action: 'in_summary', day: '2026-05-03', n: 2 },
          { bot_action: 'in_summary', day: '2026-05-02', n: 6 },
        ],
        alertsCronRecent: true,
        summaryCronRecent: true,
      },
    },
    memoriaRuns: {
      ok: true,
      data: {
        runs: [
          { date_processed: '2026-05-06', status: 'ok', conversations_count: 5, entities_count: 3, llm_cost_estimate_usd: 0.01, error_message: null },
          { date_processed: '2026-05-05', status: 'ok', conversations_count: 2, entities_count: 1, llm_cost_estimate_usd: 0.005, error_message: null },
          { date_processed: '2026-05-04', status: 'ok', conversations_count: 3, entities_count: 2, llm_cost_estimate_usd: 0.008, error_message: null },
        ],
        ok_count: 3,
        partial_count: 0,
        error_count: 0,
        missing_dates: [],
      },
    },
    costEstimate: {
      ok: true,
      data: {
        memoria_7d: 0.50,
        canary_fixed: 0.34,
        total_7d: 0.84,
        avg_per_day: 0.12, // $0.12/gg — sotto soglia $1/gg
      },
    },
  }
}

// ── D1: MODEL_ERROR_HIGH ──────────────────────────────────────────────────────

describe('analyze — MODEL_ERROR_HIGH', () => {
  it('error_rate 6% → anomalia MODEL_ERROR_HIGH high', () => {
    const input = cleanInput()
    input.modelHealth.data!.error_rate = 0.06
    input.modelHealth.data!.total = 100
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'MODEL_ERROR_HIGH')
    expect(a).toBeDefined()
    expect(a!.severity).toBe('high')
  })

  it('error_rate 4% → nessuna anomalia MODEL_ERROR_HIGH', () => {
    const input = cleanInput()
    input.modelHealth.data!.error_rate = 0.04
    const result = analyze(input)
    expect(result.anomalies.find(x => x.code === 'MODEL_ERROR_HIGH')).toBeUndefined()
  })

  it('hallucination_rate 3% → anomalia MODEL_HALLUCINATION high', () => {
    const input = cleanInput()
    input.modelHealth.data!.hallucination_rate = 0.03
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'MODEL_HALLUCINATION')
    expect(a).toBeDefined()
    expect(a!.severity).toBe('high')
  })
})

// ── D2: BREAKER_TRIP / BREAKER_RECOVERY ───────────────────────────────────────

describe('analyze — BREAKER events', () => {
  it('1 trip event → anomalia BREAKER_TRIP medium', () => {
    const input = cleanInput()
    input.breakerEvents.data!.trip_count = 1
    input.breakerEvents.data!.events = [
      { model: 'claude-sonnet-4-6', outcome: 'api_error', details: null, ts: '2026-05-06T10:00:00Z' },
    ]
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'BREAKER_TRIP')
    expect(a).toBeDefined()
    expect(a!.severity).toBe('medium')
  })

  it('0 trip events → nessuna anomalia BREAKER_TRIP', () => {
    const input = cleanInput()
    input.breakerEvents.data!.trip_count = 0
    const result = analyze(input)
    expect(result.anomalies.find(x => x.code === 'BREAKER_TRIP')).toBeUndefined()
  })

  it('1 recovery event → anomalia BREAKER_RECOVERY info', () => {
    const input = cleanInput()
    input.breakerEvents.data!.recovery_count = 1
    input.breakerEvents.data!.events = [
      { model: 'claude-sonnet-4-6', outcome: 'empty', details: null, ts: '2026-05-06T10:00:00Z' },
    ]
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'BREAKER_RECOVERY')
    expect(a).toBeDefined()
    expect(a!.severity).toBe('info')
  })
})

// ── D3: GMAIL_ALERTS_DEAD / GMAIL_MORNING_DEAD / GMAIL_ALERT_FLOOD ────────────

describe('analyze — Gmail anomalie', () => {
  it('0 notified_critical per >5gg working → GMAIL_ALERTS_DEAD high', () => {
    const input = cleanInput()
    // Rimuovi tutti i notified_critical
    input.gmailHealth.data!.rows = input.gmailHealth.data!.rows.filter(
      r => r.bot_action !== 'notified_critical'
    )
    input.gmailHealth.data!.alertsCronRecent = false
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'GMAIL_ALERTS_DEAD')
    expect(a).toBeDefined()
    expect(a!.severity).toBe('high')
  })

  it('0 in_summary per >5gg working → GMAIL_MORNING_DEAD high', () => {
    const input = cleanInput()
    input.gmailHealth.data!.rows = input.gmailHealth.data!.rows.filter(
      r => r.bot_action !== 'in_summary'
    )
    input.gmailHealth.data!.summaryCronRecent = false
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'GMAIL_MORNING_DEAD')
    expect(a).toBeDefined()
    expect(a!.severity).toBe('high')
  })

  it('spike notified_critical >20/giorno → GMAIL_ALERT_FLOOD medium', () => {
    const input = cleanInput()
    // Un giorno con 25 critici
    input.gmailHealth.data!.rows.push({ bot_action: 'notified_critical', day: '2026-05-01', n: 25 })
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'GMAIL_ALERT_FLOOD')
    expect(a).toBeDefined()
    expect(a!.severity).toBe('medium')
  })
})

// ── D4: MEMORIA_ERROR / MEMORIA_GAP ─────────────────────────────────────────

describe('analyze — Memoria anomalie', () => {
  it('1 run con status error → MEMORIA_ERROR high', () => {
    const input = cleanInput()
    input.memoriaRuns.data!.runs.push({
      date_processed: '2026-05-03',
      status: 'error',
      conversations_count: 0,
      entities_count: 0,
      llm_cost_estimate_usd: 0,
      error_message: 'LLM timeout',
    })
    input.memoriaRuns.data!.error_count = 1
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'MEMORIA_ERROR')
    expect(a).toBeDefined()
    expect(a!.severity).toBe('high')
  })

  it('missing_dates non vuoto → MEMORIA_GAP medium', () => {
    const input = cleanInput()
    input.memoriaRuns.data!.missing_dates = ['2026-05-01', '2026-04-30']
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'MEMORIA_GAP')
    expect(a).toBeDefined()
    expect(a!.severity).toBe('medium')
  })

  it('run parziali → MEMORIA_PARZIALE high', () => {
    const input = cleanInput()
    input.memoriaRuns.data!.partial_count = 2
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'MEMORIA_PARZIALE')
    expect(a).toBeDefined()
    // high e non medium: un run parziale significa memoria gia persa, ed e
    // esattamente il difetto rimasto invisibile per tre mesi.
    expect(a!.severity).toBe('high')
  })

  it('nessun errore e nessuna data mancante → nessuna anomalia memoria', () => {
    const input = cleanInput()
    const result = analyze(input)
    expect(result.anomalies.find(x => x.code === 'MEMORIA_ERROR')).toBeUndefined()
    expect(result.anomalies.find(x => x.code === 'MEMORIA_GAP')).toBeUndefined()
    expect(result.anomalies.find(x => x.code === 'MEMORIA_PARZIALE')).toBeUndefined()
  })
})

// ── D5: COST_HIGH / COST_BUDGET_BREACH ──────────────────────────────────────

describe('analyze — Costo anomalie', () => {
  it('avg_per_day > $1 → COST_HIGH medium', () => {
    const input = cleanInput()
    input.costEstimate.data!.avg_per_day = 1.5
    input.costEstimate.data!.total_7d = 10.5
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'COST_HIGH')
    expect(a).toBeDefined()
    expect(a!.severity).toBe('medium')
  })

  it('total_7d > $10 → COST_BUDGET_BREACH high', () => {
    const input = cleanInput()
    input.costEstimate.data!.avg_per_day = 1.5
    input.costEstimate.data!.total_7d = 11.0
    const result = analyze(input)
    const a = result.anomalies.find(x => x.code === 'COST_BUDGET_BREACH')
    expect(a).toBeDefined()
    expect(a!.severity).toBe('high')
  })

  it('costo normale → nessuna anomalia costo', () => {
    const input = cleanInput()
    const result = analyze(input)
    expect(result.anomalies.find(x => x.code === 'COST_HIGH')).toBeUndefined()
    expect(result.anomalies.find(x => x.code === 'COST_BUDGET_BREACH')).toBeUndefined()
  })
})

// ── Input completamente pulito → 0 anomalie ───────────────────────────────────

describe('analyze — input pulito', () => {
  it('nessuna anomalia con tutti i valori sotto soglia', () => {
    const result = analyze(cleanInput())
    expect(result.anomalies).toHaveLength(0)
  })

  it('summary contiene error_rate_pct e total_cost', () => {
    const result = analyze(cleanInput())
    expect(typeof result.summary.error_rate_pct).toBe('number')
    expect(typeof result.summary.total_cost).toBe('number')
  })
})

// ── Dimensioni fallite (ok: false) → no crash ─────────────────────────────────

describe('analyze — dimensioni con errore non crashano', () => {
  it('modelHealth ok:false → procede senza anomalie MODEL', () => {
    const input = cleanInput()
    input.modelHealth = { ok: false, error: 'DB down' }
    expect(() => analyze(input)).not.toThrow()
  })

  it('gmailHealth ok:false → procede senza anomalie GMAIL', () => {
    const input = cleanInput()
    input.gmailHealth = { ok: false, error: 'table missing' }
    expect(() => analyze(input)).not.toThrow()
  })
})

// ── formatReport ──────────────────────────────────────────────────────────────

describe('formatReport', () => {
  it('produce stringa Markdown con iso_week, narrative, run_id', () => {
    const result = analyze(cleanInput())
    const report = formatReport(result, '2026-W19', 'Settimana stabile, nessuna anomalia.', 'run-uuid-test')
    expect(report).toContain('2026-W19')
    expect(report).toContain('Settimana stabile')
    expect(report).toContain('run-uuid-test')
    expect(report).toContain('Nessuna anomalia rilevata')
  })

  it('con anomalie lista le anomalie nel report', () => {
    const input = cleanInput()
    input.modelHealth.data!.error_rate = 0.10
    const result = analyze(input)
    const report = formatReport(result, '2026-W19', 'Settimana con anomalie.', 'run-xyz')
    expect(report).toContain('MODEL_ERROR_HIGH')
    expect(report).toContain('high')
  })
})

// ── La percentuale ha bisogno di un campione (self-audit 2026-W36) ────────────
// Il report del 31/08 diceva "err 100%" su UNA chiamata sola. Il fatto vero era
// "un errore"; il 100% era un artefatto del denominatore.

describe('MODEL_ERROR_HIGH — soglia minima di campione', () => {
  function conModelHealth(over: Partial<NonNullable<AnalysisInput['modelHealth']['data']>>): AnalysisInput {
    const input = cleanInput()
    input.modelHealth.data = {
      rows: [],
      total: 1,
      mitigated_count: 0,
      error_rate: 0,
      hallucination_rate: 0,
      error_count: 0,
      hallucination_count: 0,
      ...over,
    }
    return input
  }

  it('una sola chiamata andata storta non e un tasso di errore del 100%', () => {
    const result = analyze(conModelHealth({ total: 1, error_rate: 1, error_count: 1 }))
    expect(result.anomalies.find(a => a.code === 'MODEL_ERROR_HIGH')).toBeUndefined()
  })

  it('vale anche per le allucinazioni: una su una non e il 100%', () => {
    const result = analyze(conModelHealth({ total: 1, hallucination_rate: 1, hallucination_count: 1 }))
    expect(result.anomalies.find(a => a.code === 'MODEL_HALLUCINATION')).toBeUndefined()
  })

  it('ma sotto campione gli errori in ASSOLUTO non vengono nascosti', () => {
    const result = analyze(conModelHealth({ total: 8, error_rate: 3 / 8, error_count: 3 }))
    const burst = result.anomalies.find(a => a.code === 'MODEL_ERROR_BURST')
    expect(burst).toBeDefined()
    expect(burst!.description).toContain('3')
    expect(burst!.description).toContain('8')
  })

  it('con campione sufficiente il tasso torna a valere', () => {
    const result = analyze(conModelHealth({ total: 40, error_rate: 0.1, error_count: 4 }))
    const alto = result.anomalies.find(a => a.code === 'MODEL_ERROR_HIGH')
    expect(alto).toBeDefined()
    expect(alto!.description).toContain('40')
  })

  it('il report dice quante chiamate stanno dietro la percentuale', () => {
    const result = analyze(conModelHealth({ total: 1, error_rate: 1, error_count: 1 }))
    const testo = formatReport(result, '2026-W36', 'sintesi', 'run-1')
    // Non deve piu comparire un "100%" nudo: il numeratore da solo mente.
    expect(testo).not.toMatch(/err 100%/)
    expect(testo).toContain('1 chiamata')
  })
})
