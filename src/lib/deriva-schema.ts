/**
 * Il guardiano fra quello che il repo PROMETTE e quello che il database HA.
 *
 * Perche' esiste (14 settembre 2026): cinque migrazioni su 43 non erano mai
 * state applicate, e due reggevano codice vivo da mesi senza fare rumore.
 * Il registro `supabase_migrations` non basta: puo' divergere in entrambe le
 * direzioni, quindi qui si confrontano promesse del repo e forma dello schema.
 */

export type OggettoAtteso =
  | { tipo: 'tabella'; tabella: string }
  | { tipo: 'colonna'; tabella: string; colonna: string }
  | { tipo: 'chiave_primaria'; tabella: string; colonne: string[] }
  | { tipo: 'indice'; nome: string }
  | { tipo: 'config'; chiave: string }

/** Uno statement che il parser NON ha saputo classificare. Si dichiara. */
export interface StatementNonLetto { file: string; testo: string }

export interface OggettiAttesi {
  oggetti: OggettoAtteso[]
  nonInterpretate: StatementNonLetto[]
}

/** Un identificatore SQL: `nome`, `"nome"`, `schema.nome`. Si tiene l'ultima parte. */
const ID = '(?:"?[A-Za-z_][A-Za-z0-9_$]*"?\\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?'

/** Quello che UNO statement dichiara: cosa si e' letto e cosa NON si e' letto. */
interface Lettura {
  oggetti: OggettoAtteso[]
  /** Pezzi dello statement che il parser non ha saputo leggere. Si dichiarano. */
  nonLetti: string[]
}

/**
 * Le chiavi di un `VALUES ('a', …), ('b', …), ('c', …)`.
 *
 * Di ogni tupla si prende il PRIMO letterale fra apici: per
 * `cervellone_config` e' la chiave. Si legge a mano e non con una regex
 * perche' i valori contengono virgole, parentesi e apici raddoppiati (`''`).
 * Fermarsi alla prima tupla e' il difetto che questa funzione chiude: le
 * INSERT del repo dichiarano 15 chiavi e l'elenco congelato ne conteneva 7 —
 * fra le perse c'era `audit_last_run_week`, quella su cui il rapporto
 * settimanale decide se partire.
 */
function chiaviDelleTuple(statement: string, da: number): { chiavi: string[]; tutteLette: boolean } {
  const chiavi: string[] = []
  let i = da
  let tutteLette = true

  while (i < statement.length) {
    // Fra una tupla e l'altra si accetta solo spazio o virgola: qualunque
    // altra cosa (`ON CONFLICT …`, `RETURNING …`) chiude l'elenco.
    while (i < statement.length && /[\s,]/.test(statement[i])) i += 1
    if (statement[i] !== '(') break

    i += 1
    let profondita = 1
    let chiave: string | null = null
    while (i < statement.length && profondita > 0) {
      const c = statement[i]
      if (c === "'") {
        let letterale = ''
        i += 1
        while (i < statement.length) {
          if (statement[i] === "'") {
            if (statement[i + 1] === "'") { letterale += "'"; i += 2; continue }
            i += 1
            break
          }
          letterale += statement[i]
          i += 1
        }
        if (chiave === null) chiave = letterale
        continue
      }
      if (c === '(') profondita += 1
      else if (c === ')') profondita -= 1
      i += 1
    }
    // Una tupla senza letterale iniziale non e' una chiave che sappiamo
    // leggere: si dichiara invece di sparire.
    if (chiave === null) tutteLette = false
    else chiavi.push(chiave)
  }

  return { chiavi, tutteLette }
}

/**
 * Le parole con cui comincia un VINCOLO di tabella, non una colonna.
 * `constraint t_uq unique (…)`, `primary key (a, b)`, `check (…)`, `like …`.
 */
