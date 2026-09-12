import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * genera_preventivo_completo e' il documento che Raffaele ha nominato quando
 * ha chiesto la garanzia sui dati societari (12 set 2026): «mi assicuri che
 * il bot non compili un documento sbagliando la partita IVA senza
 * accorgersene?». Qui si prova, con la guardia VERA (non mockata: solo
 * `societaPerDocumento` e' mockato, per decidere quale societa' e' attiva
 * senza fare rete), che:
 *
 *  - con la societa' sbagliata attiva il preventivo si blocca e non scrive
 *    niente (controllo positivo), e con quella giusta i tre documenti si
 *    salvano regolarmente (controllo negativo: senza, un blocco che scatta
 *    sempre passerebbe il primo test per il motivo sbagliato);
 *  - quando a fallire non e' la VERIFICA ma la SCRITTURA del secondo
 *    documento (un guasto transitorio, dopo che le verifiche sono gia'
 *    passate), il messaggio dice quali documenti sono stati salvati
 *    davvero e quali no — non "nessuno dei tre", che a quel punto e' falso.
 */

const VOCI = [
  { codice_voce: 'BAS25_E.03.068.01', descrizione: 'Calcestruzzo Rck 30 in opera', unita_misura: 'mc', prezzo: 204.49, anno: 2025, fonte: 'test' },
]
const RESULT = { data: VOCI, count: 100, error: null }

const mockInsertSpy = vi.fn()
let mockSingleCallCount = 0
/** Se impostato, la N-esima `insert().select().single()` fallisce (guasto DB simulato). */
let mockFalliScritturaAlNumero: number | null = null

vi.mock('@supabase/supabase-js', () => {
  // Stesso pattern di studio-tecnico.characterization.test.ts: chain thenable
  // condivisa da ogni client (supabase.ts / supabase-server.ts).
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'like', 'in', 'order', 'limit', 'range', 'update', 'upsert', 'delete', 'not', 'or', 'match', 'contains']
  for (const m of methods) chain[m] = () => chain
  chain.insert = (row: unknown) => { mockInsertSpy(row); return chain }
  chain.single = () => {
    mockSingleCallCount++
    if (mockFalliScritturaAlNumero !== null && mockSingleCallCount === mockFalliScritturaAlNumero) {
      return Promise.resolve({ data: null, error: { message: 'connessione persa' } })
    }
    return Promise.resolve({ data: { id: `test-doc-id-${mockSingleCallCount}` }, error: null })
  }
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
    committente: 'Test Cliente',
    comune: 'Villa dAgri',
    descrizione_lavoro: 'Getto calcestruzzo',
    // 'um', non 'unita': vedi studio-tecnico.characterization.test.ts.
    lavorazioni: [{ descrizione: 'calcestruzzo', quantita: 10, um: 'mc' }],
    regione: 'basilicata',
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSingleCallCount = 0
  mockFalliScritturaAlNumero = null
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
  vi.setSystemTime(new Date('2026-09-12T10:00:00Z'))
})

