// src/lib/foto-ingest.ts
// Helper CONDIVISO (parita Telegram/web): salva subito le foto su Drive (Telegram Inbox)
// e crea un record persistente cervellone_foto_pending. Da qui le foto NON si perdono.
import { uploadBinaryToDrive, getTelegramInboxFolderId } from './drive'
import { supabase } from './supabase'

export type FotoIngestItem = { buffer: Buffer; mimeType: string; filename: string }
export interface FotoIngestInput {
  canale: 'telegram' | 'web'
  chatId?: string | null
  items: FotoIngestItem[]
}
export interface FotoIngestRecord {
  id: string
  driveFileId: string
  driveUrl: string | null
  filename: string
}

const IMAGE_MIME = /^image\//

export async function ingestPhotoUpload(input: FotoIngestInput): Promise<FotoIngestRecord[]> {
  const out: FotoIngestRecord[] = []
  if (!input.items.length) return out
  let inbox: string
  try {
    inbox = await getTelegramInboxFolderId()
  } catch (err) {
    console.error('[FOTO-INGEST] inbox non disponibile:', err instanceof Error ? err.message : err)
    return out
  }
  for (const it of input.items) {
    if (!IMAGE_MIME.test(it.mimeType)) continue // solo foto/immagini in questa iterazione
    try {
      const { id: driveFileId, webViewLink } = await uploadBinaryToDrive(it.buffer, it.filename, it.mimeType, inbox)
      const { data, error } = await supabase
        .from('cervellone_foto_pending')
        .insert({
          chat_id: input.chatId ?? null,
          canale: input.canale,
          drive_file_id: driveFileId,
          drive_url: webViewLink,
          filename: it.filename,
          stato: 'in_attesa',
        })
        .select('id')
        .single()
      if (error) { console.error('[FOTO-INGEST] insert fallita:', error.message); continue }
      out.push({ id: data.id, driveFileId, driveUrl: webViewLink, filename: it.filename })
      console.log(`[FOTO-INGEST] canale=${input.canale} file=${it.filename} id=${driveFileId}`)
    } catch (err) {
      console.error('[FOTO-INGEST] upload fallito:', err instanceof Error ? err.message : err)
    }
  }
  return out
}
