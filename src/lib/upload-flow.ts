// Decisione PURA: una raffica di upload (molti file insieme) NON va analizzata foto-per-foto
// (intaserebbe la chat). Soglia: 1-3 file → analizza; 4+ → cataloga e basta (l'Ingegnere poi
// dice cosa farne). Nessuna dipendenza IO: testabile in isolamento. Spec incidente 14-15 giu.

export const RAFFICA_THRESHOLD = 4

/**
 * true se il numero di file media ricevuti di recente (entro la finestra) per questa chat è una
 * "raffica" (>= soglia) → catalogare senza analisi. Sotto soglia → analisi normale.
 * `recentCount` deve includere il file corrente.
 */
export function isRaffica(recentCount: number, threshold: number = RAFFICA_THRESHOLD): boolean {
  return Number.isFinite(recentCount) && recentCount >= threshold
}

// Throttle in-memory dell'avviso "ho ricevuto i file": una raffica arriva come N webhook separati;
// senza throttle manderebbe N avvisi. Qui ne manda UNO ogni ~30s per chat. Best-effort (per-istanza
// serverless: al più qualche avviso in più, mai spam). Niente tabella nuova.
const RAFFICA_ACK_COOLDOWN_MS = 60_000 // allineato alla finestra raffica (no doppio avviso su album lenti)
const _lastRafficaAck = new Map<string, number>()
export function shouldSendRafficaAck(chatKey: string, nowMs: number): boolean {
  const last = _lastRafficaAck.get(chatKey)
  if (last !== undefined && nowMs - last < RAFFICA_ACK_COOLDOWN_MS) return false
  _lastRafficaAck.set(chatKey, nowMs)
  return true
}
