import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Test di `archivia_foto` (src/lib/foto-archive-tools.ts).
 *
 * `archiviaFoto` non e esportata: si passa da `executeFotoArchiveTool`, che e
 * l'unica porta pubblica. Drive e Supabase sono mockati; la logica pura di
 * matching/clustering (`foto-archive-match`, `foto-archive-pending`) e invece
 * quella VERA — stubbarla renderebbe i test vacui.
 */

// ── Mock Drive ──────────────────────────────────────────────────────────────
// `vi.hoisted`: le factory di `vi.mock` sono issate sopra le const del modulo,
// quindi i mock devono nascere li dentro o si prende un TDZ.
const { moveFile, listSubfolders, getOrCreatePathFolders, getFileParents } = vi.hoisted(() => ({
  moveFile: vi.fn(async (_fileId: string, _target: string) => 'File spostato nella nuova cartella'),
  listSubfolders: vi.fn(async (_folderId: string) => [] as Array<{ id: string; name: string }>),
  getOrCreatePathFolders: vi.fn(async (_parent: string, _segments: string[]) => 'target-folder'),
  getFileParents: vi.fn(async (_fileId: string) => [] as string[]),
}))

vi.mock('./drive', () => ({
  DRIVE_FOLDERS: { CANTIERI_ATTIVI: 'root-cantieri', STUDIO_ATTIVI: 'root-studio' },
  SHEETS: { REGISTRO_CANTIERI: 's1', REGISTRO_PROGETTI: 's2' },
  listSubfolders,
  getOrCreatePathFolders,
  moveFile,
  getFileParents,
  readSheet: vi.fn(async () => []),
  appendSheet: vi.fn(),
  DrivePolicyError: class extends Error {},
}))

// ── Mock Supabase ───────────────────────────────────────────────────────────
// Builder chainabile che REGISTRA le operazioni invece di filtrare: il filtro
// vero lo fa il codice sotto test (o il DB), qui interessa cosa viene chiesto.
interface MockOp {
  table: string
  op: 'select' | 'update' | 'insert' | 'delete' | 'unknown'
  columns?: unknown
  payload?: unknown
  filters: { method: string; args: unknown[] }[]
}

let mockOps: MockOp[] = []
let mockHandler: (op: MockOp) => { data: unknown; error: unknown } = () => ({ data: null, error: null })

function makeBuilder(table: string) {
  const op: MockOp = { table, op: 'unknown', filters: [] }
  mockOps.push(op)

  const builder: Record<string, unknown> = {}
  const chain = (method: string) => (...args: unknown[]) => {
    op.filters.push({ method, args })
    return builder
  }
  for (const m of ['eq', 'neq', 'in', 'is', 'ilike', 'gte', 'lte', 'lt', 'gt', 'order', 'limit', 'range']) {
    builder[m] = chain(m)
  }
  builder.select = (columns?: unknown) => {
    if (op.op === 'unknown') op.op = 'select'
    op.columns = columns
    return builder
  }
  builder.update = (payload: unknown) => { op.op = 'update'; op.payload = payload; return builder }
  builder.insert = (payload: unknown) => { op.op = 'insert'; op.payload = payload; return builder }
  builder.delete = () => { op.op = 'delete'; return builder }
  builder.single = () => Promise.resolve(mockHandler(op))
  builder.maybeSingle = () => Promise.resolve(mockHandler(op))
  // thenable: `await supabase.from(...).update(...).eq(...)` risolve qui.
  builder.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(mockHandler(op)).then(resolve, reject)
  return builder
}

vi.mock('./supabase', () => ({
  supabase: { from: (table: string) => makeBuilder(table) },
}))

import { executeFotoArchiveTool } from './foto-archive-tools'

// ── Fixture ─────────────────────────────────────────────────────────────────
const NOW = new Date('2026-08-17T12:00:00.000Z').getTime()

function minutiFa(min: number): string {
  return new Date(NOW - min * 60_000).toISOString()
}

