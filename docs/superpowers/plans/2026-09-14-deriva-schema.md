# Guardiano della deriva repo↔database — piano di attuazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Far sì che il repository e il database di produzione non possano più divergere in silenzio: un guardiano che dice quali migrazioni del repo NON sono applicate, e che dichiara sempre anche quanto non è riuscito a leggere.

**Architecture:** Il confronto è una funzione pura provabile offline. L'elenco degli oggetti attesi è **generato** dai file SQL e congelato in un JSON versionato, con un test che fallisce se il JSON è più vecchio delle migrazioni. La fotografia dello schema vero si prende in produzione con una funzione Postgres di sola lettura chiamata via `rpc`. Il risultato esce da un **tool** (equipollente sui due canali per costruzione) e dal rapporto settimanale del cron `self-audit`.

**Tech Stack:** TypeScript, Next.js App Router, Supabase (`@supabase/supabase-js`), vitest, `tsx` per lo script di generazione.

**Spec:** `docs/superpowers/specs/2026-09-14-deriva-schema-design.md`

## Global Constraints

- **Nessuna lettura di file a runtime.** In tutto il repo non esiste una sola `readFileSync` fuori dai test, e `next.config.ts` traccia nel bundle solo `pdf.worker.mjs` e il binario chromium. Un `fs.readFileSync('supabase/migrations/…')` dentro una route **funziona in locale e muore su Vercel**. La lettura dei `.sql` avviene SOLO in uno script e nei test.
- **Il modello da imitare è `src/lib/tools/automazioni.ts`**: dato in codice + test che lo confronta col file vero (`src/lib/tools/automazioni.test.ts:42,50`). Stessa forma qui.
- **Commenti in italiano**, come tutto il repo. Spiegano *perché*, non *cosa*.
- ⚠️ **Mai scrivere un commento che promette una difesa che non c'è.** Il 14 set 2026 tre commenti di questo repo descrivevano protezioni inesistenti (`working-memory.ts:273`, `gmail-tools.ts:98`, il `trim()` della guardia cron). Se una difesa non c'è, il commento non la nomina.
- **Il guardiano non scrive mai sul database.** Guarda e dice. Nessun `ALTER`, nessun `INSERT`, nessuna correzione automatica.
- **Mai tacere quando non si è potuto guardare.** Ogni esito porta due numeri: quanti oggetti verificati e quanti statement non interpretati. Un esito che non può distinguere «tutto a posto» da «non ho guardato» è il difetto che questo lavoro esiste per uccidere.
- **Comandi:** test `npx vitest run <file>`, typecheck `npx tsc --noEmit`, suite intera `npx vitest run`.
- **Codex non tocca il database di produzione.** Scrive il file di migrazione; ad applicarlo è Claude, con `apply_migration`.

---

### Task 1: Il parser — dai file SQL agli oggetti attesi

**Files:**
- Create: `src/lib/deriva-schema.ts`
- Test: `src/lib/deriva-schema.test.ts`

**Interfaces:**
- Consumes: niente.
- Produces:
  ```ts
  export type OggettoAtteso =
    | { tipo: 'tabella'; tabella: string }
    | { tipo: 'colonna'; tabella: string; colonna: string }
    | { tipo: 'chiave_primaria'; tabella: string; colonne: string[] }
    | { tipo: 'indice'; nome: string }
    | { tipo: 'config'; chiave: string }

  export interface StatementNonLetto { file: string; testo: string }

  export interface OggettiAttesi {
    oggetti: OggettoAtteso[]
    nonInterpretate: StatementNonLetto[]
  }

  export function oggettiAttesi(
    file: Array<{ nome: string; sql: string }>,
  ): OggettiAttesi
  ```

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// src/lib/deriva-schema.test.ts
import { describe, it, expect } from 'vitest'
import { oggettiAttesi } from './deriva-schema'

