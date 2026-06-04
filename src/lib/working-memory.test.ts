// src/lib/working-memory.test.ts
/**
 * Test FASE 2 — memoria di progetto attivo (project_state) + inferTaskType.
 *
 * Pattern mock supabase coerente con src/v19/__tests__/email-pending.spec.ts:
 * un builder fluente configurabile che ritorna self sui filtri e termina con
 * `.maybeSingle()` / thenable. DIFFERENZA dal pattern reale: qui mockiamo
 * `./supabase-server` (export FUNZIONE `getSupabaseServer`), non `@/lib/supabase`
 * (export const `supabase`). Quindi il factory ritorna `{ from }` e la mock di
 * getSupabaseServer è `vi.fn(() => ({ from }))`.
 *
 * Inoltre `from()` è risolto PER TABELLA: getActiveProject legge `project_state`,
 * buildProcedureContext legge `procedures`. Usiamo una mappa tabella→builder così
 * un singolo test può configurare entrambe le sorgenti in modo deterministico.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type FinalResult = { data: unknown; error: { message: string } | null }

interface Builder {
  select: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  insert: ReturnType<typeof vi.fn>
  eq: ReturnType<typeof vi.fn>
  maybeSingle: ReturnType<typeof vi.fn>
  then: (resolve: (v: FinalResult) => unknown) => Promise<unknown>
}

function makeBuilder(final: FinalResult): Builder {
  const b: Partial<Builder> = {}
  b.select = vi.fn(() => b as Builder)
  b.update = vi.fn(() => b as Builder)
  b.insert = vi.fn(() => b as Builder)
  b.eq = vi.fn(() => b as Builder)
  b.maybeSingle = vi.fn(() => Promise.resolve(final))
  b.then = (resolve: (v: FinalResult) => unknown) => Promise.resolve(resolve(final))
  return b as Builder
}

// Mappa tabella → risultato. Default vuoto/non trovato.
const tableResults: Record<string, FinalResult> = {}

function setTable(table: string, final: FinalResult): void {
  tableResults[table] = final
}

function resetTables(): void {
  for (const k of Object.keys(tableResults)) delete tableResults[k]
}

const fromSpy = vi.fn((table: string) => {
  const final = tableResults[table] ?? { data: null, error: null }
  return makeBuilder(final)
})

vi.mock('./supabase-server', () => ({
  getSupabaseServer: vi.fn(() => ({
    from: (table: string) => fromSpy(table),
  })),
}))

import {
  inferTaskType,
  buildActiveProjectContext,
  buildWorkingContext,
} from './working-memory'

beforeEach(() => {
  fromSpy.mockClear()
  resetTables()
})

describe('inferTaskType', () => {
  it('riconosce un POS', () => {
    expect(inferTaskType('prepara un POS per Celano')).toBe('pos')
  })

  it('frase generica → altro', () => {
    expect(inferTaskType('ciao come stai')).toBe('altro')
  })
})

describe('buildActiveProjectContext', () => {
  it('senza conversationId → stringa vuota', async () => {
    const out = await buildActiveProjectContext(undefined)
    expect(out).toBe('')
  })

  it('con progetto attivo mockato → contiene nome progetto e pending', async () => {
    setTable('project_state', {
      data: {
        conversation_id: 'conv1',
        status: 'active',
        project_name: 'POS Celano',
        cliente: 'Celano',
        cantiere: null,
        task_type: 'pos',
        key_files: {},
        done: [],
        pending: ['organico'],
        decisions: [],
      },
      error: null,
    })

    const out = await buildActiveProjectContext('conv1')
    expect(out).toContain('=== PROGETTO ATTIVO')
    expect(out).toContain('POS Celano')
    expect(out).toContain('organico')
  })
})

describe('buildWorkingContext', () => {
  it('con procedura + progetto mockati contiene entrambi i blocchi', async () => {
    // Progetto attivo per conv1
    setTable('project_state', {
      data: {
        conversation_id: 'conv1',
        status: 'active',
        project_name: 'POS Celano',
        cliente: 'Celano',
        cantiere: null,
        task_type: 'pos',
        key_files: { dvr: 'drive://dvr.pdf' },
        done: [],
        pending: ['organico'],
        decisions: [],
      },
      error: null,
    })
    // Procedura per task_type 'pos' (inferito da "prepara un POS")
    setTable('procedures', {
      data: {
        id: 'p1',
        task_type: 'pos',
        title: 'Piano Operativo di Sicurezza',
        checklist: [{ step: 'Leggi il DVR', source: 'Drive' }],
        output_spec: 'PDF',
        save_location: 'Drive/POS',
        lessons: [],
      },
      error: null,
    })

    const out = await buildWorkingContext('prepara un POS', 'conv1')
    expect(out).toContain('=== PROGETTO ATTIVO')
    expect(out).toContain('=== PROCEDURA')
  })

  it('senza conversationId né procedura → stringa vuota', async () => {
    const out = await buildWorkingContext('ciao come stai', undefined)
    expect(out).toBe('')
  })
})
