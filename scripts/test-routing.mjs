/**
 * Simulazione routing modelli — verifica che gli scenari vadano al modello giusto
 * Esegui: node scripts/test-routing.mjs
 * (o traccia manualmente leggendo l'output)
 */

const cfg = {
  model_default: 'claude-sonnet-4-6',
  model_complex: 'claude-opus-4-6',
  thinking_budget_default: 4000,
  thinking_budget_medium: 32000,
  thinking_budget_high: 100000,
  max_tokens_default: 16000,
  max_tokens_medium: 48000,
  max_tokens_high: 128000,
}

function countComplexitySignals(userQuery, hasFiles) {
  const len = userQuery.length
  return [
    /(?:approfond|dettagliat|(?:analisi|indagine|studio)\s+complet|esaustiv|accurata|minuziosa)/i.test(userQuery),
    /(?:opus|massima\s*potenza|ragionamento\s*profondo|analisi\s*complessa)/i.test(userQuery),
    (userQuery.match(/(?:analizza|confronta|verifica|valuta|esamina|studia|indaga|investiga|redigi|prepara|elabora)/gi) || []).length >= 2,
    /(?:redigi|scrivi|prepara|elabora)\s+(?:un[ao']?\s+)?(?:relazione|perizia|parere|report|analisi|studio|indagine|piano|strategia|documento)/i.test(userQuery),
    /(?:norma|legge|decreto|regolament|codice|testo unico|direttiva|circolare|D\.?M\.?|D\.?Lgs|NTC|GDPR|CCNL)/i.test(userQuery),
    len > 500,
    hasFiles && /(?:analizza|verifica|confronta|controlla|esamina|valuta)/i.test(userQuery),
    /(?:calcol[oa]|verifica|dimension[ai]|stima|quantific)/i.test(userQuery) && len > 150,
    /(?:confronta|compara|paragona|differenz[ae]|vs\.?|rispetto a)/i.test(userQuery) && len > 100,
    /(?:strategia|piano\s+(?:di|per)|business\s*plan|marketing|posizionament|analisi\s+(?:di\s+)?mercato|target|competitor)/i.test(userQuery),
  ].filter(Boolean).length
}

function selectModel(userQuery, hasFiles) {
  const len = userQuery.length

  // Richiesta esplicita di potenza
  const wantsMax = /(?:opus|massima\s*potenza|ragionamento\s*profondo|usa\s+il\s+modello\s+(?:migliore|piu\s+potente))/i.test(userQuery)
  if (wantsMax) return { model: cfg.model_complex, thinking: cfg.thinking_budget_high, max: cfg.max_tokens_high, reason: 'explicit-max-power' }

  const isStructuredTask =
    /(?:preventiv|computo|cme|cmE|c\.m\.e)/i.test(userQuery) ||
    /(?:redigi|scrivi|prepara|elabora|genera)\b/i.test(userQuery) ||
    /(?:relazione|perizia|parere|report|documento|lettera)\b/i.test(userQuery) ||
    /(?:calcol[oa]|dimension[ai]|verifica\s+struttur)/i.test(userQuery)

  if (isStructuredTask) {
    const signals = countComplexitySignals(userQuery, hasFiles)
    if (signals >= 4) return { model: cfg.model_complex, thinking: cfg.thinking_budget_high, max: cfg.max_tokens_high, reason: `structured+complex(${signals})` }
    return { model: cfg.model_complex, thinking: cfg.thinking_budget_medium, max: cfg.max_tokens_medium, reason: `structured+base(${signals})` }
  }

  const signals = countComplexitySignals(userQuery, hasFiles)

  if (signals >= 4) return { model: cfg.model_complex, thinking: cfg.thinking_budget_high, max: cfg.max_tokens_high, reason: `complex(${signals})` }
  if (signals >= 2) return { model: cfg.model_complex, thinking: cfg.thinking_budget_medium, max: cfg.max_tokens_medium, reason: `medium(${signals})` }

  if (len < 100 && !hasFiles && signals === 0) {
    return { model: cfg.model_default, thinking: 1024, max: 4096, reason: 'short-conversational' }
  }
  if (signals >= 1 || len > 300 || hasFiles) {
    return { model: cfg.model_default, thinking: cfg.thinking_budget_default, max: cfg.max_tokens_default, reason: `default+signal(${signals})` }
  }
  return { model: cfg.model_default, thinking: cfg.thinking_budget_default, max: cfg.max_tokens_default, reason: `default(${signals})` }
}

const scenarios = [
  // CONVERSAZIONE SEMPLICE
  { query: 'Ciao, come stai?', files: false, expect: 'sonnet', cat: 'CONVERSAZIONE' },
  { query: 'Che ore sono?', files: false, expect: 'sonnet', cat: 'CONVERSAZIONE' },
  { query: 'Che modello sei?', files: false, expect: 'sonnet', cat: 'CONVERSAZIONE' },
  { query: 'Quanto costa un ponteggio?', files: false, expect: 'sonnet', cat: 'CONVERSAZIONE' },
  { query: 'Buongiorno Ingegnere', files: false, expect: 'sonnet', cat: 'CONVERSAZIONE' },

  // TASK STRUTTURATI SEMPLICI
  { query: 'Genera un preventivo per la ristrutturazione di un bagno', files: false, expect: 'opus', cat: 'TASK STRUTTURATO' },
  { query: 'Scrivi una lettera al Comune di Potenza', files: false, expect: 'opus', cat: 'TASK STRUTTURATO' },
  { query: 'Prepara un documento per il cliente Rossi', files: false, expect: 'opus', cat: 'TASK STRUTTURATO' },
  { query: 'Calcola il dimensionamento di una trave IPE 200', files: false, expect: 'opus', cat: 'TASK STRUTTURATO' },
  { query: 'Genera il computo metrico per il cantiere di Via Roma', files: false, expect: 'opus', cat: 'TASK STRUTTURATO' },
  { query: 'Redigi una relazione tecnica', files: false, expect: 'opus', cat: 'TASK STRUTTURATO' },
  { query: 'Elabora un report sullo stato del cantiere', files: false, expect: 'opus', cat: 'TASK STRUTTURATO' },

  // TASK COMPLESSI (molti segnali)
  { query: 'Redigi una relazione tecnica dettagliata sulla verifica strutturale ai sensi delle NTC 2018, analizza i carichi e verifica le sezioni secondo il D.M. 17/01/2018. Approfondisci ogni aspetto con calcoli esaustivi e confronta con la normativa vigente. Includi le verifiche SLU e SLE per tutte le combinazioni di carico previste dal decreto.', files: false, expect: 'opus', cat: 'TASK COMPLESSO' },
  { query: 'Analizza e confronta questi due preventivi, verifica le voci del prezziario regionale della Basilicata e valuta la congruita dei prezzi secondo il decreto legislativo 36/2023', files: true, expect: 'opus', cat: 'TASK COMPLESSO' },
  { query: 'Prepara un piano strategico di marketing per PonteggioSicuro, analizza i competitor e elabora una strategia di posizionamento con business plan dettagliato per il target edile', files: false, expect: 'opus', cat: 'TASK COMPLESSO' },

  // MESSAGGI MEDI senza keyword strutturato
  { query: 'Puoi spiegarmi come funziona la detrazione fiscale per ristrutturazione edilizia? Mi serve sapere le percentuali e i limiti per il 2026.', files: false, expect: 'sonnet', cat: 'MEDIO' },
  { query: 'Fammi un riepilogo approfondito del bando non metanizzati della Basilicata', files: false, expect: 'sonnet', cat: 'MEDIO' },
  { query: 'Cosa dice la normativa sulle barriere architettoniche?', files: false, expect: 'sonnet', cat: 'MEDIO' },

  // FILE senza task keyword
  { query: 'Cosa c e in questo file?', files: true, expect: 'sonnet', cat: 'FILE SEMPLICE' },
  { query: 'Leggi questo PDF per favore', files: true, expect: 'sonnet', cat: 'FILE SEMPLICE' },

  // FILE con analisi (1 signal da files+analizza)
  { query: 'Analizza questo documento per favore', files: true, expect: 'sonnet', cat: 'FILE + ANALISI' },

  // FILE con task complesso
  { query: 'Analizza questo PDF e verifica la conformita alle norme NTC, poi prepara una relazione tecnica approfondita', files: true, expect: 'opus', cat: 'FILE + TASK COMPLESSO' },

  // RICHIESTA ESPLICITA DI POTENZA
  { query: 'Rispondimi con massima potenza', files: false, expect: 'opus', cat: 'POTENZA ESPLICITA' },
  { query: 'Usa opus per rispondere', files: false, expect: 'opus', cat: 'POTENZA ESPLICITA' },
  { query: 'Ragionamento profondo su questo tema', files: false, expect: 'opus', cat: 'POTENZA ESPLICITA' },

  // EDGE CASES
  { query: 'genera', files: false, expect: 'opus', cat: 'EDGE CASE' },
  { query: 'La relazione tra due variabili', files: false, expect: 'sonnet', cat: 'EDGE CASE' },
  { query: 'Ho visto il report del TG', files: false, expect: 'sonnet', cat: 'EDGE CASE' },
]

console.log('='.repeat(80))
console.log('SIMULAZIONE ROUTING MODELLI')
console.log(`  model_default: ${cfg.model_default}`)
console.log(`  model_complex: ${cfg.model_complex}`)
console.log('='.repeat(80))
console.log()

let pass = 0, fail = 0
let currentCat = ''

for (const s of scenarios) {
  if (s.cat !== currentCat) {
    currentCat = s.cat
    console.log(`--- ${currentCat} ---`)
  }

  const result = selectModel(s.query, s.files)
  const isOpus = result.model.includes('opus')
  const got = isOpus ? 'opus' : 'sonnet'
  const ok = got === s.expect

  const icon = ok ? 'OK' : 'FAIL'
  const filesTag = s.files ? ' [+FILE]' : ''
  const shortQuery = s.query.length > 70 ? s.query.slice(0, 70) + '...' : s.query

  console.log(`  ${icon.padEnd(4)} | ${got.toUpperCase().padEnd(6)} | think=${String(result.thinking).padEnd(6)} | max=${String(result.max).padEnd(6)} | ${result.reason}`)
  console.log(`       "${shortQuery}"${filesTag}`)
  if (!ok) {
    console.log(`       >>> ATTESO: ${s.expect.toUpperCase()}, OTTENUTO: ${got.toUpperCase()}`)
  }

  if (ok) pass++; else fail++
}

console.log()
console.log('='.repeat(80))
console.log(`RISULTATO: ${pass}/${pass + fail} passati${fail > 0 ? ' --- ' + fail + ' FALLITI' : ' --- TUTTI OK'}`)
console.log('='.repeat(80))