describe('oggettiAttesi — cosa il repo PROMETTE che esista', () => {
  it('riconosce le cinque forme che sappiamo leggere', () => {
    const r = oggettiAttesi([{
      nome: '2026-01-01-prova.sql',
      sql: `
        CREATE TABLE IF NOT EXISTS tavola_uno (id bigint primary key);
        ALTER TABLE procedures ADD COLUMN IF NOT EXISTS output_preferences text[] NOT NULL DEFAULT '{}';
        ALTER TABLE gmail_processed_messages ADD PRIMARY KEY (message_id, bot_action);
        CREATE UNIQUE INDEX idx_prova ON tavola_uno (id);
        INSERT INTO cervellone_config (key, value) VALUES ('auto_debrief_enabled', 'false') ON CONFLICT (key) DO NOTHING;
      `,
    }])

    expect(r.oggetti).toContainEqual({ tipo: 'tabella', tabella: 'tavola_uno' })
    expect(r.oggetti).toContainEqual({ tipo: 'colonna', tabella: 'procedures', colonna: 'output_preferences' })
    expect(r.oggetti).toContainEqual({
      tipo: 'chiave_primaria', tabella: 'gmail_processed_messages', colonne: ['message_id', 'bot_action'],
    })
    expect(r.oggetti).toContainEqual({ tipo: 'indice', nome: 'idx_prova' })
    expect(r.oggetti).toContainEqual({ tipo: 'config', chiave: 'auto_debrief_enabled' })
  })

  it('🚨 quello che NON sa leggere lo DICHIARA, non lo ingoia', () => {
    // Senza questo, «nessuna deriva» finirebbe per voler dire «non ho guardato»
    // — che e' esattamente come output_preferences e' sopravvissuta tre mesi.
    const r = oggettiAttesi([{
      nome: '2026-01-02-strana.sql',
      sql: `CREATE OR REPLACE FUNCTION pippo() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;`,
    }])

    expect(r.oggetti).toEqual([])
    expect(r.nonInterpretate).toHaveLength(1)
    expect(r.nonInterpretate[0].file).toBe('2026-01-02-strana.sql')
    expect(r.nonInterpretate[0].testo).toContain('CREATE OR REPLACE FUNCTION')
  })

  it('i commenti SQL non diventano oggetti', () => {
    const r = oggettiAttesi([{
      nome: 'c.sql',
      sql: `-- ALTER TABLE finta ADD COLUMN IF NOT EXISTS bugiarda text;\nCREATE TABLE vera (id int);`,
    }])
    expect(r.oggetti).toEqual([{ tipo: 'tabella', tabella: 'vera' }])
  })

  it('DROP e ALTER ... DISABLE ROW LEVEL SECURITY non sono promesse: si dichiarano non lette', () => {
    // `2026-05-05-disable-rls-model-health.sql` e altre ~11 contengono questo
    // statement, e in produzione la realta' e' stata poi irrigidita al
    // contrario (RLS riacceso). Non e' una deriva da segnalare: e' una forma
    // che non sappiamo giudicare, e va detto invece che inventarsi un esito.
    const r = oggettiAttesi([{ nome: 'd.sql', sql: 'ALTER TABLE model_health DISABLE ROW LEVEL SECURITY;' }])
    expect(r.oggetti).toEqual([])
    expect(r.nonInterpretate).toHaveLength(1)
  })

  it('CONTROLLO POSITIVO: un file vuoto non produce ne oggetti ne rumore', () => {
    // Senza questo, un parser che dichiara TUTTO non letto passerebbe il test
    // qui sopra e non troverebbe mai niente.
    const r = oggettiAttesi([{ nome: 'v.sql', sql: '   \n-- solo un commento\n' }])
    expect(r.oggetti).toEqual([])
    expect(r.nonInterpretate).toEqual([])
  })
})
```

- [ ] **Step 2: Lancia il test e verifica che FALLISCA**

Run: `npx vitest run src/lib/deriva-schema.test.ts`
Atteso: FAIL — `Failed to resolve import "./deriva-schema"`.

- [ ] **Step 3: Scrivi l'implementazione minima**

```ts
// src/lib/deriva-schema.ts
/**
 * Il guardiano fra quello che il repo PROMETTE e quello che il database HA.
 *
 * ── Perche' esiste (14 settembre 2026) ──────────────────────────────────────
 * Cinque migrazioni su 43 non erano mai state applicate, e due reggevano codice
 * VIVO: la memoria di lavoro e' stata inerte tre mesi (con il flag acceso, e
 * tre procedure che il bot non ha mai letto) e `gmail_processed_messages` e'
 * rimasta VUOTA da maggio, lasciando senza anti-loop le risposte Gmail.
 * Nessuno dei due guasti ha mai fatto rumore.
 *
 * Il registro `supabase_migrations` non aiuta: diverge in ENTRAMBE le
 * direzioni — ~18 file del repo non vi compaiono, ~14 sue righe non esistono
 * nel repo. Per questo il guardiano non chiede a un registro cosa e' stato
 * applicato: lo chiede allo schema.
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

/** Un identificatore SQL: `nome`, `"nome"`, `schema.nome`. Si tiene l'ultima parte, senza virgolette. */
const ID = '(?:"?[A-Za-z_][A-Za-z0-9_$]*"?\\.)?"?([A-Za-z_][A-Za-z0-9_$]*)"?'

const FORME: Array<{ re: RegExp; leggi: (m: RegExpExecArray) => OggettoAtteso }> = [
  {
    re: new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${ID}\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'i'),
    leggi: (m) => ({ tipo: 'colonna', tabella: m[1], colonna: m[2] }),
  },
  {
    re: new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${ID}\\s+ADD\\s+PRIMARY\\s+KEY\\s*\\(([^)]*)\\)`, 'i'),
    leggi: (m) => ({
      tipo: 'chiave_primaria',
      tabella: m[1],
      colonne: m[2].split(',').map((c) => c.trim().replace(/"/g, '')).filter(Boolean),
    }),
  },
  {
    re: new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'i'),
    leggi: (m) => ({ tipo: 'tabella', tabella: m[1] }),
  },
  {
    re: new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${ID}`, 'i'),
    leggi: (m) => ({ tipo: 'indice', nome: m[1] }),
  },
  {
    re: /^INSERT\s+INTO\s+cervellone_config\s*\([^)]*\)\s*VALUES\s*\(\s*'([^']+)'/i,
    leggi: (m) => ({ tipo: 'config', chiave: m[1] }),
  },
]

