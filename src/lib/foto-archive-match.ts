// Logica PURA di matching per l'archiviazione foto: decide QUALE cartella Drive
// riceve le foto scattate in cantiere. Estratta da foto-archive-tools.ts per poter
// essere testata senza toccare Drive/Supabase — sbagliare cartella, per l'Ingegnere,
// equivale a perdere le foto.

export type FolderMatch = { id: string; name: string }

export const FOTO_FOLDER_RE = /foto|fotograf/i

// "foto" compare come sottostringa anche in parole che NON indicano un archivio
// fotografico: in una commessa fotovoltaico "05_Impianto Fotovoltaico" non è la
// cartella foto (le foto di cantiere finirebbero fra gli schemi elettrici).
export const FOTO_FOLDER_DENY_RE = /fotovoltaic|fotocopi/i

// Punteggio minimo perché una cartella sia accettata come "cartella foto" senza
// chiedere conferma. Sotto soglia si preferisce domandare all'Ingegnere.
export const FOTO_FOLDER_MIN_SCORE = 70

export function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('it-IT')
    .replace(/\s+/g, ' ')
    .trim()
}

// Stopword italiane + parole "di servizio" frequenti nei nomi commessa: non sono
// token significativi e NON devono contribuire all'overlap (altrimenti "Comune di X"
// e "Comune di Y" matcherebbero su "comune").
const MATCH_STOPWORDS = new Set([
  'comune', 'comunale', 'di', 'del', 'della', 'dei', 'delle', 'dello', 'da', 'in',
  'progetto', 'progetti', 'lavori', 'lavoro', 'cantiere', 'cantieri', 'srl', 's.r.l',
  'spa', 's.p.a', 'sas', 'snc', 'ditta', 'impresa', 'sig', 'sig.ra', 'e', 'a', 'il',
  'la', 'lo', 'gli', 'le', 'per', 'con', 'scia', 'cila', 'cilas', 'permesso', 'pdc',
])

// Numero commessa NNNN-NNN. I lookaround impediscono che "2026-012" agganci
// "2026-0125" (commessa DIVERSA, con lo stesso prefisso). La regex è GLOBALE: va usata
// solo con String#match / String#replace (che azzerano lastIndex), MAI con .test()/.exec().
export const COMMESSA_RE = /(?<!\d)\d{4}-\d{3}(?!\d)/g

export function significantTokens(value: string): string[] {
  return normalizeName(value)
    // Il flag /g e' essenziale: senza, viene rimosso solo il PRIMO numero commessa
    // e l'anno ('2026') resta un token significativo, producendo falsi match fra
    // commesse diverse dello stesso anno.
    .replace(COMMESSA_RE, ' ')
    .split(/[\s_\-.,/()]+/)
    .map(t => t.replace(/[^a-z0-9]/g, ''))
    .filter(t => t.length >= 3 && !MATCH_STOPWORDS.has(t))
}

export function commessaNumbers(value: string): string[] {
  return normalizeName(value).match(COMMESSA_RE) ?? []
}

/**
 * Peso di ogni token, calcolato SUL REGISTRO STESSO (IDF).
 *
 * Contare i token in comune li tratta tutti uguali, e non lo sono: in un
 * Registro di Basilicata `potenza` compare in centinaia di righe e non prova
 * niente, `lucane` in due e prova quasi tutto. Contandoli alla pari il
 * guardrail anti-duplicato scattava su OGNI nuova commessa (misurato: 30 su 30
 * scorrelate bloccate), e un guardrail che grida sempre viene disattivato per
 * abitudine — esito peggiore del bug che chiude.
 *
 * `MATCH_STOPWORDS` provava a fare lo stesso lavoro a mano, ma una lista fissa
 * non puo sapere che a Potenza si chiama `potenza` e a Matera `matera`: il peso
 * va dedotto dai dati, non deciso in anticipo. Le stopword restano perche
 * tolgono rumore prima del conteggio, non in alternativa a questo.
 */
export function tokenWeights(righe: string[]): Map<string, number> {
  const frequenza = new Map<string, number>()
  for (const riga of righe) {
    // `new Set`: un token ripetuto NELLA STESSA riga ("Potenza | Comune di
    // Potenza") non deve pesare doppio.
    for (const t of new Set(significantTokens(riga))) {
      frequenza.set(t, (frequenza.get(t) ?? 0) + 1)
    }
  }
  const n = righe.length
  const pesi = new Map<string, number>()
  for (const [t, f] of frequenza) pesi.set(t, Math.log((n + 1) / (f + 1)))
  return pesi
}

