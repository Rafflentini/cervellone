import {
  DRIVE_FOLDERS,
  SHEETS,
  listSubfolders,
  getOrCreatePathFolders,
  moveFile,
  getFileParents,
  readSheet,
  appendSheet,
  DrivePolicyError,
} from './drive'
import { supabase } from './supabase'
import { GoogleAuthDeadError } from './google-token-health'
import { splitRecentOlder, clusterByTime, type PendingRow } from './foto-archive-pending'
// Logica pura di matching (testata in foto-archive-match.test.ts).
import {
  normalizeName,
  significantTokens,
  commessaNumbers,
  matchNamedFolderScored,
  matchNamedFolder,
  scoreFotoFolder,
  pickFotoFolder,
  pickTopScored,
  hasFotoFolder,
  isFotoFolderName,
  isMoveSuccess,
  type FolderMatch,
} from './foto-archive-match'

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
  // Cartella in cui la foto DOVEVA finire, scritta PRIMA del move. Su una riga
  // ancora aperta e la traccia di un tentativo gia partito: va letta (e quindi
  // selezionata dal DB, vedi fetchOpenPending) o la riconciliazione non parte mai.
  target_folder_id: string | null
}

const OPEN_STATI: FotoStato[] = ['in_attesa', 'da_archiviare', 'errore']
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

// Parole che indicano un contesto "giusto" per la cartella foto (es. dentro
// "08_Direzione cantiere"): usate solo per PREFERIRE, non per escludere.
const FOTO_PARENT_HINT_RE = /direzione|foto cantiere|documentazione/i

type FotoCandidate = FolderMatch & { parentName: string; depth: number; score: number }

/**
 * BFS limitata per trovare la/le cartella/e foto annidate sotto la commessa.
 * La cartella foto può non essere figlia diretta (es. commessa → "08_Direzione
 * cantiere" → "Foto cantiere"): scendiamo fino a `maxDepth` livelli.
 * CONSERVATIVO: NON sceglie da solo se resta ambiguo, ritorna l'elenco candidati.
 * Si ferma al primo livello che contiene cartelle foto (non scende sotto cartelle
 * foto già trovate) per evitare di pescare sotto-sotto-cartelle non pertinenti.
 */
async function findFotoFolderDeep(
  rootFolderId: string,
  maxDepth = 3,
): Promise<FotoCandidate[]> {
  let frontier: Array<{ id: string; name: string; parentName: string; depth: number }> = [
    { id: rootFolderId, name: '', parentName: '', depth: 0 },
  ]
  const visited = new Set<string>([rootFolderId])

  for (let depth = 1; depth <= maxDepth; depth++) {
    const found: FotoCandidate[] = []
    const nextFrontier: typeof frontier = []

    for (const node of frontier) {
      let children: FolderMatch[]
      try {
        children = await listSubfolders(node.id)
      } catch {
        continue
      }
      for (const child of children) {
        if (isFotoFolderName(child.name)) {
          // Bonus se il genitore suggerisce un contesto foto/direzione.
          const parentBonus = FOTO_PARENT_HINT_RE.test(node.name) ? 5 : 0
          found.push({
            id: child.id,
            name: child.name,
            parentName: node.name || '(root commessa)',
            depth,
            score: scoreFotoFolder(child.name) + parentBonus,
          })
        } else if (depth < maxDepth && !visited.has(child.id)) {
          visited.add(child.id)
          nextFrontier.push({ id: child.id, name: child.name, parentName: node.name, depth })
        }
      }
    }

    // Ci fermiamo al PRIMO livello che contiene cartelle foto: è quello più vicino
    // alla commessa, il più probabile. Non scendiamo oltre per non pescare cartelle
    // foto sepolte in rami non pertinenti.
    if (found.length > 0) return found
    frontier = nextFrontier
    if (frontier.length === 0) break
  }
  return []
}