/** Via i commenti `--` e i blocchi `/* *​/`, che non promettono niente. */
function senzaCommenti(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

function statement(sql: string): string[] {
  return senzaCommenti(sql)
    .split(';')
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
        // Non si ingoia: un parser che tace su quello che non capisce fa
        // credere di aver controllato tutto.
        nonInterpretate.push({ file: f.nome, testo: s.slice(0, 200) })
        continue
      }
      const m = forma.re.exec(s)
      if (m) oggetti.push(forma.leggi(m))
    }
  }

  return { oggetti, nonInterpretate }
}
```

- [ ] **Step 4: Lancia il test e verifica che PASSI**

Run: `npx vitest run src/lib/deriva-schema.test.ts`
Atteso: PASS, 5 test.

- [ ] **Step 5: Mutazione — prova che il test morde**

Cambia in `src/lib/deriva-schema.ts` la riga `nonInterpretate.push(...)` in `continue` secco (cioè: ingoia in silenzio).
Run: `npx vitest run src/lib/deriva-schema.test.ts`
Atteso: FAIL sul test «quello che NON sa leggere lo DICHIARA».
Poi **ripristina** e rilancia: PASS.
⚠️ I sorgenti sono **CRLF**: se applichi la mutazione con `perl -0pi`, un'ancora `$` non aggancia per via del `\r`. Verifica SEMPRE che la mutazione sia entrata con un `grep -c` prima di leggere il risultato dei test — in questo repo una mutazione su due non è entrata al primo colpo.

- [ ] **Step 6: Commit**

```bash
git add src/lib/deriva-schema.ts src/lib/deriva-schema.test.ts
git commit -m "il parser delle migrazioni: e dichiara quello che non sa leggere"
```

---

### Task 2: Il confronto — funzione pura, niente database

**Files:**
- Modify: `src/lib/deriva-schema.ts`
- Modify: `src/lib/deriva-schema.test.ts`

**Interfaces:**
- Consumes: `OggettiAttesi`, `OggettoAtteso` dal Task 1.
- Produces:
  ```ts
  export interface Fotografia {
    tabelle: string[]
    colonne: string[]          // "tabella.colonna"
    chiaviPrimarie: Record<string, string[]>   // tabella -> colonne
    indici: string[]
    chiaviConfig: string[]
  }

  export interface Deriva {
    mancanti: OggettoAtteso[]
    verificati: number
    nonInterpretate: StatementNonLetto[]
  }

  export function confronta(attesi: OggettiAttesi, foto: Fotografia): Deriva
  export function descriviDeriva(d: Deriva): string
  ```

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// in coda a src/lib/deriva-schema.test.ts
import { confronta, descriviDeriva, type Fotografia } from './deriva-schema'

const FOTO_PIENA: Fotografia = {
  tabelle: ['procedures', 'gmail_processed_messages'],
  colonne: ['procedures.output_preferences'],
  chiaviPrimarie: { gmail_processed_messages: ['message_id', 'bot_action'] },
  indici: ['idx_prova'],
  chiaviConfig: ['auto_debrief_enabled'],
}

const ATTESI = {
  oggetti: [
    { tipo: 'tabella', tabella: 'procedures' },
    { tipo: 'colonna', tabella: 'procedures', colonna: 'output_preferences' },
    { tipo: 'chiave_primaria', tabella: 'gmail_processed_messages', colonne: ['message_id', 'bot_action'] },
    { tipo: 'indice', nome: 'idx_prova' },
    { tipo: 'config', chiave: 'auto_debrief_enabled' },
  ],
  nonInterpretate: [],
} as const

describe('confronta — quello che manca davvero', () => {
  it('CONTROLLO POSITIVO: se c-e tutto, la deriva e VUOTA', () => {
    // Senza questo, un `confronta` che dice sempre «manca tutto» passerebbe
    // ogni test qui sotto.
    const d = confronta(ATTESI as never, FOTO_PIENA)
    expect(d.mancanti).toEqual([])
    expect(d.verificati).toBe(5)
  })

  it('🚨 la colonna che manca compare, ed e IL caso di output_preferences', () => {
    const foto = { ...FOTO_PIENA, colonne: [] }
    const d = confronta(ATTESI as never, foto)
    expect(d.mancanti).toContainEqual({ tipo: 'colonna', tabella: 'procedures', colonna: 'output_preferences' })
  })

  it('🚨 la chiave primaria SBAGLIATA conta come mancante, ed e IL caso di gmail', () => {
    // In produzione era `PRIMARY KEY (message_id)` invece di (message_id, bot_action):
    // la tabella c-era, la colonna c-era, e l-upsert falliva lo stesso.
    const foto = { ...FOTO_PIENA, chiaviPrimarie: { gmail_processed_messages: ['message_id'] } }
    const d = confronta(ATTESI as never, foto)
    expect(d.mancanti).toContainEqual({
      tipo: 'chiave_primaria', tabella: 'gmail_processed_messages', colonne: ['message_id', 'bot_action'],
    })
  })

  it('l-ordine delle colonne della chiave primaria NON conta', () => {
    const foto = { ...FOTO_PIENA, chiaviPrimarie: { gmail_processed_messages: ['bot_action', 'message_id'] } }
    expect(confronta(ATTESI as never, foto).mancanti).toEqual([])
  })

  it('gli statement non letti viaggiano fino in fondo', () => {
    const attesi = { oggetti: [], nonInterpretate: [{ file: 'x.sql', testo: 'CREATE FUNCTION ...' }] }
    const d = confronta(attesi, FOTO_PIENA)
    expect(d.nonInterpretate).toHaveLength(1)
  })

  it('descriviDeriva dice SEMPRE due numeri, anche quando va tutto bene', () => {
    // «nessuna deriva» senza il secondo numero e- indistinguibile da «non ho guardato».
    const testo = descriviDeriva(confronta(ATTESI as never, FOTO_PIENA))
    expect(testo).toContain('5')
    expect(testo.toLowerCase()).toContain('non interpretat')
  })
})
```

- [ ] **Step 2: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/deriva-schema.test.ts`
Atteso: FAIL — `confronta is not exported`.

- [ ] **Step 3: Implementa**

```ts
// in coda a src/lib/deriva-schema.ts
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
      // L'ordine delle colonne in una PK non cambia il vincolo, e confrontarlo
      // produrrebbe falsi allarmi che a lungo andare fanno ignorare il guardiano.
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