/**
 * Quanta parte dell'informazione della NUOVA commessa e gia presente in una
 * riga esistente: 0 = niente in comune, 1 = la riga esistente contiene tutto.
 *
 * E un RAPPORTO, non una somma, e la differenza non e estetica. Una somma di
 * pesi cresce con `log(N)` e va confrontata con una soglia che dipende dalla
 * dimensione del Registro; misurato, una soglia proporzionale al peso massimo
 * teorico dava il 61% di falsi positivi a 150 righe e perdeva il 40% dei
 * duplicati a 2000 (quando il vocabolario si satura nessun token e piu raro e
 * la soglia diventa irraggiungibile). Il rapporto e invece adimensionale:
 * la stessa soglia vale per un Registro nuovo e per uno da diecimila righe.
 *
 * I token della nuova commessa MAI visti nel Registro pesano al massimo e
 * finiscono solo al denominatore: un committente mai visto abbassa il rapporto,
 * ed e giusto — e la prova piu forte che la commessa non c'e ancora.
 */
export function similarityRatio(
  nuovaText: string,
  rigaText: string,
  pesi: Map<string, number>,
  righeRegistro: number,
): number {
  const nuovi = new Set(significantTokens(nuovaText))
  if (nuovi.size === 0) return 0
  const pesoMai = Math.log(righeRegistro + 1)
  const rigaTok = new Set(significantTokens(rigaText))

  let totale = 0
  let comune = 0
  for (const t of nuovi) {
    const w = pesi.get(t) ?? pesoMai
    totale += w
    if (rigaTok.has(t)) comune += w
  }
  return totale > 0 ? comune / totale : 0
}

/**
 * Sopra questo rapporto si chiede conferma.
 *
 * CALIBRATO su Registri sintetici in stile Basilicata da 40 a 2000 righe,
 * misurando tre popolazioni: commesse nuove scorrelate (falsi positivi),
 * duplicati esatti reinseriti col numero cambiato, e QUASI-COPIE (stesso comune
 * e stesso committente, lavoro descritto diversamente) — che sono il caso
 * realistico, non quello esatto.
 *
 *   soglia | falsi positivi (N=150 / 600) | quasi-copie prese (N=150 / 600)
 *     0.50 |            84% / 57%         |          100% / 100%
 *     0.60 |            13% /  0%         |           93% / 100%   <- scelta
 *     0.65 |             8% /  0%         |           83% /  98%
 *     0.75 |             0% /  0%         |           73% /  90%
 *
 * Scelto 0.60 e non un valore piu alto perche i due errori non costano uguale:
 * un falso positivo costa una domanda di conferma, un falso negativo costa una
 * commessa DUPLICATA sul Drive — cioe' esattamente il bug che il guardrail
 * esiste per impedire. Non e un numero da limare quando un caso non piace:
 * abbassarlo riporta la saturazione che rendeva il guardrail decorativo
 * (a 0.50 blocca l'84% delle commesse legittime), alzarlo nasconde duplicati.
 */
export const SOGLIA_DUPLICATO = 0.6

// Forza del match cartella, dalla più affidabile alla più debole:
//  - 'numero'  → match sul numero commessa NNNN-NNN (prova più affidabile);
//  - 'esatto'  → la query compare per intero nel nome cartella e finisce su un
//                confine di parola (match su parola intera);
//  - 'debole'  → overlap di token significativi, OPPURE substring che finisce dentro
//                un'altra parola ("Bianchi" dentro "Villa Bianchini"): può essere la
//                commessa/il cliente sbagliato.
// Un match 'debole' NON deve far procedere in silenzio: il chiamante chiede conferma.
export type MatchStrength = 'numero' | 'esatto' | 'debole'
export type ScoredFolderMatch = FolderMatch & { strength: MatchStrength }

const WORD_CHAR_RE = /[\p{L}\p{N}]/u

/**
 * true se `query` compare in `name` terminando su un confine di parola, cioè il
 * carattere subito dopo l'occorrenza non è alfanumerico (o la stringa finisce).
 * Distingue "Bianchi" in "Ditta Bianchi" (confine → prova forte) da "Bianchi" in
 * "Villa Bianchini" (dentro un'altra parola → un'altra ditta, prova debole).
 * Entrambe le stringhe devono essere già normalizzate.
 */
