# Cervellone — Cron Self-Audit Settimanale (Sub-progetto G)

**Data:** 2026-05-07
**Autore:** Opus 4.7 (architect)
**Stato:** DRAFT → pronto per implementazione
**Spec rif.:** `2026-05-04-cervellone-self-healing.md`, `2026-05-07-cervellone-memoria-persistente-design.md`

## 1. Goal e Scope

### Goal

Cervellone si guarda allo specchio una volta a settimana. Lunedì 8:00 Rome (cron `0 6 * * 1` UTC) un orchestrator legge gli ultimi 7 giorni di telemetria interna (model_health, gmail_processed_messages, memoria_extraction_runs), individua anomalie/pattern usando soglie deterministiche + reasoning Sonnet 4.6, produce **report Telegram strutturato** con elenco proposte. **NON apre PR autonomamente** — utente always-in-the-loop.

Copre il blind-spot operativo: i 4 cron già attivi (canary, gmail-morning, gmail-alerts, memoria-extract) producono telemetria ma nessuno aggrega periodicamente. Drift silenziosi (es. `notified_critical=0` da 5gg = forse alert rotti) oggi non visibili senza ispezione manuale.

### In-scope MVP

- Cron Vercel `0 6 * * 1`
- Tabella `cervellone_audit_runs` (audit trail)
- Config keys `audit_silent_until`, `audit_last_run_week`, `audit_model`
- Collector 5 dimensioni (SQL deterministico)
- Analyzer thresholds hard-coded
- 1 chiamata Sonnet 4.6 per narrative summary
- Report Telegram Markdown a `TELEGRAM_ALLOWED_IDS[0]`
- Idempotency week-aware (ISO week)

### Out-of-scope

- PR autonome (mai)
- Multi-week trend / regression detection
- ML anomaly detection
- Cleanup TTL audit_runs (52 row/anno irrilevante)
- Drill-down comandi Telegram `/audit-detail <id>`
- Escalation email/PagerDuty/Slack

## 2. Architettura

```
LUN 06:00 UTC  →  Vercel cron → GET /api/cron/self-audit
  ├─ [0] Auth Bearer CRON_SECRET (401 else)
  ├─ [1] Silent check audit_silent_until
  ├─ [2] Idempotency week-aware: ISO week(today) vs audit_last_run_week
  ├─ [3] INSERT cervellone_audit_runs (status='started')
  ├─ [4] audit-collector → 5 query SQL parallele
  ├─ [5] audit-analyzer → Anomaly[] con thresholds
  ├─ [6] Sonnet 4.6 → narrative summary (1 call, ~5K token)
  ├─ [7] Format Markdown report
  ├─ [8] sendTelegramMessage(chatId, report)
  ├─ [9] UPDATE audit_runs status='ok', anomalies_count, report_text
  └─ [10] UPDATE config audit_last_run_week = ISO week
```

## 3. Schema SQL Migration

File: `supabase/migrations/2026-05-07-cervellone-self-audit.sql`

```sql
-- Cron self-audit settimanale Cervellone (Sub-progetto G)

CREATE TABLE IF NOT EXISTS cervellone_audit_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  iso_week TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'ok', 'error')),
  anomalies_count INT NOT NULL DEFAULT 0,
  dimensions_json JSONB,
  anomalies_json JSONB,
  report_text TEXT,
  llm_tokens_used INT,
  llm_cost_estimate_usd DECIMAL(8,4),
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_runs_week
  ON cervellone_audit_runs (iso_week DESC);

CREATE INDEX IF NOT EXISTS idx_audit_runs_started
  ON cervellone_audit_runs (started_at DESC);

ALTER TABLE cervellone_audit_runs DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE cervellone_audit_runs IS
  'Audit trail report self-audit settimanali. 1 row per lunedì cron.';

INSERT INTO cervellone_config (key, value) VALUES
  ('audit_silent_until', 'null'),
  ('audit_last_run_week', 'null'),
  ('audit_model', '"claude-sonnet-4-6"')
ON CONFLICT (key) DO NOTHING;
```

## 4. Logica Analisi — 5 Dimensioni

### D1 — Errori modello (model_health 7gg)

```sql
SELECT model, outcome, COUNT(*)::int AS n
FROM model_health
WHERE ts >= NOW() - INTERVAL '7 days'
  AND is_canary = false
GROUP BY model, outcome;
```

Threshold:
- `error_rate > 0.05` → `MODEL_ERROR_HIGH` (high)
- `hallucination_rate > 0.02` → `MODEL_HALLUCINATION` (high)

### D2 — Circuit breaker events 7gg

```sql
SELECT model, outcome, details, ts
FROM model_health
WHERE ts >= NOW() - INTERVAL '7 days'
  AND outcome IN ('api_error', 'timeout', 'empty')
  AND is_canary = true
ORDER BY ts DESC;
```

Threshold: ≥1 trip → `BREAKER_TRIP` (medium). ≥1 recovery → `BREAKER_RECOVERY` (info).

### D3 — Mail processing health

