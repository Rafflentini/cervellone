/**
 * I due tool per recuperare la memoria delle giornate perdute.
 *
 * Nascono da una misura del 3 settembre 2026 sul database di produzione:
 * **30 giornate con messaggi, 28 col riassunto "Nessuna attività rilevante",
 * 927 messaggi** archiviati come giornate vuote — fra cui il 17 agosto (74
 * messaggi) e il 5 agosto (66, il caso Blasi).
 *
 * Sono tool e non comandi slash per una ragione precisa: `getToolDefinitions()`
 * non conosce i canali, quindi un tool nasce disponibile su Telegram E sulla
 * chat web insieme — equipollente per costruzione, invece che per disciplina.
 * Vedi [[feedback_due_canali_equipollenti]].
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRunExtract = vi.fn()
vi.mock('../memoria-extract', () => ({
  runMemoriaExtract: (...a: unknown[]) => mockRunExtract(...a),
}))

// Catena Supabase pilotabile: `select(...)` ritorna un oggetto che sa fare
// gt/order (elenco) oppure eq/maybeSingle (lettura di una riga).
let righeSummary: Array<{ data: string; message_count: number; summary_text: string }> = []
let rigaSingola: { summary_text: string; message_count: number } | null = null
let erroreLettura: { message: string } | null = null

vi.mock('../supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        gt: () => ({
          order: async () => ({ data: righeSummary, error: erroreLettura }),
        }),
        eq: () => ({ maybeSingle: async () => ({ data: rigaSingola, error: null }) }),
        order: async () => ({ data: [], error: null }),
      }),
      insert: async () => ({ error: null }),
      upsert: async () => ({ error: null }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
  },
}))
vi.mock('../telegram-helpers', () => ({ sendTelegramMessage: async () => undefined }))

import { SELF_TOOLS, executeSelfTools } from './self'

beforeEach(() => {
  vi.clearAllMocks()
  righeSummary = []
  rigaSingola = null
  erroreLettura = null
  mockRunExtract.mockResolvedValue({ ok: true, conversations: 1, entities: 3, tokens: 900, cost_usd: 0.1018 })
})

describe('i due tool esistono e sono descritti al modello', () => {
  it('sono registrati fra i tool disponibili', () => {
    const nomi = SELF_TOOLS.map((t) => t.name)
    expect(nomi).toContain('memoria_giornate_da_rielaborare')
    expect(nomi).toContain('memoria_rielabora')
  })

  it('la descrizione dice al modello QUANDO usarli, non solo cosa fanno', () => {
    // Un tool che il modello non sa quando invocare e' un tool che non esiste:
    // e' la stessa lezione di `crea_procedura`, mai chiamato per settimane.
    const rielabora = SELF_TOOLS.find((t) => t.name === 'memoria_rielabora')!
    expect(rielabora.description).toMatch(/quando/i)
    // Deve dire che costa e che va una giornata per volta, o il modello ne
    // lancerebbe venti di fila.
    expect(rielabora.description).toMatch(/cost|centesim/i)
  })
})

describe('memoria_giornate_da_rielaborare', () => {
  it('trova le giornate che DICONO "nessuna attivita" pur avendo messaggi', async () => {
    // Il punto: quelle righe non sono vuote. Un filtro su null/'' non ne
    // troverebbe nemmeno una — e' il difetto di misura che ha nascosto il
    // guasto per mesi.
    righeSummary = [
      { data: '2026-08-17', message_count: 74, summary_text: 'Nessuna attività rilevante' },
      { data: '2026-08-13', message_count: 58, summary_text: 'Nessuna attività rilevante | Nessuna attività rilevante' },
      { data: '2026-08-20', message_count: 62, summary_text: 'L\'ingegnere ha chiesto del caso Blasi Giuseppe...' },
    ]

    const out = await executeSelfTools('memoria_giornate_da_rielaborare', {})

    expect(out).toContain('2026-08-17')
    expect(out).toContain('2026-08-13')
    // La giornata con un riassunto VERO non va rielaborata.
    expect(out).not.toContain('2026-08-20')
    // Il totale dei messaggi va detto: "2 giornate" e "132 messaggi" non
    // pesano allo stesso modo.
    expect(out).toContain('132')
  })

  it('riconosce anche il marcatore di fallimento nuovo', async () => {
    righeSummary = [
      { data: '2026-09-04', message_count: 20, summary_text: '⚠️ Estrazione non riuscita: 20 messaggi in 1 conversazioni, nessun riassunto prodotto. Da rielaborare.' },
    ]

    const out = await executeSelfTools('memoria_giornate_da_rielaborare', {})

    expect(out).toContain('2026-09-04')
  })

  it('quando non c e niente da fare lo dice, invece di restituire una lista vuota', async () => {
    righeSummary = [{ data: '2026-08-20', message_count: 62, summary_text: 'Riassunto vero della giornata' }]

    const out = await executeSelfTools('memoria_giornate_da_rielaborare', {})

    expect(out).toContain('Nessuna giornata da rielaborare')
  })

  it('un errore di lettura non viene spacciato per "tutto a posto"', async () => {
    erroreLettura = { message: 'permission denied' }

    const out = await executeSelfTools('memoria_giornate_da_rielaborare', {})

    expect(out).toContain('Non riesco a leggere')
    expect(out).not.toContain('Nessuna giornata da rielaborare')
  })
})

describe('memoria_rielabora', () => {
  it('rielabora la giornata chiesta, forzando la sovrascrittura', async () => {
    rigaSingola = { summary_text: 'Contenzioso Blasi Giuseppe: verificato saldo fattura.', message_count: 66 }

    const out = await executeSelfTools('memoria_rielabora', { data: '2026-08-05' })

    // forced=true: senza, l'idempotenza rifiuterebbe la rielaborazione E il
    // segnaposto del cron verrebbe spostato su una giornata passata.
    expect(mockRunExtract).toHaveBeenCalledWith('2026-08-05', true)
    expect(out).toContain('✅')
    // Deve riportare cosa e' USCITO, non solo che il comando e' andato.
    expect(out).toContain('Contenzioso Blasi Giuseppe')
    expect(out).toContain('entità estratte: 3')
  })

  it('se non e uscito niente lo DICE, invece di dichiarare "fatto"', async () => {
    // E' la regola della giornata: un "fatto" su un riassunto ancora vuoto e'
    // la stessa bugia che si sta curando, un piano piu' in alto.
    rigaSingola = { summary_text: '⚠️ Estrazione non riuscita: 66 messaggi in 1 conversazioni, nessun riassunto prodotto. Da rielaborare.', message_count: 66 }

    const out = await executeSelfTools('memoria_rielabora', { data: '2026-08-05' })

    expect(out).toContain('⚠️')
    expect(out).toContain('NON è uscito niente')
    expect(out).not.toContain('✅')
  })

  it('rifiuta una data malformata senza spendere una chiamata al modello', async () => {
    const out = await executeSelfTools('memoria_rielabora', { data: '5 agosto' })

    expect(out).toContain('YYYY-MM-DD')
    expect(mockRunExtract).not.toHaveBeenCalled()
  })

  it('rifiuta oggi e il futuro: la giornata non e ancora chiusa', async () => {
    const oggi = new Date().toISOString().slice(0, 10)

    const out = await executeSelfTools('memoria_rielabora', { data: oggi })

    expect(out).toContain('non è ancora una giornata chiusa')
    expect(mockRunExtract).not.toHaveBeenCalled()
  })

  it('un fallimento dell estrazione arriva all utente col motivo', async () => {
    mockRunExtract.mockResolvedValue({ ok: false, conversations: 0, entities: 0, tokens: 0, cost_usd: 0, error: 'Insert run: permission denied' })

    const out = await executeSelfTools('memoria_rielabora', { data: '2026-08-05' })

    expect(out).toContain('fallita')
    expect(out).toContain('permission denied')
  })
})
