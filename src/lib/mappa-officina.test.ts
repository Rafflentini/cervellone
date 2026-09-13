/**
 * src/lib/mappa-officina.test.ts — la mappa dell'officina (Task 17).
 *
 * Il cuore del task e' il primo test: ogni tool fuori dal nucleo deve stare in
 * ESATTAMENTE un dominio della mappa. Una mappa con dei buchi e' peggio di
 * nessuna mappa (vedi mappa-officina.ts): il modello si fida e conclude che un
 * attrezzo non catalogato non esiste.
 */
import { describe, it, expect, vi } from 'vitest'

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
import { DOMINI, mappaOfficina } from './mappa-officina'
import { getChatSystemPrompt, getTelegramSystemPrompt } from './prompts'

describe('la mappa dell\'officina — guardia anti-buco (test che conta piu\' di tutti)', () => {
  it('CONTROLLO POSITIVO — ogni tool fuori dal nucleo sta in ESATTAMENTE un dominio', () => {
    const tutti = (getToolDefinitions() as { name?: string }[]).map((t) => t.name).filter(Boolean) as string[]
    const fuoriNucleo = tutti.filter((n) => !NUCLEO_TOOL.has(n) && !SERVER_TOOLS.includes(n))
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