function includesAtWordBoundary(name: string, query: string): boolean {
  let from = 0
  for (;;) {
    const idx = name.indexOf(query, from)
    if (idx === -1) return false
    const after = name.charAt(idx + query.length)
    if (after === '' || !WORD_CHAR_RE.test(after)) return true
    from = idx + 1
  }
}

/**
 * Match commessa/progetto CONSERVATIVO con FORZA del match. Una cartella è candidata se:
 *  (a) il numero commessa NNNN-NNN nella query compare nel nome cartella → strength 'numero'; OPPURE
 *  (b) la query è interamente contenuta nel nome cartella (substring storico) → strength 'esatto'; OPPURE
 *  (c) c'è overlap di ALMENO 2 token significativi tra query e nome cartella → strength 'debole'.
 * NON sceglie mai: ritorna l'elenco dei candidati con la loro forza. Il chiamante
 * disambigua se >1, e chiede conferma se l'unico match è 'debole'.
 * Preferisce conservatività: se non c'è prova sufficiente, non matcha (→ "non_trovata"
 * o richiesta di conferma) invece di agganciare la cartella sbagliata.
 */
export function matchNamedFolderScored(folders: FolderMatch[], query: string): ScoredFolderMatch[] {
  const normalizedQuery = normalizeName(query)
  const queryNums = commessaNumbers(query)
  const queryTokens = new Set(significantTokens(query))

  // (a) Match forte sul numero commessa: se presente nella query e in un nome cartella,
  // è la prova più affidabile. Se almeno una cartella matcha sul numero, restringi SOLO
  // a quelle (evita falsi positivi da overlap testuale su altre commesse).
  if (queryNums.length > 0) {
    const byNumber = folders.filter(folder => {
      const folderNums = commessaNumbers(folder.name)
      return folderNums.some(n => queryNums.includes(n))
    })
    if (byNumber.length > 0) {
      return byNumber.map(folder => ({ ...folder, strength: 'numero' as const }))
    }
  }

  const out: ScoredFolderMatch[] = []
  for (const folder of folders) {
    const normalizedName = normalizeName(folder.name)

    // (b) la query è contenuta nel nome cartella. Vale 'esatto' SOLO se l'occorrenza
    // finisce su un confine di parola: "Bianchi" dentro "Villa Bianchini" è un altro
    // cliente, non una prova, e va declassato a 'debole' (→ conferma).
    if (normalizedQuery.length >= 3 && normalizedName.includes(normalizedQuery)) {
      const strength: MatchStrength = includesAtWordBoundary(normalizedName, normalizedQuery)
        ? 'esatto'
        : 'debole'
      out.push({ ...folder, strength })
      continue
    }

    // (c) overlap di >=2 token significativi → match DEBOLE (potrebbe essere la
    // commessa sbagliata: stesso comune/committente, oggetto diverso).
    const folderTokens = significantTokens(folder.name)
    let overlap = 0
    let weak = false
    for (const t of folderTokens) {
      if (queryTokens.has(t)) {
        overlap += 1
        if (overlap >= 2) { weak = true; break }
      }
    }
    if (weak) out.push({ ...folder, strength: 'debole' })
  }
  return out
}

/**
 * Variante retro-compatibile: ritorna solo le cartelle (senza forza), per i call-site
 * che disambiguano solo sul numero di candidati (hint cartella foto, livello cliente).
 * Il match radice della commessa usa invece matchNamedFolderScored per la forza.
 */
export function matchNamedFolder(folders: FolderMatch[], query: string): FolderMatch[] {
  return matchNamedFolderScored(folders, query).map(({ id, name }) => ({ id, name }))
}

