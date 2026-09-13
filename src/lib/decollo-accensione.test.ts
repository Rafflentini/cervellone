import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * La prima accensione VERA di TOOL_DEFER=1 e DECOLLO=1 insieme (13 set 2026).
 * Due difetti trovati dall'audit avversariale dell'accensione, provati qui:
 *
 * 1. Le porte degli specialisti non stavano nel nucleo: con il differimento
 *    acceso erano `defer_loading`, mentre la mappa diceva «chiamali per nome».
 *    Il Decollo sarebbe stato acceso e cieco.
 * 2. `raccogli_fatture_estere` INOLTRA mail (senza `prova` parte davvero) ed
 *    era nel perimetro della contabile: «le azioni che non si disfano non sono
 *    fra i tuoi attrezzi» era falso.
 */

const b: Record<string, unknown> = {}
for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'in', 'ilike', 'gte', 'lte', 'neq', 'is']) b[m] = () => b
b.single = () => Promise.resolve({ data: null, error: null })
b.maybeSingle = () => Promise.resolve({ data: null, error: null })
b.limit = () => Promise.resolve({ data: [], error: null })
b.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })

vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ from: () => b, rpc: () => Promise.resolve({ data: [], error: null }) }) }))
vi.mock('./supabase', () => ({ supabase: { from: () => b, rpc: () => Promise.resolve({ data: [], error: null }) } }))
vi.mock('./skills', () => ({ matchSkills: vi.fn().mockResolvedValue('') }))

import { opzioniToolDaAmbiente } from './claude'
import { getToolDefinitions } from './tools'
import { getChatSystemPrompt, getTelegramSystemPrompt } from './prompts'
import { AZIONI_IRREVERSIBILI, perimetroDiLavoro, porteAperte, specialista, toolDelCoordinatore, toolDi } from './specialisti'

type Def = { name?: string; defer_loading?: boolean }

afterEach(() => {
  delete process.env.TOOL_DEFER
  delete process.env.DECOLLO
})

describe('le porte degli specialisti con il differimento acceso', () => {
  it('le porte esistono (altrimenti i test sotto non proverebbero niente)', () => {
    expect(toolDelCoordinatore()).toContain('chiedi_alla_contabile')
  })

  it('DECOLLO acceso: le porte sono caricate, non differite', () => {
    process.env.TOOL_DEFER = '1'
    process.env.DECOLLO = '1'
    const defs = getToolDefinitions(opzioniToolDaAmbiente()) as Def[]
    for (const porta of toolDelCoordinatore()) {
      const d = defs.find((x) => x.name === porta)
      expect(d, porta).toBeDefined()
      expect(d?.defer_loading, porta).toBeUndefined()
    }
  })

  // Controllo positivo: lo stesso test SAPREBBE vedere una porta differita.
  it('DECOLLO spento: le porte restano differite (una porta che rifiuta non si mostra)', () => {
    process.env.TOOL_DEFER = '1'
    const defs = getToolDefinitions(opzioniToolDaAmbiente()) as Def[]
    const d = defs.find((x) => x.name === 'chiedi_alla_contabile')
    expect(d?.defer_loading).toBe(true)
  })

  it('porteAperte segue DECOLLO', () => {
    expect(porteAperte()).toEqual([])
    process.env.DECOLLO = '1'
    expect(porteAperte()).toEqual(toolDelCoordinatore())
  })
})

describe('la mappa nomina le porte solo se sono aperte — entrambi i canali', () => {
  for (const [canale, prompt] of [
    ['chat web', () => getChatSystemPrompt('ciao')],
    ['telegram', () => getTelegramSystemPrompt('ciao')],
  ] as const) {
    it(`${canale}: DECOLLO acceso le nomina`, async () => {
      process.env.TOOL_DEFER = '1'
      process.env.DECOLLO = '1'
      expect(await prompt()).toContain('chiedi_alla_contabile')
    })

    it(`${canale}: DECOLLO spento non le nomina`, async () => {
      process.env.TOOL_DEFER = '1'
      const p = await prompt()
      expect(p).toContain('DOVE STANNO GLI ATTREZZI') // la mappa c'e': l'assenza sotto e' vera
      expect(p).not.toContain('chiedi_alla_contabile')
    })
  }
})

describe('la contabile non inoltra mail', () => {
  it('raccogli_fatture_estere e fra i suoi attrezzi (il test sotto non e vacuo)', () => {
    expect(toolDi(specialista('contabile'))).toContain('raccogli_fatture_estere')
  })

  it('ma e un\'azione irreversibile, e resta fuori dal perimetro', () => {
    expect(AZIONI_IRREVERSIBILI).toContain('raccogli_fatture_estere')
    expect(perimetroDiLavoro(specialista('contabile')).has('raccogli_fatture_estere')).toBe(false)
  })
})

describe('le prove del pilota giocano con le carte vere (carteDelTurno)', () => {
  it('differimento acceso: avviso nel system, ricerca e porte fra gli strumenti', async () => {
    const { carteDelTurno } = await import('./claude')
    const { AVVISO_STRUMENTI_CERCABILI } = await import('./tool-nucleo')
    process.env.TOOL_DEFER = '1'
    process.env.DECOLLO = '1'
    const { system, tools } = carteDelTurno('statico')
    expect(system[0].text).toContain(AVVISO_STRUMENTI_CERCABILI.trim())
    expect((tools as Def[]).some((t) => t.name === 'tool_search_tool_bm25')).toBe(true)
    expect((tools as Def[]).find((t) => t.name === 'chiedi_alla_contabile')?.defer_loading).toBeUndefined()
  })

  // Controllo positivo: spento, l'avviso NON c'e' — il test sopra non e' vacuo.
  it('differimento spento: niente avviso, niente ricerca', async () => {
    const { carteDelTurno } = await import('./claude')
    const { AVVISO_STRUMENTI_CERCABILI } = await import('./tool-nucleo')
    const { system, tools } = carteDelTurno('statico')
    expect(system[0].text).not.toContain(AVVISO_STRUMENTI_CERCABILI.trim())
    expect((tools as Def[]).some((t) => t.name === 'tool_search_tool_bm25')).toBe(false)
  })
})