const VINCOLI_DI_TABELLA = ['PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'CONSTRAINT', 'EXCLUDE', 'LIKE']

/** Il nome di una colonna: il primo identificatore della voce, anche fra virgolette. */
const NOME_COLONNA = /^"?([A-Za-z_][A-Za-z0-9_$]*)"?/

/**
 * Le voci fra le parentesi di un `CREATE TABLE`, divise sulle virgole di
 * PRIMO livello.
 *
 * Non dividono: le virgole dentro parentesi o quadre annidate
 * (`numeric(10,2)`, `check (stato in ('a','b'))`, `default array['x','y']`)
 * ne' quelle dentro un letterale fra apici.
 *
 * Torna `null` se il corpo non c'e' o non si chiude: il chiamante lo dichiara
 * non letto invece di fingere di averlo guardato.
 */
function vociDelCorpo(statement: string): string[] | null {
  const apre = statement.indexOf('(')
  if (apre < 0) return null

  const voci: string[] = []
  let corrente = ''
  let profondita = 0

  for (let i = apre; i < statement.length; i += 1) {
    const c = statement[i]
    if (c === "'") {
      corrente += c
      i += 1
      while (i < statement.length) {
        corrente += statement[i]
        if (statement[i] === "'") {
          // Un apice raddoppiato (`''`) NON chiude il letterale.
          if (statement[i + 1] === "'") { corrente += "'"; i += 2; continue }
          break
        }
        i += 1
      }
      continue
    }
    if (c === '(' || c === '[') {
      profondita += 1
      if (profondita > 1) corrente += c
      continue
    }
    if (c === ')' || c === ']') {
      profondita -= 1
      if (profondita === 0) { voci.push(corrente); return voci }
      corrente += c
      continue
    }
    if (c === ',' && profondita === 1) { voci.push(corrente); corrente = ''; continue }
    corrente += c
  }

  return null
}

/**
 * Le colonne (e la chiave primaria in linea) promesse dal corpo di un
 * `CREATE TABLE`.
 *
 * Perche' esiste (audit del 14 settembre 2026): il corpo veniva buttato via e
 * delle 365 colonne promesse dal repo se ne controllavano 14 — il 4%. Il caso
 * che morde e' un `CREATE TABLE IF NOT EXISTS` ri-emesso con una colonna in
 * piu' su una tabella che esiste gia': Postgres non fa nulla, in silenzio, e
 * il guardiano rispondeva «Nessuna deriva».
 *
 * La `PRIMARY KEY` si registra in tutte e due le forme in cui il repo la
 * scrive: in linea (`id uuid primary key`) e come vincolo di tabella
 * (`PRIMARY KEY (name, type)`, in `cervellone_entita_menzionate`). Saltare la
 * seconda insieme agli altri vincoli la faceva sparire da ENTRAMBI i numeri
 * del rapporto — la stessa perdita silenziosa del reperto 1.
 *
 * ⚠️ Gli ALTRI vincoli (`FOREIGN`, `UNIQUE`, `CHECK`, `CONSTRAINT`, `EXCLUDE`,
 * `LIKE`) restano fuori, ed e' una scelta dichiarata: il guardiano non ha mai
 * detto di controllarli.
 */
function colonneDelCorpo(tabella: string, statement: string): Lettura {
  const voci = vociDelCorpo(statement)
  if (voci === null) return { oggetti: [], nonLetti: [statement] }

  const oggetti: OggettoAtteso[] = []
  const nonLetti: string[] = []

  for (const voce of voci) {
    const v = voce.trim()
    if (!v) continue

    // Una `PRIMARY KEY (a, b)` di tabella e' una promessa quanto una colonna:
    // si legge PRIMA di scartare i vincoli, con tutte le sue colonne.
    const pkDiTabella = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(v)
    if (pkDiTabella) {
      const colonne = pkDiTabella[1].split(',').map((c) => c.trim().replace(/"/g, '')).filter(Boolean)
      if (colonne.length > 0) oggetti.push({ tipo: 'chiave_primaria', tabella, colonne })
      // Una `PRIMARY KEY ()` senza colonne non si sa leggere: si dichiara.
      else nonLetti.push(v)
      continue
    }

    const prima = /^[A-Za-z_]+/.exec(v)
    if (prima && VINCOLI_DI_TABELLA.includes(prima[0].toUpperCase())) continue

    const nome = NOME_COLONNA.exec(v)
    if (!nome) {
      // Non si ingoia: una voce illeggibile va dichiarata, altrimenti sparisce
      // da entrambi i numeri del rapporto.
      nonLetti.push(v)
      continue
    }

    oggetti.push({ tipo: 'colonna', tabella, colonna: nome[1] })
    // `id uuid primary key default gen_random_uuid()`: la chiave primaria in
    // linea e' una promessa quanto la colonna. In produzione e' successo che
    // tabella e colonne ci fossero e l'upsert fallisse lo stesso, per una PK
    // diversa da quella promessa.
    if (/\bPRIMARY\s+KEY\b/i.test(v)) oggetti.push({ tipo: 'chiave_primaria', tabella, colonne: [nome[1]] })
  }

  return { oggetti, nonLetti }
}

const FORME: Array<{ re: RegExp; leggi: (m: RegExpExecArray, statement: string) => Lettura }> = [
  {
    re: new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${ID}\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'i'),
    leggi: (m, statement) => {
      // Un solo ALTER TABLE puo' aggiungere PIU' colonne separate da virgola
      // (`2026-09-05-fatture-estere-tre-caselle.sql`). Fermarsi alla prima
      // faceva sparire `source_key` da entrambi i numeri del rapporto: ne'
      // attesa, ne' dichiarata non letta.
      const tutte = new RegExp(`ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'gi')
      const oggetti: OggettoAtteso[] = []
      let c: RegExpExecArray | null
      while ((c = tutte.exec(statement)) !== null) {
        oggetti.push({ tipo: 'colonna', tabella: m[1], colonna: c[1] })
      }
      return { oggetti, nonLetti: [] }
    },
  },
  {
    re: new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${ID}\\s+ADD\\s+PRIMARY\\s+KEY\\s*\\(([^)]*)\\)`, 'i'),
    leggi: (m) => ({
      oggetti: [{
        tipo: 'chiave_primaria',
        tabella: m[1],
        colonne: m[2].split(',').map((c) => c.trim().replace(/"/g, '')).filter(Boolean),
      }],
      nonLetti: [],
    }),
  },
  {
    re: new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'i'),
    leggi: (m, statement) => {
      const dalCorpo = colonneDelCorpo(m[1], statement)
      return {
        oggetti: [{ tipo: 'tabella', tabella: m[1] } as OggettoAtteso].concat(dalCorpo.oggetti),
        nonLetti: dalCorpo.nonLetti,
      }
    },
  },
  {
    re: new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'i'),
    leggi: (m) => ({ oggetti: [{ tipo: 'indice', nome: m[1] }], nonLetti: [] }),
  },
  {
    re: /^INSERT\s+INTO\s+cervellone_config\s*\([^)]*\)\s*VALUES\s*\(\s*'([^']+)'/i,
    leggi: (m, statement) => {
      // Una sola INSERT dichiara spesso PIU' righe: si leggono tutte le tuple.
      const inizioTuple = /^INSERT\s+INTO\s+cervellone_config\s*\([^)]*\)\s*VALUES/i.exec(statement)
      const { chiavi, tutteLette } = chiaviDelleTuple(statement, inizioTuple ? inizioTuple[0].length : 0)
      return {
        oggetti: chiavi.map((chiave) => ({ tipo: 'config' as const, chiave })),
        nonLetti: tutteLette ? [] : [statement],
      }
    },
  },
]

