import { describe, it, expect, vi, beforeEach } from 'vitest'

// Caratterizzazione: cattura l'output ATTUALE di executeStudioTecnico per input noti.
// Per un puro spostamento serve che l'output sia IDENTICO prima e dopo il move.
// Mock @supabase/supabase-js così ogni client (supabase.ts / supabase-server.ts / inline)
// non richiede env e ritorna dati fissi → output deterministico.
const VOCI = [
  { codice_voce: 'BAS25_E.03.068.01', descrizione: 'Calcestruzzo Rck 30 in opera', unita_misura: 'mc', prezzo: 204.49, anno: 2025, fonte: 'test' },
]
const RESULT = { data: VOCI, count: 100, error: null }

vi.mock('@supabase/supabase-js', () => {
  // Chain thenable: qualsiasi combinazione di metodi si risolve in RESULT.
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like', 'in', 'order', 'limit', 'range', 'insert', 'update', 'upsert', 'delete', 'not', 'or', 'match', 'contains']
  for (const m of methods) chain[m] = () => chain
  chain.single = () => Promise.resolve(RESULT)
  chain.maybeSingle = () => Promise.resolve(RESULT)
  chain.then = (res: (v: unknown) => unknown) => res(RESULT)
  return { createClient: () => ({ from: () => chain }) }
})

import { executeStudioTecnico } from './studio-tecnico'

// Cattura output o errore in modo deterministico: per un puro spostamento conta solo
// che il risultato sia IDENTICO prima e dopo (anche un errore stabile è una prova valida).
async function capture(fn: () => Promise<string | null>): Promise<string> {
  try {
    return String(await fn())
  } catch (e) {
    return `THREW: ${e instanceof Error ? e.message : String(e)}`
  }
}

describe('caratterizzazione studio-tecnico', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.setSystemTime(new Date('2026-08-14T10:00:00Z'))
  })

  it('cerca_prezziario — output stabile', async () => {
    const out = await capture(() => executeStudioTecnico('cerca_prezziario', { query: 'calcestruzzo', regione: 'basilicata' }))
    expect(out).toMatchSnapshot()
  })

  it('genera_preventivo_completo — comportamento stabile', async () => {
    const out = await capture(() => executeStudioTecnico('genera_preventivo_completo', {
      committente: 'Test Cliente',
      comune: 'Villa dAgri',
      descrizione_lavoro: 'Getto calcestruzzo',
      lavorazioni: [{ descrizione: 'calcestruzzo', quantita: 10, unita: 'mc' }],
      regione: 'basilicata',
    }, 'conv-test'))
    expect(out).toMatchSnapshot()
  })
})
