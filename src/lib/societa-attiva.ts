/**
 * src/lib/societa-attiva.ts — quale delle due società è in uso in questa conversazione.
 *
 * Ricalca il pattern del progetto attivo (`working-memory.ts`), già collaudato:
 * stato per conversazione, letto a ogni turno e iniettato nel contesto.
 *
 * Due scelte deliberate:
 *
 * 1. Il default è Restruktura. Chi non ha mai usato `/societa` deve trovare il
 *    comportamento di sempre, senza sorprese.
 *
 * 2. Il blocco iniettato NOMINA la società e la partita IVA. La difesa vera non
 *    è il codice: è che l'Ingegnere legga il nome sbagliato PRIMA di confermare.
 */
import { getSupabaseServer } from './supabase-server'
import { getSocieta, type CodiceSocieta, type Societa } from './societa'

const DEFAULT_SOCIETA: CodiceSocieta = 'restruktura'

/**
 * La società in uso nella conversazione. Restruktura se non è mai stata scelta,
 * o se la lettura fallisce: un errore di database non deve cambiare azienda.
 */
export async function getSocietaAttiva(conversationId: string): Promise<CodiceSocieta> {
  if (!conversationId) return DEFAULT_SOCIETA
  try {
    const { data, error } = await getSupabaseServer()
      .from('cervellone_societa_attiva')
      .select('societa')
      .eq('conversation_id', conversationId)
      .maybeSingle()

    if (error || !data?.societa) return DEFAULT_SOCIETA
    const codice = data.societa as CodiceSocieta
    // Difesa contro una riga scritta prima di un'estensione del registro:
    // un codice sconosciuto non deve produrre operazioni su un'azienda fantasma.
    return getSocieta(codice) ? codice : DEFAULT_SOCIETA
  } catch {
    return DEFAULT_SOCIETA
  }
}

/** Imposta la società della conversazione. */
export async function setSocietaAttiva(
  conversationId: string,
  societa: CodiceSocieta,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!conversationId) return { ok: false, error: 'conversazione non disponibile' }
  try {
    const { error } = await getSupabaseServer()
      .from('cervellone_societa_attiva')
      .upsert(
        { conversation_id: conversationId, societa, updated_at: new Date().toISOString() },
        { onConflict: 'conversation_id' },
      )
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Il blocco da iniettare nel contesto del modello.
 *
 * Dice quale società, con la partita IVA, e vieta esplicitamente di dedurre:
 * una deduzione sbagliata qui produce un documento fiscale intestato
 * all'azienda sbagliata, e una fattura elettronica trasmessa non si cancella.
 */
export function bloccoSocietaAttiva(s: Societa): string {
  return [
    '=== SOCIETA ATTIVA ===',
    `Ogni operazione contabile si riferisce a: ${s.denominazione} (P.IVA ${s.piva}).`,
    `Aliquota IVA di riferimento: ${s.aliquotaIvaDefault}%.`,
    "Se l'Ingegnere parla di un'altra societa NON dedurlo e non cambiare da solo:",
    'chiedi conferma e invitalo a usare /societa.',
    '=== fine societa attiva ===',
  ].join('\n')
}