const APRE_DOLLARO = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/

/**
 * Divide il file negli statement, togliendo i commenti per strada.
 *
 * Una passata sola, perche' commenti, stringhe e `;` non si possono guardare
 * separatamente: prima i commenti si toglievano con una regex cieca e il
 * divisore non conosceva gli apici, cosi'
 *   `comment on table … is '… anon/auth; accesso service_role server-side.';`
 * (testo vero, `2026-05-25-cervellone-scadenze.sql`) diventava DUE statement.
 * Oggi non nasceva nessun oggetto falso — l'ancora `^` delle forme salvava —
 * ma bastava un letterale che contenesse «; create index …» per far nascere
 * un atteso INESISTENTE: un falso allarme permanente dentro il guardiano che
 * serve a dare gli allarmi veri.
 *
 * Dentro un blocco `$$ … $$` non si tocca niente: il dollar quoting esiste
 * proprio per poter scrivere apici e punti e virgola senza significato.
 */
function dividiStatement(sql: string): string[] {
  const pezzi: string[] = []
  let corrente = ''
  let dollarQuote: string | null = null
  let i = 0

  while (i < sql.length) {
    const c = sql[i]

    if (dollarQuote) {
      if (c === '$') {
        const m = APRE_DOLLARO.exec(sql.slice(i))
        if (m && m[0] === dollarQuote) {
          dollarQuote = null
          corrente += m[0]
          i += m[0].length
          continue
        }
      }
      corrente += c
      i += 1
      continue
    }

    if (c === '$') {
      const m = APRE_DOLLARO.exec(sql.slice(i))
      if (m) {
        dollarQuote = m[0]
        corrente += m[0]
        i += m[0].length
        continue
      }
    }

    // Commento di riga: sparisce fino a fine riga (il `\n` resta, e la
    // normalizzazione degli spazi lo assorbe).
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1
      corrente += ' '
      continue
    }

    // Commento a blocco.
    if (c === '/' && sql[i + 1] === '*') {
      const fine = sql.indexOf('*/', i + 2)
      i = fine === -1 ? sql.length : fine + 2
      corrente += ' '
      continue
    }

    // Letterale: si copia INTERO, `;` e `--` compresi.
    if (c === "'") {
      corrente += c
      i += 1
      while (i < sql.length) {
        if (sql[i] === "'") {
          // Un apice raddoppiato (`''`) NON chiude il letterale.
          if (sql[i + 1] === "'") { corrente += "''"; i += 2; continue }
          corrente += "'"
          i += 1
          break
        }
        corrente += sql[i]
        i += 1
      }
      continue
    }

    if (c === ';') {
      pezzi.push(corrente)
      corrente = ''
      i += 1
      continue
    }

    corrente += c
    i += 1
  }

  pezzi.push(corrente)
  return pezzi
}