/** Il rapporto in parole. DUE numeri, sempre: verificati e non interpretati. */
export function descriviDeriva(d: Deriva): string {
  const righe: string[] = []
  righe.push(
    d.mancanti.length === 0
      ? `Nessuna deriva: ${d.verificati} oggetti del repo sono presenti nel database.`
      : `DERIVA: ${d.mancanti.length} oggetti su ${d.verificati} promessi dal repo NON esistono nel database.`,
  )
  for (const m of d.mancanti) {
    if (m.tipo === 'colonna') righe.push(`  • manca la colonna ${m.tabella}.${m.colonna}`)
    else if (m.tipo === 'tabella') righe.push(`  • manca la tabella ${m.tabella}`)
    else if (m.tipo === 'indice') righe.push(`  • manca l'indice ${m.nome}`)
    else if (m.tipo === 'config') righe.push(`  • manca la chiave di configurazione ${m.chiave}`)
    else righe.push(`  • ${m.tabella} non ha la chiave primaria (${m.colonne.join(', ')})`)
  }
  // Questa riga c'e' SEMPRE, anche a zero: senza, «nessuna deriva» sarebbe
  // indistinguibile da «non ho guardato».
  righe.push(`Statement non interpretati dal controllo: ${d.nonInterpretate.length}.`)
  if (d.nonInterpretate.length > 0) {
    const file = Array.from(new Set(d.nonInterpretate.map((s) => s.file)))
    righe.push(`  (nei file: ${file.join(', ')} — il controllo NON copre queste forme)`)
  }
  return righe.join('\n')
}
```

- [ ] **Step 4: Lancia e verifica che PASSI**

Run: `npx vitest run src/lib/deriva-schema.test.ts`
Atteso: PASS, 11 test.

- [ ] **Step 5: Mutazione**

In `descriviDeriva`, cancella la riga `righe.push(\`Statement non interpretati…\`)`.
Run: `npx vitest run src/lib/deriva-schema.test.ts` → atteso FAIL su «dice SEMPRE due numeri». Ripristina, rilancia, PASS. Verifica con `grep -c "non interpretati" src/lib/deriva-schema.ts` che la mutazione sia davvero entrata e poi davvero uscita.

- [ ] **Step 6: Commit**

```bash
git add src/lib/deriva-schema.ts src/lib/deriva-schema.test.ts
git commit -m "il confronto: cosa il repo promette e il database non ha"
```

---

### Task 3: L'elenco generato, e il test che lo tiene fresco

**Files:**
- Create: `scripts/genera-attesi-schema.ts`
- Create: `src/lib/deriva-schema-attesi.json` (generato, versionato)
- Create: `src/lib/deriva-schema-attesi.test.ts`
- Modify: `package.json` (uno script npm)

**Interfaces:**
- Consumes: `oggettiAttesi` dal Task 1.
- Produces: `src/lib/deriva-schema-attesi.json`, importabile a runtime con `import ATTESI from './deriva-schema-attesi.json'`, di forma `OggettiAttesi`.

> **Perché non si leggono i `.sql` a runtime:** in tutto il repo non esiste una `readFileSync` fuori dai test, e `next.config.ts` traccia nel bundle solo `pdf.worker.mjs` e il binario chromium. Un file letto da una route funzionerebbe in locale e mancherebbe su Vercel. Il repo risolve già così lo stesso problema in `src/lib/tools/automazioni.ts`: dato in codice + test che lo confronta col file vero.

- [ ] **Step 1: Scrivi il test di freschezza (fallirà)**

```ts
// src/lib/deriva-schema-attesi.test.ts
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { oggettiAttesi } from './deriva-schema'
import ATTESI from './deriva-schema-attesi.json'

/**
 * ⚠️ L'elenco congelato DEVE combaciare con le migrazioni vere.
 *
 * Un elenco scritto a mano invecchia in silenzio, ed e' cosi' che nasce il
 * problema che questo guardiano risolve. Qui l'elenco e' GENERATO, e questo
 * test e' il patto: se qualcuno aggiunge una migrazione e non rigenera, la
 * suite muore.
 */
const CARTELLA = path.join(process.cwd(), 'supabase', 'migrations')

function daDisco() {
  const nomi = fs.readdirSync(CARTELLA).filter((n) => n.endsWith('.sql')).sort()
  return oggettiAttesi(nomi.map((nome) => ({ nome, sql: fs.readFileSync(path.join(CARTELLA, nome), 'utf8') })))
}

describe('deriva-schema-attesi.json', () => {
  it('non e vuoto: zero oggetti su 43 migrazioni vuol dire parser rotto', () => {
    // Un `forEach` su zero elementi e' verde e non prova niente.
    expect(ATTESI.oggetti.length).toBeGreaterThan(20)
  })

  it('🚨 e FRESCO: combacia con i file .sql di oggi', () => {
    expect(ATTESI).toEqual(JSON.parse(JSON.stringify(daDisco())))
  })

  it('dichiara quanti statement non sa leggere, e il numero e VISIBILE', () => {
    expect(Array.isArray(ATTESI.nonInterpretate)).toBe(true)
    // Non si pretende che sia zero — si pretende che sia DETTO.
    expect(typeof ATTESI.nonInterpretate.length).toBe('number')
  })
})
```

- [ ] **Step 2: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/deriva-schema-attesi.test.ts`
Atteso: FAIL — `Cannot find module './deriva-schema-attesi.json'`.

- [ ] **Step 3: Scrivi lo script di generazione**

```ts
// scripts/genera-attesi-schema.ts
/**
 * Congela in JSON quello che le migrazioni del repo promettono.
 *
 * Si rigenera con `npm run genera:attesi` ogni volta che si aggiunge una
 * migrazione. Se ci si dimentica, `deriva-schema-attesi.test.ts` fa morire la
 * suite: un elenco scritto a mano invecchia in silenzio, ed e' esattamente il
 * difetto che questo guardiano esiste per uccidere.
 */
import fs from 'fs'
import path from 'path'
import { oggettiAttesi } from '../src/lib/deriva-schema'

const CARTELLA = path.join(process.cwd(), 'supabase', 'migrations')
const USCITA = path.join(process.cwd(), 'src', 'lib', 'deriva-schema-attesi.json')

const nomi = fs.readdirSync(CARTELLA).filter((n) => n.endsWith('.sql')).sort()
const risultato = oggettiAttesi(
  nomi.map((nome) => ({ nome, sql: fs.readFileSync(path.join(CARTELLA, nome), 'utf8') })),
)

fs.writeFileSync(USCITA, JSON.stringify(risultato, null, 2) + '\n', 'utf8')
console.log(
  `[attesi] ${nomi.length} migrazioni → ${risultato.oggetti.length} oggetti attesi, `
  + `${risultato.nonInterpretate.length} statement non interpretati.`,
)
```

- [ ] **Step 4: Aggiungi lo script npm e genera**

In `package.json`, dentro `"scripts"`, aggiungi:
```json
"genera:attesi": "tsx scripts/genera-attesi-schema.ts"
```

Run: `npm run genera:attesi`
Atteso: stampa i due numeri e crea `src/lib/deriva-schema-attesi.json`.
⚠️ Riporta i due numeri nel messaggio di commit: servono a chi rivede.

- [ ] **Step 5: Lancia il test e verifica che PASSI**

Run: `npx vitest run src/lib/deriva-schema-attesi.test.ts`
Atteso: PASS, 3 test.

- [ ] **Step 6: Mutazione — il test di freschezza morde?**

Crea `supabase/migrations/9999-99-99-finta.sql` con dentro
`ALTER TABLE procedures ADD COLUMN IF NOT EXISTS colonna_finta_di_prova text;`
Run: `npx vitest run src/lib/deriva-schema-attesi.test.ts` → atteso **FAIL** su «e FRESCO».
Poi **cancella il file finto** e rilancia: PASS. Verifica con `ls supabase/migrations/ | grep -c 9999` che sia sparito (atteso `0`).

- [ ] **Step 7: Commit**

```bash
git add scripts/genera-attesi-schema.ts src/lib/deriva-schema-attesi.json src/lib/deriva-schema-attesi.test.ts package.json
git commit -m "l-elenco degli oggetti attesi e generato, e un test lo tiene fresco"
```

---

### Task 4: La fotografia dello schema vero

**Files:**
- Create: `supabase/migrations/2026-09-14-fotografia-schema.sql`
- Create: `src/lib/deriva-schema-db.ts`
- Test: `src/lib/deriva-schema-db.test.ts`

**Interfaces:**
- Consumes: `Fotografia` dal Task 2.
- Produces:
  ```ts
  export type EsitoFotografia =
    | { ok: true; foto: Fotografia }
    | { ok: false; errore: string }

  export async function fotografaSchema(): Promise<EsitoFotografia>
  ```

> ⚠️ **Perché serve una funzione Postgres:** il client Supabase non può leggere `information_schema` né `pg_catalog` — PostgREST espone solo gli schemi dichiarati (`public`). La fotografia si prende con una `rpc`.
> ⚠️ **Questa migrazione è essa stessa soggetta alla deriva che cura.** Se la funzione mancasse, `fotografaSchema()` deve tornare `{ ok: false }` — **mai** una fotografia vuota, che il confronto leggerebbe come «manca tutto» o, peggio, come «tutto a posto». È il caso limite più pericoloso del lavoro.

- [ ] **Step 1: Scrivi il file di migrazione**

```sql
-- supabase/migrations/2026-09-14-fotografia-schema.sql
-- La fotografia dello schema, per il guardiano della deriva repo↔database.
--
-- Serve perche' PostgREST espone solo gli schemi dichiarati: il client non
-- puo' leggere information_schema. Sola lettura, e solo per il service_role:
-- la forma del proprio schema non e' una cosa che si racconta a chi passa.

CREATE OR REPLACE FUNCTION public.fotografia_schema()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT jsonb_build_object(
    'tabelle', (
      SELECT coalesce(jsonb_agg(table_name ORDER BY table_name), '[]'::jsonb)
      FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ),
    'colonne', (
      SELECT coalesce(jsonb_agg(table_name || '.' || column_name ORDER BY table_name, column_name), '[]'::jsonb)
      FROM information_schema.columns WHERE table_schema = 'public'
    ),
    'chiaviPrimarie', (
      SELECT coalesce(jsonb_object_agg(t.tabella, t.colonne), '{}'::jsonb) FROM (
        SELECT c.conrelid::regclass::text AS tabella,
               jsonb_agg(a.attname ORDER BY a.attname) AS colonne
        FROM pg_constraint c
        JOIN pg_class cl ON cl.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
        JOIN unnest(c.conkey) AS k(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.contype = 'p'
        GROUP BY c.conrelid
      ) t
    ),
    'indici', (
      SELECT coalesce(jsonb_agg(indexname ORDER BY indexname), '[]'::jsonb)
      FROM pg_indexes WHERE schemaname = 'public'
    ),
    'chiaviConfig', (
      SELECT coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb) FROM public.cervellone_config
    )
  );
$$;

REVOKE EXECUTE ON FUNCTION public.fotografia_schema() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fotografia_schema() TO service_role;
```

⚠️ **Non applicarla.** Codex non tocca il database di produzione: ad applicarla è Claude, con `apply_migration`.

- [ ] **Step 2: Scrivi il test che fallisce**

```ts
// src/lib/deriva-schema-db.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rpc = vi.fn()
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer: () => ({ rpc }) }))