```sql
SELECT bot_action,
  DATE_TRUNC('day', ts AT TIME ZONE 'Europe/Rome')::date AS day,
  COUNT(*)::int AS n
FROM gmail_processed_messages
WHERE ts >= NOW() - INTERVAL '7 days'
GROUP BY bot_action, day
ORDER BY day DESC, bot_action;
```

Threshold:
- 0 `notified_critical` per >5gg working → `GMAIL_ALERTS_DEAD` (high)
- 0 `in_summary` per >5gg working → `GMAIL_MORNING_DEAD` (high)
- Spike `notified_critical` >20/giorno → `GMAIL_ALERT_FLOOD` (medium)

### D4 — Memoria extract runs 7gg

```sql
SELECT date_processed, status, conversations_count, entities_count,
       llm_cost_estimate_usd, error_message
FROM cervellone_memoria_extraction_runs
WHERE date_processed >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY date_processed DESC;
```

Threshold:
- ≥1 status='error' → `MEMORIA_ERROR` (high)
- giorni mancanti → `MEMORIA_GAP` (medium)

### D5 — Costo Anthropic stimato 7gg

```sql
SELECT date_processed, COALESCE(llm_cost_estimate_usd, 0) AS cost
FROM cervellone_memoria_extraction_runs
WHERE date_processed >= CURRENT_DATE - INTERVAL '7 days';
```

Sommato a stima fissa cron canary (~$0.34/settimana) + gmail-classify se attivo.

Threshold:
- `total_7d / 7 > 1.0` → `COST_HIGH` (medium)
- `total_7d > 10.0` → `COST_BUDGET_BREACH` (high)

## 5. Format Report Telegram

```markdown
*🧠 Self-audit Cervellone — settimana {{iso_week}}*

📊 *Sintesi*
{{narrative_sonnet}}

🔍 *Dimensioni monitorate*
• Modelli: {{model_summary}} (err {{error_rate_pct}}%)
• Circuit breaker: {{breaker_events_count}} eventi
• Mail: {{gmail_actions_summary}}
• Memoria: {{memoria_runs_ok}}/7 ok, {{memoria_cost_usd}}$
• Costo totale 7gg: ${{total_cost}}

⚠️ *Anomalie rilevate ({{anomalies_count}})*
1. *[{{severity}}]* {{code}}: {{description}}
   → Proposta: {{proposed_action}}

🛠 *Per autorizzare un'azione*
Rispondi con: `apri PR su anomalia <numero>` oppure `ignora anomalia <numero>`
o `silenzia audit per N giorni`.

_Run id: {{run_id}}_
```

## 6. Costo Stimato

| Componente | Stima |
|---|---|
| Sonnet 4.6, 1 call/settimana | ~$0.027 |
| Query Supabase | trascurabile |
| Telegram API | gratuito |
| **Totale settimanale** | **~$0.03** |
| **Annuo** | **~$1.40** |

## 7. Test Plan Smoke

| # | Test | Verifica |
|---|---|---|
| T1 | Auth missing | 401 |
| T2 | Auth ok | 200 + Telegram report |
| T3 | Idempotency week | `skipped:'already_ran_this_week'` |
| T4 | Silent mode | `skipped:'silent'` |
| T5 | Anomalia simulata (model_health 100 api_error) | report con `MODEL_ERROR_HIGH` |
| T6 | Zero anomalie | "Nessuna anomalia rilevata" |
| T7 | LLM down fallback | report con narrative statico, status='ok' |

## 8. DoD

- [ ] Migration applicata Supabase prod
- [ ] Tabella `cervellone_audit_runs` visibile
- [ ] 3 config key aggiunti
- [ ] `audit-collector.ts` 5 funzioni + test verdi
- [ ] `audit-analyzer.ts` thresholds + format + test pure logic
- [ ] `audit-runner.ts` orchestrator + test mock
- [ ] Route `/api/cron/self-audit` auth + idempotency week-aware
- [ ] vercel.json `0 6 * * 1`
- [ ] Deploy READY
- [ ] T1-T7 smoke
- [ ] Almeno 1 row `audit_runs` status='ok' post-trigger
- [ ] Telegram report ricevuto

## 9. Rischi/mitigazioni

| Rischio | Probab. | Impatto | Mitigazione |
|---|---|---|---|
| Sonnet caratteri Markdown-unsafe | Media | Basso | sendTelegramMessage fallback no parse_mode |
| Cron retry duplicato | Bassa | Basso | Idempotency week-aware |
| Threshold troppo aggressivi | Media | Medio | Conservative MVP, tuning post-4 settimane |
| Sonnet API down | Bassa | Basso | Fallback narrative statico |
| `gmail_processed_messages` non esiste | Bassa | Basso | Try/catch dimensione D3, default `[]` |
| Drift fuso orario | Certo | Trascurabile | Accettato 1h drift |

## 10. Out-of-scope iter future

- Multi-week trend (W-1 vs W-current)
- Drill-down `/audit_detail <run_id>`
- Auto-PR con conferma esplicita
- Dashboard webview report
- Threshold dinamici auto-tuning rolling baseline
- Email/PagerDuty escalation