function statement(sql: string): string[] {
  return dividiStatement(sql)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
}

export function oggettiAttesi(file: Array<{ nome: string; sql: string }>): OggettiAttesi {
  const oggetti: OggettoAtteso[] = []
  const nonInterpretate: StatementNonLetto[] = []

  for (const f of file) {
    for (const s of statement(f.sql)) {
      const forma = FORME.find(({ re }) => re.test(s))
      if (!forma) {
        // Non si ingoia: tacere su quello che non si capisce fa credere di
        // aver controllato tutto.
        nonInterpretate.push({ file: f.nome, testo: s.slice(0, 200) })
        continue
      }
      const m = forma.re.exec(s)
      if (!m) continue
      const lettura = forma.leggi(m, s)
      for (const o of lettura.oggetti) oggetti.push(o)
      // Anche dentro uno statement RICONOSCIUTO ci puo' essere un pezzo che non
      // si sa leggere: va dichiarato, altrimenti sparisce da tutti e due i
      // numeri del rapporto — che e' il difetto peggiore possibile qui.
      for (const t of lettura.nonLetti) nonInterpretate.push({ file: f.nome, testo: t.slice(0, 200) })
    }
  }

  // Lo stesso oggetto promesso due volte vale UNO.
  // `document_templates.dati_fissi` e' dichiarata sia nel suo CREATE TABLE sia
  // in un ALTER TABLE successivo, e contarla due volte gonfiava il numero
  // «oggetti verificati» del rapporto. E' poco, ma e' un numero che dice una
  // cosa falsa dentro lo strumento che nasce contro i numeri che dicono cose
  // false. La chiave e' l'oggetto INTERO: due colonne omonime su tabelle
  // diverse restano due.
  const visti = new Set<string>()
  const senzaDoppioni = oggetti.filter((o) => {
    const chiave = JSON.stringify(o)
    if (visti.has(chiave)) return false
    visti.add(chiave)
    return true
  })

  return { oggetti: senzaDoppioni, nonInterpretate }
}

export interface Fotografia {
  tabelle: string[]
  colonne: string[]
  chiaviPrimarie: Record<string, string[]>
  indici: string[]
  chiaviConfig: string[]
}

