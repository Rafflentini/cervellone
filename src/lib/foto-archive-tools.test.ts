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
const { moveFile, listSubfolders, getOrCreatePathFolders, getFileParents, getFolderPathNames, readSheet, appendSheet } = vi.hoisted(() => ({
  moveFile: vi.fn(async (_fileId: string, _target: string) => 'File spostato nella nuova cartella'),
  listSubfolders: vi.fn(async (_folderId: string) => [] as Array<{ id: string; name: string }>),
  getOrCreatePathFolders: vi.fn(async (_parent: string, _segments: string[]) => 'target-folder'),
  getFileParents: vi.fn(async (_fileId: string) => [] as string[]),
  getFolderPathNames: vi.fn(async (_folderId: string, _maxLevels?: number) => [] as string[]),
  // ATTENZIONE: `readSheet` VERA ritorna una STRINGA formattata ("N righe:\nRiga 1: …"),
  // non un array. Il mock precedente era `async () => []` e nessun test esercitava
  // prepara_cartella, quindi la discrepanza non e mai emersa: un mock che non
  // somiglia alla realta non prova niente (stessa trappola del mock di sendEmailInternal).
  readSheet: vi.fn(async (_sheetId: string, _range: string) => 'Foglio vuoto.'),
  appendSheet: vi.fn(async (_sheetId: string, _range: string, _values: string[][]) => 'Riga aggiunta.'),
}))