function riga(id: string, minFa: number) {
  return {
    id,
    drive_file_id: `file-${id}`,
    filename: `IMG_${id}.jpg`,
    ambito: null,
    soggetto: null,
    lavorazione: null,
    stato: 'in_attesa',
    created_at: minutiFa(minFa),
    target_folder_id: null,
  }
}

// Cluster A (3 foto) e cluster B (2 foto), separati da un gap >> 3 min:
// clusterByTime li tiene distinti, entrambi entro le 48h.
const clusterA = [riga('a1', 60), riga('a2', 59), riga('a3', 58)]
const clusterB = [riga('b1', 5), riga('b2', 4)]
const dueCluster = [...clusterA, ...clusterB]

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)

  mockOps = []
  mockHandler = () => ({ data: null, error: null })

  moveFile.mockResolvedValue('File spostato nella nuova cartella')
  getOrCreatePathFolders.mockResolvedValue('target-folder')
  getFileParents.mockResolvedValue([])
  listSubfolders.mockImplementation(async (folderId: string) => {
    if (folderId === 'root-cantieri') {
      return [
        { id: 'commessa-007', name: 'Commessa 2026-007 Rossi' },
        { id: 'commessa-alfa', name: 'Commessa Alfa' },
        { id: 'commessa-beta', name: 'Beta Ristrutturazione' },
      ]
    }
    // Sotto la commessa: struttura con una cartella foto inequivocabile.
    return [
      { id: 'sub-01', name: '01_Documenti' },
      { id: 'foto-folder', name: 'Foto' },
    ]
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('archivia_foto — residuo del gruppo (BUG E)', () => {
  it('archivia_foto gruppo:ultimo non dichiara "tutte" quando restano foto recenti (BUG E)', async () => {
    mockHandler = (op) => (op.op === 'select' ? { data: dueCluster, error: null } : { data: null, error: null })

    const out = await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Commessa 2026-007', gruppo: 'ultimo', data: '2026-08-17',
    }, 'chat-1')
    const res = JSON.parse(out!)

    expect(res.ok).toBe(true)
    expect(moveFile).toHaveBeenCalledTimes(2)          // la selezione resta corretta
    expect(res.recenti_non_archiviate).toBe(3)         // oggi: undefined
    expect(res.message).not.toMatch(/^Tutte le/)       // oggi: "Tutte le 2 foto..."
    expect(res.message).toContain('3')
  })

  it('archivia_foto gruppo:tutti resta invariato (BUG E - controprova)', async () => {
    mockHandler = (op) => (op.op === 'select' ? { data: dueCluster, error: null } : { data: null, error: null })

    const out = await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Commessa 2026-007', gruppo: 'tutti', data: '2026-08-17',
    }, 'chat-1')
    const res = JSON.parse(out!)

    expect(moveFile).toHaveBeenCalledTimes(5)
    expect(res.recenti_non_archiviate).toBe(0)
    expect(res.message).toMatch(/^Tutte le 5/)
  })
})

