/**
 * src/lib/tools/delega-tools.test.ts — la porta del coordinatore.
 *
 * ⚠️ **La cosa che questi test proteggono non è l'interruttore: è quello che il
 * coordinatore fa quando l'interruttore è spento.**
 *
 * Un rifiuto secco («non disponibile») farebbe rispondere all'Ingegnere «non
 * posso farlo» — la frase che questo progetto combatte da mesi — mentre gli
 * attrezzi per farlo da solo il coordinatore ce li ha tutti. Un interruttore
 * spento deve togliere una scorciatoia, mai una capacità.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockDelega = vi.fn()
/**
 * ⚠️ Fabbrica ESPLICITA, senza `importOriginal`.
 *
 * La prima stesura faceva `const actual = await orig()` per poi spanderlo. Il
 * modulo vero (`delega.ts`) tira dentro `claude.ts`, che tira dentro l'intero
 * registro dei tool: il caricamento superava i 5 secondi di timeout **solo
 * quando la suite gira intera**, e allora il mock non era pronto, partiva la
 * `delega` VERA e il test falliva con `cosa_ho_provato: []` — che e' proprio
 * quello che restituisce il catch della funzione vera.
 *
 * Il sintomo peggiore possibile: verde da solo, rosso nella suite. Trovato il
 * 13 set 2026 facendo girare la suite intera dopo averlo provato isolato.
 */
vi.mock('../delega', () => ({
  delega: (...a: unknown[]) => mockDelega(...a),
  perimetroDiLavoro: () => new Set(['fic_fatture_ricevute']),
}))
/**
 * Registro finto con DUE porte: serve a provare che l'instradamento è
 * derivato e non un `if` sul nome della contabile.
 */
// ⚠️ `vi.hoisted`: `vi.mock` viene issato in cima al file, prima delle `const`.
// Senza, il mock esplode con «Cannot access before initialization».
const { CONTABILE, GEOMETRA } = vi.hoisted(() => ({
  CONTABILE: {
    chiave: 'contabile',
    nome: 'la contabile',
    dominio: 'Contabilita e fatture',
    quando: 'fatture, pagamenti, prima nota',
    porta: { tool: 'chiedi_alla_contabile', usala_per: 'fatture pagate e non pagate' },
    toolDalNucleo: [] as string[],
  },
  GEOMETRA: {
    chiave: 'geometra',
    nome: 'il geometra',
    dominio: 'Studio tecnico',
    quando: 'prezzari, preventivi, computi',
    porta: { tool: 'chiedi_al_geometra', usala_per: 'prezzari e computi metrici' },
    toolDalNucleo: [] as string[],
  },
}))
vi.mock('../specialisti', () => ({
  specialista: () => CONTABILE,
  specialistiConPorta: () => [CONTABILE, GEOMETRA],
  specialistaDellaPorta: (n: string) => [CONTABILE, GEOMETRA].find((s) => s.porta.tool === n),
}))
vi.mock('../prompts', () => ({ getPromptSpecialista: () => 'prompt-finto' }))
const societaAttivaFinta = vi.fn()
vi.mock('../societa-attiva', () => ({
  leggiSocietaAttiva: (...a: unknown[]) => societaAttivaFinta(...a),
}))
vi.mock('../societa', () => ({
  listaSocieta: () => [
    { codice: 'restruktura', denominazione: 'Restruktura Srl' },
    { codice: 'la_real_estate', denominazione: 'La Real Estate Srl' },
  ],
}))

import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

import { DELEGA_TOOLS, executeDelegaTool, decolloAcceso } from './delega-tools'

/** La radice di `src/`, per sciogliere l'alias `@/`. */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Segue gli import STATICI a runtime (non i `import type`, che spariscono a
 * compilazione, e non i `await import()`, che è proprio la cura al ciclo) e
 * restituisce tutti i file raggiungibili.
 *
 * Volutamente semplice: legge i sorgenti con una regex invece di usare il
 * compilatore. Se un giorno non bastasse, il sintomo sarebbe un falso VERDE —
 * quindi il controllo positivo qui sotto, che pretende di arrivare davvero a
 * `tools.ts` partendo da un file che ci porta, non è un di più: è quello che
 * distingue «non c'è il ciclo» da «non ho guardato».
 */