export interface Deriva {
  mancanti: OggettoAtteso[]
  verificati: number
  nonInterpretate: StatementNonLetto[]
}

function presente(o: OggettoAtteso, f: Fotografia): boolean {
  switch (o.tipo) {
    case 'tabella': return f.tabelle.includes(o.tabella)
    case 'colonna': return f.colonne.includes(`${o.tabella}.${o.colonna}`)
    case 'indice': return f.indici.includes(o.nome)
    case 'config': return f.chiaviConfig.includes(o.chiave)
    case 'chiave_primaria': {
      const vere = f.chiaviPrimarie[o.tabella]
      if (!vere) return false
      // L'ordine delle colonne in una PK non cambia il vincolo: confrontarlo
      // genererebbe falsi allarmi e farebbe ignorare il guardiano.
      const a = [...vere].sort().join(',')
      const b = [...o.colonne].sort().join(',')
      return a === b
    }
  }
}

export function confronta(attesi: OggettiAttesi, foto: Fotografia): Deriva {
  return {
    mancanti: attesi.oggetti.filter((o) => !presente(o, foto)),
    verificati: attesi.oggetti.length,
    nonInterpretate: attesi.nonInterpretate,
  }
}

export interface OpzioniDescrizione {
  /**
   * Come elencare i file con statement non letti.
   *
   * `completo` (predefinito) e' per il tool, che non passa da Telegram.
   * `sintetico` e' per il rapporto settimanale: a deriva ZERO la sezione
   * misurava 1.560 caratteri, di cui ~1.420 erano i 38 nomi di file — gli
   * stessi ogni settimana. Il rapporto viene tagliato a 3.500 caratteri su
   * 4.096 e la sezione sta in coda: con deriva vera il taglio cadeva
   * esattamente sulla notizia.
   */
  elencoFile?: 'completo' | 'sintetico'
}

/** Quanti nomi di file stanno nella versione sintetica, prima di «e altri N». */
const NOMI_NEL_RAPPORTO = 3

/** Il rapporto in parole. Due numeri, sempre: verificati e non interpretati. */
export function descriviDeriva(d: Deriva, opzioni: OpzioniDescrizione = {}): string {
  const righe: string[] = []
  righe.push(
    d.mancanti.length === 0
      ? `Nessuna deriva: ${d.verificati} oggetti del repo sono presenti nel database.`
      : `DERIVA: ${d.mancanti.length} oggetti su ${d.verificati} promessi dal repo NON esistono nel database.`,
  )
  for (const m of d.mancanti) {
    if (m.tipo === 'colonna') righe.push(`  - manca la colonna ${m.tabella}.${m.colonna}`)
    else if (m.tipo === 'tabella') righe.push(`  - manca la tabella ${m.tabella}`)
    else if (m.tipo === 'indice') righe.push(`  - manca l'indice ${m.nome}`)
    else if (m.tipo === 'config') righe.push(`  - manca la chiave di configurazione ${m.chiave}`)
    else righe.push(`  - ${m.tabella} non ha la chiave primaria (${m.colonne.join(', ')})`)
  }
  // Questa riga c'e' sempre, anche a zero: senza, "nessuna deriva" sarebbe
  // indistinguibile da "non ho guardato".
  righe.push(`Statement non interpretati dal controllo: ${d.nonInterpretate.length}.`)
  if (d.nonInterpretate.length > 0) {
    const file = Array.from(new Set(d.nonInterpretate.map((s) => s.file)))
    if (opzioni.elencoFile === 'sintetico') {
      const primi = file.slice(0, NOMI_NEL_RAPPORTO)
      const altri = file.length - primi.length
      const coda = altri > 0 ? ` e altri ${altri}` : ''
      righe.push(`  (in ${file.length} file: ${primi.join(', ')}${coda} - il controllo NON copre queste forme; l'elenco per esteso lo da il tool verifica_deriva_schema)`)
    } else {
      righe.push(`  (nei file: ${file.join(', ')} - il controllo NON copre queste forme)`)
    }
  }
  return righe.join('\n')
}