// Sceglie tra i candidati BFS in modo deterministico, disambigua solo su pareggio.
// Stessa soglia di pickFotoFolder: senza, un candidato debole scartato tra i figli
// diretti verrebbe riaccettato qui (la BFS parte proprio dai figli diretti).
function pickFotoCandidate(candidates: FotoCandidate[]): { match?: FotoCandidate; tied: FotoCandidate[] } {
  return pickTopScored(candidates)
}

function sanitizeFolderSegment(value: string): string {
  return value.replace(INVALID_FOLDER_CHARS_RE, ' ').replace(/\s+/g, ' ').trim()
}

function todayRomeISO(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' })
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
    .select('id, drive_file_id, filename, ambito, soggetto, lavorazione, stato, created_at, target_folder_id')
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
  // Selezione del batch da archiviare dopo una conferma (need:'conferma_batch').
  //  - 'ultimo' → solo il cluster temporale più recente fra le pending recenti;
  //  - 'tutti'  → tutte le pending recenti (più gruppi insieme);
  //  - assente  → procede solo se NON c'è ambiguità (1 solo gruppo, niente orfani).
  const gruppoRaw = cleanString(input.gruppo)?.toLowerCase()
  const gruppoScelta: 'ultimo' | 'tutti' | undefined =
    gruppoRaw === 'ultimo' || gruppoRaw === 'tutti' ? gruppoRaw : undefined
  // L'Ingegnere ha esplicitamente chiesto di includere anche le foto più vecchie (>48h).
  const includiVecchie = input.includi_vecchie === true || input.includi_vecchie === 'true'

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
  const matches = matchNamedFolderScored(rootSubfolders, nome)

  if (matches.length === 0) return fail({ stato: 'non_trovata', ambito, nome })
  if (matches.length > 1) return fail({ need: 'disambigua', candidati: matches.map(({ id, name }) => ({ id, name })) })

  // Match singolo ma DEBOLE (solo overlap di token, NON numero commessa né substring
  // esatto): potrebbe essere la commessa SBAGLIATA (stesso comune/committente, oggetto
  // diverso). NON procedere in silenzio: chiedi conferma all'Ingegnere col candidato.
  if (matches[0].strength === 'debole') {
    return fail({
      need: 'disambigua',
      stato: 'match_debole',
      message: `Ho trovato una sola commessa simile a "${nome}", ma il match è incerto (corrispondenza solo parziale, non sul numero commessa né sul nome esatto). Conferma con l'Ingegnere che sia quella giusta PRIMA di archiviare.`,
      candidati: [{ id: matches[0].id, name: matches[0].name }],
    })
  }

  const rootMatch: FolderMatch = { id: matches[0].id, name: matches[0].name }

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
    // Prova a riconoscere un livello di RAGGRUPPAMENTO CLIENTE: i suoi figli portano
    // il nome del cantiere/commessa, quindi matchNamedFolder li aggancia. Se invece i
    // figli sono la struttura numerata 00..12 (nessuno matcha il nome commessa), questo
    // NON è un livello cliente: NON disambiguare qui, lascia che la cartella foto venga
    // cercata in profondità (step 3, BFS), che gestisce l'annidamento es. "08_Direzione".
    const narrowed = matchNamedFolderScored(subjectSubfolders, nome)

    if (narrowed.length === 1) {
      const inner = narrowed[0]
      const innerSubs = await listSubfolders(inner.id)
      if (hasFotoFolder(innerSubs)) {
        // Anche nella discesa cliente, un match singolo DEBOLE va confermato: il
        // cantiere agganciato per solo overlap di token potrebbe essere quello sbagliato.
        if (inner.strength === 'debole') {
          return fail({
            need: 'cantiere',
            stato: 'match_debole',
            message: `Sotto "${rootMatch.name}" ho trovato un solo cantiere simile a "${nome}", ma il match è incerto (corrispondenza solo parziale). Conferma con l'Ingegnere PRIMA di archiviare.`,
            candidati: [{ id: inner.id, name: inner.name }],
          })
        }
        subjectFolder = { id: inner.id, name: inner.name }
        subjectSubfolders = innerSubs
        pathPrefix = `${rootMatch.name}/${inner.name}`
      }
    } else if (narrowed.length > 1) {
      // Più cantieri del cliente combaciano col nome: disambigua per davvero.
      return fail({ need: 'cantiere', candidati: narrowed.map(({ id, name }) => ({ id, name })) })
    }
    // narrowed.length === 0 → non è un livello cliente: prosegui, la cartella foto
    // verrà trovata in profondità (BFS) tra i figli/nipoti del subject.
  }

  // 1) Override esplicito: il bot/Ingegnere ha indicato quale sottocartella usare.
  let fotoFolder: FolderMatch | undefined
  // Prefisso del path della cartella foto rispetto al subject (può essere annidata,
  // es. "08_Direzione cantiere/Foto cantiere"): lo costruiamo man mano.
  let fotoPathPrefix = ''
  if (cartellaFotoHint) {
    // Tieni solo i match che sono davvero cartelle foto: l'hint ("documentazione
    // fotografica") non deve poter puntare a una cartella "Documentazione" (documenti).
    const hintMatches = matchNamedFolder(subjectSubfolders, cartellaFotoHint)
      .filter(folder => isFotoFolderName(folder.name))
    if (hintMatches.length === 1) {
      fotoFolder = hintMatches[0]
    } else if (hintMatches.length > 1) {
      return fail({ need: 'cartella_foto', candidati: hintMatches.map(({ id, name }) => ({ id, name })) })
    }
    // se 0 match tra i figli diretti, prova in profondità sull'hint (cartella annidata).
    if (!fotoFolder) {
      const deepHint = (await findFotoFolderDeep(subjectFolder.id))
        .filter(c => matchNamedFolder([{ id: c.id, name: c.name }], cartellaFotoHint).length > 0)
      if (deepHint.length === 1) {
        fotoFolder = { id: deepHint[0].id, name: deepHint[0].name }
        fotoPathPrefix = deepHint[0].parentName && deepHint[0].depth > 1 ? `${deepHint[0].parentName}/` : ''
      } else if (deepHint.length > 1) {
        return fail({ need: 'cartella_foto', candidati: deepHint.map(({ id, name, parentName }) => ({ id, name, dentro: parentName })) })
      }
    }
    // se ancora 0 match, prosegue con l'auto-detection sotto
  }

  // 2) Auto-detection con ranking deterministico tra i figli diretti.
  if (!fotoFolder) {
    const picked = pickFotoFolder(subjectSubfolders)
    if (picked.match) {
      fotoFolder = picked.match
    } else if (picked.candidates.length > 1) {
      // Pareggio tra figli diretti: chiedi conferma, non scegliere a caso.
      return fail({ need: 'cartella_foto', candidati: picked.candidates.map(({ id, name }) => ({ id, name })) })
    }
    // se nessun candidato tra i figli diretti, scendi in profondità (3 punto FIX B).
  }

  // 3) Discesa ricorsiva: la cartella foto è annidata (es. dentro "08_Direzione cantiere").
  if (!fotoFolder) {
    const deep = await findFotoFolderDeep(subjectFolder.id)
    if (deep.length === 0) {
      // Nessuna cartella foto trovata neppure in profondità: chiedi all'Ingegnere.
      return fail({ need: 'cartella_foto', candidati: subjectSubfolders.map(({ id, name }) => ({ id, name })) })
    }
    const pickedDeep = pickFotoCandidate(deep)
    if (!pickedDeep.match) {
      // Più candidati a pari punteggio: NON scegliere, chiedi conferma con il contesto.
      return fail({
        need: 'cartella_foto',
        candidati: pickedDeep.tied.map(({ id, name, parentName }) => ({ id, name, dentro: parentName })),
      })
    }
    fotoFolder = { id: pickedDeep.match.id, name: pickedDeep.match.name }
    // Includi il genitore nel path solo se la cartella foto è annidata (depth>1).
    fotoPathPrefix = pickedDeep.match.depth > 1 ? `${pickedDeep.match.parentName}/` : ''
  }

  // ANTI-CONTAMINAZIONE (spec 2026-06-13 #2): la cartella destinazione è risolta.
  // PRIMA di spostare, decidi QUALI pending archiviare. NON rastrellare tutto il
  // pool: includi solo le foto recenti (48h) e, se queste formano più "raffiche"
  // distinte o ci sono orfani vecchi, CHIEDI conferma invece di indovinare.
  const { recent, older } = splitRecentOlder(pendingRows as PendingRow[], Date.now())

  if (recent.length === 0) {
    return fail({
      stato: 'nessuna_foto_recente',
      message: 'Nessuna foto caricata di recente da archiviare.'
        + (older.length ? ` Ci sono ${older.length} foto più vecchie non archiviate.` : ''),
    })
  }

  const clusters = clusterByTime(recent)
  // Conferma necessaria SOLO se ci sono PIÙ raffiche recenti distinte (ambiguità reale su
  // quale commessa). Gli orfani vecchi (>48h) NON fanno scattare la conferma — altrimenti un
  // singolo orfano fantasma la farebbe scattare a OGNI archiviazione futura in questa chat;
  // vengono solo SEGNALATI nel messaggio finale e MAI inclusi senza includi_vecchie.
  const needsConfirm = clusters.length > 1 && gruppoScelta === undefined

  if (needsConfirm) {
    const gruppi = clusters.map((cluster, idx) => {
      const sorted = [...cluster].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      const first = sorted[0]
      const last = sorted[sorted.length - 1]
      const hhmm = (iso: string) => {
        const t = Date.parse(iso)
        return Number.isFinite(t)
          ? new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
          : '??:??'
      }
      return {
        indice: idx + 1,
        count: cluster.length,
        dalle: hhmm(first.created_at),
        alle: hhmm(last.created_at),
        files: sorted.slice(0, 3).map(r => r.filename).filter(Boolean),
      }
    })
    return fail({
      need: 'conferma_batch',
      stato: 'batch_ambiguo',
      gruppi,
      vecchie: older.length,
      message: `Ci sono ${clusters.length} grupp${clusters.length === 1 ? 'o' : 'i'} di foto in attesa`
        + (older.length ? ` (più ${older.length} foto più vecchie di 48h)` : '')
        + ` — chiedi all'Ingegnere QUALI archiviare PRIMA di procedere. Poi richiama archivia_foto con gruppo:"ultimo" (solo le più recenti) o gruppo:"tutti" (tutte le recenti)`
        + (older.length ? ', e includi_vecchie:true SOLO se conferma di voler archiviare anche le vecchie' : '')
        + '. NON includere mai foto non richieste (contaminazione).',
    })
  }

  // Selezione effettiva delle righe da spostare. Il loop opera SOLO su queste,
  // MAI su `older` salvo includi_vecchie esplicito.
  let rowsToArchive: FotoPendingRow[]
  if (gruppoScelta === 'ultimo') {
    // Solo la raffica più recente (l'ultimo cluster, ordinato per tempo).
    const lastCluster = clusters.length > 0 ? clusters[clusters.length - 1] : []
    rowsToArchive = lastCluster as FotoPendingRow[]
  } else {
    // 'tutti' o nessuna ambiguità → tutte le recenti.
    rowsToArchive = recent as FotoPendingRow[]
  }
  if (includiVecchie && older.length > 0) {
    rowsToArchive = [...rowsToArchive, ...(older as FotoPendingRow[])]
  }

  // Foto recenti (<48h) rimaste in attesa perche NON selezionate dal gruppo.
  // Non sono coperte da `notaOrfani`, che guarda solo le >48h: senza questo
  // conteggio il messaggio dichiarava "tutte archiviate" mentre i cluster
  // precedenti restavano in_attesa e l'utente non li cercava piu.
  const recentiNonArchiviate = gruppoScelta === 'ultimo'
    ? clusters.slice(0, -1).reduce((n, c) => n + c.length, 0)
    : 0

  if (rowsToArchive.length === 0) {
    return fail({
      stato: 'nessuna_foto_recente',
      message: 'Nessuna foto selezionata da archiviare.',
    })
  }

  const giorno = data && ISO_DATE_RE.test(data) ? data : todayRomeISO()
  const cleanLavorazione = lavorazione ? sanitizeFolderSegment(lavorazione) : undefined
  const segment = cleanLavorazione ? `${giorno} - ${cleanLavorazione}` : giorno

  let targetId: string
  try {
    targetId = await getOrCreatePathFolders(fotoFolder.id, [segment])
  } catch (err) {
    // Token Google morto: è un blocco vero quanto quello di policy, non un errore
    // generico. Senza questo ramo il messaggio finiva nel catch-all e l'Ingegnere
    // leggeva un errore tecnico invece della causa (e del link di riautorizzazione,
    // che GoogleAuthDeadError si porta dietro nel messaggio).
    if (err instanceof GoogleAuthDeadError) {
      return fail({ stato: 'bloccata', message: err.message })
    }
    if (err instanceof DrivePolicyError) {
      return fail({ stato: 'bloccata', message: err.message })
    }
    return fail({ error: err instanceof Error ? err.message : String(err) })
  }

  let archiviate = 0
  // Move fallito/non verificato → la foto è DAVVERO ancora da archiviare (resta in_attesa).
  let erroriMove = 0
  // Move riuscito (verificato) ma UPDATE dello stato DB fallito → il FILE è già spostato,
  // solo lo stato DB è disallineato. NON è una foto "in attesa": non va riprovata né
  // marcata 'errore' (rimuoverebbe l'allineamento col file già fisicamente archiviato).
  let erroriDb = 0
  // Righe che erano GIÀ fisicamente nella loro cartella (move riuscito in un
  // tentativo precedente, update di stato fallito): qui si riallinea solo il DB.
  let riconciliate = 0
  // Riconciliazione TENTATA e FALLITA: il file sta nella cartella di un
  // tentativo PRECEDENTE (non in `path`) e la riga resta aperta. Contarlo in
  // `erroriDb` — e quindi in `spostate` e in notaDb ("sono GIÀ nella cartella")
  // — sarebbe una bugia su due fronti: la foto non e in `path` e non e chiusa.
  // Caso limite reale: batch fatto di sole riconciliazioni fallite → il
  // messaggio diceva "Tutte le N foto spostate e verificate in {path}" mentre
  // non si era mosso nulla.
  let erroriRiconciliazione = 0

  for (const row of rowsToArchive) {
    // Una riga ancora aperta ma con target_folder_id valorizzato ha gia avuto un
    // tentativo di archiviazione: il move puo essere riuscito e solo l'update di
    // stato fallito. Prima di rispostarla si guarda dove sta DAVVERO il file —
    // altrimenti la si strappa dalla commessa giusta.
    if (row.target_folder_id) {
      let parents: string[] | null = null
      try {
        parents = await getFileParents(row.drive_file_id)
      } catch (err) {
        // FAIL-CLOSED. Se Drive non risponde non sappiamo dove sia il file, e
        // `target_folder_id` da solo e un'intenzione, non una prova: rispostare
        // alla cieca sarebbe esattamente il bug che questo blocco esiste per
        // impedire (strappare la foto dalla commessa giusta). La riga resta in
        // attesa — visibile e recuperabile — e il file non si tocca.
        console.error(
          `[archivia_foto] verifica parent non riuscita per foto ${row.id} (${row.drive_file_id}): ${err instanceof Error ? err.message : err} — NON rispostata`,
        )
        erroriMove += 1
        continue
      }
      if (parents.includes(row.target_folder_id)) {
        const { error: fixError } = await supabase
          .from('cervellone_foto_pending')
          .update({ stato: 'archiviata', updated_at: new Date().toISOString() })
          .eq('id', row.id)
        if (fixError) {
          erroriRiconciliazione += 1
          console.error(
            `[archivia_foto] riconciliazione fallita per foto ${row.id}: il file e gia in ${row.target_folder_id} ma lo stato DB non e aggiornabile (${fixError.message}) — la riga resta aperta`,
          )
        } else {
          riconciliate += 1
        }
        continue
      }
    }

    // Dichiarazione d'intento PRIMA del move: se questa scrittura non passa, non
    // si sposta niente. Meglio una foto onestamente in attesa che un file spostato
    // di cui il DB non conserva traccia.
    const { error: intentError } = await supabase
      .from('cervellone_foto_pending')
      .update({ target_folder_id: targetId })
      .eq('id', row.id)
    if (intentError) {
      erroriMove += 1
      console.error(
        `[archivia_foto] intento non scrivibile per foto ${row.id}: ${intentError.message} — move NON eseguito`,
      )
      continue
    }

    const moveResult = await moveFile(row.drive_file_id, targetId)
    if (isMoveSuccess(moveResult)) {
      const { error: updateError } = await supabase
        .from('cervellone_foto_pending')
        .update({
          stato: 'archiviata',
          ambito,
          soggetto: subjectFolder.name,
          lavorazione: lavorazione ?? null,
          data_lavorazione: giorno,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)

      if (updateError) {
        // File spostato e verificato: contabilizziamo come archiviata di fatto. Lo stato
        // DB è solo disallineato (best-effort: log, non blocchiamo, non marchiamo 'errore').
        erroriDb += 1
        console.error(
          `[archivia_foto] move OK ma update stato fallito per foto ${row.id} (file già in ${targetId}): ${updateError.message}`,
        )
      } else {
        archiviate += 1
      }
    } else {
      erroriMove += 1
      await supabase
        .from('cervellone_foto_pending')
        .update({ stato: 'errore', updated_at: new Date().toISOString() })
        .eq('id', row.id)
    }
  }

  const totale = rowsToArchive.length
  // Spostate fisicamente = update OK + update fallito (il file è comunque nella cartella).
  const spostate = archiviate + erroriDb
  // "In attesa" sul serio = SOLO i move realmente falliti.
  const restano = erroriMove
  const path = `${pathPrefix}/${fotoPathPrefix}${fotoFolder.name}/${segment}`
  const notaDb = erroriDb > 0
    ? ` (${erroriDb} foto spostate ma stato non aggiornato — sono GIÀ nella cartella e verranno riconciliate al prossimo tentativo, non verranno rispostate)`
    : ''
  // Righe già fisicamente archiviate in un tentativo precedente: NON sono finite
  // in `path` (il loro target era un altro), quindi non vanno confuse con `spostate`.
  const notaRiconciliate = riconciliate > 0
    ? ` (${riconciliate} foto erano già state spostate in un tentativo precedente: stato DB riallineato, file NON toccato)`
    : ''
  // Riconciliazione fallita: NON è una foto in `path` e NON è una foto chiusa.
  // Va detto a parte, o il messaggio finisce per rivendicare un'archiviazione
  // che non è avvenuta.
  const notaRiconciliazioneKo = erroriRiconciliazione > 0
    ? ` (${erroriRiconciliazione} foto erano già state spostate in un tentativo precedente ma il riallineamento del DB è fallito: NON sono in questa cartella e restano APERTE, verranno riprovate)`
    : ''

  // ESITO ONESTO: il modello NON deve poter annunciare "foto archiviate" se una foto
  // non è stata spostata (verificato lato moveFile). MA un fallimento del solo UPDATE DB
  // (file già spostato) NON è un fallimento di archiviazione: non deve far dire al modello
  // "non archiviate". Falliamo SOLO se qualche MOVE è davvero fallito.
  if (erroriMove > 0) {
    return fail({
      partial: true,
      stato: spostate > 0 ? 'parziale' : 'fallita',
      archiviate: spostate,
      errori_move: erroriMove,
      errori_db: erroriDb,
      totale,
      restano_in_attesa: restano,
      riconciliate,
      errori_riconciliazione: erroriRiconciliazione,
      path,
      message: `Spostate ${spostate}/${totale} foto.${notaDb}${notaRiconciliate}${notaRiconciliazioneKo} ${restano} NON spostate e restano IN ATTESA. NON dichiarare l'archiviazione completata: riprova o segnala all'Ingegnere.`,
    })
  }

  // Nota orfani: foto >48h non archiviate e NON incluse → segnalale (senza bloccare).
  const notaOrfani = (older.length > 0 && !includiVecchie)
    ? ` Nota: ci sono ${older.length} foto più vecchie di 48h non archiviate — se vanno qui, richiama con includi_vecchie:true.`
    : ''
  const notaResidue = recentiNonArchiviate > 0
    ? ` Restano ${recentiNonArchiviate} foto recenti NON archiviate (raffiche precedenti): richiama con gruppo:"tutti" se vanno nella stessa cartella.`
    : ''

  // Testa del messaggio. `spostate === 0` capita quando il batch era fatto solo di
  // righe già archiviate in precedenza: "Tutte le 0 foto spostate" sarebbe assurdo.
  const testa = spostate === 0
    ? `Nessuna foto nuova da spostare in ${path}.`
    : recentiNonArchiviate > 0
      ? `Archiviate ${spostate} foto in ${path}.`
      : `Tutte le ${spostate} foto spostate e verificate in ${path}.`

  // Tutti i move riusciti (anche se qualche update DB è fallito): archiviazione OK.
  return ok({
    archiviate: spostate,
    errori_move: 0,
    errori_db: erroriDb,
    totale,
    path,
    riconciliate,
    errori_riconciliazione: erroriRiconciliazione,
    recenti_non_archiviate: recentiNonArchiviate,
    vecchie_non_archiviate: !includiVecchie ? older.length : 0,
    message: `${testa}${notaDb}${notaRiconciliate}${notaRiconciliazioneKo}${notaResidue}${notaOrfani}`,
  })
}

