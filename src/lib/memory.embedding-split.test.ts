/**
 * src/lib/memory.embedding-split.test.ts
 *
 * Il path web scriveva due volte in `messages`: una dal browser e una dal server.
 * Si tiene quella del browser, e il server deve poter generare il solo embedding.
 * Questi test fissano la separazione fra le due responsabilità.
 *
 * Pattern mock: come in memory.test.ts / memoria-tools.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Traccia gli insert per tabella
const inserts: Record<string, unknown[]> = { messages: [], embeddings: [] }

function makeBuilder(table: string) {
  const b: Record<string, unknown> = {}
  b.insert = vi.fn((row: unknown) => {
    if (!inserts[table]) inserts[table] = []
    inserts[table].push(row)
    return Promise.resolve({ data: null, error: null })
  })
  b.select = vi.fn(() => b)
  b.eq = vi.fn(() => b)
  b.order = vi.fn(() => b)
  b.limit = vi.fn(() => Promise.resolve({ data: [], error: null }))
  b.ilike = vi.fn(() => b)
  b.or = vi.fn(() => b)
  return b
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}))

vi.mock('./embeddings', () => ({
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}))

vi.mock('./telegram', () => ({ sendTelegramMessage: vi.fn() }))

import { saveMessageWithEmbedding, saveEmbeddingOnly } from './memory'

// Deve superare MIN_EMBEDDING_LENGTH (50) e non essere "triviale"
const TESTO_LUNGO =
  'Contenzioso Blasi: la controreplica poggia sull articolo 5.1 del contratto ecobonus del 2021.'

describe('separazione fra scrittura del messaggio e generazione embedding', () => {
  beforeEach(() => {
    inserts.messages = []
    inserts.embeddings = []
    vi.clearAllMocks()
  })

  it('saveEmbeddingOnly NON scrive in messages, ma genera l embedding', async () => {
    await saveEmbeddingOnly('conv-1', 'user', TESTO_LUNGO)

    expect(inserts.messages).toHaveLength(0)
    expect(inserts.embeddings).toHaveLength(1)
  })

  it('saveMessageWithEmbedding continua a fare entrambe le cose (path Telegram)', async () => {
    await saveMessageWithEmbedding('conv-2', 'assistant', TESTO_LUNGO)

    expect(inserts.messages).toHaveLength(1)
    expect(inserts.embeddings).toHaveLength(1)
  })

  it('saveEmbeddingOnly salta i messaggi troppo brevi senza scrivere nulla', async () => {
    await saveEmbeddingOnly('conv-3', 'user', 'ok')

    expect(inserts.messages).toHaveLength(0)
    expect(inserts.embeddings).toHaveLength(0)
  })
})

describe('il path web non scrive piu lato server', () => {
  it('claude.ts chiama saveMessageWithEmbedding solo nei path Telegram e nel codice morto', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/lib/claude.ts', 'utf-8')
    const chiamate = src.match(/saveMessageWithEmbedding\(/g) ?? []

    // 2 nel path Telegram (user + assistant) + 2 in callClaude, che e codice morto.
    // Se qualcuno reintroduce le scritture del path web questo numero torna a 6.
    expect(chiamate).toHaveLength(4)
  })
})
