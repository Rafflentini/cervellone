/**
 * `promuovi_modello` non deve poter uccidere il bot.
 *
 * Fino al 2 settembre 2026 l'unico controllo era `newDefault.startsWith('claude-')`:
 * nessuna allowlist, nessun confronto con /v1/models, nessuna chiamata di prova.
 * Il 1 settembre il bot ha tentato davvero di promuovere `claude-fable-5-1`
 * (che per fortuna esiste) convinto da un elenco di modelli mutilato dal suo
 * stesso strumento di verifica. Con un id inventato sarebbe passato lo stesso.
 *
 * Cosa sarebbe successo: model_default e model_active riscritti, ogni chiamata
 * successiva 404. Telegram si auto-salva dopo ~5 messaggi (il circuit breaker
 * traccia gli outcome e fa rollback), ma la chat WEB non e' coperta dal breaker
 * e sarebbe rimasta rotta a tempo indeterminato — fino a che qualcuno non
 * digita /sonnet su Telegram.
 *
 * L'API dei modelli e' gia' raggiungibile e autoritativa: si chiede a lei.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const updates: Array<{ key: string; value: unknown }> = []

vi.mock('./supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        in: async () => ({ data: [
          { key: 'model_default', value: 'claude-sonnet-5' },
          { key: 'model_stable', value: 'claude-sonnet-4-6' },
        ] }),
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
      update: (payload: { value: unknown }) => ({
        eq: async (_c: string, key: string) => { updates.push({ key, value: payload.value }); return { error: null } },
      }),
      upsert: async () => ({ error: null }),
    }),
  },
}))
vi.mock('./telegram-helpers', () => ({ sendTelegramMessage: async () => {} }))

import { promoteModel } from './circuit-breaker'

const MODELLI_VERI = [
  { id: 'claude-fable-5-1' },
  { id: 'claude-opus-5' },
  { id: 'claude-sonnet-5' },
  { id: 'claude-haiku-4-5-20251001' },
  // Presente APPOSTA: senza, il test sul prefisso "claude-" sarebbe verde
  // perche' l'id manca dall'elenco, non perche' il prefisso venga controllato.
  { id: 'gpt-5' },
]

function mockModelsApi(
  models: Array<{ id: string }> | null,
  opts: { ok?: boolean; status?: number; hasMore?: boolean } = {},
) {
  const ok = opts.ok ?? true
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok,
    status: opts.status ?? (ok ? 200 : 500),
    json: async () => ({ data: models ?? [], has_more: opts.hasMore }),
  })))
}

beforeEach(() => {
  updates.length = 0
  vi.unstubAllGlobals()
})

describe('promoteModel — validazione dell id', () => {
  it('rifiuta una variante inventata di un id reale, dicendo che NON esiste', async () => {
    // Il modo esatto in cui il bot ha sbagliato: ha costruito una versione
    // plausibile di un nome vero.
    // L'asserzione sul MESSAGGIO non e' cosmetica: senza, "non esiste" e "non
    // ho potuto verificare" sarebbero indistinguibili, e un difetto che
    // trasforma il primo nel secondo passerebbe inosservato.
    mockModelsApi(MODELLI_VERI)

    await expect(promoteModel('claude-opus-5-1')).rejects.toThrow(/NON esiste/)
    expect(updates).toHaveLength(0)
  })

  it('un elenco VUOTO non e la prova che il modello non esista', async () => {
    // 200 con un body inatteso (schema cambiato, campo rinominato) produceva
    // "Il modello NON esiste... Modelli disponibili: (nessuno)": una falsa
    // dichiarazione di inesistenza presentata come autorevole, cioe' lo stesso
    // "elenco mutilato" dell'incidente Fable.
    mockModelsApi([])

    await expect(promoteModel('claude-opus-5')).rejects.toThrow(/Non ho potuto verificare/)
    expect(updates).toHaveLength(0)
  })

  it('con elenco troncato non dichiara inesistenze', async () => {
    mockModelsApi(MODELLI_VERI, { hasMore: true })

    await expect(promoteModel('claude-qualcosa-9')).rejects.toThrow(/INCOMPLETO/)
    expect(updates).toHaveLength(0)
  })

  it('una chiave API mancante non viene spacciata per problema di rete', async () => {
    // "Riprova fra poco" non risolvera' mai una variabile d'ambiente assente.
    mockModelsApi(null, { ok: false, status: 401 })

    await expect(promoteModel('claude-opus-5')).rejects.toThrow(/ANTHROPIC_API_KEY/)
    expect(updates).toHaveLength(0)
  })

  it('promuove un modello che esiste davvero', async () => {
    mockModelsApi(MODELLI_VERI)

    const res = await promoteModel('claude-opus-5')

    expect(res.newDefault).toBe('claude-opus-5')
    expect(updates.find(u => u.key === 'model_default')?.value).toBe('claude-opus-5')
    // il default di prima diventa il fallback
    expect(updates.find(u => u.key === 'model_stable')?.value).toBe('claude-sonnet-5')
  })

  it('se non riesce a verificare, NON promuove', async () => {
    // Fail closed: il costo di un rifiuto sbagliato e' "riprova", quello di
    // un'accettazione sbagliata e' la chat web ferma a tempo indeterminato.
    // NB: il body e' VALIDO e contiene il modello. Cosi' l'unica ragione per
    // cui il test puo' passare e' il controllo sullo stato HTTP. Con un body
    // vuoto sarebbe la guardia sulla lista a salvarlo, e togliere il controllo
    // su `res.ok` non farebbe fallire niente.
    mockModelsApi(MODELLI_VERI, { ok: false, status: 500 })

    await expect(promoteModel('claude-opus-5')).rejects.toThrow(/Non ho potuto verificare/)
    expect(updates).toHaveLength(0)
  })

  it('chiede l elenco completo, non la prima pagina di default', async () => {
    // Senza `limit`, l'API pagina col default e un modello valido puo' restare
    // fuori pagina: la verifica lo rifiuterebbe pur esistendo.
    mockModelsApi(MODELLI_VERI)

    await promoteModel('claude-opus-5')

    const url = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]
    expect(String(url)).toContain('limit=100')
  })

  it('rifiuta chi non inizia per claude- ANCHE se l API lo elenca', async () => {
    // `gpt-5` e' dentro MODELLI_VERI apposta: cosi' l'unico motivo per cui
    // questo test puo' passare e' il controllo sul prefisso.
    mockModelsApi(MODELLI_VERI)

    await expect(promoteModel('gpt-5')).rejects.toThrow(/claude-/)
    expect(updates).toHaveLength(0)
  })
})
