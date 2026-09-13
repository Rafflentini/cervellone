/**
 * src/lib/mappa-officina.test.ts — la mappa dell'officina (Task 17).
 *
 * Il cuore del task e' il primo test: ogni tool fuori dal nucleo deve stare in
 * ESATTAMENTE un dominio della mappa. Una mappa con dei buchi e' peggio di
 * nessuna mappa (vedi mappa-officina.ts): il modello si fida e conclude che un
 * attrezzo non catalogato non esiste.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// tools.ts importa moltissimi moduli con client Supabase a load-time (drive,
// gmail, fatture-in-cloud, ...): mock di @supabase/supabase-js così ogni
// createClient non richiede env reali. Stesso pattern di tools.registry.test.ts
// e tool-nucleo.test.ts.
vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like', 'in', 'order', 'limit', 'range', 'insert', 'update', 'upsert', 'delete', 'not', 'or', 'match', 'contains']
  for (const m of methods) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

// getChatSystemPrompt / getTelegramSystemPrompt: stesso mock di prompts.test.ts
// (già dimostrato sufficiente lì per far girare i due generatori di prompt).
vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => {
      const b: Record<string, unknown> = {}
      b.select = vi.fn(() => b)
      b.eq = vi.fn(() => b)
      b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }))
      b.order = vi.fn(() => b)
      b.limit = vi.fn(() => Promise.resolve({ data: [], error: null }))
      b.insert = vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [], error: null }) }))
      return b
    }),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
  },
}))
vi.mock('./skills', () => ({
  matchSkills: vi.fn().mockResolvedValue(''),
}))

import { getToolDefinitions } from './tools'
import { NUCLEO_TOOL, SERVER_TOOLS } from './tool-nucleo'
import { DOMINI, mappaOfficina, TOOL_DEL_COORDINATORE } from './mappa-officina'
import { DELEGA_TOOLS } from './tools/delega-tools'
import { getChatSystemPrompt, getTelegramSystemPrompt } from './prompts'

describe('la mappa dell\'officina — guardia anti-buco (test che conta piu\' di tutti)', () => {
  it('CONTROLLO POSITIVO — ogni tool fuori dal nucleo sta in ESATTAMENTE un dominio', () => {
    const tutti = (getToolDefinitions() as { name?: string }[]).map((t) => t.name).filter(Boolean) as string[]
    // ⚠️ `TOOL_DEL_COORDINATORE` aggiunto il 13 set 2026, e aggiunto perche'
    // QUESTA guardia ha morso. Con il Decollo esiste un attrezzo che non
    // appartiene a nessun mestiere — serve a girare il lavoro a chi il mestiere
    // ce l'ha — e il modello del mondo di questo test non lo prevedeva.
    //
    // Non e' una maglia allargata: e' una categoria in piu', chiusa e
    // sorvegliata dai test qui sotto — primo fra tutti quello che la LEGA a
    // `DELEGA_TOOLS`, senza il quale l'esenzione era una scappatoia vera
    // (provato con una mutazione, audit 13 set 2026). Allargare la guardia
    // avrebbe spento la difesa insieme al problema.
    const fuoriNucleo = tutti.filter(
      (n) => !NUCLEO_TOOL.has(n) && !SERVER_TOOLS.includes(n) && !TOOL_DEL_COORDINATORE.includes(n),
    )
    const catalogati = DOMINI.flatMap((d) => d.tool)
    const senzaScaffale = fuoriNucleo.filter((n) => !catalogati.includes(n))
    // Il messaggio deve NOMINARE i tool orfani: un test che dice solo "3 != 0"
    // fa perdere mezz'ora a chi lo legge fra sei mesi.
    expect(senzaScaffale, `tool senza scaffale: ${senzaScaffale.join(', ')}`).toEqual([])
  })

  it('nessun tool sta in due domini: uno scaffale solo per attrezzo', () => {
    const conteggio = new Map<string, string[]>()
    for (const d of DOMINI) {
      for (const n of d.tool) {
        const doves = conteggio.get(n) ?? []
        doves.push(d.nome)
        conteggio.set(n, doves)
      }
    }
    const doppi = [...conteggio.entries()].filter(([, doves]) => doves.length > 1)
    const messaggio = doppi.map(([n, doves]) => `${n} in [${doves.join(', ')}]`).join('; ')
    expect(doppi, `tool in piu' di uno scaffale: ${messaggio}`).toEqual([])
  })

  it('nessun dominio elenca un tool che non esiste piu', () => {
    // Il caso opposto del test principale: un attrezzo tolto dal codice e
    // rimasto sulla mappa. La mappa mentirebbe al contrario: prometterebbe
    // una capacita' sparita.
    const esistenti = new Set((getToolDefinitions() as { name?: string }[]).map((t) => t.name).filter(Boolean) as string[])
    const fantasmi = DOMINI.flatMap((d) => d.tool.filter((n) => !esistenti.has(n)).map((n) => `${n} (${d.nome})`))
    expect(fantasmi, `tool sulla mappa ma spariti dal registro: ${fantasmi.join(', ')}`).toEqual([])
  })
})

/**
 * ⚠️ `TOOL_DEL_COORDINATORE` e' un'ESENZIONE dalla guardia principale, e ogni
 * esenzione e' una scorciatoia per chi un giorno avra' fretta: basta infilarci
 * dentro un nome per far tacere la mappa. Questi tre test sono il prezzo che
 * l'esenzione deve pagare per esistere.
 */