describe('genera_preventivo_completo — la guardia sui dati societari (end-to-end)', () => {
  // Task 7: prima le CINQUE intestazioni erano cablate a Restruktura, quindi
  // "La Real Estate attiva" bastava da solo a far mordere la guardia. Dopo la
  // cura l'intestazione la scrive gia' giusta (Step 3): la guardia di
  // salvataggio non ha piu' nulla da bloccare in questo caso, che infatti ora
  // e' coperto da studio-tecnico.header.test.ts ("porta LA SUA partita IVA").
  //
  // Il caso che RESTA per la guardia di rete, qui, e' la RACE: la societa'
  // attiva letta al momento di costruire l'intestazione (Restruktura) non e'
  // piu' quella letta un istante dopo, al momento di salvare (La Real
  // Estate) — per esempio l'Ingegnere cambia societa' a meta' generazione.
  // Il contenuto scritto (Restruktura) e quello atteso al salvataggio (La
  // Real Estate) divergono, ed e' esattamente il caso per cui la guardia
  // esiste: un confronto fra stringhe che non dipende dall'attenzione di
  // nessuno, indipendente da quanto e' accurata la cura a monte.
  it('CONTROLLO POSITIVO: la societa cambia fra la generazione e il salvataggio → blocca, nomina entrambe le P.IVA, non scrive', async () => {
    mockSocietaPerDocumento
      .mockResolvedValueOnce({ ok: true, societa: RESTRUKTURA, esplicita: false }) // letta per l'intestazione
      .mockResolvedValue({ ok: true, societa: LAREALESTATE, esplicita: true }) // letta per il salvataggio

    const out = await executeStudioTecnico('genera_preventivo_completo', input(), 'conv-test')

    expect(out).not.toContain('GENERATI CON SUCCESSO')
    expect(out).toContain(RESTRUKTURA.piva)
    expect(out).toContain(LAREALESTATE.piva)
    // la prova che conta: NESSUNA scrittura, su nessuno dei tre documenti.
    expect(mockInsertSpy).not.toHaveBeenCalled()
  })

  // Controllo positivo del ramo ok:false NUOVO di questo task (Step 3): se
  // non sappiamo quale societa' e' attiva GIA' al momento di costruire
  // l'intestazione, il preventivo non si genera — non solo non si salva.
  it('societa attiva sconosciuta al momento di costruire l\'intestazione → non genera niente, nessuna scrittura', async () => {
    mockSocietaPerDocumento.mockResolvedValue({ ok: false, errore: 'connessione a supabase persa' })

    const out = await executeStudioTecnico('genera_preventivo_completo', input(), 'conv-test')

    expect(out).not.toContain('GENERATI CON SUCCESSO')
    expect(out).toMatch(/non so quale societa/i)
    expect(out).toContain('connessione a supabase persa')
    expect(mockInsertSpy).not.toHaveBeenCalled()
  })

  // CONTROLLO NEGATIVO: senza, un blocco che scatta SEMPRE passerebbe il
  // test sopra per il motivo sbagliato.
  it('CONTROLLO NEGATIVO: Restruktura attiva (coerente con l\'intestazione) → i tre documenti si salvano, nessun blocco', async () => {
    mockSocietaPerDocumento.mockResolvedValue({ ok: true, societa: RESTRUKTURA, esplicita: true })

    const out = await executeStudioTecnico('genera_preventivo_completo', input(), 'conv-test')

    expect(out).toContain('GENERATI CON SUCCESSO')
    expect(out).not.toContain('NON SALVATO')
    expect(mockInsertSpy).toHaveBeenCalledTimes(3)
  })

  it('scrittura (non verifica) fallita sul secondo documento: il messaggio dice cosa e\' successo davvero, non "nessuno dei tre"', async () => {
    // Societa' coerente: le VERIFICHE passano tutte e tre. Il guasto arriva
    // dopo, sulla SCRITTURA del secondo documento (il CME) — esattamente il
    // caso che il vecchio "si fermano insieme" dichiarava sbagliato.
    mockSocietaPerDocumento.mockResolvedValue({ ok: true, societa: RESTRUKTURA, esplicita: true })
    mockFalliScritturaAlNumero = 2

    const out = await executeStudioTecnico('genera_preventivo_completo', input(), 'conv-test')

    expect(out).not.toContain('GENERATI CON SUCCESSO')
    expect(out).not.toMatch(/nessuno dei tre/i)
    expect(out).toContain('connessione persa')
    // il preventivo (primo, gia' scritto quando il secondo fallisce) resta
    // salvato per davvero: il messaggio deve dirlo.
    expect(out).toMatch(/preventivo/i)
    // due insert tentati (preventivo riuscito, CME fallito): il quadro
    // economico non deve nemmeno essere stato provato.
    expect(mockInsertSpy).toHaveBeenCalledTimes(2)
  })
})
