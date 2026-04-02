import { supabase } from './supabase'
import { generateEmbedding } from './embeddings'

// Salva un messaggio con il suo embedding
export async function saveMessageWithEmbedding(
  conversationId: string,
  role: string,
  content: string,
  projectId?: string | null,
) {
  // Genera embedding (non bloccante per la UX)
  const embedding = await generateEmbedding(content)

  if (embedding.length > 0) {
    const { error } = await supabase.from('embeddings').insert({
      content,
      conversation_id: conversationId,
      message_role: role,
      project_id: projectId || null,
      embedding: JSON.stringify(embedding),
      metadata: { type: 'message' },
    })
    if (error) {
      console.error('MEMORY salvataggio errore:', error)
    } else {
      console.log('MEMORY salvato:', role, content.slice(0, 50) + '...')
    }
  }
}

// Cerca nella memoria i contenuti più rilevanti per la domanda
export async function searchMemory(query: string, limit: number = 30): Promise<string> {
  const embedding = await generateEmbedding(query)

  if (embedding.length === 0) return ''

  const { data, error } = await supabase.rpc('search_memory', {
    query_embedding: JSON.stringify(embedding),
    match_threshold: 0.40,
    match_count: limit,
  })

  if (error) {
    console.error('MEMORY ricerca errore:', error)
    return ''
  }
  console.log('MEMORY ricerca risultati:', data?.length || 0, 'per query:', query.slice(0, 50))
  if (!data || data.length === 0) return ''

  // Formatta i risultati come contesto
  const memories = data.map((item: { content: string; message_role: string; similarity: number }, idx: number) => {
    const label = item.message_role === 'knowledge' ? '📄 Documento'
      : item.message_role === 'assistant' ? '🧠 Risposta precedente'
      : item.message_role === 'user' ? '💬 Domanda precedente'
      : '📋 Dato'
    return `[${label} ${idx + 1}]\n${item.content}`
  })

  return `\n\n# La tua memoria — dati reali dal database di Restruktura\nQuesti ${memories.length} risultati provengono dal database. Sono documenti, analisi e conversazioni reali.\n\n${memories.join('\n\n---\n\n')}`
}

// Salva conoscenza di progetto (da ZIP o documenti caricati)
export async function saveProjectKnowledge(
  projectId: string,
  content: string,
  fileName: string,
) {
  const embedding = await generateEmbedding(content)

  if (embedding.length > 0) {
    await supabase.from('embeddings').insert({
      content,
      project_id: projectId,
      message_role: 'knowledge',
      embedding: JSON.stringify(embedding),
      metadata: { type: 'project_file', fileName },
    })
  }
}
