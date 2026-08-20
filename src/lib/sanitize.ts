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

/**
 * Prefissi IIN (Issuer Identification Number) plausibili per le carte di
 * pagamento piu diffuse. Un numero che non inizia con uno di questi non e
 * MAI considerato una carta, a prescindere da Luhn: e questo il filtro che
 * salva i protocolli tecnici, che quasi sempre iniziano con 0 o 1.
 */
const CARD_PREFIX_PATTERNS: RegExp[] = [
  /^4/, // Visa
  /^(?:5[1-5]|2[2-7])/, // Mastercard
  /^3[47]/, // Amex
  /^(?:30[0-5]|3[689])/, // Diners
  /^(?:6011|65|64[4-9])/, // Discover
]

function hasValidCardPrefix(digits: string): boolean {
  return CARD_PREFIX_PATTERNS.some((re) => re.test(digits))
}

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

function isDigitChar(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

/**
 * Cerca, a partire da fromIndex, la prima sotto-finestra di 13-19 cifre che
 * ha un prefisso di emittente plausibile, supera Luhn E non e attaccata ad
 * altre cifre (ne prima ne dopo — una carta non comincia mai a meta di un
 * altro numero). Scansiona gli offset da sinistra a destra e, per ciascun
 * offset, le lunghezze dalla piu lunga (19) alla piu corta (13): cosi un
 * numero di carta reale viene preso per intero prima che una sua
 * sotto-sequenza piu corta (ma anch'essa Luhn-valida per caso) faccia
 * scattare una redazione parziale che lascerebbe cifre in chiaro.
 *
 * `match` e `digitPositions` servono a guardare il carattere originale
 * immediatamente prima/dopo la finestra candidata (fuori da `digits`, che
 * contiene solo cifre e non ha piu questa informazione).
 */
function findCardWindow(
  digits: string,
  digitPositions: number[],
  match: string,
  fromIndex: number
): { start: number; end: number } | null {
  const n = digits.length
  for (let offset = fromIndex; offset <= n - 13; offset++) {
    const maxLen = Math.min(19, n - offset)
    for (let len = maxLen; len >= 13; len--) {
      const window = digits.slice(offset, offset + len)
      if (!hasValidCardPrefix(window) || !isLuhnValid(window)) continue

      const charStart = digitPositions[offset]
      const charEnd = digitPositions[offset + len - 1] + 1
      const before = charStart > 0 ? match[charStart - 1] : ''
      const after = charEnd < match.length ? match[charEnd] : ''
      if (isDigitChar(before) || isDigitChar(after)) continue

      return { start: offset, end: offset + len }
    }
  }
  return null
}

/**
 * Redige solo le sotto-sequenze di cifre che soddisfano insieme le quattro
 * condizioni (prefisso IIN plausibile + lunghezza 13-19 + Luhn valido + non
 * attaccata ad altre cifre). I separatori e le cifre fuori dalla finestra
 * trovata restano intatti: cosi "4539148803436467-01" diventa
 * "[REDACTED]-01" e non inghiotte il suffisso, e "1234 5678 9012 3456 7890"
 * resta intatto perche nessuna finestra di 13-19 cifre al suo interno puo
 * cominciare o finire senza toccare un'altra cifra.
 */
function redactCardNumbers(text: string): string {
  return text.replace(/\b\d[\d -]*\d\b/g, (match) => {
    const digitPositions: number[] = []
    let digitsOnly = ''
    for (let i = 0; i < match.length; i++) {
      const ch = match[i]
      if (ch >= '0' && ch <= '9') {
        digitsOnly += ch
        digitPositions.push(i)
      }
    }
    if (digitsOnly.length < 13) return match

    let result = ''
    let cursor = 0
    let digitIndex = 0
    while (digitIndex <= digitsOnly.length - 13) {
      const win = findCardWindow(digitsOnly, digitPositions, match, digitIndex)
      if (!win) break
      const charStart = digitPositions[win.start]
      const charEnd = digitPositions[win.end - 1] + 1
      result += match.slice(cursor, charStart) + '[REDACTED]'
      cursor = charEnd
      digitIndex = win.end
    }
    result += match.slice(cursor)
    return result
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