import { fotografaSchema } from './deriva-schema-db'

beforeEach(() => rpc.mockReset())

describe('fotografaSchema — e se non riesce, LO DICE', () => {
  it('traduce la risposta della rpc in una Fotografia', async () => {
    rpc.mockResolvedValue({
      data: {
        tabelle: ['procedures'],
        colonne: ['procedures.output_preferences'],
        chiaviPrimarie: { gmail_processed_messages: ['bot_action', 'message_id'] },
        indici: ['idx_x'],
        chiaviConfig: ['working_memory_enabled'],
      },
      error: null,
    })

    const e = await fotografaSchema()
    expect(e.ok).toBe(true)
    if (e.ok) expect(e.foto.colonne).toContain('procedures.output_preferences')
  })

  it('🚨 se la rpc fallisce NON torna una fotografia vuota: torna un ERRORE', async () => {
    // Il caso limite piu' pericoloso: una fotografia vuota il confronto la
    // leggerebbe come «manca tutto» — o, con un parser a zero oggetti, come
    // «tutto a posto». Un guardiano che tace quando non riesce a guardare fa
    // credere che qualcuno controlli.
    rpc.mockResolvedValue({ data: null, error: { message: 'function public.fotografia_schema() does not exist' } })

    const e = await fotografaSchema()
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.errore).toContain('fotografia_schema')
  })

  it('🚨 anche una risposta VUOTA o malformata e un errore, non una fotografia', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    expect((await fotografaSchema()).ok).toBe(false)

    rpc.mockResolvedValue({ data: { tabelle: 'non-un-array' }, error: null })
    expect((await fotografaSchema()).ok).toBe(false)
  })

  it('la rpc che solleva non fa esplodere il chiamante', async () => {
    rpc.mockRejectedValue(new Error('rete giu'))
    const e = await fotografaSchema()
    expect(e.ok).toBe(false)
  })
})
```

- [ ] **Step 3: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/deriva-schema-db.test.ts`
Atteso: FAIL — modulo non trovato.

- [ ] **Step 4: Implementa**