// Parsa le righe DATI del Registro (esclusi gli header) dal testo di readSheet.
// Ritorna, per ogni riga dati, il testo concatenato delle celle (per il confronto
// anti-duplicato). Le righe header sono quelle che combaciano con parseHeaderColumns.
function parseRegistroDataRows(sheetText: string, headerCols: string[]): string[] {
  const headerSet = new Set(headerCols.map(c => normalizeName(c)))
  return sheetText
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^Riga\s+\d+:/i.test(line))
    .map(line => {
      const [, raw = ''] = line.split(/Riga\s+\d+:\s*/i)
      return raw.split(' | ').map(c => c.trim()).filter(Boolean)
    })
    .filter(cells => {
      if (cells.length === 0) return false
      // Scarta le righe header (stesso insieme di celle dei nomi colonna).
      const asSet = new Set(cells.map(c => normalizeName(c)))
      let same = 0
      for (const c of asSet) if (headerSet.has(c)) same += 1
      const isHeader = headerSet.size > 0 && same >= Math.min(headerSet.size, asSet.size) * 0.8
      return !isHeader
    })
    .map(cells => cells.join(' '))
}

async function preparaCartella(input: Record<string, unknown>): Promise<string> {
  const ambito = parseAmbito(input.ambito)
  const valori = asObject(input.valori)
  const confermaDuplicato = input.conferma_duplicato === true || input.conferma_duplicato === 'true'

  if (!ambito) return fail({ need: 'ambito' })
  if (!Object.keys(valori).length) return fail({ need: 'valori' })

  const sheetId = ambito === 'cantiere' ? SHEETS.REGISTRO_CANTIERI : SHEETS.REGISTRO_PROGETTI
  // Leggi abbastanza righe per il controllo anti-duplicato (header + dati).
  const sheetFull = await readSheet(sheetId, 'A1:Z500')
  const colonne = parseHeaderColumns(sheetFull)

  if (!colonne.length) {
    return fail({ error: 'intestazione Registro non leggibile', sheet_preview: sheetFull.slice(0, 2000) })
  }

  const mancanti = colonne.filter(col => valori[col] === undefined || valori[col] === null || String(valori[col]).trim() === '')
  if (mancanti.length) return fail({ need: 'valori', colonne, mancanti })

  // GUARDRAIL ANTI-DUPLICATO: prima di creare, cerca commesse già esistenti con
  // comune/committente/oggetto SIMILI. Confronto su numero commessa (match forte)
  // e overlap di >=2 token significativi. Se trova candidati, NON crea: chiede conferma.
  if (!confermaDuplicato) {
    const nuovaRigaText = colonne.map(col => String(valori[col] ?? '').trim()).join(' ')
    const nuoviNums = commessaNumbers(nuovaRigaText)
    const nuoviTokens = new Set(significantTokens(nuovaRigaText))
    const esistenti = parseRegistroDataRows(sheetFull, colonne)

    const simili: string[] = []
    for (const rigaText of esistenti) {
      const rigaNums = commessaNumbers(rigaText)
      const numMatch = nuoviNums.length > 0 && rigaNums.some(n => nuoviNums.includes(n))
      let overlap = 0
      if (!numMatch) {
        for (const t of significantTokens(rigaText)) {
          if (nuoviTokens.has(t)) overlap += 1
        }
      }
      if (numMatch || overlap >= 2) simili.push(rigaText.slice(0, 200))
    }

    if (simili.length > 0) {
      return fail({
        need: 'conferma_duplicato',
        message: `Trovate ${simili.length} commesse SIMILI già nel Registro: potrebbe essere un DUPLICATO. Verifica con l'Ingegnere se la commessa esiste già (in tal caso usa archivia_foto su quella, non crearne una nuova). Per creare comunque, richiama prepara_cartella con conferma_duplicato:true.`,
        candidati: simili.slice(0, 8),
      })
    }
  }

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
    description: 'Archivia le foto pending della conversazione nella sottocartella Foto di un cantiere o progetto. Considera solo le foto caricate di recente (ultime 48h); se ci sono più gruppi temporali o foto vecchie non archiviate, torna need:"conferma_batch" e va richiamato indicando il gruppo.',
    input_schema: {
      type: 'object',
      properties: {
        ambito: { type: 'string', enum: ['cantiere', 'progetto'], description: 'Impresa edile/cantiere oppure studio tecnico/progetto.' },
        nome: { type: 'string', description: 'Nome o parte del nome del cantiere/progetto.' },
        lavorazione: { type: 'string', description: 'Lavorazione o descrizione breve della sessione foto.' },
        data: { type: 'string', description: 'Data lavorazione in formato YYYY-MM-DD.' },
        cartella_foto: { type: 'string', description: 'OPZIONALE — nome (anche parziale) della sottocartella foto da usare, es. "Documentazione Fotografica". Se omesso, viene rilevata automaticamente.' },
        gruppo: { type: 'string', enum: ['ultimo', 'tutti'], description: 'OPZIONALE — da usare SOLO dopo che il tool ha risposto need:"conferma_batch" e l\'Ingegnere ha confermato. "ultimo" = archivia solo la raffica di foto più recente; "tutti" = archivia tutte le foto caricate nelle ultime 48h.' },
        includi_vecchie: { type: 'boolean', description: 'OPZIONALE — true SOLO se l\'Ingegnere conferma esplicitamente di voler archiviare anche le foto più vecchie di 48h (segnalate nel campo "vecchie" della conferma). Default: le foto vecchie NON vengono toccate.' },
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
        conferma_duplicato: {
          type: 'boolean',
          description: 'Metti true SOLO dopo aver verificato con l\'Ingegnere che la commessa NON esiste già, quando il tool ha segnalato need:"conferma_duplicato". Forza la creazione bypassando il controllo anti-duplicato.',
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
