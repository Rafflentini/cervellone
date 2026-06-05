/**
 * src/lib/opus-ttl.ts — Cost-control 5 giu 2026: /opus a tempo.
 * Opus si spegne da solo dopo il TTL — nessun Opus "permanente" via Telegram.
 *
 * Invariante: opus_until DEVE esistere in DB ogni volta che model_default/model_active
 * è Opus. Se manca (es. messo a mano via SQL), isOpusExpired(null)=true → revert
 * automatico a Sonnet. È VOLUTO (fail-safe: Opus senza scadenza non deve esistere).
 */

export const OPUS_TTL_DEFAULT_MIN = 60
export const OPUS_TTL_MAX_MIN = 480
export const OPUS_MODEL = 'claude-opus-4-8'
export const SONNET_MODEL = 'claude-sonnet-4-6'

/**
 * Parsa '/opus' o '/opus 120' → minuti clampati [5, 480].
 * Restituisce null se il testo NON è un comando /opus (es. "ciao /opus", "/opusx").
 */
export function parseOpusCommand(text: string): number | null {
  const m = /^\/opus(?:\s+(\d{1,4}))?\s*$/.exec(text.trim())
  if (!m) return null
  const min = m[1] ? parseInt(m[1], 10) : OPUS_TTL_DEFAULT_MIN
  return Math.min(Math.max(min, 5), OPUS_TTL_MAX_MIN)
}

/**
 * Calcola la scadenza Opus sommando `minutes` minuti alla data `now`.
 * Restituisce una stringa ISO 8601 UTC.
 */
export function computeOpusUntil(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString()
}

/**
 * Restituisce true se il TTL Opus è scaduto (o mancante/malformato).
 *
 * Valore mancante (null/undefined) → true  — fail-safe verso Sonnet.
 * Stringa malformata                → true  — fail-safe verso Sonnet.
 * Timestamp nel futuro             → false — Opus ancora attivo.
 * Timestamp nel passato o uguale   → true  — scaduto.
 *
 * Gestisce anche valori con virgolette JSON (es. '"2026-06-05T13:00:00.000Z"')
 * che Supabase restituisce quando la colonna è di tipo text e il valore è stato
 * inserito come JSON serializzato.
 */
export function isOpusExpired(opusUntil: string | null | undefined, now: Date): boolean {
  if (!opusUntil) return true
  const t = Date.parse(String(opusUntil).replace(/"/g, ''))
  if (Number.isNaN(t)) return true
  return now.getTime() >= t
}