describe("gli attrezzi del coordinatore: un'esenzione, quindi sorvegliata", () => {
  it("🚨 L'ESENZIONE E' ESATTAMENTE DELEGA_TOOLS: non un elenco a mano", () => {
    // ⚠️ Questo test nasce da una MUTAZIONE SOPRAVVISSUTA, audit del 13 set
    // 2026. Le altre guardie di questo blocco non chiudevano il buco che il
    // commento in `mappa-officina.ts` prometteva di chiudere: bastava togliere
    // un tool VERO dal suo scaffale e infilarlo qui, e la suite intera restava
    // verde. `length <= 3` ✓, `esiste davvero` ✓ (esiste, e' proprio il
    // problema), `non sta anche su uno scaffale` ✓ (l'avevi tolto).
    //
    // L'effetto in produzione era silenzioso e cattivo: il tool usciva dal
    // perimetro del suo specialista, che se lo vedeva rifiutare, e la mappa
    // taceva — esattamente come prima che l'esenzione esistesse.
    //
    // La cura non e' un'altra guardia a mano ma DERIVARE: l'esenzione vale per
    // i tool della delega, e per nessun altro. Se domani qualcuno ci infila un
    // nome, questo test lo dice — e se aggiunge un tool di delega vero, basta
    // che lo registri dove va.
    expect([...TOOL_DEL_COORDINATORE].sort()).toEqual(DELEGA_TOOLS.map((t) => t.name).sort())
  })

  it('resta minuscola: se cresce, non e piu un eccezione ma una scappatoia', () => {
    expect(TOOL_DEL_COORDINATORE.length).toBeLessThanOrEqual(3)
  })

  it('ognuno esiste davvero nel registro', () => {
    // Il verso opposto: un nome rimasto qui dopo che il tool e' sparito
    // esenterebbe un fantasma, e la mappa tacerebbe su un buco vero.
    const esistenti = new Set((getToolDefinitions() as { name?: string }[]).map((t) => t.name).filter(Boolean) as string[])
    const fantasmi = TOOL_DEL_COORDINATORE.filter((n) => !esistenti.has(n))
    expect(fantasmi, `esentati che non esistono piu': ${fantasmi.join(', ')}`).toEqual([])
  })

  it("🚨 con l'interruttore ACCESO la mappa li NOMINA: altrimenti sono invisibili", () => {
    // ⚠️ Bloccante trovato dall'audit del 13 set 2026. Con `TOOL_DEFER=1`
    // questi tool NON sono nel nucleo, quindi vengono differiti come tutti gli
    // altri; e non stando su nessuno scaffale non comparivano nemmeno sulla
    // mappa. Invisibili in tutti e due i posti — proprio nel regime per cui il
    // Decollo esiste.
    //
    // E non li avrebbe trovati cercando: le parole di `chiedi_alla_contabile`
    // sono quelle dei tool FIC veri, quindi la porta e gli attrezzi si fanno
    // concorrenza nella ricerca BM25.
    process.env.TOOL_DEFER = '1'
    const m = mappaOfficina()
    for (const n of TOOL_DEL_COORDINATORE) {
      expect(m, `la mappa non nomina ${n}: sarebbe invisibile`).toContain(n)
    }
  })

  it('CONTROLLO POSITIVO — sono DIFFERITI: e per questo che vanno nominati', () => {
    // La prova del fatto su cui poggia il test qui sopra. Se un domani
    // finissero nel nucleo, questo morirebbe e direbbe che la riga sulla mappa
    // e' diventata superflua — che e' un'informazione, non un guasto.
    const defs = getToolDefinitions({ nucleo: NUCLEO_TOOL, ricerca: true }) as { name: string; defer_loading?: boolean }[]
    for (const n of TOOL_DEL_COORDINATORE) {
      expect(defs.find((d) => d.name === n)?.defer_loading, `${n} non risulta differito`).toBe(true)
    }
  })

  it('nessuno di loro sta ANCHE su uno scaffale: o e del coordinatore o e di un mestiere', () => {
    // Se stesse in tutti e due i posti, toglierlo dall'esenzione non basterebbe
    // a rimetterlo sotto guardia — e la doppia catalogazione e' il modo in cui
    // una mappa comincia a mentire senza che nessuno se ne accorga.
    const catalogati = new Set(DOMINI.flatMap((d) => d.tool))
    const doppi = TOOL_DEL_COORDINATORE.filter((n) => catalogati.has(n))
    expect(doppi, `esentati che stanno anche su uno scaffale: ${doppi.join(', ')}`).toEqual([])
  })
})

