/**
 * Le due contabilità non si mescolano.
 *
 * È il test più importante del lavoro sulle due società: gli altri impediscono
 * di SBAGLIARE azienda, questo impedisce che i DATI si mescolino. Un bonifico de
 * La Real Estate dentro la prima nota di Restruktura è un bilancio che non torna
 * per nessuna delle due, e nessuno se ne accorge finché non parla il
 * commercialista.
 *
 * NB sulla non-vacuità: il finto database qui APPLICA davvero i filtri `.eq()`.
 * Un mock che restituisce sempre tutto farebbe passare il test anche con il
 * filtro per società rimosso — cioè proprio col difetto in produzione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface RigaMovimento {
  id: string
  societa: string
  data: string
  importo: number
  direzione: string
  descrizione: string
  controparte: string | null
  fonte: string | null
  conto: string | null
  periodo: string
  stato: string
}

let movimenti: RigaMovimento[] = []
let fogliCreati: Array<{ titolo: string; righe: unknown[][] }> = []

/** Costruttore di query che APPLICA i filtri, invece di ignorarli. */
function builder(righe: Record<string, unknown>[]) {
  let filtrate = [...righe]
  const api: Record<string, unknown> = {}
  api.select = () => api
  api.eq = (colonna: string, valore: unknown) => {
    filtrate = filtrate.filter((r) => r[colonna] === valore)
    return api
  }
  api.in = (colonna: string, valori: unknown[]) => {
    filtrate = filtrate.filter((r) => valori.includes(r[colonna]))
    return api
  }
  api.order = () => api
  api.limit = () => api
  api.then = (risolvi: (v: { data: unknown[]; error: null }) => unknown) =>
    Promise.resolve({ data: filtrate, error: null }).then(risolvi)
  return api
}

vi.mock('./supabase', () => ({
  supabase: {
    from: (tabella: string) => {
      if (tabella === 'cervellone_movimenti') return builder(movimenti as unknown as Record<string, unknown>[])
      // nessuna riconciliazione in questi test
      return builder([])
    },
  },
}))

vi.mock('./drive', () => ({
  // firma reale: (titolo, folderId, righe)
  createSpreadsheetInFolder: async (titolo: string, _folderId: string, righe: unknown[][]) => {
    fogliCreati.push({ titolo, righe })
    return { id: 'foglio-1', webViewLink: 'https://drive.google.com/foglio-1' }
  },
}))

import { executePrimaNotaTool } from './prima-nota-tools'

function movimento(societa: string, descrizione: string, importo: number): RigaMovimento {
  return {
    id: `${societa}-${descrizione}`,
    societa,
    data: '2026-08-10',
    importo,
    direzione: 'entrata',
    descrizione,
    controparte: null,
    fonte: 'banca',
    conto: null,
    periodo: '2026-08',
    stato: 'attivo',
  }
}

describe('prima nota separata per societa', () => {
  beforeEach(() => {
    fogliCreati = []
    movimenti = [
      movimento('restruktura', 'bonifico cantiere Villa d Agri', 5000),
      movimento('larealestate', 'incasso Booking agosto', 1200),
    ]
  })

  it('la prima nota di una societa NON contiene i movimenti dell altra', async () => {
    await executePrimaNotaTool('genera_prima_nota', { periodo: '2026-08', folder_id: 'cartella' }, 'larealestate')

    const testo = JSON.stringify(fogliCreati)
    expect(testo).toContain('Booking')
    expect(testo).not.toContain('Villa d Agri')
  })

  it('e viceversa', async () => {
    await executePrimaNotaTool('genera_prima_nota', { periodo: '2026-08', folder_id: 'cartella' }, 'restruktura')

    const testo = JSON.stringify(fogliCreati)
    expect(testo).toContain('Villa d Agri')
    expect(testo).not.toContain('Booking')
  })

  it('se una societa non ha movimenti nel periodo lo dice, invece di mostrare quelli dell altra', async () => {
    movimenti = [movimento('restruktura', 'bonifico cantiere', 5000)]

    const risposta = await executePrimaNotaTool(
      'genera_prima_nota',
      { periodo: '2026-08', folder_id: 'cartella' },
      'larealestate',
    )

    expect(String(risposta)).toContain('nessun movimento')
    expect(fogliCreati).toHaveLength(0)
  })
})
