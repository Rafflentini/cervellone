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
const { moveFile, listSubfolders, getOrCreatePathFolders } = vi.hoisted(() => ({
  moveFile: vi.fn(async (_fileId: string, _target: string) => 'File spostato nella nuova cartella'),
  listSubfolders: vi.fn(async (_folderId: string) => [] as Array<{ id: string; name: string }>),
  getOrCreatePathFolders: vi.fn(async (_parent: string, _segments: string[]) => 'target-folder'),
}))

vi.mock('./drive', () => ({
  DRIVE_FOLDERS: { CANTIERI_ATTIVI: 'root-cantieri', STUDIO_ATTIVI: 'root-studio' },
  SHEETS: { REGISTRO_CANTIERI: 's1', REGISTRO_PROGETTI: 's2' },
  listSubfolders,
  getOrCreatePathFolders,
  moveFile,
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
