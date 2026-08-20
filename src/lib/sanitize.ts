/**
 * lib/sanitize.ts — SEC-004 fix
 * Rimuove dati sensibili prima del salvataggio in database.
 */

const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,              // OpenAI/Anthropic API keys
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,         // Project-scoped keys
  /ghp_[a-zA-Z0-9]{36,}/g,               // GitHub tokens
  /glpat-[a-zA-Z0-9_-]{20,}/g,           // GitLab tokens
  /(?:password|pwd|pass|secret|token)\s*[:=]\s*\S+/gi,
]

/** Verifica di Luhn: ogni numero di carta reale la supera, un protocollo tecnico quasi mai. */
function isLuhnValid(digits: string): boolean {
  if (digits.length < 13) return false
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** Redige solo le sequenze numeriche che superano Luhn. */
function redactCardNumbers(text: string): string {
  return text.replace(/\b(?:\d[ -]?){13,19}\b/g, (match) => {
    const digits = match.replace(/\D/g, '')
    return isLuhnValid(digits) ? '[REDACTED]' : match
  })
}

export function sanitizeForStorage(text: string): string {
  let sanitized = text
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]')
  }
  return redactCardNumbers(sanitized)
}

/**
 * lib/logger.ts — SEC-005 fix
 * Safe logging: mai loggare contenuto messaggi utente in produzione.
 */

const IS_PROD = process.env.NODE_ENV === 'production'

export function logInfo(msg: string): void {
  if (!IS_PROD) console.log(msg)
}

export function logWarn(msg: string): void {
  console.warn(msg)
}

export function logError(msg: string, err?: unknown): void {
  console.error(msg, err instanceof Error ? err.message : '')
}
