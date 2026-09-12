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

export type EsitoSocietaAttiva =
  | { ok: true; codice: CodiceSocieta; esplicita: boolean }
  | { ok: false; errore: string }

/**
 * Quale societa' e' in uso, distinguendo TRE casi che il codice di prima
 * schiacciava in uno:
 *
 *   - l'Ingegnere l'ha scelta      → { ok: true, esplicita: true }
 *   - non l'ha mai scelta          → { ok: true, esplicita: false }  (politica: Restruktura)
 *   - non siamo riusciti a leggere → { ok: false }
 *
 * Il terzo caso e' il motivo per cui questa funzione esiste. Prima tornava
 * `restruktura` anche su errore, col commento «un errore di database non deve
 * cambiare azienda» — ragionamento sano che pero' rendeva un guasto
 * indistinguibile da una scelta. Chi stampa una partita IVA su un documento
 * NON puo' accontentarsi di un'ipotesi: la guardia a valle vale esattamente
 * quanto vale questo dato.
 */
export async function leggiSocietaAttiva(conversationId?: string): Promise<EsitoSocietaAttiva> {
  if (!conversationId) return { ok: true, codice: DEFAULT_SOCIETA, esplicita: false }
  try {
    const { data, error } = await getSupabaseServer()
      .from('cervellone_societa_attiva')
      .select('societa')
      .eq('conversation_id', conversationId)
      .maybeSingle()

    if (error) return { ok: false, errore: error.message || 'lettura della societa\' attiva fallita' }
    if (!data?.societa) return { ok: true, codice: DEFAULT_SOCIETA, esplicita: false }
    const codice = data.societa as CodiceSocieta
    // Difesa contro una riga scritta prima di un'estensione del registro:
    // un codice sconosciuto non deve produrre operazioni su un'azienda fantasma.
    if (!getSocieta(codice)) return { ok: true, codice: DEFAULT_SOCIETA, esplicita: false }
    return { ok: true, codice, esplicita: true }
  } catch (err) {
    return { ok: false, errore: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * La società in uso nella conversazione. Restruktura se non è mai stata scelta,
 * o se la lettura fallisce: un errore di database non deve cambiare azienda.
 *
 * Firma e comportamento osservabile invariati: usata dai chiamanti di contesto
 * (prompt, blocco iniettato) dove indovinare Restruktura non produce un
 * documento. Il percorso che genera documenti usa `leggiSocietaAttiva`.
 */
export async function getSocietaAttiva(conversationId?: string): Promise<CodiceSocieta> {
  const e = await leggiSocietaAttiva(conversationId)
  return e.ok ? e.codice : DEFAULT_SOCIETA
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
    'chiedi conferma, poi usa il tool imposta_societa_attiva.',
    '=== fine societa attiva ===',
  ].join('\n')
}
