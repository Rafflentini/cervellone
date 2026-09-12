import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'

vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'insert', 'update', 'upsert', 'delete', 'order', 'limit', 'in', 'ilike']) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { getToolDefinitions } from './tools'

type Def = { name: string; defer_loading?: boolean; type?: string }

describe('differimento delle definizioni dei tool', () => {
  it('SENZA opzioni l output e identico a prima: nessun defer_loading, nessuna ricerca', () => {
    const defs = getToolDefinitions() as Def[]
    expect(defs.some((d) => d.defer_loading !== undefined)).toBe(false)
    expect(defs.some((d) => d.type?.startsWith('tool_search'))).toBe(false)
    // L'ordine e' parte della garanzia: `tools` e' il primo blocco del prefisso
    // della cache, un riordino la invaliderebbe a ogni turno senza dirlo.
    expect(defs.slice(0, 2).map((d) => d.name)).toEqual(['web_search', 'code_execution'])
  })

  // LA GARANZIA DEL RAMO, PRESIDIATA.
  //
  // "Senza opzioni l'output e' identico a main" e' la frase piu' citata di
  // questo lavoro, ma era una misura fatta A MANO una volta sola: nessun test
  // la difendeva. Mutazione sopravvissuta alla suite INTERA (2.231 verdi):
  //   ALL_TOOLS.filter(t => t.name !== 'gmail_summary_inbox'
  //                      && t.name !== 'estrai_movimenti'
  //                      && t.name !== 'affitti_incassi')
  // cioe' tre tool spariti dalle definizioni spedite all'API senza che nulla
  // se ne accorgesse.
  //
  // ⚠️ L'md5 e' quello di `main`: md5(JSON.stringify(getToolDefinitions())),
  // 130 definizioni = 2 tool server + 128 custom, ordine compreso. Se questa
  // asserzione cade, NON si aggiorna il numero: o la parita' con `main` si e'
  // rotta per sbaglio, o si e' DECISO di cambiarla — e allora va scritta la
  // decisione, non il nuovo md5.
  //
  // LA DECISIONE, 12 settembre 2026. Era 129 (2 + 127) con impronta
  // `5fe48792af88c5f89beaf66c53366b1c`. E' stato aggiunto UN tool custom:
  // `segna_fatture_ricevute_pagate` — segnare pagata una fattura RICEVUTA su
  // Fatture in Cloud, che prima non si poteva fare, per registrare i pagamenti
  // in contanti che non lasciano nessun movimento bancario. Un tool in piu' e'
  // esattamente quello che questa asserzione deve costringere a dichiarare: il
  // numero sale da 129 a 130 di proposito, non per sbaglio.
  it('senza opzioni: 130 definizioni e la stessa impronta di main', () => {
    const defs = getToolDefinitions()
    expect(defs).toHaveLength(130)
    expect(createHash('md5').update(JSON.stringify(defs)).digest('hex'))
      .toBe('16ce3fca1c09ee99f6f379e648300bee')
  })

  it('col nucleo, i tool fuori dal nucleo sono differiti e quelli dentro no', () => {
    const nucleo = new Set(['cervellone_info', 'cerca_documenti'])
    const defs = getToolDefinitions({ nucleo }) as Def[]
    const dentro = defs.find((d) => d.name === 'cervellone_info')
    const fuori = defs.find((d) => d.name === 'read_email')
    expect(dentro?.defer_loading).toBeUndefined()
    expect(fuori?.defer_loading).toBe(true)
  })

  it('i due tool server non vengono MAI differiti', () => {
    const defs = getToolDefinitions({ nucleo: new Set<string>() }) as Def[]
    for (const n of ['web_search', 'code_execution']) {
      expect(defs.find((d) => d.name === n)?.defer_loading).toBeUndefined()
    }
  })

  it('con ricerca:true dichiara il tool di ricerca in testa', () => {
    const defs = getToolDefinitions({ nucleo: new Set(['cervellone_info']), ricerca: true }) as Def[]
    expect(defs[0].type).toBe('tool_search_tool_bm25_20251119')
    expect(defs[0].name).toBe('tool_search_tool_bm25')
  })

  // L'API rifiuta con 400 una richiesta in cui TUTTO e differito. Il nucleo
  // vuoto piu ricerca deve restare legale grazie ai due tool server.
  it('non differisce mai tutto: resta sempre almeno un tool caricato', () => {
    const defs = getToolDefinitions({ nucleo: new Set<string>(), ricerca: true }) as Def[]
    expect(defs.filter((d) => !d.defer_loading).map((d) => d.name))
      .toEqual(['tool_search_tool_bm25', 'web_search', 'code_execution'])
  })
})
