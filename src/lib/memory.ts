/**
 * lib/memory.ts — PER-001, FUN-search, DAT-003 fixes
 * 
 * Memoria intelligente:
 * - Non genera embedding per messaggi brevi
 * - Ricerca ibrida: embedding + keyword
 * - Chunk con overlap per file grandi
 * - Sanitizzazione prima del salvataggio
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
export async function searchMemory(query: string, limit = 15): Promise<string> {
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
      for (const kw of keywords.slice(0, 3)) {
        const { data } = await supabase
          .from('embeddings')
          .select('content, message_role')
          .ilike('content', `%${kw}%`)
          .limit(3)
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

  const memories = results.slice(0, limit).map((item, idx) => {
    const label =
      item.message_role === 'knowledge' ? '📄 Documento'
      : item.message_role === 'summary' ? '📋 Riepilogo'
      : item.message_role === 'assistant' ? '🧠 Risposta precedente'
      : item.message_role === 'user' ? '💬 Domanda precedente'
      : '📋 Dato'
    return `[${label} ${idx + 1}]\n${item.content}`
  })

  return `\n\n# Contesto dalla memoria\n${memories.join('\n\n---\n\n')}`
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