```ts
// src/lib/deriva-schema-db.ts
/**
 * L'unico pezzo del guardiano che parla col database.
 *
 * Il client Supabase non puo' leggere `information_schema`: PostgREST espone
 * solo gli schemi dichiarati. La fotografia arriva da `public.fotografia_schema()`
 * (migrazione 2026-09-14), di sola lettura e concessa al solo service_role.
 */
import { getSupabaseServer } from '@/lib/supabase-server'
import type { Fotografia } from './deriva-schema'

export type EsitoFotografia =
  | { ok: true; foto: Fotografia }
  | { ok: false; errore: string }

function elencoDiStringhe(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null
}

export async function fotografaSchema(): Promise<EsitoFotografia> {
  try {
    const { data, error } = await getSupabaseServer().rpc('fotografia_schema')
    if (error) return { ok: false, errore: `fotografia_schema: ${error.message}` }
    if (!data || typeof data !== 'object') {
      return { ok: false, errore: 'fotografia_schema ha risposto senza dati: NON so dire se il database sia allineato.' }
    }

    const d = data as Record<string, unknown>
    const tabelle = elencoDiStringhe(d.tabelle)
    const colonne = elencoDiStringhe(d.colonne)
    const indici = elencoDiStringhe(d.indici)
    const chiaviConfig = elencoDiStringhe(d.chiaviConfig)
    const pk = d.chiaviPrimarie

    if (!tabelle || !colonne || !indici || !chiaviConfig || !pk || typeof pk !== 'object') {
      // Malformata = non guardata. Non si degrada a una fotografia parziale:
      // il confronto la leggerebbe come deriva, e sarebbe un falso allarme che
      // a lungo andare fa ignorare il guardiano.
      return { ok: false, errore: 'fotografia_schema ha risposto in una forma che non riconosco: NON so dire se il database sia allineato.' }
    }

    const chiaviPrimarie: Record<string, string[]> = {}
    for (const [tabella, colonneVoce] of Object.entries(pk as Record<string, unknown>)) {
      const c = elencoDiStringhe(colonneVoce)
      if (c) chiaviPrimarie[tabella.replace(/^public\./, '')] = c
    }

    return { ok: true, foto: { tabelle, colonne, chiaviPrimarie, indici, chiaviConfig } }
  } catch (e) {
    return { ok: false, errore: `fotografia_schema non raggiungibile: ${e instanceof Error ? e.message : String(e)}` }
  }
}
```

- [ ] **Step 5: Lancia e verifica che PASSI**

Run: `npx vitest run src/lib/deriva-schema-db.test.ts`
Atteso: PASS, 4 test.

- [ ] **Step 6: Mutazione**

Sostituisci il primo `return { ok: false, errore: ... }` con `return { ok: true, foto: { tabelle: [], colonne: [], chiaviPrimarie: {}, indici: [], chiaviConfig: [] } }` (cioè: la fotografia vuota che il design vieta).
Run: `npx vitest run src/lib/deriva-schema-db.test.ts` → atteso FAIL. Ripristina, rilancia, PASS.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/2026-09-14-fotografia-schema.sql src/lib/deriva-schema-db.ts src/lib/deriva-schema-db.test.ts
git commit -m "la fotografia dello schema, e un guardiano che dice quando non ha potuto guardare"
```

---

### Task 5: Il tool `verifica_deriva_schema`

**Files:**
- Create: `src/lib/tools/deriva-schema-tools.ts`
- Test: `src/lib/tools/deriva-schema-tools.test.ts`
- Modify: `src/lib/tools.ts` (import riga ~39, `ALL_TOOLS` riga ~802, `EXECUTORS` riga ~934)

**Interfaces:**
- Consumes: `oggettiAttesi`/`confronta`/`descriviDeriva` (Task 1-2), `deriva-schema-attesi.json` (Task 3), `fotografaSchema` (Task 4).
- Produces: `export const DERIVA_TOOLS: ToolDefinition[]`, `export async function executeDerivaTools(name: string, input: Record<string, unknown>): Promise<string | null>`

> Un **tool** e non un comando slash: `getToolDefinitions()` non conosce i canali, quindi un tool nasce equipollente su Telegram e sulla chat web **per costruzione**. Modello da imitare: `src/lib/tools/automazioni.ts:220-246`.

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// src/lib/tools/deriva-schema-tools.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fotografaSchema = vi.fn()
vi.mock('@/lib/deriva-schema-db', () => ({ fotografaSchema }))

import { DERIVA_TOOLS, executeDerivaTools } from './deriva-schema-tools'

beforeEach(() => fotografaSchema.mockReset())

describe('verifica_deriva_schema', () => {
  it('il tool e dichiarato una volta sola e ha un nome stabile', () => {
    expect(DERIVA_TOOLS.map((t) => t.name)).toEqual(['verifica_deriva_schema'])
  })

  it('non risponde ai nomi che non sono suoi', async () => {
    expect(await executeDerivaTools('altro_tool', {})).toBeNull()
  })

  it('🚨 se la fotografia fallisce, il tool DICE che non ha potuto guardare', async () => {
    fotografaSchema.mockResolvedValue({ ok: false, errore: 'fotografia_schema: does not exist' })

    const testo = await executeDerivaTools('verifica_deriva_schema', {})

    expect(testo).toContain('NON')
    expect(testo).toContain('fotografia_schema')
    // E soprattutto: non deve MAI dire che va tutto bene.
    expect(testo?.toLowerCase()).not.toContain('nessuna deriva')
  })

  it('CONTROLLO POSITIVO: con una fotografia completa risponde e riporta i due numeri', async () => {
    // Costruita dagli attesi veri: qualunque cosa il repo prometta oggi, c-e.
    const ATTESI = (await import('@/lib/deriva-schema-attesi.json')).default
    const foto = {
      tabelle: [] as string[], colonne: [] as string[],
      chiaviPrimarie: {} as Record<string, string[]>, indici: [] as string[], chiaviConfig: [] as string[],
    }
    for (const o of ATTESI.oggetti as Array<Record<string, never>>) {
      const x = o as unknown as { tipo: string; tabella?: string; colonna?: string; nome?: string; chiave?: string; colonne?: string[] }
      if (x.tipo === 'tabella') foto.tabelle.push(x.tabella!)
      if (x.tipo === 'colonna') foto.colonne.push(`${x.tabella}.${x.colonna}`)
      if (x.tipo === 'indice') foto.indici.push(x.nome!)
      if (x.tipo === 'config') foto.chiaviConfig.push(x.chiave!)
      if (x.tipo === 'chiave_primaria') foto.chiaviPrimarie[x.tabella!] = x.colonne!
    }
    fotografaSchema.mockResolvedValue({ ok: true, foto })

    const testo = await executeDerivaTools('verifica_deriva_schema', {})

    expect(testo).toContain('Nessuna deriva')
    expect(testo?.toLowerCase()).toContain('non interpretat')
  })
})
```

