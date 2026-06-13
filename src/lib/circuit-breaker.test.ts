import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectHallucination, isCompletedOrConditional, claimsArchiveCompletion, getActiveModel, invalidateCache, recordOutcome } from './circuit-breaker'

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

import { supabase } from './supabase'

describe('isCompletedOrConditional (guard force-action)', () => {
  it('true: lavoro già svolto o offerta condizionale (NON deve scattare force-action)', () => {
    const cases = [
      'Ho preparato il DDT. Se vuole glielo invio anche in PDF.',
      'Il documento è pronto. Glielo preparo anche in Word se vuole.',
      'Ho aggiornato la prima nota. Se mi conferma, lo invio subito al commercialista.',
      'Ecco il computo. Se preferisce lo controllo di nuovo voce per voce.',
      'Ho finito l\'analisi. La verifico ancora se ha dubbi.',
    ]
    for (const t of cases) expect(isCompletedOrConditional(t)).toBe(true)
  })

  it('true: offerta interrogativa (chiede conferma, non promette) → soppressa', () => {
    const cases = [
      'Vuole che invii la mail adesso?',
      'Lo invio adesso?',
      'Procedo?',
      'Vuole che cerchi il documento? ',
    ]
    for (const t of cases) expect(isCompletedOrConditional(t)).toBe(true)
  })

  it('false: vera promessa non mantenuta (force-action DEVE poter scattare)', () => {
    const cases = [
      'Ora cerco subito il file e le rispondo.',
      'Controllo nelle mail e torno con il risultato.',
      'Lo recupero adesso.',
    ]
    for (const t of cases) expect(isCompletedOrConditional(t)).toBe(false)
  })
})

describe('detectHallucination', () => {
  describe('promise pattern + 0 tool → true (hallucination)', () => {
    const cases = [
      'Ora lo cerco subito!',
      'Lo controllo per Lei.',
      'Ora cerco il DURC.',
      'Faccio subito.',
      'Vado a leggere il file.',
      'Verifico subito.',
      'La leggo e Le dico.',
      'Adesso cerco nelle cartelle.',
      'Ora verifico.',
      'Lo trovo io.',
      'Glielo cerco.',
      // RIMOSSO: 'Le invio il documento.' — "le" è articolo plurale, ora falso positivo con pattern rimosso
      'Creo subito una copia.',
      'Archivio subito il PDF.',
      // RIMOSSO: 'Cercherò il contratto.' — futuro non più rilevato via regex (gestito a livello prompt)
      'Vado a controllare.',
    ]
    cases.forEach(text => {
      it(`"${text.slice(0, 30)}..." → true`, () => {
        expect(detectHallucination(text, 0)).toBe(true)
      })
    })
  })

  describe('promise pattern + ≥1 tool → false (legitimate)', () => {
    it('promise con tool chiamato non è hallucination', () => {
      expect(detectHallucination('Ora lo cerco subito!', 1)).toBe(false)
    })
  })

  describe('no promise pattern → false', () => {
    const cases = [
      'Ho letto il file. Il DURC è regolare.',
      'Non ho trovato il documento richiesto.',
      'Le rispondo a momenti.',
      'Buongiorno Ingegnere.',
      'Il preventivo è pronto.',
      'Ho elaborato la richiesta.',
      'Glielo dico subito.',
      'Le faccio sapere.',
      // Regressioni: pattern rimossi — devono restare false
      'Il ponteggio è leggero.',             // "leggero" non deve triggerare futuro rimosso
      'Di solito salvo il file nella cartella.', // "salvo" senza avverbio d'immediatezza
      'Le fatture sono arrivate.',           // "le" articolo plurale
      // Futuro rimosso — non più rilevato
      'Cercherò il contratto.',
    ]
    cases.forEach(text => {
      it(`"${text.slice(0, 40)}..." → false`, () => {
        expect(detectHallucination(text, 0)).toBe(false)
      })
    })
  })
})

