const LONG_TASK_KEYWORDS: RegExp[] = [
  /\bredig\w*/i,
  /\bprepar\w*/i,
  /\belabor\w*/i,
  /\bgener\w*/i,
  /\bpreventiv\w*/i,
  /\bcomput\w*/i,
  /\bcme\b/i,
  /\bquadro\s+economic\w*/i,
  /\bsal\b/i,
  /\bpos\b/i,
  /\bperizi\w*/i,
  /\brelazion\w*/i,
  /\bpratic\w*/i,
  /\bscia\b/i,
  /\bcila\b/i,
  /\brelazione\s+di\s+calcol\w*/i,
]

// Pattern che indicano "non è una richiesta di task ma una domanda/lamentela/conversazione"
// Se uno di questi matcha → forziamo chat veloce anche se ci sono keyword di task.
const NOT_REQUEST_PATTERNS: RegExp[] = [
  /^\s*(?:perch[éè]|com'?è\s+che|come\s+mai|non\s+capisco|non\s+vol[lt]|ma\s+|smett|ferma|stop)/i,
  /\b(?:non\s+ti\s+ho\s+chiesto|non\s+volevo|non\s+serve|basta\s+con|dimentica)/i,
  /\b(?:cos'?è|che\s+cos'?è|chi\s+(?:sei|è)|come\s+(?:stai|va|mai))/i,
]

const FILE_SIZE_THRESHOLD_BYTES = 100_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyTask(userText: string, fileBlocks: any[]): boolean {
  // FIX W1.2: lamentele/domande/intent "non-richiesta" → chat veloce anche se
  // ci sono keyword di task. Senza questo, "Perché mi rispondi col POS?"
  // matcherebbe \bpos\b e finirebbe nel path durable (sbagliato).
  if (NOT_REQUEST_PATTERNS.some((re) => re.test(userText))) return false

  if (LONG_TASK_KEYWORDS.some((re) => re.test(userText))) return true
  if (fileBlocks.length > 0 && JSON.stringify(fileBlocks).length > FILE_SIZE_THRESHOLD_BYTES) {
    return true
  }
  return false
}
