// Sostantivi-documento "forti": ancore del dominio tecnico/amministrativo.
// I verbi-azione larghi (prepara/genera/elabora/redigi) attivano un task SOLO
// se accompagnati da uno di questi sostantivi, per evitare falsi positivi su
// chat colloquiale ("preparati", "in relazione a", "genera confusione").
const STRONG_DOC_NOUNS: RegExp[] = [
  /\bpreventiv\w*/i,
  /\bcomput\w*/i,
  /\bcme\b/i,
  /\bquadro\s+economic\w*/i,
  /\bperizi\w*/i,
  /\brelazione\s+(?:tecnic\w*|di\s+calcol\w*|geologic\w*|specialistic\w*|paesaggistic\w*)/i,
  /\bpratic\w*/i,
  /\bscia\b/i,
  /\bcila\b/i,
  /\bddt\b/i,
  /\bsal\b/i, // Stato Avanzamento Lavori — acronimo di dominio, conserva veri match
  /\bpiano\s+operativo(?:\s+di\s+sicurezza)?\b/i, // POS esteso (non l'acronimo nudo)
  /\bp\.?o\.?s\.?\s+(?:di\s+)?sicurezz\w*/i, // "POS sicurezza"
]

// Verbi-azione larghi: da soli NON bastano (troppi falsi positivi colloquiali).
// Diventano trigger solo se il messaggio contiene anche uno STRONG_DOC_NOUNS
// oppure un sostantivo-documento "debole" (es. l'acronimo nudo POS).
const ACTION_VERBS: RegExp[] = [
  /\bredig\w*/i,
  /\bprepar(?:a|are|ami|iamo|ate|erò|erai|erà|eremo|erete|eranno|ato|ata|ati|ate)\b/i,
  /\belabor(?:a|are|ami|iamo|ate|o|ato|ata|ati)\b/i,
  /\bgener(?:a|are|ami|iamo|ate|o|ato|ata|ati)\b/i,
  /\bfai\b/i,
  /\bfar(?:e|mi|gli|ci)\b/i,
  /\bfamm[io]\b/i,
  /\bpredispon\w*/i,
  /\bcre(?:a|are|ami|iamo|ate|o|ato|ata|ati)\b/i,
  /\bstil(?:a|are|ami|iamo|ate|o|ato|ata|ati)\b/i,
  /\bcompil(?:a|are|ami|iamo|ate|o|ato|ata|ati)\b/i,
]

// Sostantivi-documento "deboli": acronimi nudi che da soli NON sono task
// (potrebbero comparire in chat colloquiale, es. "il pos del bar"), ma che
// diventano task SE accompagnati da un verbo-azione (es. "fai il POS").
const WEAK_DOC_NOUNS: RegExp[] = [
  /\bpos\b/i,
]

// Keyword che sono già di per sé un task documentale (sostantivo forte presente):
// se compare uno di questi, è task a prescindere dal verbo.
const STANDALONE_TASK_KEYWORDS: RegExp[] = [
  ...STRONG_DOC_NOUNS,
]

// Pattern che indicano "non è una richiesta di task ma una domanda/lamentela/conversazione"
// Se uno di questi matcha → forziamo chat veloce anche se ci sono keyword di task.
const NOT_REQUEST_PATTERNS: RegExp[] = [
  /^\s*(?:perch[éè]|com'?è\s+che|come\s+mai|non\s+capisco|non\s+vol[lt]|ma\s+|smett|ferma|stop)/i,
  /\b(?:non\s+ti\s+ho\s+chiesto|non\s+volevo|non\s+serve|basta\s+con|dimentica)/i,
  /\b(?:cos'?è|che\s+cos'?è|chi\s+(?:sei|è)|come\s+(?:stai|va|mai))/i,
  // Forme colloquiali che NON sono richieste di task:
  // "preparati" (imperativo riflessivo), "in relazione a/al/alla" (preposizionale).
  /\bpreparati\b/i,
  /\bin\s+relazione\s+(?:a|al|alla|allo|ai|agli|alle)\b/i,
]

const FILE_SIZE_THRESHOLD_BYTES = 100_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyTask(userText: string, fileBlocks: any[]): boolean {
  // FIX W1.2: lamentele/domande/intent "non-richiesta" → chat veloce anche se
  // ci sono keyword di task. Senza questo, "Perché mi rispondi col POS?"
  // matcherebbe \bpos\b e finirebbe nel path durable (sbagliato).
  if (NOT_REQUEST_PATTERNS.some((re) => re.test(userText))) return false

  // 1) Sostantivo-documento forte presente → è un task documentale a prescindere.
  if (STANDALONE_TASK_KEYWORDS.some((re) => re.test(userText))) return true

  // 2) Verbo-azione largo (prepara/genera/elabora/redigi/fai/...) → task SOLO se nel
  //    messaggio compare anche un sostantivo-documento (forte O debole). Questo elimina
  //    i falsi positivi colloquiali ("preparati", "genera confusione", "fai presto")
  //    senza rompere i veri trigger ("prepara un preventivo", "fai il POS"). L'acronimo
  //    nudo POS (sostantivo debole) triggera SOLO accoppiato a un verbo-azione, così
  //    "il pos del bar" e "Smettila con il POS" (nessun verbo-task) restano FALSE.
  if (
    ACTION_VERBS.some((re) => re.test(userText)) &&
    (STRONG_DOC_NOUNS.some((re) => re.test(userText)) ||
      WEAK_DOC_NOUNS.some((re) => re.test(userText)))
  ) {
    return true
  }

  if (fileBlocks.length > 0 && JSON.stringify(fileBlocks).length > FILE_SIZE_THRESHOLD_BYTES) {
    return true
  }
  return false
}
