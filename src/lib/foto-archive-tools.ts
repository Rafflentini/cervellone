import {
  DRIVE_FOLDERS,
  SHEETS,
  listSubfolders,
  getOrCreatePathFolders,
  moveFile,
  readSheet,
  appendSheet,
  DrivePolicyError,
} from './drive'
import { supabase } from './supabase'

interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

type Ambito = 'cantiere' | 'progetto'
type FotoStato = 'in_attesa' | 'da_archiviare' | 'archiviata' | 'errore'

interface FotoPendingRow {
  id: string
  drive_file_id: string
  filename: string | null
  ambito: Ambito | null
  soggetto: string | null
  lavorazione: string | null
  stato: FotoStato
  created_at: string
}

type FolderMatch = { id: string; name: string }

const OPEN_STATI: FotoStato[] = ['in_attesa', 'da_archiviare', 'errore']
const FOTO_FOLDER_RE = /foto|fotograf/i
const INVALID_FOLDER_CHARS_RE = /[\\/:*?"<>|]/g
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload })
}

function fail(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: false, ...payload })
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function parseAmbito(value: unknown): Ambito | undefined {
  const ambito = cleanString(value)?.toLowerCase()
  return ambito === 'cantiere' || ambito === 'progetto' ? ambito : undefined
}

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it-IT')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstToken(value: string): string {
  // Strippa il prefisso numerico (es. "08_", "08 -", "08.") come scoreFotoFolder
  // e splitta anche su underscore, cosi "08_Documentazione Fotografica" -> "documentazione".
  return normalizeName(value)
    .replace(/^\d+\s*[_\-.)]*\s*/, '')
    .split(/[\s_]+/)
    .find(Boolean) || ''
}

function matchNamedFolder(folders: FolderMatch[], query: string): FolderMatch[] {
  const normalizedQuery = normalizeName(query)
  return folders.filter(folder => {
    const normalizedName = normalizeName(folder.name)
    const token = firstToken(folder.name)
    return normalizedName.includes(normalizedQuery) || (token ? normalizedQuery.includes(token) : false)
  })
}

// Punteggio per scegliere la sottocartella foto quando piu candidate matchano
// la FOTO_FOLDER_RE (frequente nella struttura numerata 00-12 dei cantieri).
// Toglie la numerazione iniziale (es. "08_", "08 -", "08.") prima di valutare.
function scoreFotoFolder(name: string): number {
  const n = normalizeName(name)
  const stripped = n.replace(/^\d+\s*[_\-.)]*\s*/, '')
  if (stripped === 'foto') return 100
  if (/documentazione fotografica/.test(n)) return 90
  if (/fotografic/.test(n)) return 80
  if (/\bfoto\b/.test(n)) return 70
  if (/foto/.test(n)) return 60
  return 0
}

// Sceglie la cartella foto fra le sottocartelle. In caso di piu candidate usa
// un ranking deterministico; disambigua solo se c'e un vero pareggio di punteggio.
function pickFotoFolder(subfolders: FolderMatch[]): { match?: FolderMatch; candidates: FolderMatch[] } {
  const candidates = subfolders.filter(f => FOTO_FOLDER_RE.test(f.name))
  if (candidates.length === 0) return { candidates: [] }
  if (candidates.length === 1) return { match: candidates[0], candidates }
  const ranked = [...candidates].sort((a, b) => scoreFotoFolder(b.name) - scoreFotoFolder(a.name))
  const topScore = scoreFotoFolder(ranked[0].name)
  const topTied = ranked.filter(f => scoreFotoFolder(f.name) === topScore)
  if (topTied.length === 1) return { match: ranked[0], candidates }
  return { candidates: topTied }
}

function hasFotoFolder(folders: FolderMatch[]): boolean {
  return folders.some(f => FOTO_FOLDER_RE.test(f.name))
}

function sanitizeFolderSegment(value: string): string {
  return value.replace(INVALID_FOLDER_CHARS_RE, ' ').replace(/\s+/g, ' ').trim()
}

function todayRomeISO(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
}

function isMoveSuccess(result: string): boolean {
  if (!result || typeof result !== 'string') return false
  const normalized = result.toLocaleLowerCase('it-IT')
  return !normalized.startsWith('errore') && !normalized.includes('scrittura non consentita')
}

function parseHeaderColumns(sheetText: string): string[] {
  // Il Registro ha header su piu righe (es. 3, dati dalla riga 4): scegli la riga "Riga N:"
  // con PIU celle — e quella coi nomi colonna reali (titolo/merge hanno poche celle).
  const candidates = sheetText
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^Riga\s+\d+:/i.test(line))
    .map(line => {
      const [, rawColumns = ''] = line.split(/Riga\s+\d+:\s*/i)
      return rawColumns.split(' | ').map(col => col.trim()).filter(Boolean)
    })
  if (candidates.length === 0) return []
  return candidates.reduce((best, cur) => (cur.length > best.length ? cur : best), candidates[0])
}