function camminaGrafo(partenza: string, visti = new Set<string>()): Set<string> {
  if (visti.has(partenza) || !existsSync(partenza)) return visti
  visti.add(partenza)
  const sorgente = readFileSync(partenza, 'utf8')
  const righe = sorgente
    .split(/\r?\n/)
    .filter((r) => /^\s*import\s/.test(r) && !/^\s*import\s+type\s/.test(r))
  for (const riga of righe) {
    const m = riga.match(/from\s+['"]([^'"]+)['"]/)
    if (!m) continue
    const spec = m[1]
    let base: string
    if (spec.startsWith('@/')) base = resolve(SRC, spec.slice(2))
    else if (spec.startsWith('.')) base = resolve(dirname(partenza), spec)
    else continue // pacchetto di node_modules: non può riportare qui
    for (const cand of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
      if (existsSync(cand)) { camminaGrafo(cand, visti); break }
    }
  }
  return visti
}

beforeEach(() => {
  mockDelega.mockReset()
  mockDelega.mockResolvedValue({ ok: true, risposta: 'due fatture', azioni_fatte: ['fic_fatture_ricevute'] })
  societaAttivaFinta.mockReset()
  societaAttivaFinta.mockResolvedValue({ ok: true, codice: 'restruktura', esplicita: true })
  delete process.env.DECOLLO
})
afterEach(() => {
  delete process.env.DECOLLO
})

