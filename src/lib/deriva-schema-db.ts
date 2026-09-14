/**
 * L'unico pezzo del guardiano che parla col database.
 *
 * Il client Supabase non puo' leggere `information_schema`: PostgREST espone
 * solo gli schemi dichiarati. La fotografia arriva da
 * `public.fotografia_schema()`, di sola lettura e concessa al service_role.
 */
import { getSupabaseServer } from '@/lib/supabase-server'
import type { Fotografia } from './deriva-schema'

export type EsitoFotografia =
  | { ok: true; foto: Fotografia }
  | { ok: false; errore: string }

function elencoDiStringhe(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null
}

function interpretaRisposta(risposta: { data: unknown; error: { message?: string } | null }): EsitoFotografia {
  const { data, error } = risposta
  if (error) return { ok: false, errore: `fotografia_schema: ${error.message}` }
  if (!data || typeof data !== 'object') {
    return { ok: false, errore: 'fotografia_schema ha risposto senza dati: NON so dire se il database sia allineato.' }
  }

  const d = data as Record<string, unknown>
  const tabelle = elencoDiStringhe(d.tabelle)
  const colonne = elencoDiStringhe(d.colonne)
  const indici = elencoDiStringhe(d.indici)
  const chiaviConfig = elencoDiStringhe(d.chiaviConfig)
  const pk = d.chiaviPrimarie

  if (!tabelle || !colonne || !indici || !chiaviConfig || !pk || typeof pk !== 'object') {
    // Malformata = non guardata. Non si degrada a una fotografia parziale:
    // il confronto la leggerebbe come deriva e produrrebbe falsi allarmi.
    return { ok: false, errore: 'fotografia_schema ha risposto in una forma che non riconosco: NON so dire se il database sia allineato.' }
  }

  const chiaviPrimarie: Record<string, string[]> = {}
  for (const [tabella, colonneVoce] of Object.entries(pk as Record<string, unknown>)) {
    const c = elencoDiStringhe(colonneVoce)
    if (c) chiaviPrimarie[tabella.replace(/^public\./, '')] = c
  }

  return { ok: true, foto: { tabelle, colonne, chiaviPrimarie, indici, chiaviConfig } }
}

export async function fotografaSchema(): Promise<EsitoFotografia> {
  return Promise.resolve()
    .then(() => getSupabaseServer().rpc('fotografia_schema'))
    .then((risposta) => interpretaRisposta(risposta as { data: unknown; error: { message?: string } | null }))
    .catch((e) => ({
      ok: false,
      errore: `fotografia_schema non raggiungibile: ${e instanceof Error ? e.message : String(e)}`,
    }))
}
