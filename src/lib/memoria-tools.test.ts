import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock Supabase
// NOTA: mockInsert qui rappresenta il risultato finale di `.insert(...).select('id')`.
// Il source di `ricorda` fa: supabase.from(...).insert({...}).select('id')
// quindi il mock di insert deve ritornare un oggetto con `.select()` che ritorna
// la Promise risolta da `mockInsert`. Usiamo il pattern: insert() → { select() → Promise }.
const mockInsert = vi.fn()
const mockSelect = vi.fn()
const mockEq = vi.fn()
const mockMaybeSingle = vi.fn()
const mockIlike = vi.fn()
const mockOrder = vi.fn()
const mockLimit = vi.fn()
const mockDelete = vi.fn()
const mockOr = vi.fn()

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      // insert(...) ritorna un oggetto chainabile { select(cols) → Promise<insertResult> }
      insert: vi.fn(() => ({
        select: vi.fn(() => mockInsert()),
      })),
      select: mockSelect,
      delete: mockDelete,
    })),
  },
}))

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: vi.fn(() => ({
    from: vi.fn(() => ({
      insert: vi.fn(() => ({
        select: vi.fn(() => mockInsert()),
      })),
      select: mockSelect,
      delete: mockDelete,
    })),
  })),
}))

// Patch chaining
beforeEach(() => {
  vi.clearAllMocks()
  // mockInsert è chiamato come funzione dentro .select() → ritorna la Promise finale.
  // I test possono usare mockInsert.mockResolvedValueOnce(...) per simulare errori/ok.
  mockInsert.mockResolvedValue({ data: [{ id: 'test-uuid-1234' }], error: null })
  // select() del read-path: ritorna oggetto con eq/ilike/order (tutti i metodi che il source può chiamare dopo .select())
  mockSelect.mockReturnValue({ eq: mockEq, ilike: mockIlike, order: mockOrder, or: mockOr })
  mockOr.mockReturnValue({ order: mockOrder, limit: mockLimit, ilike: mockIlike })
  mockEq.mockReturnValue({ maybeSingle: mockMaybeSingle, order: mockOrder, ilike: mockIlike, limit: mockLimit })
  mockMaybeSingle.mockResolvedValue({ data: null, error: null })
  mockIlike.mockReturnValue({ order: mockOrder, limit: mockLimit })
  // order() può essere seguito da limit() o eq() (lista_entita: select.order.eq.limit)
  mockOrder.mockReturnValue({ limit: mockLimit, eq: mockEq })
  mockLimit.mockResolvedValue({ data: [], error: null })
  mockDelete.mockReturnValue({ eq: vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue({ data: [], error: null }) }) })
})

