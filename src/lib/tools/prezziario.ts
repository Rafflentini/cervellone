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
