// src/lib/working-memory.test.ts
/**
 * Test FASE 1+2 — memoria procedurale (procedures) + progetto attivo (project_state).
 *
 * GAP 2 (2026-06-06): nuovi test per createProcedure e inferTaskType data-driven.
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
 *
 * NOTA: il builder è stato esteso per supportare la catena `.select(...).then(resolve)`
 * usata da inferTaskType per caricare tutte le righe (senza .maybeSingle()).
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
  inferTaskTypeRegex,
  invalidateProcedureCache,
  createProcedure,
  buildActiveProjectContext,
  buildWorkingContext,
} from './working-memory'

beforeEach(() => {
  fromSpy.mockClear()
  resetTables()
  invalidateProcedureCache()
})

// ─── inferTaskTypeRegex (sincrono, fallback) ──────────────────────────────────

describe('inferTaskTypeRegex (fallback sincrono)', () => {
  it('riconosce un POS', () => {
    expect(inferTaskTypeRegex('prepara un POS per Celano')).toBe('pos')
  })

  it('frase generica → altro', () => {
    expect(inferTaskTypeRegex('ciao come stai')).toBe('altro')
  })

  it('riconosce CME', () => {
    expect(inferTaskTypeRegex('fai un computo metrico per il cantiere')).toBe('cme')
  })
})

// ─── inferTaskType (async, data-driven + fallback) ───────────────────────────

describe('inferTaskType (async data-driven)', () => {
  it('riconosce un POS via fallback regex quando tabella vuota', async () => {
    // tabella procedures vuota → array vuoto → fallback regex
    setTable('procedures', { data: [], error: null })
    const result = await inferTaskType('prepara un POS per Celano')
    expect(result).toBe('pos')
  })

  it('frase generica senza procedure → altro', async () => {
    setTable('procedures', { data: [], error: null })
    const result = await inferTaskType('ciao come stai')
    expect(result).toBe('altro')
  })

  it('riconosce un tipo creato a runtime via task_type (parola intera)', async () => {
    setTable('procedures', {
      data: [{ task_type: 'cigo', keywords: [] }],
      error: null,
    })
    const result = await inferTaskType('prepara pratica cigo per il cantiere')
    expect(result).toBe('cigo')
  })

  it('riconosce un tipo creato a runtime via keywords', async () => {
    setTable('procedures', {
      data: [{ task_type: 'cigo', keywords: ['cassa integrazione', 'ammortizzatore'] }],
      error: null,
    })
    const result = await inferTaskType('gestisci la cassa integrazione ordinaria')
    expect(result).toBe('cigo')
  })

  it('usa la cache: non ricarica il DB al secondo invocation', async () => {
    setTable('procedures', {
      data: [{ task_type: 'durc', keywords: ['documento unico regolarita'] }],
      error: null,
    })
    await inferTaskType('richiesta durc per cantiere')
    const callsAfterFirst = fromSpy.mock.calls.length

    // Seconda invocation: non deve toccare il DB (cache valida)
    await inferTaskType('rinnova durc')
    expect(fromSpy.mock.calls.length).toBe(callsAfterFirst)
  })

  it('dopo invalidateProcedureCache ricarica il DB', async () => {
    setTable('procedures', {
      data: [{ task_type: 'cigo', keywords: [] }],
      error: null,
    })
    await inferTaskType('cigo')
    const callsBefore = fromSpy.mock.calls.length

    invalidateProcedureCache()
    await inferTaskType('cigo')
    expect(fromSpy.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('fallback regex se DB restituisce errore', async () => {
    setTable('procedures', { data: null, error: { message: 'connection error' } })
    const result = await inferTaskType('prepara un POS')
    expect(result).toBe('pos')
  })
})

// ─── createProcedure ─────────────────────────────────────────────────────────

describe('createProcedure', () => {
  it('inserisce una nuova procedura e ritorna true', async () => {
    // maybeSingle per SELECT esistenza → null (non esiste)
    setTable('procedures', { data: null, error: null })

    const ok = await createProcedure({
      taskType: 'CIGO',
      title: 'CIGO — Cassa Integrazione Guadagni Ordinaria',
      keywords: ['cigo', 'cassa integrazione'],
      checklist: ['Raccogliere buste paga', 'Compilare modulo INPS SR41'],
    })
    expect(ok).toBe(true)
  })

  it('normalizza taskType: uppercase → lowercase, caratteri non validi rimossi', async () => {
    setTable('procedures', { data: null, error: null })

    const ok = await createProcedure({
      taskType: 'DURC Preventivo!',
      title: 'DURC',
    })
    expect(ok).toBe(true)
    // Verifichiamo che l'INSERT abbia ricevuto il taskType normalizzato
    // (il fromSpy ha ricevuto la chiamata con il task_type sanitizzato)
    const insertCall = fromSpy.mock.calls.find(([table]) => table === 'procedures')
    expect(insertCall).toBeDefined()
  })

  it('ritorna false se task_type esiste gia', async () => {
    // maybeSingle ritorna un record esistente
    setTable('procedures', { data: { id: 1 }, error: null })

    const ok = await createProcedure({
      taskType: 'pos',
      title: 'POS duplicato',
    })
    expect(ok).toBe(false)
  })

  it('ritorna false se taskType o title sono vuoti', async () => {
    const ok1 = await createProcedure({ taskType: '', title: 'Titolo' })
    expect(ok1).toBe(false)

    const ok2 = await createProcedure({ taskType: 'tipo', title: '   ' })
    expect(ok2).toBe(false)
  })

  it('invalida la cache dopo insert riuscito', async () => {
    setTable('procedures', { data: null, error: null })

    // Prima: popola cache
    setTable('procedures', {
      data: [{ task_type: 'pos', keywords: [] }],
      error: null,
    })
    await inferTaskType('pos')
    const callsBefore = fromSpy.mock.calls.length

    // createProcedure deve invalidare la cache
    setTable('procedures', { data: null, error: null })
    await createProcedure({ taskType: 'durc', title: 'DURC' })

    // La prossima inferTaskType ricarica il DB (cache invalidata)
    setTable('procedures', { data: [{ task_type: 'durc', keywords: [] }], error: null })
    await inferTaskType('durc')
    expect(fromSpy.mock.calls.length).toBeGreaterThan(callsBefore + 1)
  })
})

// ─── buildActiveProjectContext ────────────────────────────────────────────────

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

describe('buildActiveProjectContext — stale filter', () => {
  it('progetto aggiornato oggi → viene iniettato', async () => {
    const now = new Date().toISOString()
    setTable('project_state', {
      data: {
        conversation_id: 'conv-fresh',
        status: 'active',
        project_name: 'POS Recente',
        cliente: null,
        cantiere: null,
        task_type: null,
        key_files: {},
        done: [],
        pending: [],
        decisions: [],
        updated_at: now,
      },
      error: null,
    })

    const out = await buildActiveProjectContext('conv-fresh')
    expect(out).toContain('=== PROGETTO ATTIVO')
    expect(out).toContain('POS Recente')
  })

  it('progetto con updated_at 8 giorni fa → stringa vuota (stale)', async () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    setTable('project_state', {
      data: {
        conversation_id: 'conv-stale',
        status: 'active',
        project_name: 'POS Vecchio',
        cliente: null,
        cantiere: null,
        task_type: null,
        key_files: {},
        done: [],
        pending: [],
        decisions: [],
        updated_at: eightDaysAgo,
      },
      error: null,
    })

    const out = await buildActiveProjectContext('conv-stale')
    expect(out).toBe('')
  })

  it('progetto senza updated_at → viene iniettato (fail-open: data mancante non è stale)', async () => {
    setTable('project_state', {
      data: {
        conversation_id: 'conv-nodate',
        status: 'active',
        project_name: 'POS Senza Data',
        cliente: null,
        cantiere: null,
        task_type: null,
        key_files: {},
        done: [],
        pending: [],
        decisions: [],
        updated_at: null,
      },
      error: null,
    })

    const out = await buildActiveProjectContext('conv-nodate')
    expect(out).toContain('=== PROGETTO ATTIVO')
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
        keywords: [],
      },
      error: null,
    })

    const out = await buildWorkingContext('prepara un POS', 'conv1')
    expect(out).toContain('=== PROGETTO ATTIVO')
    expect(out).toContain('=== PROCEDURA')
  })

  it('senza conversationId né procedura → stringa vuota', async () => {
    setTable('procedures', { data: [], error: null })
    const out = await buildWorkingContext('ciao come stai', undefined)
    expect(out).toBe('')
  })
})
