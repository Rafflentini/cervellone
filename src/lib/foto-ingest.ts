// src/lib/foto-ingest.ts
// Helper CONDIVISO (parita Telegram/web): salva subito le foto su Drive (Telegram Inbox)
// e crea un record persistente cervellone_foto_pending.
//
// REGOLA (incidenti 12 e 14 giu 2026): una foto puo non entrare — Drive giu, token OAuth
// scaduto, mime non riconosciuto, insert DB fallita — ma NON puo sparire in silenzio.
// Ogni ramo che non produce un record lo DICHIARA nel risultato, cosi il chiamante puo
// avvisare l'Ingegnere. Il conteggio non deve mai mentire.
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

/** Scartata prima dell'upload: il mime non e riconosciuto come immagine. */
export interface FotoIngestSkipped {
  filename: string
  mimeType?: string
  reason: 'mime-non-immagine'
}
/** ORFANA: i byte SONO su Drive ma la riga cervellone_foto_pending non e stata creata
 *  → `archivia_foto` non la vedra mai. E il caso peggiore: sembra tutto a posto. */
export interface FotoIngestOrphan {
  driveFileId: string
  driveUrl: string | null
  filename: string
  reason: 'db-insert'
  error?: string
}
/** Upload su Drive fallito: la foto non e da nessuna parte. */
export interface FotoIngestFailed {
  filename: string
  reason: 'upload'
  error?: string
}

export interface FotoIngestResult {
  records: FotoIngestRecord[]
  skipped: FotoIngestSkipped[]
  orphans: FotoIngestOrphan[]
  failed: FotoIngestFailed[]
  /** Nessun item e stato nemmeno tentato: Inbox Drive irraggiungibile (es. token OAuth scaduto). */
  fatal?: 'inbox-non-disponibile'
}

const IMAGE_MIME = /^image\//

export async function ingestPhotoUpload(input: FotoIngestInput): Promise<FotoIngestResult> {
  const out: FotoIngestResult = { records: [], skipped: [], orphans: [], failed: [] }
  if (!input.items.length) return out
  let inbox: string
  try {
    inbox = await getTelegramInboxFolderId()
  } catch (err) {
    console.error('[FOTO-INGEST] inbox non disponibile:', err instanceof Error ? err.message : err)
    out.fatal = 'inbox-non-disponibile'
    return out
  }
  for (const it of input.items) {
    if (!IMAGE_MIME.test(it.mimeType)) {
      // Il mime arriva indovinato dall'estensione (telegram-helpers): estensione ignota
      // → application/octet-stream. Non silenziare: dichiaralo.
      console.warn(`[FOTO-INGEST] scartata (mime non-immagine) file=${it.filename} mime=${it.mimeType}`)
      out.skipped.push({ filename: it.filename, mimeType: it.mimeType, reason: 'mime-non-immagine' })
      continue
    }
    let uploaded: { id: string; webViewLink: string | null } | null = null
    try {
      const r = await uploadBinaryToDrive(it.buffer, it.filename, it.mimeType, inbox)
      uploaded = { id: r.id, webViewLink: r.webViewLink ?? null }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[FOTO-INGEST] upload fallito:', msg)
      out.failed.push({ filename: it.filename, reason: 'upload', error: msg })
      continue
    }
    const driveFileId = uploaded.id
    const webViewLink = uploaded.webViewLink
    try {
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
      if (error || !data) {
        const msg = error?.message ?? 'insert senza dati'
        console.error(`[FOTO-INGEST] ORFANA (byte su Drive ${driveFileId}, riga assente):`, msg)
        out.orphans.push({ driveFileId, driveUrl: webViewLink, filename: it.filename, reason: 'db-insert', error: msg })
        continue
      }
      out.records.push({ id: data.id, driveFileId, driveUrl: webViewLink, filename: it.filename })
      console.log(`[FOTO-INGEST] canale=${input.canale} file=${it.filename} id=${driveFileId}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[FOTO-INGEST] ORFANA (byte su Drive ${driveFileId}, insert in errore):`, msg)
      out.orphans.push({ driveFileId, driveUrl: webViewLink, filename: it.filename, reason: 'db-insert', error: msg })
    }
  }
  return out
}

/** true se qualcosa non e entrato: il chiamante DEVE avvisare l'utente. */
export function hasFotoIngestProblems(r: FotoIngestResult): boolean {
  return !!r.fatal || r.skipped.length > 0 || r.orphans.length > 0 || r.failed.length > 0
}

function nomi(list: { filename: string }[]): string {
  return list.map(x => x.filename).join(', ')
}

/**
 * Messaggio in italiano (PURO, testabile) da mandare all'Ingegnere quando l'ingest non e pulito.
 * Dice la verita operativa — cosa NON e stato salvato e cosa deve fare lui — non l'errore tecnico.
 * Ritorna null se non c'e nulla da segnalare.
 */
export function formatFotoIngestWarning(r: FotoIngestResult): string | null {
  if (!hasFotoIngestProblems(r)) return null
  const righe: string[] = []
  if (r.fatal === 'inbox-non-disponibile') {
    righe.push(
      '⚠️ *Foto NON salvate.* Non riesco ad accedere alla cartella Drive (Inbox Telegram), ' +
      'quindi non ho archiviato nulla di questo invio. Le rimandi tra qualche minuto: non le recupero da solo.',
    )
    return righe.join('\n\n')
  }
  if (r.orphans.length > 0) {
    righe.push(
      `⚠️ ${r.orphans.length} foto ${r.orphans.length === 1 ? 'e' : 'sono'} su Drive ma NON ${r.orphans.length === 1 ? 'risulta' : 'risultano'} ` +
      `in attesa di archiviazione: con \`archivia_foto\` non ${r.orphans.length === 1 ? 'la vedro' : 'le vedro'}. ` +
      `File: ${nomi(r.orphans)}. ${r.orphans.length === 1 ? 'La rimandi' : 'Le rimandi'} oppure ${r.orphans.length === 1 ? 'la sposti' : 'le sposti'} a mano dalla Inbox di Drive.`,
    )
  }
  if (r.failed.length > 0) {
    righe.push(
      `⚠️ ${r.failed.length} foto non caricate su Drive (upload fallito): ${nomi(r.failed)}. Non sono da nessuna parte: le rimandi.`,
    )
  }
  if (r.skipped.length > 0) {
    righe.push(
      `⚠️ ${r.skipped.length} file non riconosciuti come immagine e quindi NON archiviati: ${nomi(r.skipped)}. ` +
      'Li rimandi come foto (o con estensione .jpg/.png).',
    )
  }
  if (r.records.length > 0) {
    righe.push(`✅ Archiviate correttamente: ${r.records.length}.`)
  }
  return righe.join('\n\n')
}
