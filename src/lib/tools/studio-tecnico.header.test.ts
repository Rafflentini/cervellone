import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Task 7 — le cinque intestazioni cablate a Restruktura dentro
 * `genera_preventivo_completo`. La rete (guardia sui dati societari, Task 1/4)
 * gia' impedisce che il documento venga SALVATO con la P.IVA sbagliata; questo
 * file prova la CURA: che il preventivo generato per La Real Estate porti
 * davvero l'intestazione e i piedi de La Real Estate, e non quelli di
 * Restruktura scritti a mano nel generatore.
 */

const VOCI = [
  { codice_voce: 'BAS25_E.03.068.01', descrizione: 'Calcestruzzo Rck 30 in opera', unita_misura: 'mc', prezzo: 204.49, anno: 2025, fonte: 'test' },
]
const RESULT = { data: VOCI, count: 100, error: null }

const mockInsertSpy = vi.fn()

vi.mock('@supabase/supabase-js', () => {
  // Stesso pattern di studio-tecnico.characterization.test.ts e
  // studio-tecnico.guardia.test.ts: chain thenable condivisa da ogni client.
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like', 'in', 'order', 'limit', 'range', 'update', 'upsert', 'delete', 'not', 'or', 'match', 'contains']
  for (const m of methods) chain[m] = () => chain
  chain.insert = (row: unknown) => { mockInsertSpy(row); return chain }
  chain.single = () => Promise.resolve({ data: { id: 'test-doc-id' }, error: null })
  chain.maybeSingle = () => Promise.resolve({ data: { id: 'test-doc-id' }, error: null })
  chain.then = (res: (v: unknown) => unknown) => res(RESULT)
  return { createClient: () => ({ from: () => chain }) }
})

const RESTRUKTURA = { denominazione: 'RESTRUKTURA S.r.l.', piva: '02087420762', sede: "Villa d'Agri (PZ), Italia" }
const LAREALESTATE = { denominazione: 'LA REAL ESTATE SRLS', piva: '02232730768', sede: 'Via Civita 8, Maratea (PZ)' }

const mockSocietaPerDocumento = vi.fn()
vi.mock('../societa-documenti', () => ({
  societaPerDocumento: (...a: unknown[]) => mockSocietaPerDocumento(...a),
}))

import { executeStudioTecnico } from './studio-tecnico'

function input() {
  return {
    committente: 'Cliente',
    comune: 'Maratea',
    descrizione_lavoro: 'x',
    lavorazioni: [{ descrizione: 'calcestruzzo', quantita: 10, um: 'mc' }],
    regione: 'basilicata',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.setSystemTime(new Date('2026-09-12T10:00:00Z'))
})

describe('genera_preventivo_completo — le intestazioni seguono la societa attiva', () => {
  // Riproduzione del difetto (Task 7, Step 1-2), PRIMA della cura:
  //   mockSocietaPerDocumento.mockResolvedValue({ ok: true, societa: LAREALESTATE, esplicita: true })
  //   const out = String(await executeStudioTecnico('genera_preventivo_completo', input(), 'conv-lre'))
  //   expect(out).toContain('02087420762')
  // Eseguito contro il codice di PRIMA di questo commit: PASSAVA — ma non
  // perche' il documento uscisse con l'intestazione sbagliata (la guardia di
  // rete, Task 1/4, lo blocca gia' e non scrive niente); passava perche' il
  // MESSAGGIO DI BLOCCO nomina entrambe le partite IVA (`messaggioBlocco`),
  // ed e' testo, quindi contiene la stringa '02087420762' comunque. La cura
  // di questo task non e' la rete (che teneva gia'): e' che il generatore,
  // con La Real Estate attiva, adesso scrive l'intestazione e i piedi de La
  // Real Estate fin dall'inizio, e la guardia non ha piu' nulla da bloccare.
  it('con La Real Estate attiva il preventivo porta LA SUA partita IVA, e non quella di Restruktura', async () => {
    mockSocietaPerDocumento.mockResolvedValue({ ok: true, societa: LAREALESTATE, esplicita: true })

    const out = String(await executeStudioTecnico('genera_preventivo_completo', input(), 'conv-lre'))

    expect(out).toContain('GENERATI CON SUCCESSO')
    expect(out).toContain(LAREALESTATE.denominazione)
    expect(out).toContain(LAREALESTATE.sede)
    expect(out).toContain('02232730768')
    expect(out).not.toContain('02087420762')
    expect(out).not.toContain('RESTRUKTURA')
  })

  // CONTROLLO NEGATIVO: con Restruktura attiva l'intestazione resta la sua,
  // per lo stesso motivo per cui il test sopra vale — non perche' qualunque
  // intestazione sparisca sempre.
  it('con Restruktura attiva il preventivo porta LA SUA intestazione', async () => {
    mockSocietaPerDocumento.mockResolvedValue({ ok: true, societa: RESTRUKTURA, esplicita: false })

    const out = String(await executeStudioTecnico('genera_preventivo_completo', input(), 'conv-restruktura'))

    expect(out).toContain('GENERATI CON SUCCESSO')
    expect(out).toContain('02087420762')
    expect(out).toContain(RESTRUKTURA.sede)
    expect(out).not.toContain('02232730768')
  })

  // Controllo positivo del ramo ok:false: senza, "il preventivo non si
  // genera su ok:false" e' solo una frase nel rapporto, non una difesa.
  it('societa attiva sconosciuta -> il preventivo NON si genera, e lo dichiara', async () => {
    mockSocietaPerDocumento.mockResolvedValue({ ok: false, errore: 'connessione a supabase persa' })

    const out = String(await executeStudioTecnico('genera_preventivo_completo', input(), 'conv-guasto'))

    expect(out).not.toContain('GENERATI CON SUCCESSO')
    expect(out).toMatch(/non so quale societa/i)
    expect(out).toContain('connessione a supabase persa')
    expect(mockInsertSpy).not.toHaveBeenCalled()
  })
})
