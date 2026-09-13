import { describe, it, expect, vi } from 'vitest'

// Carica il registry completo (tools.ts importa molti moduli con client supabase a
// load-time): mock di @supabase/supabase-js così ogni createClient non richiede env.
vi.mock('@supabase/supabase-js', () => {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like', 'in', 'order', 'limit', 'range', 'insert', 'update', 'upsert', 'delete', 'not', 'or', 'match', 'contains']
  for (const m of methods) chain[m] = () => chain
  chain.single = () => Promise.resolve({ data: null, error: null })
  chain.then = (res: (v: unknown) => unknown) => res({ data: [], error: null })
  return { createClient: () => ({ from: () => chain }) }
})

import { getToolDefinitions } from './tools'

describe('registry tool (post-refactor)', () => {
  it('espone un set di nomi non vuoto e senza duplicati', () => {
    const defs = getToolDefinitions() as { name: string }[]
    const names = defs.map(d => d.name)
    expect(names.length).toBeGreaterThan(40)
    expect(new Set(names).size).toBe(names.length) // nessun duplicato
  })

  it('contiene i tool chiave di ogni gruppo estratto (nessun tool perso nel refactor)', () => {
    const names = (getToolDefinitions() as { name: string }[]).map(d => d.name)
    for (const n of [
      'cerca_prezziario', 'genera_preventivo_completo', // studio-tecnico
      'cervellone_info', 'cervellone_check_aggiornamenti', // self
      'gmail_list_inbox', // mail (Gmail)
      'sal_calcola', // sal
      'genera_pdf', 'rivedi_immagine', // gruppi rimasti in tools.ts (pdf, image)
    ]) {
      expect(names, `manca il tool ${n}`).toContain(n)
    }
  })
})

/**
 * `soloQuesti` — il perimetro di uno specialista, sul registro VERO.
 *
 * ⚠️ Questo blocco esiste per un buco trovato il 13 set 2026. I test del
 * perimetro (`claude.perimetro.test.ts`) mockano `./tools`, quindi provano che
 * l'opzione ARRIVA a `getToolDefinitions` ma non che `getToolDefinitions` la
 * applichi: disattivando il filtro, restavano tutti verdi. Provato con una
 * mutazione — ed e' il motivo per cui una mutazione sopravvissuta vale piu' di
 * dieci test verdi.
 */
describe('soloQuesti: gli attrezzi di uno specialista, e nessun altro', () => {
  it('restituisce SOLO i tool chiesti, piu i due server', () => {
    const defs = getToolDefinitions({ soloQuesti: new Set(['fic_fatture_ricevute', 'fic_dettaglio_documento']) }) as { name: string }[]
    const nomi = defs.map(d => d.name).sort()
    expect(nomi).toEqual(['code_execution', 'fic_dettaglio_documento', 'fic_fatture_ricevute', 'web_search'])
  })

  it('la posta NON c e: e il punto di tutta la faccenda', () => {
    // «Ne il coordinatore, ne la segretaria spedisce MAI una fattura, quello lo
    // faccio solo io!» — Raffaele, 13 set 2026.
    const defs = getToolDefinitions({ soloQuesti: new Set(['fic_fatture_ricevute']) }) as { name: string }[]
    const nomi = defs.map(d => d.name)
    expect(nomi).not.toContain('send_email')
    expect(nomi).not.toContain('gmail_send_draft')
  })

  it('CONTROLLO POSITIVO — senza soloQuesti quegli stessi tool ci sono tutti', () => {
    // Senza questo, i due test sopra passerebbero anche se getToolDefinitions
    // restituisse sempre una lista vuota.
    const nomi = (getToolDefinitions() as { name: string }[]).map(d => d.name)
    expect(nomi).toContain('send_email')
    expect(nomi).toContain('fic_fatture_ricevute')
    expect(nomi.length).toBeGreaterThan(40)
  })

  it('niente tool_search_tool_bm25: non c e nient altro da cercare', () => {
    // Dichiararlo sarebbe una bugia: lo specialista non ha altri attrezzi da
    // trovare. Stesso difetto gia' chiuso sulla mappa dell'officina.
    const defs = getToolDefinitions({ soloQuesti: new Set(['fic_fatture_ricevute']), ricerca: true }) as { name: string }[]
    expect(defs.map(d => d.name)).not.toContain('tool_search_tool_bm25')
  })

  it('nessun tool dello specialista e differito: sono pochi e stanno caricati', () => {
    const defs = getToolDefinitions({ soloQuesti: new Set(['fic_fatture_ricevute']), nucleo: new Set<string>() }) as { name: string; defer_loading?: boolean }[]
    expect(defs.filter(d => d.defer_loading)).toEqual([])
  })
})