describe('claimsArchiveCompletion (anti-bugia archiviazione)', () => {
  describe('true: AFFERMA archiviazione completata (deve poter ri-promptare)', () => {
    const cases = [
      '✅ 12 foto archiviate in Celano',
      'Ho archiviato le foto nella cartella 2026-06-13',
      'Le ho spostate nella cartella massetto',
      'Foto e video salvati su Drive',
      '✅ Tutte e 4 le foto sono ora in Foto cantiere',
      'le ho messe nella cartella giusta',
    ]
    cases.forEach(text => {
      it(`"${text.slice(0, 40)}..." → true`, () => {
        expect(claimsArchiveCompletion(text)).toBe(true)
      })
    })
  })

  describe('false: NON è claim di archiviazione completata', () => {
    const cases = [
      'Ora archivio le foto',                       // promessa futura, non completamento
      'Vuoi che archivi le foto?',                  // domanda
      'Ho analizzato le foto: mostrano il massetto', // analisi, non archiviazione
      'Le foto non sono ancora state archiviate',   // negazione esplicita
      'Dimmi in quale cartella archiviare',         // richiesta, non completamento
      '',                                           // vuoto
    ]
    cases.forEach(text => {
      it(`"${text.slice(0, 40)}..." → false`, () => {
        expect(claimsArchiveCompletion(text)).toBe(false)
      })
    })
  })
})

describe('getActiveModel', () => {
  beforeEach(() => {
    invalidateCache()
    vi.clearAllMocks()
  })

  it('legge model_active dalla config', async () => {
    const fromMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({
          data: [
            { key: 'model_active', value: '"claude-opus-latest"' },
            { key: 'circuit_state', value: '{"state":"NORMAL","tripped_at":null,"reason":null,"canary_consecutive_ok":0}' },
          ],
          error: null,
        }),
      }),
    })
    ;(supabase.from as any).mockImplementation(fromMock)

    const model = await getActiveModel()
    expect(model).toBe('claude-opus-latest')
  })

  it('usa fallback se Supabase ritorna errore', async () => {
    const fromMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({
          data: null,
          error: new Error('connection lost'),
        }),
      }),
    })
    ;(supabase.from as any).mockImplementation(fromMock)

    const model = await getActiveModel()
    expect(model).toBe('claude-sonnet-4-6')
  })

  it('cache la seconda chiamata entro 60s', async () => {
    const inMock = vi.fn().mockResolvedValue({
      data: [{ key: 'model_active', value: '"test-model"' }],
      error: null,
    })
    const fromMock = vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({ in: inMock }),
    })
    ;(supabase.from as any).mockImplementation(fromMock)

    await getActiveModel()
    await getActiveModel()
    expect(inMock).toHaveBeenCalledTimes(1)
  })
})

describe('recordOutcome — threshold', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invalidateCache()
  })

  function mockSelectReturning(rows: { outcome: string }[]) {
    const insertMock = vi.fn().mockReturnValue({
      then: (cb: (arg: { error: null }) => void) => { cb({ error: null }); return Promise.resolve() },
    })
    const limitMock = vi.fn().mockResolvedValue({ data: rows, error: null })
    const orderMock = vi.fn().mockReturnValue({ limit: limitMock })
    const eqCanary = vi.fn().mockReturnValue({ order: orderMock })
    const eqModel = vi.fn().mockReturnValue({ eq: eqCanary })
    const selectMock = vi.fn().mockReturnValue({ eq: eqModel })
    ;(supabase.from as any).mockImplementation(() => ({
      insert: insertMock,
      select: selectMock,
    }))
    return { insertMock, limitMock }
  }

  it('skippa threshold check se outcome=success', async () => {
    const { limitMock } = mockSelectReturning([])
    await recordOutcome('claude-opus-latest', 'success')
    expect(limitMock).not.toHaveBeenCalled()
  })

  it('skippa threshold check se canary', async () => {
    const { limitMock } = mockSelectReturning([])
    await recordOutcome('claude-opus-latest', 'empty', { isCanary: true })
    expect(limitMock).not.toHaveBeenCalled()
  })

  it('non scatta breaker con sample insufficiente (<5)', async () => {
    mockSelectReturning([
      { outcome: 'force_text' },
      { outcome: 'force_text' },
    ])
    await expect(recordOutcome('claude-opus-latest', 'empty')).resolves.not.toThrow()
  })

  it('verifica che threshold check si attiva con 5 sample', async () => {
    const { limitMock } = mockSelectReturning([
      { outcome: 'success' },
      { outcome: 'success' },
      { outcome: 'success' },
      { outcome: 'success' },
      { outcome: 'success' },
    ])
    await recordOutcome('claude-opus-latest', 'empty')
    expect(limitMock).toHaveBeenCalled()
  })
})
