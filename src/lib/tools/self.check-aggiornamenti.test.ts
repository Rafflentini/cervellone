/**
 * Il percorso che SCRIVE i modelli in produzione non aveva un solo test.
 *
 * L'audit lo ha misurato: 5 mutazioni su 5 sopravvivevano all'intera suite di
 * 1389 test. Cambiando UNA parola — `migliorePerFamiglia(claudeModels, 'opus')`
 * in `'fable'` — `model_complex` sarebbe diventato claude-fable-5-1 (10$/50$ per
 * milione di token, il doppio di Opus), scritto in `cervellone_config` con
 * `applica=true` di default, e la suite sarebbe rimasta verde al 100%.
 *
 * Il P0 non c'era, ma l'unica cosa che lo teneva fuori era una stringa letterale
 * che nessun test difendeva. Questi test difendono quella stringa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const updates: Array<{ table: string; col: string; key: string; value: unknown }> = []
let configRows: Array<{ key: string; value: string }> = []

// Il mock registra TABELLA e COLONNA, non solo il valore: ignorandoli, un
// `.from('tabella_inesistente')` passava con 1399 test verdi — cioe' il file
// che dichiara di difendere "il percorso che scrive in produzione" difendeva
// i valori calcolati, non la scrittura.
vi.mock('../supabase', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        order: async () => ({ data: configRows }),
        // check_aggiornamenti legge la config senza order()
        then: (res: (v: unknown) => unknown) => Promise.resolve(res({ data: configRows })),
        neq: () => ({ order: () => ({ limit: async () => ({ data: [] }) }) }),
      }),
      update: (payload: { value: unknown }) => ({
        eq: async (col: string, key: string) => {
          updates.push({ table, col, key, value: payload.value })
          return { error: null }
        },
      }),
      insert: async () => ({ error: null }),
    }),
  },
}))
vi.mock('../telegram-helpers', () => ({ sendTelegramMessage: async () => {} }))
vi.mock('../circuit-breaker', () => ({ promoteModel: async () => '' }))
// Il ramo che SCRIVE fa `await import('../claude')` per invalidare le cache:
// senza questo mock il test tira dentro l'intero motore (SDK Anthropic, tool,
// env) e va in timeout — cioe' proprio i due test che coprono la scrittura.
vi.mock('../claude', () => ({
  invalidateConfigCache: () => {},
  invalidateModelCapsCache: () => {},
}))

import { executeSelfTools } from './self'

/**
 * Elenco reale di /v1/models al 2 settembre 2026, Fable incluso, PIU' due voci
 * che il filtro `claude-` / `embed` scarta. Senza almeno un id scartato, il
 * conteggio grezzo coincide con quello filtrato e l'avviso sui modelli tolti dal
 * filtro non viene mai esercitato — cioe' il difetto principale corretto qui
 * resterebbe scoperto.
 */
const MODELLI = [
  { id: 'claude-fable-5-1', created_at: '2026-08-28T00:00:00Z' },
  { id: 'claude-opus-5', created_at: '2026-07-24T00:00:00Z' },
  { id: 'claude-sonnet-5', created_at: '2026-06-30T00:00:00Z' },
  { id: 'claude-fable-5', created_at: '2026-06-10T00:00:00Z' },
  { id: 'claude-opus-4-8', created_at: '2026-05-20T00:00:00Z' },
  { id: 'claude-haiku-4-5-20251001', created_at: '2025-10-01T00:00:00Z' },
  { id: 'voyage-3-embed', created_at: '2026-01-01T00:00:00Z' },
  { id: 'us.anthropic.claude-opus-5-v1', created_at: '2026-07-24T00:00:00Z' },
]
const SCARTATI_DAL_FILTRO = 2

function mockFetch(body: Record<string, unknown>, ok = true) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  })))
}

beforeEach(() => {
  updates.length = 0
  configRows = [
    { key: 'model_default', value: 'claude-sonnet-4-6' },
    { key: 'model_complex', value: 'claude-opus-4-7' },
    { key: 'model_digest', value: 'claude-sonnet-4-6' },
  ]
  vi.unstubAllGlobals()
})

