/**
 * lib/sanitize.ts — SEC-004 fix
 * Rimuove dati sensibili prima del salvataggio in database.
 */

const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,              // OpenAI/Anthropic API keys
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,         // Project-scoped keys
  /ghp_[a-zA-Z0-9]{36,}/g,               // GitHub tokens
  /glpat-[a-zA-Z0-9_-]{20,}/g,           // GitLab tokens
  /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, // Credit card numbers
  /(?:password|pwd|pass|secret|token)\s*[:=]\s*\S+/gi,
]

export function sanitizeForStorage(text: string): string {
  let sanitized = text
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]')
  }
  return sanitized
}

/**
 * lib/logger.ts — SEC-005 fix
 * Safe logging: mai loggare contenuto messaggi utente in produzione.
 */

const IS_PROD = process.env.NODE_ENV === 'production'

export function logInfo(msg: string) {
  if (!IS_PROD) console.log(msg)
}

export function logWarn(msg: string) {
  console.warn(msg)
}

export function logError(msg: string, err?: unknown) {
  console.error(msg, err instanceof Error ? err.message : '')
}
