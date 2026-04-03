import { supabase } from '@/lib/supabase'

export interface PrezziarioResult {
  found: boolean
  prezzo: number | null
  fonte: string
  codice_voce: string | null
  descrizione_prezziario: string | null
}

/**
 * Search for a price in the prezziario cache.
 * Tries current year first, then previous year.
 */
export async function cercaPrezziario(
  descrizione: string,
  regione: string = 'basilicata',
  anno?: number,
): Promise<PrezziarioResult> {
  const targetAnno = anno || new Date().getFullYear()

  for (const y of [targetAnno, targetAnno - 1]) {
    const { data, error } = await supabase
      .from('prezziario')
      .select('*')
      .eq('regione', regione.toLowerCase())
      .eq('anno', y)
      .textSearch('descrizione', descrizione.split(' ').slice(0, 4).join(' & '), {
        type: 'plain',
        config: 'italian',
      })
      .limit(1)

    if (!error && data && data.length > 0) {
      const match = data[0]
      return {
        found: true,
        prezzo: Number(match.prezzo),
        fonte: match.fonte || `Prezziario ${regione} ${y}`,
        codice_voce: match.codice_voce,
        descrizione_prezziario: match.descrizione,
      }
    }
  }

  return { found: false, prezzo: null, fonte: '', codice_voce: null, descrizione_prezziario: null }
}

/**
 * Save a prezziario entry to cache for future lookups.
 */
export async function salvaPrezziario(entry: {
  regione: string
  anno: number
  descrizione: string
  unita_misura: string
  prezzo: number
  codice_voce?: string
  fonte?: string
}): Promise<void> {
  await supabase.from('prezziario').insert({
    regione: entry.regione.toLowerCase(),
    anno: entry.anno,
    descrizione: entry.descrizione,
    unita_misura: entry.unita_misura,
    prezzo: entry.prezzo,
    codice_voce: entry.codice_voce || null,
    fonte: entry.fonte || `Prezziario ${entry.regione} ${entry.anno}`,
  })
}

/**
 * Check how many prezziario entries exist for a region/year.
 * Tries current year, then year-1, then year-2.
 * Returns the first year that has data, or count=0 if none found.
 */
export async function countPrezziario(
  regione: string,
  anno?: number,
): Promise<{ count: number; regione: string; anno: number }> {
  const baseAnno = anno || new Date().getFullYear()

  for (const y of [baseAnno, baseAnno - 1, baseAnno - 2]) {
    const { count, error } = await supabase
      .from('prezziario')
      .select('*', { count: 'exact', head: true })
      .eq('regione', regione.toLowerCase())
      .eq('anno', y)

    if (!error && count !== null && count > 0) {
      return { count, regione: regione.toLowerCase(), anno: y }
    }
  }

  return { count: 0, regione: regione.toLowerCase(), anno: baseAnno }
}

/**
 * List all regions with prezziario data, grouped by regione+anno with row count.
 */
export async function listRegioniDisponibili(): Promise<
  Array<{ regione: string; anno: number; count: number }>
> {
  const { data, error } = await supabase
    .from('prezziario')
    .select('regione, anno')

  if (error || !data) return []

  // Group client-side by regione+anno and count rows
  const map = new Map<string, { regione: string; anno: number; count: number }>()
  for (const row of data) {
    const key = `${row.regione}__${row.anno}`
    const existing = map.get(key)
    if (existing) {
      existing.count++
    } else {
      map.set(key, { regione: row.regione, anno: row.anno, count: 1 })
    }
  }

  return Array.from(map.values()).sort((a, b) =>
    a.regione === b.regione ? b.anno - a.anno : a.regione.localeCompare(b.regione),
  )
}