describe('check_aggiornamenti — cosa scrive davvero in configurazione', () => {
  it('promuove al miglior SONNET per la conversazione, mai a fable', async () => {
    mockFetch({ data: MODELLI })

    await executeSelfTools('cervellone_check_aggiornamenti', { applica: true })

    const def = updates.find(u => u.key === 'model_default')
    expect(def?.value).toBe('claude-sonnet-5')
    // il vincolo che conta: fable non deve finire in NESSUNA chiave
    for (const u of updates) expect(String(u.value)).not.toContain('fable')
    // e la scrittura deve andare dove serve: tabella e colonna, non solo il valore
    expect(def?.table).toBe('cervellone_config')
    expect(def?.col).toBe('key')
  })

  it('avvisa dei modelli che il filtro ha tolto dall elenco', async () => {
    // Il totale era contato DOPO il filtro: copriva il raggruppamento, non il
    // filtro, cioe' proprio il punto in cui un id sparisce in silenzio.
    mockFetch({ data: MODELLI })

    const out = await executeSelfTools('cervellone_check_aggiornamenti', { applica: false })

    expect(out).toContain(`${MODELLI.length - SCARTATI_DAL_FILTRO} su ${MODELLI.length}`)
    expect(out).toContain('NON sono in questo elenco')
  })

  it('il report descrive i modelli in uso ORA, non quelli proposti', async () => {
    // Derivando le famiglie dai valori NUOVI, con un cambio in sospeso il report
    // diceva "non uso fable" a tre righe da "model_complex: claude-fable-5-1".
    configRows = [
      { key: 'model_default', value: 'claude-sonnet-5' },
      { key: 'model_complex', value: 'claude-fable-5-1' },
      { key: 'model_digest', value: 'claude-sonnet-5' },
    ]
    mockFetch({ data: MODELLI })

    const out = await executeSelfTools('cervellone_check_aggiornamenti', { applica: false })

    // fable e' in uso adesso: non puo' comparire fra le famiglie "non usate"
    expect(out).not.toMatch(/configurazione non usa:.*\bfable\b/)
  })

  it('promuove al miglior OPUS per i task pesanti, mai a fable', async () => {
    mockFetch({ data: MODELLI })

    await executeSelfTools('cervellone_check_aggiornamenti', { applica: true })

    expect(updates.find(u => u.key === 'model_complex')?.value).toBe('claude-opus-5')
  })

  it('con applica=false non scrive niente', async () => {
    mockFetch({ data: MODELLI })

    const out = await executeSelfTools('cervellone_check_aggiornamenti', { applica: false })

    expect(updates).toHaveLength(0)
    expect(out).toContain('claude-sonnet-5') // il report c'e' comunque
  })

  it('se l elenco e incompleto NON promuove, e lo dice', async () => {
    // Dire "questo elenco non e' completo" e promuovere sulla sua base nello
    // stesso respiro era incoerente: se non basta per concludere, non basta
    // nemmeno per scrivere.
    mockFetch({ data: MODELLI, has_more: true })

    const out = await executeSelfTools('cervellone_check_aggiornamenti', { applica: true })

    expect(updates).toHaveLength(0)
    expect(out).toContain('NON è completo')
  })

  it('il report mostra Fable, che il codice vecchio nascondeva', async () => {
    mockFetch({ data: MODELLI })

    const out = await executeSelfTools('cervellone_check_aggiornamenti', { applica: false })

    expect(out).toContain('claude-fable-5-1')
    expect(out).toContain('non le sto usando, è diverso')
  })

  it('un errore dell API non viene scambiato per "nessun modello"', async () => {
    mockFetch({}, false)

    const out = await executeSelfTools('cervellone_check_aggiornamenti', { applica: true })

    expect(out).toContain('Errore API Anthropic')
    expect(updates).toHaveLength(0)
  })
})