- [ ] **Step 2: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/tools/deriva-schema-tools.test.ts`
Atteso: FAIL — modulo non trovato.

- [ ] **Step 3: Implementa**

```ts
// src/lib/tools/deriva-schema-tools.ts
/**
 * Il tool con cui Cervellone sa dire se il proprio database e' allineato al
 * repository.
 *
 * Nasce il 14 settembre 2026, il giorno in cui si e' scoperto che cinque
 * migrazioni su 43 non erano mai state applicate — e che due di quelle
 * reggevano codice vivo, da mesi, in silenzio.
 *
 * Un tool e non un comando slash: `getToolDefinitions()` non conosce i canali,
 * quindi nasce equipollente su Telegram e sulla chat web per costruzione.
 */
import type { ToolDefinition } from './types'
import { confronta, descriviDeriva, type OggettiAttesi } from '@/lib/deriva-schema'
import { fotografaSchema } from '@/lib/deriva-schema-db'
import ATTESI from '@/lib/deriva-schema-attesi.json'

export const DERIVA_TOOLS: ToolDefinition[] = [
  {
    name: 'verifica_deriva_schema',
    description:
      'Dice se il database di produzione ha davvero tutto quello che le migrazioni del repository promettono: tabelle, colonne, chiavi primarie, indici e chiavi di configurazione. USALO quando l Ingegnere chiede "il database e allineato?", quando una funzione sembra non salvare o non leggere niente senza un motivo, o quando un errore parla di una colonna che non esiste. Il 14 settembre 2026 cinque migrazioni su 43 risultavano mai applicate e due reggevano codice vivo da mesi, senza che nessuno se ne accorgesse. RIPORTA SEMPRE ANCHE il numero di statement che il controllo non sa interpretare: quel numero dice quanto NON e stato guardato, e senza di esso "nessuna deriva" non significa niente. Se il controllo dice che non e riuscito a guardare, DILLO cosi com e: non e la stessa cosa di "va tutto bene".',
    input_schema: { type: 'object', properties: {} },
  },
]

