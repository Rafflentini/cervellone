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

  // 3. Memorie esplicite (tool `ricorda`) — più affidabili del RAG, prepend
  const explicitBlock = await searchExplicitMemories(query)

  if (results.length === 0) return explicitBlock

  const memories = results.slice(0, limit).map((item, idx) => {
    const label =
      item.message_role === 'knowledge' ? '📄 Documento'
      : item.message_role === 'summary' ? '📋 Riepilogo'
      : item.message_role === 'assistant' ? '🧠 Risposta precedente'
      : item.message_role === 'user' ? '💬 Domanda precedente'
      : '📋 Dato'
    return `[${label} ${idx + 1}]\n${item.content.slice(0, 500)}`
  })

  const ragBlock = `\n\n# Contesto dalla memoria\n${memories.join('\n\n---\n\n')}`
  if (explicitBlock) {
    return '\n\n' + explicitBlock + ragBlock
  }
  return ragBlock
}

/**
 * Memorie esplicite (tool `ricorda`) pertinenti alla query: match keyword su contenuto+tag.
 * Ritorna al più 3 memorie, troncate a 400 char l'una, formattate per il system.
 * Best-effort: mai throw, ritorna stringa vuota su errore o nessun match.
 */
export async function searchExplicitMemories(query: string): Promise<string> {
  try {
    // Estrai parole significative (>3 char, lowercase, max 6) — stesso pattern di searchMemory
    const words = query
      .toLowerCase()
      .replace(/[^\wàáâãäåæçèéêëìíîïðñòóôõöùúûüýÿ\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 6)

    if (words.length === 0) return ''

    // Una query OR su contenuto + tag per ciascuna keyword
    const orFilters = words.flatMap(kw => [
      `contenuto.ilike.%${kw}%`,
      `tag.ilike.%${kw}%`,
    ])

    const { data, error } = await supabase
      .from('cervellone_memoria_esplicita')
      .select('id, contenuto, tag')
      .or(orFilters.join(','))
      .order('created_at', { ascending: false })
      .limit(10)

    if (error || !data || data.length === 0) return ''

    // Dedup per id, prendi max 3
    const seen = new Set<string>()
    const deduped: Array<{ id: string; contenuto: string; tag: string | null }> = []
    for (const row of data) {
      if (!seen.has(row.id)) {
        seen.add(row.id)
        deduped.push(row)
        if (deduped.length >= 3) break
      }
    }

    if (deduped.length === 0) return ''

    const lines = deduped.map(r => {
      const tagLabel = r.tag ? '[' + r.tag + '] ' : ''
      return '- ' + tagLabel + r.contenuto.slice(0, 400)
    })

    return 'MEMORIE SALVATE rilevanti:\n' + lines.join('\n')
  } catch {
    return ''
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
