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

import { DELEGA_TOOLS, executeDelegaTool, decolloAcceso } from './delega-tools'

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
    const { readFileSync } = await import('fs')
    const { fileURLToPath } = await import('url')
    const percorso = fileURLToPath(new URL('./delega-tools.ts', import.meta.url))
    const sorgente = readFileSync(percorso, 'utf8')
    // ⚠️ NESSUN import statico a runtime, punto — non una lista nera di nomi.
    //
    // La prima stesura vietava `'../delega'`, `'../claude'`, `'../prompts'`,
    // `'../specialisti'`. L'audit del 13 set 2026 l'ha aggirata due volte:
    // - con l'alias **`'@/lib/delega'`**, che in `src/lib` e' usato in 21 file
    //   (p.es. `agent-job.ts` importa cosi' `@/lib/claude`);
    // - con **`'../tools'`**, cioe' il modulo al centro del ciclo, quello che
    //   esplode — e che la lista nera non nominava nemmeno.
    //
    // Una lista di nomi si aggira cambiando grafia. L'invariante vera e' piu'
    // semplice e non si aggira: da qui non si importa NIENTE a runtime, solo
    // tipi (che spariscono a compilazione) e `./types`, che e' un modulo di
    // soli tipi.
    const vietati = sorgente
      .split(/\r?\n/)
      .filter((r) => /^\s*import\s/.test(r))
      .filter((r) => !/^\s*import\s+type\s/.test(r))
      .filter((r) => !/['"]\.\/types['"]/.test(r))
    expect(
      vietati,
      `import statici a runtime (rimettono il ciclo): ${vietati.join(' | ')}`,
    ).toEqual([])
  })

  it('CONTROLLO POSITIVO — il filtro riconosce anche le grafie che aggiravano la lista nera', () => {
    // Senza, il test sopra passerebbe anche con un filtro che non riconosce
    // niente: l'11 set 2026 un commento dichiarava «controllo positivo» un test
    // che non controllava nulla.
    const vietato = (r: string) =>
      /^\s*import\s/.test(r) && !/^\s*import\s+type\s/.test(r) && !/['"]\.\/types['"]/.test(r)
    // I due che avevano aggirato la lista nera:
    expect(vietato("import { delega } from '@/lib/delega'")).toBe(true)
    expect(vietato("import { getToolDefinitions } from '../tools'")).toBe(true)
    // E quello che la lista nera prendeva:
    expect(vietato("import { delega } from '../delega'")).toBe(true)
    // Quelli leciti restano leciti: i tipi spariscono a compilazione, e
    // './types' e' un modulo di soli tipi.
    expect(vietato("import type { ToolDefinition } from './types'")).toBe(false)
    expect(vietato("import { qualcosa } from './types'")).toBe(false)
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
