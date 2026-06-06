/**
 * src/lib/memory.test.ts — test per searchExplicitMemories (GAP 3/5 FIX B)
 *
 * Pattern mock: vi.mock('@/lib/supabase') come in memoria-tools.test.ts.
 * supabase.from() → builder chainabile che termina con Promise risolta da mockResult.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Mock supabase ────────────────────────────────────────────────────────────
type FinalResult = { data: unknown; error: { message: string } | null }

// Risultato configurabile per la tabella cervellone_memoria_esplicita
let mockExplicitResult: FinalResult = { data: [], error: null }

// Builder fluente: supporta .select().or().order().limit() → Promise
function makeExplicitBuilder() {
  const b: Record<string, unknown> = {}
  const terminal = () => Promise.resolve(mockExplicitResult)
  b.select = vi.fn(() => b)
  b.or = vi.fn(() => b)
  b.order = vi.fn(() => b)
  b.limit = vi.fn(terminal)
  b.ilike = vi.fn(() => b)
  b.eq = vi.fn(() => b)
  b.insert = vi.fn(() => ({ select: vi.fn(terminal) }))
  b.then = undefined // non thenable direttamente
  return b
}

// Builder per embeddings (searchMemory path — restituisce sempre vuoto per questi test)
function makeEmbeddingsBuilder() {
  const b: Record<string, unknown> = {}
  const terminal = () => Promise.resolve({ data: [], error: null })
  b.select = vi.fn(() => b)
  b.ilike = vi.fn(() => b)
  b.limit = vi.fn(terminal)
  b.order = vi.fn(() => b)
  b.eq = vi.fn(() => b)
  return b
}

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      if (table === 'cervellone_memoria_esplicita') return makeExplicitBuilder()
      if (table === 'embeddings') return makeEmbeddingsBuilder()
      // fallback
      return makeEmbeddingsBuilder()
    }),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}))

// Mock dipendenze pesanti non utili nei test unitari
vi.mock('./embeddings', () => ({
  generateEmbedding: vi.fn().mockResolvedValue([]),
}))
vi.mock('./sanitize', () => ({
  sanitizeForStorage: vi.fn((s: string) => s),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}))
vi.mock('./resilience', () => ({
  trackEmbeddingFailure: vi.fn(),
  resetEmbeddingFailure: vi.fn(),
}))
vi.mock('./telegram-helpers', () => ({
  sendTelegramMessage: vi.fn(),
}))

import { searchExplicitMemories } from './memory'

beforeEach(() => {
  vi.clearAllMocks()
  mockExplicitResult = { data: [], error: null }
})

// ─── searchExplicitMemories ──────────────────────────────────────────────────

describe('searchExplicitMemories', () => {
  it('match per keyword su contenuto → ritorna blocco formattato', async () => {
    mockExplicitResult = {
      data: [
        { id: 'uuid-1', contenuto: 'Cliente Bianchi accordo 15.000 euro', tag: 'cliente' },
      ],
      error: null,
    }
    const result = await searchExplicitMemories('Bianchi accordo')
    expect(result).toContain('MEMORIE SALVATE rilevanti:')
    expect(result).toContain('[cliente]')
    expect(result).toContain('Bianchi')
  })

  it('match per keyword su tag → ritorna blocco con tag', async () => {
    mockExplicitResult = {
      data: [
        { id: 'uuid-2', contenuto: 'Decisione importante sul cantiere Potenza', tag: 'cantiere' },
      ],
      error: null,
    }
    const result = await searchExplicitMemories('cantiere decisione potenza')
    expect(result).toContain('MEMORIE SALVATE rilevanti:')
    expect(result).toContain('[cantiere]')
  })

  it('nessun match → ritorna stringa vuota', async () => {
    mockExplicitResult = { data: [], error: null }
    const result = await searchExplicitMemories('query senza corrispondenze xyz')
    expect(result).toBe('')
  })

  it('errore DB → stringa vuota senza throw', async () => {
    mockExplicitResult = { data: null, error: { message: 'connection error' } }
    await expect(searchExplicitMemories('qualcosa')).resolves.toBe('')
  })

  it('dedup per id: stessa memoria non appare due volte', async () => {
    mockExplicitResult = {
      data: [
        { id: 'dup-1', contenuto: 'Memoria duplicata A', tag: 'test' },
        { id: 'dup-1', contenuto: 'Memoria duplicata A', tag: 'test' }, // stesso id
        { id: 'dup-2', contenuto: 'Memoria distinta B', tag: 'test' },
      ],
      error: null,
    }
    const result = await searchExplicitMemories('memoria duplicata')
    // Conta quante volte appare "Memoria duplicata A"
    const count = (result.match(/Memoria duplicata A/g) || []).length
    expect(count).toBe(1)
    expect(result).toContain('Memoria distinta B')
  })

  it('troncamento a 400 char per memoria lunga', async () => {
    const longContent = 'X'.repeat(600)
    mockExplicitResult = {
      data: [{ id: 'uuid-long', contenuto: longContent, tag: null }],
      error: null,
    }
    const result = await searchExplicitMemories('contenuto lungo')
    // Il contenuto troncato deve essere <=400 char (più il prefisso "- ")
    const lines = result.split('\n').filter(l => l.startsWith('- '))
    expect(lines.length).toBeGreaterThan(0)
    // Ogni riga contenuto <= 402 char (400 + "- ")
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(402)
    }
  })

  it('query troppo corta (parole <=3 char) → stringa vuota', async () => {
    // "ok no" → tutte ≤3 char → words vuoto
    const result = await searchExplicitMemories('ok no')
    expect(result).toBe('')
  })

  it('al massimo 3 memorie restituite', async () => {
    mockExplicitResult = {
      data: [
        { id: 'a1', contenuto: 'Prima memoria cantiere', tag: 'a' },
        { id: 'a2', contenuto: 'Seconda memoria cantiere', tag: 'b' },
        { id: 'a3', contenuto: 'Terza memoria cantiere', tag: 'c' },
        { id: 'a4', contenuto: 'Quarta memoria cantiere', tag: 'd' },
      ],
      error: null,
    }
    const result = await searchExplicitMemories('memoria cantiere')
    const lines = result.split('\n').filter(l => l.startsWith('- '))
    expect(lines.length).toBeLessThanOrEqual(3)
  })
})
