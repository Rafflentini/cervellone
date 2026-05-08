/**
 * lib/memory.ts — PER-001, FUN-search, DAT-003 fixes
 * 
 * Memoria intelligente:
 * - Non genera embedding per messaggi brevi
 * - Ricerca ibrida: embedding + keyword
 * - Chunk con overlap per file grandi
 * - Sanitizzazione prima del salvataggio
 *
 * FIX BUG-DDT-LOST (2026-05-07):
 * - Troncamento retrieval alzato da 500 a 4000 char (8000 se ~~~document)
 * - Nuova archiveDocumentBlocks: auto-salva blocchi ~~~document in tabella documents
 */

import { supabase } from './supabase'
import { generateEmbedding } from './embeddings'
import { sanitizeForStorage } from './sanitize'
import { logInfo, logWarn } from './sanitize'
import { trackEmbeddingFailure, resetEmbeddingFailure } from './resilience'
import { sendTelegramMessage } from './telegram-helpers'

const TRIVIAL_PATTERN = /^(ok|sì|no|grazie|perfetto|va bene|capito|ciao|buongiorno|buonasera|arrivederci|salve)[.!\s]*$/i
const MIN_EMBEDDING_LENGTH = 50

/**
 * Salva un messaggio. Genera embedding solo se il contenuto è sostanziale.
 */
export async function saveMessageWithEmbedding(
  conversationId: string,
  role: string,
  content: string,
  projectId?: string | null,
) {
  const sanitized = sanitizeForStorage(content)

  // Sempre salva in messages (per history Telegram)
  try {
    await supabase.from('messages').insert({
      conversation_id: conversationId,
      role,
      content: sanitized,
    })
  } catch (err) {
    logWarn(`Messages insert failed: ${(err as Error).message}`)
  }

  // Skip embedding per messaggi brevi o triviali
  if (sanitized.length < MIN_EMBEDDING_LENGTH) return
  if (TRIVIAL_PATTERN.test(sanitized.trim())) return

  // Genera embedding
  try {
    const embedding = await generateEmbedding(sanitized)
    if (embedding.length === 0) return

    resetEmbeddingFailure()

    const { error } = await supabase.from('embeddings').insert({
      content: sanitized,
      conversation_id: conversationId,
      message_role: role,
      project_id: projectId || null,
      embedding: JSON.stringify(embedding),
      metadata: { type: 'message' },
    })
    if (error) logWarn(`Embedding insert error: ${error.message}`)
    else logInfo(`MEMORY salvato: ${role} len=${sanitized.length}`)
  } catch (err) {
    trackEmbeddingFailure((msg) =>
      sendTelegramMessage(Number(process.env.ADMIN_CHAT_ID), msg)
    )
    logWarn(`Embedding generation failed: ${(err as Error).message}`)
  }
}

/**
 * Ricerca ibrida: embedding (semantica) + keyword (ILIKE).
 * Cattura sia significato simile che nomi propri/codici esatti.
 */
export async function searchMemory(query: string, limit = 5): Promise<string> {
  // V10: Skip per saluti
  if (TRIVIAL_PATTERN.test(query.trim())) return ''

  const results: Array<{ content: string; message_role: string; similarity: number }> = []
  const seenContent = new Set<string>()

  // 1. Ricerca semantica via embedding
  try {
    const embedding = await generateEmbedding(query)
    if (embedding.length > 0) {
      const { data } = await supabase.rpc('search_memory', {
        query_embedding: JSON.stringify(embedding),
        match_threshold: 0.55,
        match_count: Math.ceil(limit * 0.7),
      })
      if (data) {
        for (const item of data) {
          seenContent.add(item.content.slice(0, 100))
          results.push(item)
        }
      }
    }
  } catch (err) {
    logWarn(`Memory semantic search failed: ${(err as Error).message}`)
  }

  // 2. Ricerca keyword per nomi propri, codici, date
  try {
    const keywords = query.match(/\b[A-Z][a-zà-ú]{2,}\b|\b\d{4}\b|\b[A-Z]{2,}\b/g)
    if (keywords?.length) {
      for (const kw of keywords.slice(0, 2)) {
        const { data } = await supabase
          .from('embeddings')
          .select('content, message_role')
          .ilike('content', `%${kw}%`)
          .limit(2)
        if (data) {
          for (const item of data) {
            const key = item.content.slice(0, 100)
            if (!seenContent.has(key)) {
              seenContent.add(key)
              results.push({ ...item, similarity: 0.5 })
            }
          }
        }
      }
    }
  } catch (err) {
    logWarn(`Memory keyword search failed: ${(err as Error).message}`)
  }

  if (results.length === 0) return ''

  // FIX BUG-DDT-LOST (2026-05-07):
  // Vecchio limite 500 char troncava documenti generati (DDT, preventivi, POS,
  // perizie), facendo perdere codici prodotto/quantità/pesi → modello rigenerava
  // su dati allucinati. Limite alzato a 4000 char standard, 8000 char se il
  // contenuto include un blocco ~~~document (per preservare HTML completo).
  const memories = results.slice(0, limit).map((item, idx) => {
    const label =
      item.message_role === 'knowledge' ? '📄 Documento'
      : item.message_role === 'summary' ? '📋 Riepilogo'
      : item.message_role === 'assistant' ? '🧠 Risposta precedente'
      : item.message_role === 'user' ? '💬 Domanda precedente'
      : '📋 Dato'
    const sliceLimit = item.content.includes('~~~document') ? 8000 : 4000
    return `[${label} ${idx + 1}]\n${item.content.slice(0, sliceLimit)}`
  })

  return `\n\n# Contesto dalla memoria\n${memories.join('\n\n---\n\n')}`
}

