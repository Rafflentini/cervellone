/**
 * "Dove stiamo mettendo le foto" — separato da "che lavoro stiamo facendo".
 *
 * Sembrano la stessa cosa e non lo sono. Il progetto attivo (project_state)
 * descrive il lavoro in corso: un POS, una perizia, con il suo cliente e le sue
 * cose da fare. Il cantiere delle foto e' l'ultima cartella Drive in cui sono
 * finiti degli scatti. Tenerli nella stessa riga e' stato bocciato due volte
 * dallo stesso audit, sempre per accoppiamenti invisibili — riga fantasma,
 * staleness rinnovata, gate anti-costo aggirato. Vedi la migration
 * 2026-09-02-foto-contesto.sql per l'elenco.
 *
 * Perche' esiste. Fino al 2 settembre 2026 `archivia_foto` pretendeva il
 * cantiere dal modello a ogni chiamata e falliva senza. Misura in produzione:
 * 103 foto su Drive mai archiviate, e la riga del progetto attivo scritta UNA
 * volta in tutta la storia del database — perche' dipendeva dal fatto che il
 * modello si ricordasse di chiamare un tool.
 */
import { supabase } from './supabase'

/**
 * Entro questa finestra dall'ultima CONFERMA esplicita, il cantiere si deduce da
 * solo (dicendolo). Due ore: la durata di una sessione di scatti in cantiere.
 */
export const FOTO_CONTESTO_MAX_MS = 2 * 60 * 60 * 1000

/**
 * Oltre la finestra e fino a qui, il contesto non si butta ma non si usa da
 * solo: si chiede conferma col nome gia' pronto, un tap. Oltre, si riparte da
 * zero. Sette giorni e' la stessa soglia oltre cui il blocco "PROGETTO ATTIVO"
 * sparisce dal system prompt: dedurre da un dato che il modello non vede
 * significherebbe che i due non sanno cosa sta facendo l'altro.
 */
export const FOTO_CONTESTO_CONFERMA_MS = 7 * 24 * 60 * 60 * 1000

export type FotoAmbito = 'cantiere' | 'progetto'

export interface FotoContesto {
  cantiere: string
  ambito: FotoAmbito
  /** Da quanti ms e' stato confermato esplicitamente l'ultima volta. */
  etaMs: number
}

/** Best-effort: qualunque problema → null, e si torna a chiedere. */
export async function getFotoContesto(conversationId: string): Promise<FotoContesto | null> {
  if (!conversationId) return null
  const { data, error } = await supabase
    .from('cervellone_foto_contesto')
    .select('cantiere, ambito, confermato_at')
    .eq('conversation_id', conversationId)
    .maybeSingle()

  if (error) {
    console.error('[foto-contesto] lettura fallita:', error.message)
    return null
  }
  if (!data) return null

  const row = data as { cantiere: string; ambito: string; confermato_at: string }
  const ts = new Date(row.confermato_at).getTime()
  // Un timestamp assente o illeggibile vale "vecchissimo", non "adesso": in
  // dubbio si chiede, non si deduce. E un timestamp nel FUTURO (clock skew,
  // dato manomesso) darebbe eta negativa, cioe' un contesto eternamente fresco:
  // il clamp a 0 lo riporta al massimo a "appena confermato", mai oltre. Senza,
  // le due posture sarebbero opposte — prudente sui dati illeggibili, credulona
  // su quelli impossibili.
  const etaMs = Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : Infinity
  if (row.ambito !== 'cantiere' && row.ambito !== 'progetto') return null

  return { cantiere: row.cantiere, ambito: row.ambito, etaMs }
}

/**
 * Registra dove sono finite le foto.
 *
 * `confermato` distingue i due casi, ed e' il punto: se il cantiere l'ha detto
 * l'Ingegnere, la finestra riparte; se l'ho dedotto io, NON riparte. Altrimenti
 * una deduzione rinnoverebbe se stessa e un giro di tre cantieri nella stessa
 * giornata finirebbe tutto nel primo, senza che scatti mai la richiesta di
 * conferma — cioe' proprio la sequenza da cui quella richiesta doveva difendere.
 */
export async function setFotoContesto(
  conversationId: string,
  cantiere: string,
  ambito: FotoAmbito,
  confermato: boolean,
): Promise<boolean> {
  if (!conversationId || !cantiere) return false
  const now = new Date().toISOString()

  const payload: Record<string, unknown> = { conversation_id: conversationId, cantiere, ambito, updated_at: now }
  if (confermato) payload.confermato_at = now

  const { error } = await supabase
    .from('cervellone_foto_contesto')
    .upsert(payload, { onConflict: 'conversation_id' })

  if (error) {
    console.error('[foto-contesto] scrittura fallita:', error.message)
    return false
  }
  return true
}

/** Usato da /nuova: azzerare la conversazione azzera anche dove vanno le foto. */
export async function clearFotoContesto(conversationId: string): Promise<void> {
  if (!conversationId) return
  const { error } = await supabase
    .from('cervellone_foto_contesto')
    .delete()
    .eq('conversation_id', conversationId)
  if (error) console.error('[foto-contesto] cancellazione fallita:', error.message)
}