describe('ricorda', () => {
  it('inserisce correttamente nella tabella', async () => {
    const { ricorda } = await import('./memoria-tools')
    const result = await ricorda({ testo: 'Test memoria', tag: 'cliente' })
    expect(result.ok).toBe(true)
    expect(result.id).toBeDefined()
  })

  it('fallisce con errore Supabase', async () => {
    mockInsert.mockResolvedValueOnce({ data: null, error: { message: 'DB error' } })
    const { ricorda } = await import('./memoria-tools')
    const result = await ricorda({ testo: 'Test' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('DB error')
  })

  it('richiede testo non vuoto', async () => {
    const { ricorda } = await import('./memoria-tools')
    const result = await ricorda({ testo: '' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('testo')
  })
})

describe('richiama_memoria', () => {
  it('ritorna risultati espliciti se presenti (L1 prima)', async () => {
    mockLimit.mockResolvedValueOnce({
      data: [{ id: 'uuid-1', contenuto: 'Cliente Bianchi accordo 15k', tag: 'cliente', created_at: '2026-05-06T10:00:00Z' }],
      error: null,
    })
    const { richiama_memoria } = await import('./memoria-tools')
    const result = await richiama_memoria({ query: 'Bianchi', tipo_filtro: 'esplicita' })
    expect(result.ok).toBe(true)
    expect(result.results[0].livello).toBe('esplicita')
    expect(result.results[0].testo).toContain('Bianchi')
  })

  it('ritorna array vuoto se nessun risultato', async () => {
    mockLimit.mockResolvedValue({ data: [], error: null })
    const { richiama_memoria } = await import('./memoria-tools')
    const result = await richiama_memoria({ query: 'query inesistente xyz', tipo_filtro: 'tutto' })
    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(0)
  })

  it('gestisce errore DB gracefully', async () => {
    mockLimit.mockResolvedValue({ data: null, error: { message: 'DB error' } })
    const { richiama_memoria } = await import('./memoria-tools')
    const result = await richiama_memoria({ query: 'test' })
    expect(result.ok).toBe(false)
  })
})

/**
 * La ricerca metteva la domanda INTERA dentro un ILIKE: chiedendo
 * "le due lettere di risposta per Blasi" pretendeva quella sequenza letterale
 * e non trovava mai nulla, e il bot rispondeva "non ho memoria" in buona fede.
 *
 * NB sulla non-vacuità: con i mock il filtro non viene davvero applicato, quindi
 * asserire "trova risultati" non proverebbe nulla. Si asserisce invece SUL FILTRO
 * che viene passato a Supabase, che è la cosa realmente cambiata.
 */
describe('richiama_memoria — ricerca per parole, non per frase', () => {
  it('spezza la domanda in parole invece di cercare la frase intera', async () => {
    const { richiama_memoria } = await import('./memoria-tools')
    await richiama_memoria({ query: 'le due lettere di risposta per Blasi', tipo_filtro: 'esplicita' })

    expect(mockOr).toHaveBeenCalled()
    const filtro = String(mockOr.mock.calls[0][0])

    // deve cercare la parola significativa...
    expect(filtro).toContain('blasi')
    // ...e non la frase intera come sequenza letterale
    expect(filtro).not.toContain('le due lettere di risposta per Blasi')
  })

  it('scarta le paroline corte e si ferma a sei parole', async () => {
    const { buildSearchTokens } = await import('./memoria-tools')
    expect(buildSearchTokens('le due lettere di risposta per Blasi Giuseppe'))
      .toEqual(['due', 'lettere', 'risposta', 'per', 'blasi', 'giuseppe'])
  })

  it('neutralizza i caratteri jolly nelle parole', async () => {
    const { buildSearchTokens } = await import('./memoria-tools')
    expect(buildSearchTokens('100% Blasi_x')).toEqual(['100\\%', 'blasi\\_x'])
  })

  it('con sole paroline corte ricade sulla query intera', async () => {
    const { richiama_memoria } = await import('./memoria-tools')
    await richiama_memoria({ query: 'e la', tipo_filtro: 'esplicita' })

    expect(mockOr).not.toHaveBeenCalled()
    expect(mockIlike).toHaveBeenCalled()
  })
})

describe('riepilogo_giorno — parser data', () => {
  // Freezare data: 2026-05-07 (mercoledì)
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-05-07T10:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('oggi → 2026-05-07', async () => {
    const { parseDateInput } = await import('./memoria-tools')
    expect(parseDateInput('oggi')).toBe('2026-05-07')
  })

  it('ieri → 2026-05-06', async () => {
    const { parseDateInput } = await import('./memoria-tools')
    expect(parseDateInput('ieri')).toBe('2026-05-06')
  })

  it('lunedi-scorso → 2026-05-04', async () => {
    const { parseDateInput } = await import('./memoria-tools')
    expect(parseDateInput('lunedi-scorso')).toBe('2026-05-04')
  })

  it('venerdi-scorso → 2026-05-01', async () => {
    const { parseDateInput } = await import('./memoria-tools')
    expect(parseDateInput('venerdi-scorso')).toBe('2026-05-01')
  })

  it('data ISO pass-through → 2026-05-05', async () => {
    const { parseDateInput } = await import('./memoria-tools')
    expect(parseDateInput('2026-05-05')).toBe('2026-05-05')
  })

  it('riepilogo_giorno chiama supabase con data corretta', async () => {
    mockEq.mockReturnValueOnce({ maybeSingle: vi.fn().mockResolvedValue({
      data: { data: '2026-05-06', summary_text: 'Test summary', message_count: 5 },
      error: null
    })})
    const { riepilogo_giorno } = await import('./memoria-tools')
    const result = await riepilogo_giorno({ data: 'ieri' })
    expect(result.ok).toBe(true)
    expect(result.data_iso).toBe('2026-05-06')
    expect(result.summary_text).toBe('Test summary')
  })
})

describe('lista_entita', () => {
  it('ritorna lista clienti filtrata per tipo', async () => {
    mockLimit.mockResolvedValueOnce({
      data: [
        { name: 'Bianchi Srl', type: 'cliente', last_seen_at: '2026-05-06', mention_count: 3 },
        { name: 'Rossi Mario', type: 'cliente', last_seen_at: '2026-05-05', mention_count: 1 },
      ],
      error: null,
    })
    const { lista_entita } = await import('./memoria-tools')
    const result = await lista_entita({ tipo: 'cliente' })
    expect(result.ok).toBe(true)
    expect(result.entita).toHaveLength(2)
    expect(result.entita[0].name).toBe('Bianchi Srl')
  })

  it('ritorna tutti i tipi se tipo non specificato', async () => {
    mockLimit.mockResolvedValueOnce({ data: [], error: null })
    const { lista_entita } = await import('./memoria-tools')
    const result = await lista_entita({})
    expect(result.ok).toBe(true)
  })
})
