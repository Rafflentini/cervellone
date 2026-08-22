/**
 * `/societa` deve COMMUTARE, non solo rispondere "fatto".
 *
 * La revisione ha trovato che il comando cambiava la società attiva e il blocco
 * di contesto, mentre gli strumenti contabili restavano cablati su Restruktura:
 * il bot dichiarava di lavorare per un'azienda e leggeva e scriveva i dati
 * dell'altra. Un sistema che non sa fare una cosa è onesto; uno che afferma di
 * averla fatta è pericoloso.
 *
 * Questi test pinnano il cablaggio: la società attiva della conversazione deve
 * arrivare fino agli esecutori contabili.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let societaAttiva = 'restruktura'
const societaRicevute: Record<string, string> = {}

vi.mock('./societa-attiva', () => ({
  getSocietaAttiva: async () => societaAttiva,
}))

// Ogni esecutore contabile registra la società che gli è arrivata
vi.mock('./prima-nota-tools', () => ({
  PRIMA_NOTA_TOOLS: [{ name: 'genera_prima_nota', description: '', input_schema: {} }],
  executePrimaNotaTool: async (name: string, _i: unknown, societa: string) => {
    if (name !== 'genera_prima_nota') return null
    societaRicevute.primaNota = societa
    return '{"ok":true}'
  },
}))
vi.mock('./movimenti-extract', () => ({
  MOVIMENTI_TOOLS: [{ name: 'lista_movimenti', description: '', input_schema: {} }],
  executeMovimentiTool: async (name: string, _i: unknown, societa: string) => {
    if (name !== 'lista_movimenti') return null
    societaRicevute.movimenti = societa
    return '{"ok":true}'
  },
}))
vi.mock('./fic-write-tools', () => ({
  FIC_WRITE_TOOLS: [{ name: 'compila_fattura_emessa', description: '', input_schema: {} }],
  executeFicWriteTool: async (name: string, _i: unknown, societa: string) => {
    if (name !== 'compila_fattura_emessa') return null
    societaRicevute.ficWrite = societa
    return '{"ok":true}'
  },
}))
vi.mock('./riconciliazione-tools', () => ({
  RICONCILIAZIONE_TOOLS: [{ name: 'lista_riconciliazioni', description: '', input_schema: {} }],
  executeRiconciliazioneTool: async (name: string, _i: unknown, societa: string) => {
    if (name !== 'lista_riconciliazioni') return null
    societaRicevute.riconciliazione = societa
    return '{"ok":true}'
  },
}))
vi.mock('./fatture-in-cloud', () => ({
  FIC_READ_TOOLS: [{ name: 'fic_fatture_emesse', description: '', input_schema: {} }],
  executeFicTool: async (name: string, _i: unknown, societa: string) => {
    if (!name.startsWith('fic_')) return null
    societaRicevute.ficRead = societa
    return '{"ok":true}'
  },
  ficGet: async () => ({ ok: true, data: {} }),
  getCompanyId: async () => ({ ok: true, id: '1' }),
  getFicToken: () => 'token',
  creaDocumentoFIC: async () => ({ ok: true, id: 'x', url: null }),
  eliminaDocumentoFIC: async () => ({ ok: true }),
}))

import { executeTool } from './tools'

describe('la societa attiva arriva agli strumenti contabili', () => {
  beforeEach(() => {
    societaAttiva = 'restruktura'
    delete societaRicevute.primaNota
    delete societaRicevute.movimenti
    delete societaRicevute.ficWrite
  })

  it('con Restruktura attiva, la prima nota riceve Restruktura', async () => {
    await executeTool('genera_prima_nota', { periodo: '2026-08', folder_id: 'x' }, 'conv-1')
    expect(societaRicevute.primaNota).toBe('restruktura')
  })

  // Il test che avrebbe smascherato l'interruttore finto.
  it('dopo /societa larealestate, la prima nota riceve La Real Estate', async () => {
    societaAttiva = 'larealestate'
    await executeTool('genera_prima_nota', { periodo: '2026-08', folder_id: 'x' }, 'conv-1')
    expect(societaRicevute.primaNota).toBe('larealestate')
  })

  it('vale anche per i movimenti — dove la societa sbagliata SCRIVE nel posto sbagliato', async () => {
    societaAttiva = 'larealestate'
    await executeTool('lista_movimenti', {}, 'conv-1')
    expect(societaRicevute.movimenti).toBe('larealestate')
  })

  it('vale anche per la compilazione fatture', async () => {
    societaAttiva = 'larealestate'
    await executeTool('compila_fattura_emessa', { cliente: 'X', righe: [] }, 'conv-1')
    expect(societaRicevute.ficWrite).toBe('larealestate')
  })

  it('vale per la riconciliazione', async () => {
    societaAttiva = 'larealestate'
    await executeTool('lista_riconciliazioni', {}, 'conv-1')
    expect(societaRicevute.riconciliazione).toBe('larealestate')
  })

  it('vale per la lettura fatture', async () => {
    societaAttiva = 'larealestate'
    await executeTool('fic_fatture_emesse', {}, 'conv-1')
    expect(societaRicevute.ficRead).toBe('larealestate')
  })
})

/**
 * Senza conversazione la società non è determinabile. Un'operazione contabile
 * NON deve ricadere su un default: sarebbe come sceglierla a caso.
 */
describe('senza conversazione un operazione contabile rifiuta', () => {
  beforeEach(() => {
    societaAttiva = 'restruktura'
    delete societaRicevute.primaNota
  })

  it('non esegue e lo dice, invece di usare un default', async () => {
    const risposta = await executeTool('genera_prima_nota', { periodo: '2026-08', folder_id: 'x' })

    expect(risposta).toContain('societa non determinabile')
    expect(societaRicevute.primaNota).toBeUndefined()
  })
})