export async function executeDerivaTools(
  name: string,
  _input: Record<string, unknown>,
): Promise<string | null> {
  if (name !== 'verifica_deriva_schema') return null

  const esito = await fotografaSchema()
  if (!esito.ok) {
    // Non si degrada in «nessuna deriva»: un guardiano che tace quando non
    // riesce a guardare fa credere che qualcuno stia controllando.
    return `NON sono riuscito a leggere la forma del database, quindi NON so dire se sia allineato al repository.\nMotivo: ${esito.errore}`
  }

  const deriva = confronta(ATTESI as unknown as OggettiAttesi, esito.foto)
  return descriviDeriva(deriva)
}
```

- [ ] **Step 4: Lancia e verifica che PASSI**

Run: `npx vitest run src/lib/tools/deriva-schema-tools.test.ts`
Atteso: PASS, 4 test.

- [ ] **Step 5: Collega il tool al registro**

In `src/lib/tools.ts`, tre modifiche puntuali:

1. accanto agli altri import (vicino alla riga 39):
```ts
import { DERIVA_TOOLS, executeDerivaTools } from './tools/deriva-schema-tools'
```
2. dentro `const ALL_TOOLS: ToolDefinition[] = [` (riga ~802), in coda alle altre voci:
```ts
  ...DERIVA_TOOLS, // 2026-09-14: il database e' davvero allineato al repo?
```
3. dentro `const EXECUTORS = [` (riga ~934), aggiungi `executeDerivaTools` all'elenco.

- [ ] **Step 6: Verifica il collegamento**

Run: `npx tsc --noEmit` → atteso exit 0.
Run: `npx vitest run` → atteso: suite intera verde, e il numero dei test **cresciuto** rispetto a prima.
⚠️ Se esistono test che contano i tool o ne fissano l'elenco, andranno aggiornati: leggi il fallimento, non forzarlo.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tools/deriva-schema-tools.ts src/lib/tools/deriva-schema-tools.test.ts src/lib/tools.ts
git commit -m "un tool per chiedere se il database e allineato al repo"
```

---

### Task 6: La deriva nel rapporto settimanale

**Files:**
- Create: `src/lib/audit-deriva.ts`
- Test: `src/lib/audit-deriva.test.ts`
- Modify: `src/lib/audit-runner.ts` (dentro `runAudit`, riga 76, dove si compone `report_text`)

**Interfaces:**
- Consumes: `executeDerivaTools` (Task 5).
- Produces: `export async function sezioneDeriva(): Promise<string>` — una sezione intestata `— Deriva fra repository e database —`.

> ⚠️ **Perché in `audit-runner.ts` e NON nella rotta del cron.** `runAudit()` compone `report_text` **e lo salva** in `cervellone_audit_runs` prima di tornare; la rotta (`self-audit/route.ts:132`) si limita a consegnare `result.report_text`. Accodare la sezione nella rotta farebbe divergere la copia consegnata da quella archiviata: due fonti per lo stesso rapporto, che in questo repo è il difetto che torna sempre. La sezione entra dove il rapporto nasce.
>
> Il cron gira `0 6 * * 1` (lunedì alle 6), e dall'11 settembre **consegna davvero**. La sezione c'è **anche quando la deriva è zero**: un sorvegliante che parla solo quando c'è un guasto è indistinguibile da uno morto.

- [ ] **Step 1: Scrivi il test che fallisce**

```ts
// src/lib/audit-deriva.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const executeDerivaTools = vi.fn()
vi.mock('@/lib/tools/deriva-schema-tools', () => ({ executeDerivaTools, DERIVA_TOOLS: [] }))

import { sezioneDeriva } from './audit-deriva'

beforeEach(() => executeDerivaTools.mockReset())

describe('self-audit — la sezione sulla deriva', () => {
  it('🚨 c-e ANCHE quando non c-e nessuna deriva', async () => {
    // Un sorvegliante che parla solo quando c-e un guasto e- indistinguibile
    // da uno morto: e- il difetto che ha tenuto sei rapporti di autodiagnosi
    // nel cassetto per sei settimane.
    executeDerivaTools.mockResolvedValue('Nessuna deriva: 40 oggetti del repo sono presenti nel database.\nStatement non interpretati dal controllo: 12.')

    const s = await sezioneDeriva()

    expect(s).toContain('Deriva fra repository e database')
    expect(s).toContain('Nessuna deriva')
    expect(s).toContain('12')
  })

  it('riporta la deriva quando c-e', async () => {
    executeDerivaTools.mockResolvedValue('DERIVA: 3 oggetti su 40 promessi dal repo NON esistono nel database.')
    expect(await sezioneDeriva()).toContain('DERIVA: 3 oggetti')
  })

  it('se il controllo esplode, il rapporto lo DICE e non salta la sezione', async () => {
    executeDerivaTools.mockRejectedValue(new Error('rete giu'))

    const s = await sezioneDeriva()

    expect(s).toContain('Deriva fra repository e database')
    expect(s.toLowerCase()).toContain('non')
    expect(s).not.toContain('Nessuna deriva')
  })
})
```

- [ ] **Step 2: Lancia e verifica che FALLISCA**

Run: `npx vitest run src/lib/audit-deriva.test.ts`
Atteso: FAIL — modulo `./audit-deriva` non trovato.

- [ ] **Step 3: Implementa**

Crea `src/lib/audit-deriva.ts`:

```ts
// src/lib/audit-deriva.ts
import { executeDerivaTools } from '@/lib/tools/deriva-schema-tools'

/**
 * La deriva fra quello che il repository promette e quello che il database ha.
 *
 * La sezione c'e' SEMPRE, anche a deriva zero: un sorvegliante che parla solo
 * quando c'e' un guasto e' indistinguibile da uno morto — ed e' esattamente il
 * difetto che ha tenuto sei rapporti di autodiagnosi nel cassetto.
 */
export async function sezioneDeriva(): Promise<string> {
  const intestazione = '— Deriva fra repository e database —'
  try {
    const testo = await executeDerivaTools('verifica_deriva_schema', {})
    return `${intestazione}\n${testo ?? 'il controllo non ha risposto niente.'}`
  } catch (e) {
    return `${intestazione}\nNON sono riuscito a fare il controllo: ${e instanceof Error ? e.message : String(e)}`
  }
}
```

Poi, in `src/lib/audit-runner.ts`, dentro `runAudit()` (riga 76): **prima** che il rapporto venga
salvato in `cervellone_audit_runs` e messo in `report_text`, accoda la sezione al testo del
rapporto — così la copia archiviata e quella consegnata sono la stessa cosa.

```ts
import { sezioneDeriva } from './audit-deriva'
// …dove il testo del rapporto è ormai composto, prima del salvataggio:
const testoRapporto = `${testoRapporto}\n\n${await sezioneDeriva()}`
```

⚠️ `testoRapporto` è un segnaposto per **la variabile vera di quel file**: aprila e leggila, non
indovinare il nome. Se il rapporto viene costruito come array di righe, accoda la sezione a quello.

- [ ] **Step 4: Lancia e verifica che PASSI**

Run: `npx vitest run src/lib/audit-deriva.test.ts`
Atteso: PASS, 3 test.

Poi verifica che il rapporto la porti davvero, con i test già esistenti dell'audit-runner:
Run: `npx vitest run src/lib/audit-runner.test.ts`
⚠️ Quei test asseriscono su `report_text` (`audit-runner.test.ts:149,173,187`): se ora falliscono
perché il testo è cambiato, **leggi il fallimento e aggiornali di proposito** — non allentare
l'asserzione per farla passare.

- [ ] **Step 5: Mutazione**

Nella `sezioneDeriva`, sostituisci il blocco `catch` con `return ''` (cioè: se esplode, la sezione sparisce).
Run: il test → atteso FAIL su «se il controllo esplode». Ripristina, rilancia, PASS.

- [ ] **Step 6: Verifica finale e commit**

```bash
npx tsc --noEmit
npx vitest run
git add src/lib/audit-deriva.ts src/lib/audit-deriva.test.ts src/lib/audit-runner.ts src/lib/audit-runner.test.ts
git commit -m "il rapporto settimanale dice anche se il database ha derivato"
```

Atteso: typecheck exit 0, suite intera verde. **Riporta i numeri veri nel messaggio della PR**: quanti test prima, quanti dopo.

- [ ] **Step 7: Apri la PR**

Descrizione della PR — quello che Claude deve poter leggere senza aprire il codice:
cosa è stato fatto, file toccati, esito di `npx tsc --noEmit` e `npx vitest run` (numeri veri),
**l'esito di ogni mutazione** (quale, quanti rossi, ripristinata sì/no), e i due numeri
dello script `genera:attesi` (oggetti attesi, statement non interpretati). Dubbi e decisioni prese.

---

## Cosa fa Claude, non Codex

1. **Applicare la migrazione** `2026-09-14-fotografia-schema.sql` in produzione con `apply_migration` (Codex non tocca il database).
2. **Il controllo positivo sul campo**, che è la prova che tutto questo serve a qualcosa: al primo giro vero il guardiano **deve ritrovare le tre migrazioni inerti già note** — `2026-05-07-gmail-classification` (tabella `cervellone_gmail_categorie`, indice `idx_gmail_categorie_enabled`, chiave `gmail_classify_last_run`), `2026-05-09-v19-foundation` (`agent_runs`, `sub_agent_jobs`, `document_renders`, `e2b_sandboxes`), `2026-05-09-v19-memories-bucket`. **Se dice «nessuna deriva», è rotto** — perché la deriva oggi c'è, e la conosciamo nome per nome.
3. **Audit avversariale** prima del merge, come il 14 settembre mattina.