describe("l'interruttore: spento di default, come TOOL_DEFER", () => {
  it('spento senza la variabile', () => {
    expect(decolloAcceso()).toBe(false)
  })

  it("acceso SOLO con '1' esatto: 'true' e 'si' non bastano", () => {
    process.env.DECOLLO = 'true'
    expect(decolloAcceso()).toBe(false)
    process.env.DECOLLO = '1'
    expect(decolloAcceso()).toBe(true)
  })

  it('⚠️ i tool restano nel registro anche da SPENTO', () => {
    // Un tool che compare e scompare a seconda di una variabile d'ambiente
    // sfuggirebbe a qualunque guardia che legge il registro: si spegnerebbe la
    // sorveglianza insieme alla funzione, che e' il modo in cui un
    // interruttore diventa un buco.
    expect(DELEGA_TOOLS.map((t) => t.name)).toEqual(['chiedi_alla_contabile', 'chiedi_al_geometra'])
  })

  it('⭐ le porte sono GENERATE dal registro: il secondo specialista costa una riga', () => {
    // Il punto del passo 5. Non «un secondo specialista scritto a mano», ma la
    // prova che il secondo costa quanto una riga: la definizione, il testo che
    // il modello legge e l'instradamento vengono tutti dal registro.
    //
    // Con una copia per specialista, la seconda porta sarebbe nata gia'
    // disallineata dalla prima — lo stesso marciume che `specialisti.ts`
    // esiste per impedire, un piano piu' in basso.
    const perNome = Object.fromEntries(DELEGA_TOOLS.map((t) => [t.name, t.description]))
    // Le parti che valgono per TUTTI compaiono in TUTTE, identiche.
    for (const d of Object.values(perNome)) {
      expect(d).toMatch(/IDENTIFICATIVI esatti/)
      expect(d).toMatch(/PREPARA ma non esegue/)
      expect(d).toMatch(/societa' ATTIVA/)
    }
    // E quello che cambia e' solo il mestiere.
    expect(perNome['chiedi_alla_contabile']).toMatch(/la contabile/)
    expect(perNome['chiedi_alla_contabile']).toMatch(/fatture pagate e non pagate/)
    expect(perNome['chiedi_al_geometra']).toMatch(/il geometra/)
    expect(perNome['chiedi_al_geometra']).toMatch(/prezzari e computi metrici/)
  })

  it("⭐ l'instradamento e' derivato: la porta del geometra NON finisce alla contabile", async () => {
    // Un `if (name === 'chiedi_alla_contabile')` sarebbe la terza copia dello
    // stesso elenco, e la terza copia e' quella che un giorno resta indietro.
    process.env.DECOLLO = '1'
    await executeDelegaTool('chiedi_al_geometra', { compito: 'computo' }, 'conv-1')
    const [chi] = mockDelega.mock.calls[0]
    expect(chi.chiave).toBe('geometra')
  })

  it('da spento NON delega: la contabile non viene nemmeno svegliata', async () => {
    await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' }, 'conv-1')
    expect(mockDelega).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO — da acceso delega davvero', async () => {
    // Senza, il test sopra passerebbe anche se `delega` non venisse chiamata
    // MAI, in nessuna condizione.
    process.env.DECOLLO = '1'
    await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' }, 'conv-1')
    expect(mockDelega).toHaveBeenCalled()
  })
})

describe('⭐ un interruttore spento toglie una scorciatoia, non una capacita', () => {
  it("da spento il rifiuto dice al coordinatore DI FARLO LUI", async () => {
    const risposta = JSON.parse((await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' }, 'conv-1'))!)
    expect(risposta.ok).toBe(false)
    expect(risposta.cosa_faccio_adesso).toMatch(/Fai tu il lavoro/i)
    // La riga che conta: senza, il coordinatore riferirebbe «non si puo'» —
    // mentre gli attrezzi per farlo li ha tutti.
    expect(risposta.cosa_faccio_adesso).toMatch(/Non dire che non si puo/i)
  })

  it('anche un FALLIMENTO della contabile dice al coordinatore cosa fare', async () => {
    process.env.DECOLLO = '1'
    mockDelega.mockResolvedValue({
      ok: false,
      motivo: 'la contabile si è fermata a metà',
      cosa_ho_provato: ['fic_fatture_ricevute'],
    })
    const risposta = JSON.parse((await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' }, 'conv-1'))!)
    expect(risposta.ok).toBe(false)
    // `cosa_ho_provato` deve sopravvivere fino al coordinatore: e' la meta' che
    // gli permette di riferire qualcosa di utile invece di un muro.
    expect(risposta.cosa_ho_provato).toEqual(['fic_fatture_ricevute'])
    expect(risposta.cosa_faccio_adesso).toMatch(/Riprova tu/i)
    expect(risposta.cosa_faccio_adesso).toMatch(/mai un "non si puo/i)
  })

  it("su un successo NON si aggiunge nessuna istruzione: non serve", async () => {
    process.env.DECOLLO = '1'
    const risposta = JSON.parse((await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' }, 'conv-1'))!)
    expect(risposta.ok).toBe(true)
    expect(risposta.cosa_faccio_adesso).toBeUndefined()
  })
})

describe('gli identificativi passano, la descrizione lo pretende', () => {
  it('riferimenti e conversazione arrivano alla delega', async () => {
    process.env.DECOLLO = '1'
    await executeDelegaTool(
      'chiedi_alla_contabile',
      { compito: 'segnale pagate', riferimenti: ['2/1144', '2/1145'] },
      'conv-1',
    )
    const [, incarico] = mockDelega.mock.calls[0]
    expect(incarico.riferimenti).toEqual(['2/1144', '2/1145'])
    expect(incarico.conversationId).toBe('conv-1')
  })

  it("🚨 la societa NON e un parametro: si LEGGE dalla conversazione", async () => {
    // Bloccante trovato dall'audit del 13 set 2026. Un parametro `societa` non
    // commutava NIENTE: gli attrezzi della contabile passano dal wrapper
    // `contabile()`, che ricava la societa' dalla CONVERSAZIONE e non guarda
    // mai l'input. Il coordinatore avrebbe potuto scrivere «La Real Estate»,
    // la contabile leggere Restruktura, e riferirle come La Real Estate —
    // senza che se ne accorgesse nessuno.
    //
    // Ora la societa' si legge dalla stessa fonte che useranno i suoi
    // attrezzi: quello che le si dice e quello che leggera' non possono
    // divergere.
    expect(Object.keys((DELEGA_TOOLS[0].input_schema as { properties: object }).properties)).toEqual([
      'compito',
      'riferimenti',
    ])
    process.env.DECOLLO = '1'
    await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' }, 'conv-1')
    const [, incarico] = mockDelega.mock.calls[0]
    expect(incarico.societa).toBe('Restruktura Srl')
  })

  it('senza conversazione NON si delega: si direbbe dieci volte «non so su quale societa»', async () => {
    // TUTTI gli attrezzi della contabile passano dal wrapper `contabile()`,
    // che senza conversationId rifiuta uno per uno. Delegare lo stesso
    // brucerebbe un turno intero — modello, token, secondi — per farsi dire
    // dieci volte la stessa cosa. Rilevato dall'audit del 13 set 2026.
    process.env.DECOLLO = '1'
    // ⚠️ Terzo argomento OMESSO di proposito: è il punto del test.
    const r = JSON.parse((await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' }))!)
    expect(r.ok).toBe(false)
    expect(mockDelega).not.toHaveBeenCalled()
    // E non si scomoda nemmeno il database.
    expect(societaAttivaFinta).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO — se la societa NON si legge, NON si delega', async () => {
    // Un lavoro contabile sulla societa' sbagliata e' peggio di un lavoro non
    // fatto. E senza questo controllo il test sopra proverebbe solo che una
    // lettura riuscita funziona.
    process.env.DECOLLO = '1'
    societaAttivaFinta.mockResolvedValue({ ok: false, errore: 'tabella non leggibile' })
    const r = JSON.parse((await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' }, 'conv-1'))!)
    expect(r.ok).toBe(false)
    expect(r.motivo).toMatch(/quale societa/i)
    expect(mockDelega).not.toHaveBeenCalled()
  })

  it("la descrizione dice che si lavora sulla societa ATTIVA e come cambiarla", () => {
    const d = DELEGA_TOOLS[0].description
    expect(d).toMatch(/societa' ATTIVA/)
    expect(d).toMatch(/imposta_societa_attiva/)
  })

  it("la descrizione VIETA le descrizioni tipo 'quelle di prima'", () => {
    // E' la regola che impedisce l'insieme sbagliato: senza gli id, la
    // contabile rifarebbe la ricerca e potrebbe trovare fatture diverse da
    // quelle che il coordinatore aveva davanti.
    const d = DELEGA_TOOLS[0].description
    expect(d).toMatch(/IDENTIFICATIVI esatti/)
    expect(d).toMatch(/quelle di prima/)
    expect(d).toMatch(/insieme diverso/)
  })

  it("la descrizione dice che la contabile PREPARA e non esegue", () => {
    const d = DELEGA_TOOLS[0].description
    expect(d).toMatch(/PREPARA ma non esegue/)
    expect(d).toMatch(/la conferma la chiedi TU/)
  })

  it('un altro nome di tool non lo gestisce: torna null', async () => {
    expect(await executeDelegaTool('genera_pdf', {})).toBeNull()
  })
})

describe('🚨 il ciclo di import non deve tornare', () => {
  it('nessun import STATICO di delega, claude o prompts in cima al file', async () => {
    // C'e' un ciclo: tools.ts → questo file → delega.ts → claude.ts → tools.ts.
    // Con gli import statici, al caricamento `DELEGA_TOOLS` risulta undefined
    // proprio mentre tools.ts prova a spanderlo dentro ALL_TOOLS, e il registro
    // esplode con «DELEGA_TOOLS is not iterable». Successo il 13 set 2026.
    //
    // ⚠️ E' il peggior tipo di guasto: si manifesta o no a seconda di quale
    // file viene caricato per primo. Puo' funzionare in locale e non su Vercel,
    // o funzionare per settimane e rompersi il giorno che qualcuno aggiunge un
    // import altrove.
    //
    // ⚠️ E questa guardia NON e' l'unica rete, ne' la prima a mordere — la
    // versione precedente di questo commento lo sosteneva ed era rovesciata dai
    // fatti (audit 13 set 2026). A mordere per prima e' il COMPORTAMENTO: il
    // `vi.mock('../delega')` in cima a questo file forza l'ordine di
    // caricamento cattivo, quindi rimettendo l'import statico il file esplode
    // gia' in fase di raccolta con «DELEGA_TOOLS is not iterable», e questa
    // guardia non arriva nemmeno a girare.
    //
    // Serve lo stesso, per due ragioni: dice PERCHE' con parole invece di un
    // TypeError, e regge il giorno in cui questo file smettesse di mockare
    // `../delega` — e allora l'ordine cattivo non sarebbe piu' forzato.
    const percorso = fileURLToPath(new URL('./delega-tools.ts', import.meta.url))
    const sorgente = readFileSync(percorso, 'utf8')
    // ⚠️ **SI CAMMINA IL GRAFO, non si elenca cosa è vietato.**
    //
    // Due stesure precedenti di questa guardia erano liste di nomi, e l'audit
    // del 13 set 2026 le ha aggirate: con l'alias `'@/lib/delega'` (usato in
    // 21 file di `src/lib`) e con `'../tools'`, cioè **il modulo al centro del
    // ciclo**, che la lista non nominava nemmeno. Una lista di nomi si aggira
    // cambiando grafia.
    //
    // La regola vera è una sola: **da questo file, seguendo gli import statici,
    // non si deve poter arrivare a `tools.ts`.** Quello è il ciclo, e questa è
    // l'unica formulazione che non si aggira — copre gli alias, i percorsi
    // relativi, e qualunque strada indiretta di domani.
    const raggiunti = camminaGrafo(percorso)
    const arrivo = [...raggiunti].filter((f) => /[\\/]lib[\\/]tools\.ts$/.test(f))
    expect(
      arrivo,
      `da delega-tools.ts si arriva a tools.ts: il ciclo e' tornato. Catena: ${[...raggiunti].join(' → ')}`,
    ).toEqual([])
  })

  it('CONTROLLO POSITIVO — il camminatore ARRIVA davvero a tools.ts partendo da un file che ci porta', () => {
    // La prova che il grafo viene percorso sul serio. Senza, il test sopra
    // passerebbe anche con un camminatore che non segue nessun import — ed è
    // esattamente l'errore dell'11 set 2026, un «controllo positivo» che non
    // controllava niente.
    //
    // `delega.ts` importa `claude.ts`, che importa `tools.ts`: due salti.
    const daDelega = camminaGrafo(fileURLToPath(new URL('../delega.ts', import.meta.url)))
    expect([...daDelega].some((f) => /[\\/]lib[\\/]tools\.ts$/.test(f))).toBe(true)
  })

  it(
    'il registro completo si carica davvero, e DELEGA_TOOLS c e dentro',
    async () => {
      // La prova finale, sul registro VERO: se il ciclo tornasse, questo import
      // esploderebbe come e' esploso il 13 set.
      vi.resetModules()
      const { getToolDefinitions } = await import('../tools')
      const nomi = (getToolDefinitions() as { name: string }[]).map((t) => t.name)
      expect(nomi).toContain('chiedi_alla_contabile')
    },
    // ⏱️ 30s, e non e' lentezza da nascondere: questo test compila il registro
    // INTERO da zero (`resetModules` butta la cache) — un centinaio di moduli,
    // Drive, Gmail, FIC, PDF. Il default di 5s non basta, e un timeout qui
    // verrebbe letto come «il ciclo e' tornato» invece che «il compilatore ci
    // ha messo 6 secondi»: un falso allarme sulla guardia sbagliata.
    30_000,
  )
})