vi.mock('./drive', () => ({
  DRIVE_FOLDERS: { CANTIERI_ATTIVI: 'root-cantieri', STUDIO_ATTIVI: 'root-studio' },
  SHEETS: { REGISTRO_CANTIERI: 's1', REGISTRO_PROGETTI: 's2' },
  listSubfolders,
  getOrCreatePathFolders,
  moveFile,
  getFileParents,
  getFolderPathNames,
  readSheet,
  appendSheet,
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
  getFolderPathNames.mockResolvedValue([])
  readSheet.mockResolvedValue('Foglio vuoto.')
  appendSheet.mockResolvedValue('Riga aggiunta.')
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
    // NON `toContain('3')`: passava per coincidenza (nessun altro '3' nella
    // fixture) e sarebbe rimasto verde anche con il conteggio sbagliato.
    expect(res.message).toMatch(/Restano 3 foto recenti NON archiviate \(raffiche precedenti\)/)
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
  // Tentativo precedente su un'ALTRA commessa (target-A = "Commessa Alfa"): il
  // file e finito li. Serve ai test in cui la richiesta di ORA punta altrove.
  const rigaPendingConTarget = { ...rigaPending, target_folder_id: 'target-A' }
  // Tentativo precedente sulla STESSA commessa che si sta richiedendo ora
  // (target-B = "Beta Ristrutturazione"): move riuscito, update di stato fallito.
  // E' la RETRY della stessa archiviazione — l'unico caso in cui riconciliare e
  // chiudere la riga e' legittimo, perche' il file e' gia' esattamente dove
  // l'Ingegnere lo sta mandando.
  const rigaPendingStessoTarget = { ...rigaPending, target_folder_id: 'target-B' }

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
    mockOps = []
    getFileParents.mockResolvedValue(['target-A'])
    getOrCreatePathFolders.mockResolvedValue('target-B')
    getFolderPathNames.mockResolvedValue(['Commessa Alfa', 'Foto', '2026-08-17'])
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPendingConTarget], error: null }
      return { data: null, error: null }
    }

    const r2 = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1'))!)

    // Asserzione centrale del BUG F, invariata: il file NON si tocca.
    expect(moveFile).not.toHaveBeenCalledWith('file-1', 'target-B')

    // CAMBIO DELIBERATO (fix P1): prima il codice riconciliava e CHIUDEVA la
    // riga, anche se la cartella richiesta ora (target-B) non e quella dove il
    // file sta davvero (target-A). Cosi la foto usciva da OPEN_STATI e non era
    // piu recuperabile via tool, mentre il messaggio nominava solo target-B.
    // Ora la riga resta aperta e il tool chiede conferma, dicendo il NOME della
    // commessa dove la foto si trova per davvero.
    const chiusure = mockOps.filter(o =>
      o.table === 'cervellone_foto_pending' && o.op === 'update' &&
      (o.payload as Record<string, unknown> | undefined)?.stato === 'archiviata' &&
      o.filters.some(f => f.method === 'eq' && f.args[0] === 'id' && f.args[1] === 'row-1'))
    expect(chiusure).toHaveLength(0)
    expect(r2.ok).toBe(false)
    expect(r2.need).toBe('conferma_ricollocazione')
    expect(r2.message).toContain('Commessa Alfa/Foto/2026-08-17')
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
    // RETRY della STESSA archiviazione: il file e gia in target-B, che e proprio
    // la cartella che "Beta Ristrutturazione" risolve adesso.
    getFileParents.mockResolvedValue(['target-B'])
    getOrCreatePathFolders.mockResolvedValue('target-B')
    mockHandler = (op) => (op.op === 'select' ? { data: [rigaPendingStessoTarget], error: null } : { data: null, error: null })

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
    // e NON riscrive target_folder_id: era gia corretto, la riconciliazione
    // tocca SOLO lo stato. Riscriverlo mascherebbe un eventuale disallineamento.
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
    // Una riga da riconciliare (retry della stessa archiviazione) + una foto mai
    // toccata: la prima si chiude senza move, la seconda si sposta.
    const nuova = { ...rigaPending, id: 'row-2', drive_file_id: 'file-2', created_at: minutiFa(2) }
    getFileParents.mockResolvedValue(['target-B'])
    getOrCreatePathFolders.mockResolvedValue('target-B')
    mockHandler = (op) =>
      (op.op === 'select' ? { data: [rigaPendingStessoTarget, nuova], error: null } : { data: null, error: null })

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

  // FIX 3 — il fallimento della riconciliazione veniva riciclato in `spostate`
  // via `erroriDb`, e quindi anche in notaDb ("sono GIÀ nella cartella"). Ma
  // quelle righe restano APERTE: `archivia_foto` non ha chiuso niente e le
  // riproporra al tentativo successivo, quindi contarle fra le spostate ORA e
  // una bugia. Caso limite: batch di sole riconciliazioni fallite → il messaggio
  // diceva "Tutte le N foto spostate e verificate in {path}" mentre non si era
  // mosso un file.
  it('riconciliazione fallita: non conta come foto spostata (FIX 3 - caso limite)', async () => {
    // Retry della stessa archiviazione, ma stavolta anche il riallineamento del
    // DB fallisce: la riga resta aperta.
    getFileParents.mockResolvedValue(['target-B'])
    getOrCreatePathFolders.mockResolvedValue('target-B')
    mockHandler = (op) => {
      if (op.op === 'select') return { data: [rigaPendingStessoTarget], error: null }
      const payload = op.payload as Record<string, unknown> | undefined
      if (op.op === 'update' && payload?.stato === 'archiviata') {
        return { data: null, error: { message: 'PostgREST 503' } }
      }
      return { data: null, error: null }
    }

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1'))!)

    expect(moveFile).not.toHaveBeenCalled()
    // La bugia del caso limite, per prima: e quello che legge l'Ingegnere.
    expect(res.message).not.toMatch(/^Tutte le/)
    expect(res.message).toMatch(/^Nessuna foto nuova da spostare in /)
    expect(res.errori_riconciliazione).toBe(1)
    expect(res.riconciliate).toBe(0)
    // Contatore separato: NON deve travasare in erroriDb ne in `archiviate`.
    expect(res.errori_db).toBe(0)
    expect(res.archiviate).toBe(0)
    expect(res.totale).toBe(1)
    // E nemmeno la nota di erroriDb, che dichiara "sono GIÀ nella cartella".
    expect(res.message).not.toMatch(/sono GI\S+ nella cartella/)
    // Deve invece dirlo: restano aperte, il file non e in questa cartella.
    expect(res.message).toMatch(/riallineamento del DB \S+ fallito/)
    expect(res.message).toMatch(/restano APERTE/)
  })

  // ── P1: la riconciliazione chiudeva righe di ALTRE commesse ────────────────
  // Il blocco di riconciliazione non confrontava `row.target_folder_id` con la
  // cartella richiesta ORA: bastava che il file fosse dove diceva la riga per
  // chiuderla. Una riga vecchia trascinata in un batch nuovo veniva quindi
  // marcata `archiviata` — usciva da OPEN_STATI, spariva dalle pendenti e non
  // era piu recuperabile via tool — mentre la foto restava nella commessa
  // precedente e il messaggio nominava solo la commessa nuova.
  it('stessa cartella richiesta: riconcilia come prima (retry legittima, invariato)', async () => {
    getFileParents.mockResolvedValue(['target-B'])
    getOrCreatePathFolders.mockResolvedValue('target-B')
    mockHandler = (op) =>
      (op.op === 'select' ? { data: [{ ...rigaPending, target_folder_id: 'target-B' }], error: null } : { data: null, error: null })

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1'))!)

    expect(res.ok).toBe(true)
    expect(res.riconciliate).toBe(1)
    expect(moveFile).not.toHaveBeenCalled()

    const updates = mockOps.filter(o =>
      o.table === 'cervellone_foto_pending' && o.op === 'update' &&
      o.filters.some(f => f.method === 'eq' && f.args[0] === 'id' && f.args[1] === 'row-1'))
    expect(updates).toHaveLength(1)
    expect((updates[0].payload as Record<string, unknown>).stato).toBe('archiviata')
    // Il percorso normale non deve pagare chiamate Drive in piu: il nome
    // leggibile della cartella serve SOLO nel ramo (raro) di ricollocazione.
    expect(getFolderPathNames).not.toHaveBeenCalled()
  })

  it('cartella DIVERSA senza ricolloca: non chiude la riga e non tocca il file', async () => {
    getFileParents.mockResolvedValue(['target-alfa'])
    getOrCreatePathFolders.mockResolvedValue('target-beta')
    getFolderPathNames.mockResolvedValue(['Commessa Alfa', 'Foto', '2026-08-17'])
    mockHandler = (op) =>
      (op.op === 'select' ? { data: [{ ...rigaPending, target_folder_id: 'target-alfa' }], error: null } : { data: null, error: null })

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1'))!)

    // (a) il file resta dov'e
    expect(moveFile).not.toHaveBeenCalledWith('file-1', 'target-beta')
    expect(moveFile).not.toHaveBeenCalled()

    // (b) la riga NON viene chiusa: deve restare in OPEN_STATI, o la foto
    // diventa irrecuperabile via tool.
    const chiusure = mockOps.filter(o =>
      o.table === 'cervellone_foto_pending' && o.op === 'update' &&
      (o.payload as Record<string, unknown> | undefined)?.stato === 'archiviata' &&
      o.filters.some(f => f.method === 'eq' && f.args[0] === 'id' && f.args[1] === 'row-1'))
    expect(chiusure).toHaveLength(0)

    // (c) l'esito chiede conferma e dice DOVE sta davvero la foto, col NOME
    // della commessa: un id Drive non dice niente all'Ingegnere.
    expect(res.ok).toBe(false)
    expect(res.need).toBe('conferma_ricollocazione')
    expect(res.da_ricollocare).toHaveLength(1)
    expect(res.da_ricollocare[0].id).toBe('row-1')
    expect(res.da_ricollocare[0].si_trova_in).toBe('Commessa Alfa/Foto/2026-08-17')
    expect(res.message).toContain('Commessa Alfa/Foto/2026-08-17')
    expect(res.message).toContain('ricolloca:true')
    expect(getFolderPathNames).toHaveBeenCalledWith('target-alfa')
  })

  it('cartella DIVERSA con ricolloca:true: sposta davvero e chiude la riga', async () => {
    getFileParents.mockResolvedValue(['target-alfa'])
    getOrCreatePathFolders.mockResolvedValue('target-beta')
    mockHandler = (op) =>
      (op.op === 'select' ? { data: [{ ...rigaPending, target_folder_id: 'target-alfa' }], error: null } : { data: null, error: null })

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione', ricolloca: true,
    }, 'chat-1'))!)

    expect(moveFile).toHaveBeenCalledWith('file-1', 'target-beta')
    expect(res.ok).toBe(true)
    expect(res.need).toBeUndefined()
    expect(res.archiviate).toBe(1)
    expect(res.riconciliate).toBe(0)

    const updates = mockOps.filter(o =>
      o.table === 'cervellone_foto_pending' && o.op === 'update' &&
      o.filters.some(f => f.method === 'eq' && f.args[0] === 'id' && f.args[1] === 'row-1'))
    // intento (target_folder_id riscritto sulla cartella nuova) + chiusura.
    expect(updates.length).toBeGreaterThanOrEqual(2)
    expect(updates[0].payload).toEqual({ target_folder_id: 'target-beta' })
    expect((updates[updates.length - 1].payload as Record<string, unknown>).stato).toBe('archiviata')
  })

  it('batch misto: la foto nuova viene archiviata lo stesso, la ricollocazione resta da confermare', async () => {
    const nuova = { ...rigaPending, id: 'row-2', drive_file_id: 'file-2', created_at: minutiFa(2) }
    getFileParents.mockResolvedValue(['target-alfa'])
    getOrCreatePathFolders.mockResolvedValue('target-beta')
    getFolderPathNames.mockResolvedValue(['Commessa Alfa', 'Foto', '2026-08-17'])
    mockHandler = (op) =>
      (op.op === 'select'
        ? { data: [{ ...rigaPending, target_folder_id: 'target-alfa' }, nuova], error: null }
        : { data: null, error: null })

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1'))!)

    // La foto nuova non deve restare ostaggio della riga da ricollocare.
    expect(moveFile).toHaveBeenCalledTimes(1)
    expect(moveFile).toHaveBeenCalledWith('file-2', 'target-beta')
    expect(moveFile).not.toHaveBeenCalledWith('file-1', 'target-beta')

    // Ma l'esito complessivo resta un `need`: serve la decisione dell'Ingegnere.
    expect(res.ok).toBe(false)
    expect(res.need).toBe('conferma_ricollocazione')
    expect(res.totale).toBe(2)
    expect(res.archiviate).toBe(1)          // solo row-2
    expect(res.riconciliate).toBe(0)        // row-1 NON e stata riconciliata
    expect(res.errori_move).toBe(0)
    expect(res.da_ricollocare).toHaveLength(1)
    expect(res.da_ricollocare[0].id).toBe('row-1')
  })

  it('se getFolderPathNames esplode, il ramo regge e ripiega sull id', async () => {
    getFileParents.mockResolvedValue(['target-alfa'])
    getOrCreatePathFolders.mockResolvedValue('target-beta')
    getFolderPathNames.mockRejectedValue(new Error('Drive 500'))
    mockHandler = (op) =>
      (op.op === 'select' ? { data: [{ ...rigaPending, target_folder_id: 'target-alfa' }], error: null } : { data: null, error: null })

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1'))!)

    expect(res.ok).toBe(false)
    expect(res.need).toBe('conferma_ricollocazione')
    expect(res.da_ricollocare[0].si_trova_in).toBe('target-alfa')
    expect(moveFile).not.toHaveBeenCalled()
  })

  it('"Tutte le N foto" non si dice se una riconciliazione e fallita', async () => {
    const nuova = { ...rigaPending, id: 'row-2', drive_file_id: 'file-2', created_at: minutiFa(2) }
    getFileParents.mockResolvedValue(['target-beta'])
    getOrCreatePathFolders.mockResolvedValue('target-beta')
    mockHandler = (op) => {
      if (op.op === 'select') {
        return { data: [{ ...rigaPending, target_folder_id: 'target-beta' }, nuova], error: null }
      }
      const payload = op.payload as Record<string, unknown> | undefined
      const suRow1 = op.filters.some(f => f.method === 'eq' && f.args[0] === 'id' && f.args[1] === 'row-1')
      if (op.op === 'update' && suRow1 && payload?.stato === 'archiviata') {
        return { data: null, error: { message: 'PostgREST 503' } }
      }
      return { data: null, error: null }
    }

    const res = JSON.parse((await executeFotoArchiveTool('archivia_foto', {
      ambito: 'cantiere', nome: 'Beta Ristrutturazione',
    }, 'chat-1'))!)

    expect(res.ok).toBe(true)
    expect(res.archiviate).toBe(1)
    expect(res.errori_riconciliazione).toBe(1)
    // "Tutte" e falso: row-1 resta aperta.
    expect(res.message).not.toMatch(/^Tutte le/)
    expect(res.message).toMatch(/^Archiviate 1 foto in /)
    expect(res.message).toMatch(/restano APERTE/)
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

// ── prepara_cartella: il Registro letto per intero ──────────────────────────
// Il guardrail anti-duplicato confrontava la nuova commessa con le sole righe
// lette da `readSheet(sheetId, 'A1:Z500')`. Oltre la 500esima riga il Registro
// era invisibile al controllo: la commessa esistente non veniva trovata e ne
// nasceva una DUPLICATA, senza alcun avviso. Stessa malattia del BUG D
// (listSubfolders fermo a 200), con un esito peggiore: li si diceva
// 'non_trovata', qui si crea in silenzio.
describe('prepara_cartella — anti-duplicato oltre le 500 righe', () => {
  const HEADER = ['Commessa', 'Comune', 'Committente', 'Oggetto']

  // 600 righe dati: la commessa da riconoscere sta alla 550esima, cioe' FUORI
  // dalle prime 500 righe del foglio (header incluso).
  const DATI = Array.from({ length: 600 }, (_, i) => {
    const n = i + 1
    return n === 550
      ? ['2026-550', 'Potenza', 'Ferrovie Appulo Lucane', 'Rifacimento copertura']
      : [`2026-${String(n).padStart(3, '0')}`, `ComuneX${n}`, `ClienteX${n}`, `LavoroX${n}`]
  })

  // Simula il comportamento REALE dell'API Sheets: un range con un tetto di riga
  // ('A1:Z500') restituisce solo quelle righe; un range aperto ('A:Z') le da tutte.
  function foglioPerRange(range: string): string {
    const tetto = /[A-Z](\d+)\s*$/.exec(range)
    const limite = tetto ? Number(tetto[1]) : Number.POSITIVE_INFINITY
    const tutte = [HEADER, ...DATI]
    const righe = tutte.slice(0, limite)
    const corpo = righe.map((r, i) => `Riga ${i + 1}: ${r.join(' | ')}`).join('\n')
    return `${righe.length} righe:\n${corpo}`
  }

  const NUOVA_COMMESSA = {
    ambito: 'cantiere',
    valori: {
      Commessa: '2026-550',
      Comune: 'Potenza',
      Committente: 'Ferrovie Appulo Lucane',
      Oggetto: 'Rifacimento copertura',
    },
  }

  beforeEach(() => {
    readSheet.mockImplementation(async (_sheetId: string, range: string) => foglioPerRange(range))
  })

  it('trova il duplicato anche se sta oltre la 500esima riga del Registro', async () => {
    const res = JSON.parse((await executeFotoArchiveTool('prepara_cartella', NUOVA_COMMESSA, 'chat-1'))!)

    expect(res.ok).toBe(false)
    expect(res.need).toBe('conferma_duplicato')
    expect(res.candidati.join(' ')).toContain('2026-550')
    // e soprattutto: NON ha scritto niente nel Registro
    expect(appendSheet).not.toHaveBeenCalled()
  })

  it('chiede il Registro senza tetto di riga', async () => {
    await executeFotoArchiveTool('prepara_cartella', NUOVA_COMMESSA, 'chat-1')

    const range = readSheet.mock.calls[0][1]
    expect(range).not.toMatch(/\d/)
  })

  it('crea la commessa quando non ci sono simili (controprova)', async () => {
    const res = JSON.parse((await executeFotoArchiveTool('prepara_cartella', {
      ambito: 'cantiere',
      valori: {
        Commessa: '2029-999',
        Comune: 'Matera',
        Committente: 'Nuovo Cliente Srl',
        Oggetto: 'Ristrutturazione palazzina',
      },
    }, 'chat-1'))!)

    expect(res.ok).toBe(true)
    expect(appendSheet).toHaveBeenCalledTimes(1)
  })

  it('un Registro illeggibile non viene scambiato per una intestazione mancante', async () => {
    // `readSheet` NON lancia: ritorna una stringa d'errore. Senza riconoscerla,
    // il codice la trattava come un foglio dall'header incomprensibile e diceva
    // all'utente di sistemare l'intestazione, mandandolo a cercare il problema
    // dove non era.
    readSheet.mockResolvedValue('Errore leggendo il foglio: Error: quota exceeded')

    const res = JSON.parse((await executeFotoArchiveTool('prepara_cartella', NUOVA_COMMESSA, 'chat-1'))!)

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/quota exceeded/)
    expect(res.error).not.toMatch(/intestazione/i)
    expect(appendSheet).not.toHaveBeenCalled()
  })
})