/**
 * FIX BUG-DDT-LOST (2026-05-07):
 * Estrae blocchi ~~~document dalla risposta assistant e li salva nella tabella
 * `documents` per recupero futuro via cerca_documenti. Il title è estratto dal
 * primo <h1>/<h2>/<title> del HTML, altrimenti fallback "Documento <data> #N".
 *
 * Idempotente per content+conversation: se un documento identico esiste già,
 * lo skip (evita duplicati su rigenerazioni).
 *
 * Da chiamare in claude.ts dopo ogni saveMessageWithEmbedding(assistant).
 */
export async function archiveDocumentBlocks(
  conversationId: string,
  fullResponse: string,
): Promise<void> {
  if (!fullResponse || !fullResponse.includes('~~~document')) return

  const blockPattern = /~~~document\s*([\s\S]*?)~~~/g
  let match: RegExpExecArray | null
  let blockIdx = 0

  while ((match = blockPattern.exec(fullResponse)) !== null) {
    blockIdx++
    const html = match[1].trim()
    if (html.length < 100) continue // skip vuoti/trivial

    // Estrai title da h1/h2/title (in quest'ordine di priorità)
    let title = ''
    const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/i)
    const h2 = html.match(/<h2[^>]*>([^<]+)<\/h2>/i)
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i)
    if (h1) title = h1[1].trim()
    else if (h2) title = h2[1].trim()
    else if (titleTag) title = titleTag[1].trim()
    else title = `Documento ${new Date().toISOString().slice(0, 10)} #${blockIdx}`

    // Pulisce entità HTML basic dal title
    title = title
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 200)

    // Idempotenza: skip se già esiste documento con stesso name+conversation
    try {
      const { data: existing } = await supabase
        .from('documents')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('name', title)
        .limit(1)
      if (existing && existing.length > 0) {
        logInfo(`DOC auto-archive skip (già esistente): "${title.slice(0, 60)}"`)
        continue
      }
    } catch {
      // Se la query fallisce, procedi con l'insert (meglio duplicato che perso)
    }

    // Salva in documents
    try {
      const { error } = await supabase.from('documents').insert({
        name: title,
        content: html,
        conversation_id: conversationId,
        type: 'html',
        metadata: {
          source: 'auto-archive',
          block_idx: blockIdx,
          archived_at: new Date().toISOString(),
        },
      })
      if (error) {
        logWarn(`archiveDocumentBlocks insert error: ${error.message}`)
      } else {
        logInfo(`DOC auto-archiviato: "${title.slice(0, 60)}" (${html.length} char)`)
      }
    } catch (err) {
      logWarn(`archiveDocumentBlocks failed: ${(err as Error).message}`)
    }
  }
}

/**
 * Salva conoscenza da file con chunk overlap (DAT-003 fix).
 */
export async function saveFileKnowledge(
  conversationId: string,
  content: string,
  fileName: string,
) {
  const CHUNK_SIZE = 30_000
  const OVERLAP = 500

  for (let i = 0; i < content.length; i += CHUNK_SIZE - OVERLAP) {
    const chunk = content.slice(i, i + CHUNK_SIZE)
    // Cerca di tagliare a fine paragrafo
    const breakPoint = chunk.lastIndexOf('\n\n', CHUNK_SIZE)
    const cleanChunk = breakPoint > CHUNK_SIZE * 0.8
      ? chunk.slice(0, breakPoint)
      : chunk
    const partLabel = content.length > CHUNK_SIZE
      ? ` — parte ${Math.floor(i / (CHUNK_SIZE - OVERLAP)) + 1}`
      : ''
    const label = `[File: ${fileName}${partLabel}]`
    await saveMessageWithEmbedding(conversationId, 'knowledge', `${label}\n\n${cleanChunk}`)
  }
}

// Alias per compatibilità con projects/route.ts
export async function saveProjectKnowledge(
  projectId: string,
  content: string,
  fileName: string,
) {
  await saveFileKnowledge(projectId, content, fileName)
}
