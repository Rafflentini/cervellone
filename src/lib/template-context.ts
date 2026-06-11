/**
 * src/lib/template-context.ts — Injection deterministica modelli documento
 *
 * Quando la query utente contiene una delle parole_chiave di un modello registrato,
 * inietta un blocco FORCEFUL nel system prompt che dice al modello di usare
 * compila_modello (NON scrivere il documento in prosa).
 *
 * Injection INCONDIZIONATA: non dipende dal flag working_memory_enabled.
 * E' cheap (cache 5 min + un solo match regex per template) e best-effort
 * (qualsiasi errore -> stringa vuota).
 */

import { listTemplatesForInjection } from './document-templates'
import type { CampoModello } from './document-templates'

// ── Cache in-module TTL 5 min (identica al pattern di inferTaskType) ──

interface TemplateInjectionCacheEntry {
  rows: Array<{
    slug: string
    titolo: string
    parole_chiave: string[]
    campi: CampoModello[]
    dati_fissi: Record<string, unknown>
  }>
  cachedAt: number
}

const TEMPLATE_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minuti
let templateInjectionCache: TemplateInjectionCacheEntry | null = null

/** Invalida la cache (utile nei test e dopo upsert di un modello). */
export function invalidateTemplateInjectionCache(): void {
  templateInjectionCache = null
}

// ── Normalizzazione query (rimuove accenti, lowercase) ──

function normalizeQuery(q: string): string {
  return (q || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

// ── Escape metacaratteri regex (identico a inferTaskType) ──

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
}

// ── Conta i match di parole_chiave nella query ──

function countKeywordHits(keywords: string[], normalizedQuery: string): number {
  let hits = 0
  for (const kw of keywords) {
    if (!kw) continue
    const kwNorm = normalizeQuery(kw)
    try {
      const re = new RegExp('\\b' + esc(kwNorm) + '\\b', 'i')
      if (re.test(normalizedQuery)) hits++
    } catch {
      // keyword malformata -> skip
    }
  }
  return hits
}

/**
 * Costruisce il blocco di injection per il modello documento piu' rilevante
 * rispetto alla query utente, oppure '' se nessun match.
 *
 * Best-effort: qualsiasi eccezione -> ''.
 */
export async function buildTemplateContext(userQuery: string): Promise<string> {
  try {
    const normalized = normalizeQuery(userQuery)
    if (!normalized.trim()) return ''

    // Carica i template (con cache TTL 5 min)
    if (
      !templateInjectionCache ||
      Date.now() - templateInjectionCache.cachedAt > TEMPLATE_CACHE_TTL_MS
    ) {
      const rows = await listTemplatesForInjection()
      templateInjectionCache = { rows, cachedAt: Date.now() }
    }

    const rows = templateInjectionCache.rows
    if (rows.length === 0) return ''

    // Trova il template con piu' hit di keyword (minimo 1)
    let bestTemplate: (typeof rows)[0] | null = null
    let bestHits = 0

    for (const tpl of rows) {
      const hits = countKeywordHits(tpl.parole_chiave, normalized)
      if (hits > bestHits) {
        bestHits = hits
        bestTemplate = tpl
      }
    }

    if (!bestTemplate || bestHits === 0) return ''

    const tpl = bestTemplate

    // Campi obbligatori NON gia' presenti nei dati fissi
    const datiFissiKeys = new Set(Object.keys(tpl.dati_fissi))

    // Tutte le chiavi del modello (solo nome-chiave, niente etichette: il modello
    // DEVE usare questi nomi in valori). * = obbligatorio.
    const tuttiKeys = tpl.campi
      .map((c) => c.nome + (c.obbligatorio ? '*' : ''))
      .join(', ')

    const campiDaChiedere = tpl.campi
      .filter((c) => c.obbligatorio && !datiFissiKeys.has(c.nome))
      .map((c) => c.nome + ' (' + c.label + ')')

    const campiStr =
      campiDaChiedere.length > 0
        ? campiDaChiedere.join(', ')
        : 'nessuno (tutti i campi obbligatori sono gia nei dati fissi)'

    const datiFissiStr =
      datiFissiKeys.size > 0
        ? Array.from(datiFissiKeys).join(', ')
        : 'nessuno'

    return (
      '\n=== MODELLO DOCUMENTO DISPONIBILE ===\n' +
      'Per questa richiesta esiste il modello "' + tpl.titolo + '" (slug: ' + tpl.slug + ').\n' +
      'USA SEMPRE lo strumento compila_modello(slug="' + tpl.slug + '", valori={...}). NON scrivere il documento in prosa nella chat: l\'impaginazione ufficiale la produce solo compila_modello.\n' +
      'IMPORTANTE: nel parametro valori usa ESATTAMENTE questi nomi-chiave, NON le etichette (* = obbligatorio): ' + tuttiKeys + '.\n' +
      'Mancano ancora (chiedili all\'utente e passali con la chiave indicata tra parentesi): ' + campiStr + '.\n' +
      'Dati fissi gia\' memorizzati (NON richiederli): ' + datiFissiStr + '.\n' +
      'Se l\'utente fornisce dati fissi nuovi (azienda, legale rappresentante, operai abituali), salvali con imposta_dati_fissi usando le stesse chiavi.\n' +
      'NON dire mai "documento generato" e NON fornire alcun link se compila_modello non ti ha restituito un link reale IN QUESTA risposta. Se restituisce campi mancanti o un errore, riportalo all\'utente e chiedi i dati: non inventare nulla.\n' +
      '===\n'
    )
  } catch (err) {
    console.error(
      '[template-context] buildTemplateContext error:',
      err instanceof Error ? err.message : err,
    )
    return ''
  }
}