describe('archivia_foto — riga strappata dopo move OK + update DB fallito (BUG F)', () => {
  const rigaPending = {
    id: 'row-1', drive_file_id: 'file-1', filename: 'IMG_1.jpg', stato: 'in_attesa',
    created_at: minutiFa(1), ambito: null, soggetto: null,
    lavorazione: null, target_folder_id: null,
  }
  const rigaPendingConTarget = { ...rigaPending, target_folder_id: 'target-A' }

  it('non strappa dalla commessa giusta la foto gia spostata con update DB fallito (BUG F)', async () => {
    // ROUND 1: move OK, update stato fallito -> riga resta in_attesa
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPending], error: null }
      const payload = op.payload as Record<string, unknown> | undefined
      if (op.op === 'update' && payload?.stato === 'archiviata') {
        return { data: null, error: { message: 'PostgREST 503' } }
      }
      return { data: null, error: null }
    }
    getOrCreatePathFolders.mockResolvedValue('target-A')

    const r1 = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Commessa Alfa',
    }, 'chat-1'))!)
    expect(r1.errori_db).toBe(1)
    expect(moveFile).toHaveBeenCalledWith('file-1', 'target-A')

    // ROUND 2: altra commessa, stessa chat. Il file E GIA in target-A su Drive.
    moveFile.mockClear()
    getFileParents.mockResolvedValue(['target-A'])
    getOrCreatePathFolders.mockResolvedValue('target-B')
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPendingConTarget], error: null }
      return { data: null, error: null }
    }

    await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1')

    // OGGI ROSSO: il file viene spostato in target-B, strappato dalla commessa giusta.
    expect(moveFile).not.toHaveBeenCalledWith('file-1', 'target-B')
  })

  // Test STRUTTURALE, non comportamentale: il mock Supabase non filtra le
  // colonne, quindi la fixture arriva completa comunque e i test di
  // riconciliazione resterebbero verdi anche togliendo `target_folder_id`
  // dalla select. In produzione PostgREST restituirebbe invece il campo
  // `undefined` e la riconciliazione non partirebbe MAI. Va pinnato qui.
  it('fetchOpenPending chiede target_folder_id al DB (BUG F - prerequisito)', async () => {
    mockHandler = (op) => (op.op === 'select' ? { data: [rigaPending], error: null } : { data: null, error: null })

    await executeFotoArchiveTool('archivia_foto', { ambito: 'cantiere', nome: 'Commessa Alfa' }, 'chat-1')

    const select = mockOps.find(o => o.table === 'cervellone_foto_pending' && o.op === 'select')
    expect(select).toBeDefined()
    expect(String(select!.columns)).toContain('target_folder_id')
  })

  it('scrive target_folder_id PRIMA di spostare, cosi un update fallito lascia una traccia (BUG F)', async () => {
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPending], error: null }
      return { data: null, error: null }
    }
    getOrCreatePathFolders.mockResolvedValue('target-A')

    await executeFotoArchiveTool('archivia_foto', { ambito: 'cantiere', nome: 'Commessa Alfa' }, 'chat-1')

    const updates = mockOps.filter(o =>
      o.table === 'cervellone_foto_pending' && o.op === 'update' &&
      o.filters.some(f => f.method === 'eq' && f.args[1] === 'row-1'))
    // OGGI ROSSO: oggi e esattamente 1 (solo quello finale).
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(updates[0].payload).toEqual({ target_folder_id: 'target-A' })
  })

  it('non sposta se non riesce nemmeno a dichiarare l intento (BUG F - fail fast)', async () => {
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPending], error: null }
      const payload = op.payload as Record<string, unknown> | undefined
      if (op.op === 'update' && payload && 'target_folder_id' in payload && !('stato' in payload)) {
        return { data: null, error: { message: 'PostgREST 503' } }
      }
      return { data: null, error: null }
    }
    getOrCreatePathFolders.mockResolvedValue('target-A')

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Commessa Alfa',
    }, 'chat-1'))!)

    expect(moveFile).not.toHaveBeenCalled()
    expect(res.restano_in_attesa).toBe(1)
  })

  it('riprova normalmente se il file NON risulta gia spostato (BUG F - controprova)', async () => {
    // target_folder_id valorizzato ma il file su Drive e altrove: il move non era avvenuto.
    getFileParents.mockResolvedValue(['inbox-telegram'])
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPendingConTarget], error: null }
      return { data: null, error: null }
    }
    getOrCreatePathFolders.mockResolvedValue('target-B')

    await executeFotoArchiveTool('archivia_foto', { ambito: 'cantiere', nome: 'Beta Ristrutturazione' }, 'chat-1')

    expect(moveFile).toHaveBeenCalledWith('file-1', 'target-B')
  })

  // Scostamento deliberato dal piano, che qui prescriveva `.catch(() => [])`:
  // con quella variante un errore transitorio di Drive fa cadere il codice nel
  // ramo "non e mai stata spostata" e il file viene rispostato alla cieca —
  // cioe' esattamente il BUG F, resuscitato su un errore di rete. Senza prova
  // non si tocca il file.
  it('non sposta la foto se la verifica su Drive fallisce (BUG F - fail closed)', async () => {
    getFileParents.mockRejectedValue(new Error('Drive 503'))
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPendingConTarget], error: null }
      return { data: null, error: null }
    }
    getOrCreatePathFolders.mockResolvedValue('target-B')

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1'))!)

    expect(moveFile).not.toHaveBeenCalled()
    expect(res.restano_in_attesa).toBe(1)
  })

  // ── La META che mancava del BUG F ─────────────────────────────────────────
  // Il BUG F ha due meta: (a) NON rispostare il file, (b) RIALLINEARE il DB.
  // Sopra e testata solo la (a): si poteva cancellare la UPDATE
  // {stato:'archiviata'} del ramo riconciliazione e restare verdi, mentre in
  // produzione la foto restava `in_attesa` per sempre — invisibile come
  // archiviata e ri-proposta a ogni tentativo successivo.

  it('riallinea il DB della foto gia spostata: la UPDATE di riconciliazione parte davvero (BUG F)', async () => {
    getFileParents.mockResolvedValue(['target-A'])
    getOrCreatePathFolders.mockResolvedValue('target-B')
    mockHandler = (op) => (op.op === 'select' ? { data: [rigaPendingConTarget], error: null } : { data: null, error: null })

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1'))!)

    // (a) il file NON si tocca
    expect(moveFile).not.toHaveBeenCalled()

    // (b) il DB si riallinea, sulla riga giusta e col payload giusto
    const updates = mockOps.filter(o =>
      o.table === 'cervellone_foto_pending' && o.op === 'update' &&
      o.filters.some(f => f.method === 'eq' && f.args[0] === 'id' && f.args[1] === 'row-1'))
    expect(updates).toHaveLength(1)
    expect((updates[0].payload as Record<string, unknown>).stato).toBe('archiviata')
    // e NON riscrive target_folder_id: il file e in target-A, non in target-B.
    expect(updates[0].payload).not.toHaveProperty('target_folder_id')

    expect(res.ok).toBe(true)
    expect(res.riconciliate).toBe(1)
    expect(res.errori_db).toBe(0)
    // La riconciliata NON e una foto spostata ORA: `archiviate` deve restare 0.
    expect(res.archiviate).toBe(0)
    // Ramo `spostate === 0`, altrimenti mai esercitato: "Tutte le 0 foto
    // spostate e verificate" sarebbe una bugia.
    expect(res.message).toMatch(/^Nessuna foto nuova da spostare in Beta Ristrutturazione\/Foto\//)
    expect(res.message).toMatch(/1 foto erano gi\S+ state spostate in un tentativo precedente/)
    expect(res.message).toMatch(/file NON toccato/)
  })

  it('in un batch misto le riconciliate NON finiscono nel conteggio delle spostate (BUG F)', async () => {
    const nuova = { ...rigaPending, id: 'row-2', drive_file_id: 'file-2', created_at: minutiFa(2) }
    getFileParents.mockResolvedValue(['target-A'])
    getOrCreatePathFolders.mockResolvedValue('target-B')
    mockHandler = (op) =>
      (op.op === 'select' ? { data: [rigaPendingConTarget, nuova], error: null } : { data: null, error: null })

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1'))!)

    // Solo la riga senza tentativo precedente viene spostata.
    expect(moveFile).toHaveBeenCalledTimes(1)
    expect(moveFile).toHaveBeenCalledWith('file-2', 'target-B')

    expect(res.ok).toBe(true)
    expect(res.totale).toBe(2)
    expect(res.archiviate).toBe(1)     // solo la nuova
    expect(res.riconciliate).toBe(1)   // la vecchia, contata a parte
    expect(res.message).toMatch(/^Tutte le 1 foto spostate e verificate in /)
  })

  it('guardia: move fallito resta un errore onesto (BUG F - anti-regressione)', async () => {
    moveFile.mockResolvedValue('Errore: il file NON risulta spostato nella cartella di destinazione.')
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPending], error: null }
      return { data: null, error: null }
    }

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Commessa Alfa',
    }, 'chat-1'))!)

    expect(res.ok).toBe(false)
    expect(res.restano_in_attesa).toBe(1)
  })
})
