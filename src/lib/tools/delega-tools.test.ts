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
vi.mock('../specialisti', () => ({
  specialista: () => ({
    chiave: 'contabile',
    nome: 'la contabile',
    dominio: 'Contabilita e fatture',
    quando: 'fatture',
    toolDalNucleo: [],
  }),
}))
vi.mock('../prompts', () => ({ getPromptSpecialista: () => 'prompt-finto' }))

import { DELEGA_TOOLS, executeDelegaTool, decolloAcceso } from './delega-tools'

beforeEach(() => {
  mockDelega.mockReset()
  mockDelega.mockResolvedValue({ ok: true, risposta: 'due fatture', azioni_fatte: ['fic_fatture_ricevute'] })
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

  it('⚠️ il tool resta nel registro anche da SPENTO', () => {
    // Un tool che compare e scompare a seconda di una variabile d'ambiente
    // sfuggirebbe alle guardie anti-buco della mappa dell'officina: si
    // spegnerebbe la difesa insieme alla funzione, che e' il modo in cui un
    // interruttore diventa un buco.
    expect(DELEGA_TOOLS.map((t) => t.name)).toEqual(['chiedi_alla_contabile'])
  })

  it('da spento NON delega: la contabile non viene nemmeno svegliata', async () => {
    await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' })
    expect(mockDelega).not.toHaveBeenCalled()
  })

  it('CONTROLLO POSITIVO — da acceso delega davvero', async () => {
    // Senza, il test sopra passerebbe anche se `delega` non venisse chiamata
    // MAI, in nessuna condizione.
    process.env.DECOLLO = '1'
    await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' })
    expect(mockDelega).toHaveBeenCalled()
  })
})

describe('⭐ un interruttore spento toglie una scorciatoia, non una capacita', () => {
  it("da spento il rifiuto dice al coordinatore DI FARLO LUI", async () => {
    const risposta = JSON.parse((await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' }))!)
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
    const risposta = JSON.parse((await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' }))!)
    expect(risposta.ok).toBe(false)
    // `cosa_ho_provato` deve sopravvivere fino al coordinatore: e' la meta' che
    // gli permette di riferire qualcosa di utile invece di un muro.
    expect(risposta.cosa_ho_provato).toEqual(['fic_fatture_ricevute'])
    expect(risposta.cosa_faccio_adesso).toMatch(/Riprova tu/i)
    expect(risposta.cosa_faccio_adesso).toMatch(/mai un "non si puo/i)
  })

  it("su un successo NON si aggiunge nessuna istruzione: non serve", async () => {
    process.env.DECOLLO = '1'
    const risposta = JSON.parse((await executeDelegaTool('chiedi_alla_contabile', { compito: 'x' }))!)
    expect(risposta.ok).toBe(true)
    expect(risposta.cosa_faccio_adesso).toBeUndefined()
  })
})

describe('gli identificativi passano, la descrizione lo pretende', () => {
  it('riferimenti e societa arrivano alla delega', async () => {
    process.env.DECOLLO = '1'
    await executeDelegaTool(
      'chiedi_alla_contabile',
      { compito: 'segnale pagate', riferimenti: ['2/1144', '2/1145'], societa: 'Restruktura' },
      'conv-1',
    )
    const [, incarico] = mockDelega.mock.calls[0]
    expect(incarico.riferimenti).toEqual(['2/1144', '2/1145'])
    expect(incarico.societa).toBe('Restruktura')
    expect(incarico.conversationId).toBe('conv-1')
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
    // import altrove. Per questo la guardia legge il SORGENTE: un test di
    // comportamento non lo vedrebbe tornare.
    const { readFileSync } = await import('fs')
    const { fileURLToPath } = await import('url')
    const percorso = fileURLToPath(new URL('./delega-tools.ts', import.meta.url))
    const sorgente = readFileSync(percorso, 'utf8')
    const importStatici = sorgente
      .split(/\r?\n/)
      .filter((r) => /^\s*import\s/.test(r) && !/^\s*import\s+type\s/.test(r))
    const vietati = importStatici.filter((r) => /['"]\.\.\/(delega|claude|prompts|specialisti)['"]/.test(r))
    expect(
      vietati,
      `import statici che rimettono il ciclo: ${vietati.join(' | ')}`,
    ).toEqual([])
  })

  it('CONTROLLO POSITIVO — il filtro riconoscerebbe un import statico vietato', () => {
    // Senza, il test sopra passerebbe anche con una regex che non riconosce
    // niente: l'11 set 2026 un commento dichiarava «controllo positivo» un test
    // che non controllava nulla.
    const finto = "import { delega } from '../delega'"
    expect(/['"]\.\.\/(delega|claude|prompts|specialisti)['"]/.test(finto)).toBe(true)
    expect(/^\s*import\s/.test(finto)).toBe(true)
    // E NON deve morsicare gli import di tipo, che il ciclo non lo creano.
    const tipo = "import type { ToolDefinition } from './types'"
    expect(/^\s*import\s+type\s/.test(tipo)).toBe(true)
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
