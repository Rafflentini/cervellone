/**
 * src/lib/image-memory.ts — Memoria delle IMMAGINI caricate (fix BUG1).
 *
 * Problema: le immagini caricate non sono "ricordate" nei turni successivi
 * (la tabella `messages` salva solo testo). Qui, a fine turno, persistiamo
 * l'ESTRAZIONE testuale che il modello ha già prodotto sull'immagine, nello
 * store `documents` (type 'image-extraction'), con i riferimenti Drive in
 * metadata. Ad ogni turno successivo `buildImagesPointer` ri-inietta un blocco
 * breve nel system prompt → il bot non dice "non posso rivederle" e non
 * inventa identificativi.
 *
 * CRITICO: tutto INCONDIZIONATO (NON gated da isWorkingMemoryEnabled, OFF in
 * prod). Best-effort: nessuna funzione lancia mai.
 *
 * Riuso `documents` (id, name, content, conversation_id, type, metadata jsonb,
 * created_at) → nessuna migration.
 */

import { getSupabaseServer } from './supabase-server'

const IMAGE_EXTRACTION_TYPE = 'image-extraction'
/** Recency del pointer: 24h (conversazione Telegram è globale/permanente). */
const POINTER_RECENCY_MS = 24 * 60 * 60 * 1000
const POINTER_MAX_ENTRIES = 8
/** Estratto massimo per immagine mostrato nel pointer. */
const EXTRACTION_EXCERPT_MAXLEN = 600
/** Estrazione minima perché valga la pena salvarla. */
const MIN_EXTRACTION_LENGTH = 40

export interface UploadedImageRef {
  driveFileId: string
  filename: string
  driveUrl?: string | null
}

/**
 * Persiste l'estrazione testuale del turno (assistantText) legandola ai
 * riferimenti Drive delle immagini caricate IN QUEL turno. Salva SOLO se ci
 * sono immagini e l'estrazione è non banale. Best-effort.
 */
export async function captureImageExtraction(
  conversationId: string,
  assistantText: string,
  images: UploadedImageRef[],
): Promise<{ saved: boolean; id?: string; reason?: string }> {
  try {
    if (!conversationId) return { saved: false, reason: 'no-conversation' }
    if (!images || images.length === 0) return { saved: false, reason: 'no-images' }
    const content = (assistantText || '').trim()
    if (content.length < MIN_EXTRACTION_LENGTH) return { saved: false, reason: 'empty-extraction' }

    const supabase = getSupabaseServer()
    const filenames = images.map((i) => i.filename).filter(Boolean)
    const driveFileIds = images.map((i) => i.driveFileId).filter(Boolean)
    const driveUrls = images.map((i) => i.driveUrl).filter((u): u is string => Boolean(u))
    const name = `Estrazione immagini: ${filenames.slice(0, 3).join(', ') || '(immagini)'}`.slice(0, 120)

    const { data, error } = await supabase
      .from('documents')
      .insert({
        name,
        content,
        conversation_id: conversationId,
        type: IMAGE_EXTRACTION_TYPE,
        metadata: { source: 'image-memory', filenames, drive_file_ids: driveFileIds, drive_urls: driveUrls },
      })
      .select('id')
      .single()

    if (error) {
      console.error('[image-memory] insert failed:', error.message)
      return { saved: false, reason: error.message }
    }
    return { saved: true, id: (data as { id?: string } | null)?.id }
  } catch (err) {
    console.error('[image-memory] captureImageExtraction error:', err instanceof Error ? err.message : err)
    return { saved: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Blocco breve che elenca le immagini già caricate+analizzate (ultime 24h) con
 * l'estratto dei dati. Ritorna '' se non ce ne sono. Best-effort.
 */
export async function buildImagesPointer(conversationId: string): Promise<string> {
  try {
    if (!conversationId) return ''
    const supabase = getSupabaseServer()
    const sinceIso = new Date(Date.now() - POINTER_RECENCY_MS).toISOString()

    const { data, error } = await supabase
      .from('documents')
      .select('id, name, content, metadata, created_at')
      .eq('conversation_id', conversationId)
      .eq('type', IMAGE_EXTRACTION_TYPE)
      .gt('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(POINTER_MAX_ENTRIES)

    if (error) {
      console.error('[image-memory] buildImagesPointer read failed:', error.message)
      return ''
    }
    if (!data || data.length === 0) return ''

    const lines: string[] = []
    lines.push(
      '=== IMMAGINI/DOCUMENTI GIÀ CARICATI E ANALIZZATI in questa chat — i dati estratti sono QUI SOTTO. NON dire che non puoi rivederli; NON re-inventare numeri/ID: se un dato non è qui, CHIEDILO. ===',
    )
    for (const row of data) {
      const r = row as { content?: string | null; metadata?: unknown }
      const meta = (r.metadata ?? {}) as { filenames?: unknown; drive_file_ids?: unknown }
      const names = Array.isArray(meta.filenames) && meta.filenames.length
        ? (meta.filenames as string[]).join(', ')
        : '(immagini)'
      const ids = Array.isArray(meta.drive_file_ids) ? (meta.drive_file_ids as string[]).join(', ') : ''
      const excerpt = (r.content || '').trim().slice(0, EXTRACTION_EXCERPT_MAXLEN)
      lines.push(`- File: ${names}${ids ? ` [drive: ${ids}]` : ''}\n  Dati già estratti: ${excerpt}`)
    }
    lines.push('=== fine immagini ===')
    return lines.join('\n')
  } catch (err) {
    console.error('[image-memory] buildImagesPointer error:', err instanceof Error ? err.message : err)
    return ''
  }
}