async function fetchOpenPending(conversationId: string): Promise<{ rows: FotoPendingRow[]; error?: string }> {
  const { data, error } = await supabase
    .from('cervellone_foto_pending')
    .select('id, drive_file_id, filename, ambito, soggetto, lavorazione, stato, created_at')
    .eq('chat_id', conversationId)
    .in('stato', OPEN_STATI)
    .order('created_at', { ascending: true })
    .limit(500)

  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as FotoPendingRow[] }
}

async function listaFotoDaArchiviare(conversationId?: string): Promise<string> {
  if (!conversationId) return fail({ error: 'conversationId mancante' })

  const { rows, error } = await fetchOpenPending(conversationId)
  if (error) return fail({ error })

  return ok({
    count: rows.length,
    foto: rows.map(row => ({
      filename: row.filename,
      soggetto: row.soggetto,
      lavorazione: row.lavorazione,
      stato: row.stato,
    })),
  })
}

async function archiviaFoto(input: Record<string, unknown>, conversationId?: string): Promise<string> {
  if (!conversationId) return fail({ error: 'conversationId mancante' })

  const ambito = parseAmbito(input.ambito)
  const nome = cleanString(input.nome)
  const lavorazione = cleanString(input.lavorazione)
  const data = cleanString(input.data)
  const cartellaFotoHint = cleanString(input.cartella_foto)

  if (!ambito) return fail({ need: 'ambito' })
  if (!nome) return fail({ error: 'nome richiesto' })

  // Niente foto in attesa → non creare cartelle a vuoto, segnala chiaramente.
  const { rows: pendingRows, error: pendingError } = await fetchOpenPending(conversationId)
  if (pendingError) return fail({ error: pendingError })
  if (pendingRows.length === 0) {
    return fail({ stato: 'nessuna_foto_pending', message: 'Nessuna foto in attesa di archiviazione per questa conversazione.' })
  }

  const rootId = ambito === 'cantiere' ? DRIVE_FOLDERS.CANTIERI_ATTIVI : DRIVE_FOLDERS.STUDIO_ATTIVI
  const rootSubfolders = await listSubfolders(rootId)
  const matches = matchNamedFolder(rootSubfolders, nome)

  if (matches.length === 0) return fail({ stato: 'non_trovata', ambito, nome })
  if (matches.length > 1) return fail({ need: 'disambigua', candidati: matches.map(({ id, name }) => ({ id, name })) })

  const rootMatch = matches[0]

  // La struttura cantieri/progetti puo' avere un livello di RAGGRUPPAMENTO
  // intermedio (es. Cliente con piu' cantieri):
  //   CANTIERI_ATTIVI / <Cliente> / <Cantiere> / <00..12 sottocartelle>.
  // matchNamedFolder puo' quindi agganciare il livello cliente, che NON contiene
  // direttamente la cartella foto. Se sotto il match non c'e' alcuna cartella foto,
  // scendiamo di un livello fino a trovarne una. Disambiguiamo solo se il livello
  // intermedio resta ambiguo (piu' cantieri selezionabili).
  let subjectFolder = rootMatch
  let subjectSubfolders = await listSubfolders(subjectFolder.id)
  let pathPrefix = subjectFolder.name

  if (!hasFotoFolder(subjectSubfolders) && subjectSubfolders.length > 0) {
    const narrowed = matchNamedFolder(subjectSubfolders, nome)
    const innerCandidates = narrowed.length > 0 ? narrowed : subjectSubfolders

    if (innerCandidates.length === 1) {
      const inner = innerCandidates[0]
      const innerSubs = await listSubfolders(inner.id)
      if (hasFotoFolder(innerSubs)) {
        subjectFolder = inner
        subjectSubfolders = innerSubs
        pathPrefix = `${rootMatch.name}/${inner.name}`
      }
    } else if (innerCandidates.length > 1) {
      return fail({ need: 'cantiere', candidati: innerCandidates.map(({ id, name }) => ({ id, name })) })
    }
  }

  // 1) Override esplicito: il bot/Ingegnere ha indicato quale sottocartella usare.
  let fotoFolder: FolderMatch | undefined
  if (cartellaFotoHint) {
    // Tieni solo i match che sono davvero cartelle foto: l'hint ("documentazione
    // fotografica") non deve poter puntare a una cartella "Documentazione" (documenti).
    const hintMatches = matchNamedFolder(subjectSubfolders, cartellaFotoHint)
      .filter(folder => FOTO_FOLDER_RE.test(folder.name))
    if (hintMatches.length === 1) {
      fotoFolder = hintMatches[0]
    } else if (hintMatches.length > 1) {
      return fail({ need: 'cartella_foto', candidati: hintMatches.map(({ id, name }) => ({ id, name })) })
    }
    // se 0 match, prosegue con l'auto-detection sotto
  }

  // 2) Auto-detection con ranking deterministico.
  if (!fotoFolder) {
    const picked = pickFotoFolder(subjectSubfolders)
    if (!picked.match) {
      const candidati = (picked.candidates.length ? picked.candidates : subjectSubfolders).map(({ id, name }) => ({ id, name }))
      return fail({ need: 'cartella_foto', candidati })
    }
    fotoFolder = picked.match
  }

  const giorno = data && ISO_DATE_RE.test(data) ? data : todayRomeISO()
  const cleanLavorazione = lavorazione ? sanitizeFolderSegment(lavorazione) : undefined
  const segment = cleanLavorazione ? `${giorno} - ${cleanLavorazione}` : giorno

  let targetId: string
  try {
    targetId = await getOrCreatePathFolders(fotoFolder.id, [segment])
  } catch (err) {
    if (err instanceof DrivePolicyError) {
      return fail({ stato: 'bloccata', message: err.message })
    }
    return fail({ error: err instanceof Error ? err.message : String(err) })
  }

  let archiviate = 0
  let errori = 0

  for (const row of pendingRows) {
    const moveResult = await moveFile(row.drive_file_id, targetId)
    if (isMoveSuccess(moveResult)) {
      const { error: updateError } = await supabase
        .from('cervellone_foto_pending')
        .update({
          stato: 'archiviata',
          target_folder_id: targetId,
          ambito,
          soggetto: subjectFolder.name,
          lavorazione: lavorazione ?? null,
          data_lavorazione: giorno,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)

      if (updateError) errori += 1
      else archiviate += 1
    } else {
      errori += 1
      await supabase
        .from('cervellone_foto_pending')
        .update({ stato: 'errore', updated_at: new Date().toISOString() })
        .eq('id', row.id)
    }
  }

  return ok({
    archiviate,
    errori,
    path: `${pathPrefix}/${fotoFolder.name}/${segment}`,
  })
}

async function preparaCartella(input: Record<string, unknown>): Promise<string> {
  const ambito = parseAmbito(input.ambito)
  const valori = asObject(input.valori)

  if (!ambito) return fail({ need: 'ambito' })
  if (!Object.keys(valori).length) return fail({ need: 'valori' })

  const sheetId = ambito === 'cantiere' ? SHEETS.REGISTRO_CANTIERI : SHEETS.REGISTRO_PROGETTI
  const sheetPreview = await readSheet(sheetId, 'A1:Z3')
  const colonne = parseHeaderColumns(sheetPreview)

  if (!colonne.length) {
    return fail({ error: 'intestazione Registro non leggibile', sheet_preview: sheetPreview })
  }

  const mancanti = colonne.filter(col => valori[col] === undefined || valori[col] === null || String(valori[col]).trim() === '')
  if (mancanti.length) return fail({ need: 'valori', colonne, mancanti })

  const riga = colonne.map(col => String(valori[col] ?? '').trim())
  const result = await appendSheet(sheetId, 'A:Z', [riga])

  if (result.toLocaleLowerCase('it-IT').startsWith('errore')) return fail({ error: result })

  return ok({
    foglio_url: `https://docs.google.com/spreadsheets/d/${sheetId}`,
    message: 'Riga aggiunta. Premi il pulsante sul foglio per creare le cartelle, poi scrivimi "fatto".',
    result,
  })
}

export const FOTO_ARCHIVE_TOOLS: ToolDefinition[] = [
  {
    name: 'lista_foto_da_archiviare',
    description: 'Elenca le foto ancora da archiviare per la conversazione corrente.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'archivia_foto',
    description: 'Archivia le foto pending della conversazione nella sottocartella Foto di un cantiere o progetto.',
    input_schema: {
      type: 'object',
      properties: {
        ambito: { type: 'string', enum: ['cantiere', 'progetto'], description: 'Impresa edile/cantiere oppure studio tecnico/progetto.' },
        nome: { type: 'string', description: 'Nome o parte del nome del cantiere/progetto.' },
        lavorazione: { type: 'string', description: 'Lavorazione o descrizione breve della sessione foto.' },
        data: { type: 'string', description: 'Data lavorazione in formato YYYY-MM-DD.' },
        cartella_foto: { type: 'string', description: 'OPZIONALE — nome (anche parziale) della sottocartella foto da usare, es. "Documentazione Fotografica". Se omesso, viene rilevata automaticamente.' },
      },
      required: ['nome'],
    },
  },
  {
    name: 'prepara_cartella',
    description: 'Aggiunge una riga al Registro cantieri/progetti per far creare le cartelle dalla macro del foglio.',
    input_schema: {
      type: 'object',
      properties: {
        ambito: { type: 'string', enum: ['cantiere', 'progetto'] },
        valori: {
          type: 'object',
          description: 'Valori della nuova riga, indicizzati per nome colonna letto dal Registro.',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['ambito', 'valori'],
    },
  },
]

export async function executeFotoArchiveTool(
  name: string,
  input: Record<string, unknown>,
  conversationId?: string,
): Promise<string | null> {
  const safeInput = asObject(input)
  if (name === 'lista_foto_da_archiviare') return listaFotoDaArchiviare(conversationId)
  if (name === 'archivia_foto') return archiviaFoto(safeInput, conversationId)
  if (name === 'prepara_cartella') return preparaCartella(safeInput)
  return null
}
