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
  PRIMA_NOTA_TOOLS: [],
  executePrimaNotaTool: async (name: string, _i: unknown, societa: string) => {
    if (name !== 'genera_prima_nota') return null
    societaRicevute.primaNota = societa
    return '{"ok":true}'
  },
}))
vi.mock('./movimenti-extract', () => ({
  MOVIMENTI_TOOLS: [],
  executeMovimentiTool: async (name: string, _i: unknown, societa: string) => {
    if (name !== 'lista_movimenti') return null
    societaRicevute.movimenti = societa
    return '{"ok":true}'
  },
}))
vi.mock('./fic-write-tools', () => ({
  FIC_WRITE_TOOLS: [],
  executeFicWriteTool: async (name: string, _i: unknown, societa: string) => {
    if (name !== 'compila_fattura_emessa') return null
    societaRicevute.ficWrite = societa
    return '{"ok":true}'
  },
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
})