/**
 * ⚠️ La mappa esiste SOLO a interruttore acceso, e questi test lo accendono.
 *
 * A `TOOL_DEFER` spento il blocco direbbe «questi strumenti esistono e NON sono
 * caricati» mentre sono caricati tutti e 131, e manderebbe il modello a cercare
 * con `tool_search_tool_bm25`, che a interruttore spento non esiste fra i tool.
 * Un'istruzione che indica uno strumento assente e' peggio di nessuna
 * istruzione — e un test che la pretendesse sempre presente **proteggerebbe una
 * bugia**.
 */
beforeEach(() => {
  process.env.TOOL_DEFER = '1'
})
afterEach(() => {
  delete process.env.TOOL_DEFER
})

describe('a interruttore SPENTO la mappa non c\'e\' — perche direbbe il falso', () => {
  it('mappaOfficina() e vuota senza TOOL_DEFER', () => {
    delete process.env.TOOL_DEFER
    expect(mappaOfficina()).toBe('')
  })

  it('CONTROLLO POSITIVO — il prompt vivo NON la contiene a interruttore spento', async () => {
    delete process.env.TOOL_DEFER
    expect(await getChatSystemPrompt('ciao', [])).not.toContain('DOVE STANNO GLI ATTREZZI')
    expect(await getTelegramSystemPrompt('ciao', [])).not.toContain('DOVE STANNO GLI ATTREZZI')
  })
})

describe('mappaOfficina() — il testo iniettato nel prompt', () => {
  it('nomina i domini ma NON i singoli tool (e la scelta sui token)', () => {
    const m = mappaOfficina()
    expect(m).toContain('Contabilita e fatture')
    // i nomi costano 1.056 token nella mappa grande: stanno nel registro
    // DOMINI (per i test), non nel testo iniettato nel prompt.
    expect(m).not.toContain('fic_fatture_ricevute')
  })

  it('contiene la frase che vieta di concludere "non so farlo"', () => {
    expect(mappaOfficina()).toMatch(/non concludere mai/i)
  })

  it('contiene l\'intestazione DOVE STANNO GLI ATTREZZI', () => {
    expect(mappaOfficina()).toContain('DOVE STANNO GLI ATTREZZI')
  })
})

describe('la mappa arriva nel prompt VIVO di ENTRAMBI i canali', () => {
  it('getChatSystemPrompt la contiene', async () => {
    expect(await getChatSystemPrompt('ciao', [])).toContain('DOVE STANNO GLI ATTREZZI')
  })

  it('getTelegramSystemPrompt la contiene (stesso testo, non solo lo stesso motore)', async () => {
    expect(await getTelegramSystemPrompt('ciao', [])).toContain('DOVE STANNO GLI ATTREZZI')
  })
})
