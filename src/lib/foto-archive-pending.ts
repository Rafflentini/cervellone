// Funzioni PURE per l'anti-contaminazione dell'archiviazione foto (spec
// 2026-06-13 componente #2). Estratte qui per essere testabili in isolamento,
// senza dipendenze da Supabase/Drive. NON usano Date.now: il tempo "ora" è
// sempre passato come argomento esplicito (deterministico).

export interface PendingRow {
  id: string
  drive_file_id: string
  filename: string | null
  created_at: string
  stato: string
}

const DEFAULT_RECENCY_MS = 48 * 60 * 60 * 1000 // 48 ore
const DEFAULT_GAP_MS = 3 * 60 * 1000 // 3 minuti

/**
 * Divide le pending in "recenti" (created_at entro la finestra di rilevanza, di
 * default ultime 48h rispetto a nowMs) e "vecchie" (oltre la finestra). Una riga
 * con created_at non parsabile è trattata come VECCHIA (conservativo: non la
 * auto-includo). L'ordine relativo delle righe è preservato.
 */
export function splitRecentOlder(
  rows: PendingRow[],
  nowMs: number,
  recencyMs: number = DEFAULT_RECENCY_MS,
): { recent: PendingRow[]; older: PendingRow[] } {
  const recent: PendingRow[] = []
  const older: PendingRow[] = []
  const cutoff = nowMs - recencyMs
  for (const row of rows) {
    const t = Date.parse(row.created_at)
    if (Number.isFinite(t) && t > cutoff) {
      recent.push(row)
    } else {
      older.push(row)
    }
  }
  return { recent, older }
}

/**
 * Raggruppa le righe per "raffica" temporale: ordina per created_at crescente e
 * inizia un nuovo gruppo ogni volta che il gap dal created_at precedente supera
 * gapMs (default 3 min). Ritorna i gruppi ordinati per tempo. Righe con
 * created_at non parsabile vengono ordinate per ultime e raggruppate insieme.
 */
export function clusterByTime(
  rows: PendingRow[],
  gapMs: number = DEFAULT_GAP_MS,
): PendingRow[][] {
  if (rows.length === 0) return []

  const withTime = rows.map(row => {
    const t = Date.parse(row.created_at)
    return { row, t: Number.isFinite(t) ? t : Number.POSITIVE_INFINITY }
  })
  withTime.sort((a, b) => a.t - b.t)

  const groups: PendingRow[][] = []
  let current: PendingRow[] = []
  let prevT: number | null = null

  for (const { row, t } of withTime) {
    if (prevT === null) {
      current = [row]
    } else {
      const gap = t === Number.POSITIVE_INFINITY || prevT === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : t - prevT
      if (gap > gapMs) {
        groups.push(current)
        current = [row]
      } else {
        current.push(row)
      }
    }
    prevT = t
  }
  if (current.length > 0) groups.push(current)
  return groups
}
