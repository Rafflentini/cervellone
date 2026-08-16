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

// ── Foto inviate come FILE ("Invia come file" su iPhone, per non comprimere) ──
// Arrivano come message.document, non come message.photo: finivano su Drive SENZA riga
// cervellone_foto_pending → archivia_foto non le avrebbe mai viste. Decisione PURA.
const IMAGE_EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', jfif: 'image/jpeg',
  png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
  avif: 'image/avif',
}

/** Mime immagine dedotto dall'estensione del nome file, o null se non e un'immagine nota. */
export function photoMimeFromFilename(filename?: string | null): string | null {
  if (!filename) return null
  const parts = filename.split('.')
  if (parts.length < 2) return null
  const ext = parts.pop()!.toLowerCase()
  return IMAGE_EXT_MIME[ext] ?? null
}

export interface PhotoLikeDocument {
  mime_type?: string | null
  file_name?: string | null
}

/**
 * true se questo `message.document` e in realta una FOTO: mime image/*, oppure
 * mime assente/generico (application/octet-stream) con estensione immagine.
 */
export function isPhotoLikeDocument(doc: PhotoLikeDocument): boolean {
  const mime = (doc.mime_type || '').toLowerCase().trim()
  if (mime.startsWith('image/')) return true
  if (mime && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream') return false
  return photoMimeFromFilename(doc.file_name) !== null
}