// Punteggio per scegliere la sottocartella foto quando piu candidate matchano
// la FOTO_FOLDER_RE (frequente nella struttura numerata 00-12 dei cantieri).
// Toglie la numerazione iniziale (es. "08_", "08 -", "08.") e normalizza gli underscore
// PRIMA di valutare i test su "foto": valutandoli sul nome grezzo, "08_Foto cantiere"
// perdeva il confine di parola dopo l'underscore e valeva meno di "Rilievo fotografico".
export function scoreFotoFolder(name: string): number {
  const stripped = normalizeName(name)
    .replace(/^\d+\s*[_\-.)]*\s*/, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped === 'foto') return 100
  if (/documentazione fotografica/.test(stripped)) return 90
  // La PAROLA "foto" ("Foto cantiere") indica l'archivio delle foto scattate meglio
  // dell'aggettivo "fotografico" usato in altro contesto ("Rilievo fotografico" è un
  // elaborato di progetto): per questo 'foto' sta sopra 'fotografi'.
  if (/\bfoto\b/.test(stripped)) return 80
  if (/fotografi/.test(stripped)) return 70
  // Deny-list DOPO i segnali forti: una cartella che contiene comunque la parola "foto"
  // ("Foto impianto fotovoltaico") resta valida, "Impianto Fotovoltaico" no.
  if (FOTO_FOLDER_DENY_RE.test(stripped)) return 0
  if (/foto/.test(stripped)) return 60
  return 0
}

/** true se il nome è plausibilmente una cartella foto (deny-list esclusa). */
export function isFotoFolderName(name: string): boolean {
  return FOTO_FOLDER_RE.test(name) && scoreFotoFolder(name) > 0
}

// Sceglie la cartella foto fra le sottocartelle con un ranking deterministico, applicato
// SEMPRE — anche con un solo candidato: prima veniva accettato al volo, così in una
// commessa fotovoltaico "05_Impianto Fotovoltaico" diventava "la cartella foto".
// Sotto soglia non sceglie nulla (il chiamante chiede all'Ingegnere); disambigua solo
// se c'e un vero pareggio di punteggio.
export function pickFotoFolder(subfolders: FolderMatch[]): { match?: FolderMatch; candidates: FolderMatch[] } {
  const candidates = subfolders.filter(f => isFotoFolderName(f.name))
  if (candidates.length === 0) return { candidates: [] }
  const ranked = [...candidates].sort((a, b) => scoreFotoFolder(b.name) - scoreFotoFolder(a.name))
  const topScore = scoreFotoFolder(ranked[0].name)
  // Nessun candidato abbastanza convincente: meglio non scegliere affatto.
  if (topScore < FOTO_FOLDER_MIN_SCORE) return { candidates: [] }
  const topTied = ranked.filter(f => scoreFotoFolder(f.name) === topScore)
  if (topTied.length === 1) return { match: ranked[0], candidates }
  return { candidates: topTied }
}

export function hasFotoFolder(folders: FolderMatch[]): boolean {
  return folders.some(f => isFotoFolderName(f.name))
}

// Stessa regola di pickFotoFolder, ma su candidati che portano già il punteggio
// calcolato (la BFS annidata somma un bonus per il genitore). Vive qui, e non
// dentro foto-archive-tools, perché è pura: lasciarla là la rendeva l'unico pezzo
// della catena di scelta non coperto da test, proprio mentre le si affidava la
// soglia che impedisce di archiviare in "05_Impianto Fotovoltaico".
export function pickTopScored<T extends { score: number }>(
  candidates: T[],
): { match?: T; tied: T[] } {
  if (candidates.length === 0) return { tied: [] }
  const ranked = [...candidates].sort((a, b) => b.score - a.score)
  const topScore = ranked[0].score
  const tied = ranked.filter(c => c.score === topScore)
  // Sotto soglia non si sceglie: il chiamante elenca i candidati e chiede.
  if (topScore < FOTO_FOLDER_MIN_SCORE) return { tied }
  if (tied.length === 1) return { match: ranked[0], tied }
  return { tied }
}

// moveFile (drive.ts) ora rilegge i parent e VERIFICA lo spostamento: in caso di
// fallimento ritorna SEMPRE una stringa che inizia con "Errore" (verifica/permessi)
// oppure "🔒" (policy). Un successo verificato contiene "spostato nella nuova cartella".
// Il rilevamento qui è quindi un AND di due condizioni positive, non solo l'assenza
// di parole d'errore: così un cambio di wording non può far passare un esito ambiguo.
export function isMoveSuccess(result: string): boolean {
  if (!result || typeof result !== 'string') return false
  const normalized = result.toLocaleLowerCase('it-IT')
  if (normalized.startsWith('errore')) return false
  if (result.startsWith('🔒')) return false
  if (normalized.includes('scrittura non consentita')) return false
  if (normalized.includes('non risulta spostato')) return false
  return normalized.includes('spostato nella nuova cartella')
}
