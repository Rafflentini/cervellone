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
    leggi: (m) => ({ oggetti: [{ tipo: 'tabella', tabella: m[1] }], nonLetti: [] }),
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

/** Via i commenti `--` e i blocchi, che non promettono niente. */
function senzaCommenti(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

function dividiStatement(sql: string): string[] {
  const pezzi: string[] = []
  let corrente = ''
  let dollarQuote: string | null = null

  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i]
    if (c === '$') {
      const resto = sql.slice(i)
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(resto)
      if (m) {
        if (dollarQuote === m[0]) dollarQuote = null
        else if (!dollarQuote) dollarQuote = m[0]
        corrente += m[0]
        i += m[0].length - 1
        continue
      }
    }
    if (c === ';' && !dollarQuote) {
      pezzi.push(corrente)
      corrente = ''
      continue
    }
    corrente += c
  }
  pezzi.push(corrente)
  return pezzi
}

function statement(sql: string): string[] {
  return dividiStatement(senzaCommenti(sql))
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

  return { oggetti, nonInterpretate }
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

/** Il rapporto in parole. Due numeri, sempre: verificati e non interpretati. */
export function descriviDeriva(d: Deriva): string {
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
    righe.push(`  (nei file: ${file.join(', ')} - il controllo NON copre queste forme)`)
  }
  return righe.join('\n')
}
