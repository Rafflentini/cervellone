import { supabase } from '@/lib/supabase'
import { classifyTask } from '@/lib/task-classifier'

/** Modello economico usato per le chat semplici quando il routing è attivo. */
export const CHEAP_MODEL = 'claude-sonnet-4-6'

/**
 * Routing Opus→Sonnet per le chat semplici, FLAG-GATED e fail-closed.
 *
 * Ritorna `true` (usa modello economico) SOLO se TUTTE queste condizioni valgono:
 *  - il flag `cheap_chat_routing_enabled` in `cervellone_config` è 'true';
 *  - NON ci sono allegati (fileBlocks vuoto) — gli allegati richiedono Opus;
 *  - il messaggio NON è un task documentale (`classifyTask` === false).
 *
 * In qualunque altro caso (flag off/assente, errore di lettura, allegati,
 * task documentale) ritorna `false` → resta il modello attuale (Opus).
 */
export async function shouldUseCheapModel(
  userQuery: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fileBlocks: unknown[]
): Promise<boolean> {
  const { data, error } = await supabase
    .from('cervellone_config')
    .select('value')
    .eq('key', 'cheap_chat_routing_enabled')
    .maybeSingle()

  if (error) {
    console.error('[cheap routing] cheap_chat_routing_enabled read failed:', error.message)
    return false
  }

  const enabled = String(data?.value ?? '').replace(/"/g, '') === 'true'
  if (!enabled) return false

  // Allegati → serve Opus.
  if (Array.isArray(fileBlocks) && fileBlocks.length > 0) return false

  // Task documentale → serve Opus. Chat semplice → modello economico.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return classifyTask(userQuery, fileBlocks as any[]) === false
}
