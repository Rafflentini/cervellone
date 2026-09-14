import { describe, it, expect, vi, beforeEach } from 'vitest'

const { rpc, getSupabaseServer } = vi.hoisted(() => {
  const rpc = vi.fn()
  const getSupabaseServer = vi.fn(() => ({ rpc }))
  return { rpc, getSupabaseServer }
})
vi.mock('@/lib/supabase-server', () => ({ getSupabaseServer }))

import { fotografaSchema } from './deriva-schema-db'

beforeEach(() => {
  rpc.mockReset()
  getSupabaseServer.mockReset()
  getSupabaseServer.mockReturnValue({ rpc })
})

describe('fotografaSchema - e se non riesce, LO DICE', () => {
  it('traduce la risposta della rpc in una Fotografia', async () => {
    rpc.mockResolvedValue({
      data: {
        tabelle: ['procedures'],
        colonne: ['procedures.output_preferences'],
        chiaviPrimarie: { gmail_processed_messages: ['bot_action', 'message_id'] },
        indici: ['idx_x'],
        chiaviConfig: ['working_memory_enabled'],
      },
      error: null,
    })

    const e = await fotografaSchema()
    expect(e.ok).toBe(true)
    if (e.ok) expect(e.foto.colonne).toContain('procedures.output_preferences')
  })

  it('se la rpc fallisce NON torna una fotografia vuota: torna un ERRORE', async () => {
    // Una fotografia vuota non equivale a "ho guardato": sarebbe un falso
    // responso mascherato da controllo.
    rpc.mockResolvedValue({ data: null, error: { message: 'function public.fotografia_schema() does not exist' } })

    const e = await fotografaSchema()
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.errore).toContain('fotografia_schema')
  })

  it('anche una risposta VUOTA o malformata e un errore, non una fotografia', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    expect((await fotografaSchema()).ok).toBe(false)

    rpc.mockResolvedValue({ data: { tabelle: 'non-un-array' }, error: null })
    expect((await fotografaSchema()).ok).toBe(false)
  })

  it('la rpc che solleva non fa esplodere il chiamante', async () => {
    getSupabaseServer.mockImplementation(() => { throw new Error('rete giu') })
    const e = await fotografaSchema()
    expect(e.ok).toBe(false)
  })
})

describe('la fotografia VUOTA non e una fotografia (audit 14 set 2026)', () => {
  it('🚨 zero tabelle e un ERRORE, non un database senza niente', () => {
    // Prima della cura questa risposta passava i controlli (array vuoti sono
    // `string[]` legittimi) e il guardiano urlava «DERIVA: 493 su 493 non
    // esistono» — indistinguibile da «non ho potuto guardare», che e' proprio
    // la confusione che questo file esiste per evitare.
    // Un database senza nemmeno una tabella non esiste: se la rpc ne dichiara
    // zero, quello che e' rotto e' il controllo, non lo schema.
    rpc.mockResolvedValue({
      data: { tabelle: [], colonne: [], indici: [], chiaviConfig: [], chiaviPrimarie: {} },
      error: null,
    })

    return fotografaSchema().then((e) => {
      expect(e.ok).toBe(false)
      if (!e.ok) expect(e.errore).toContain('NON so dire')
    })
  })

  it('🚨 una voce di chiave primaria malformata e un ERRORE, non una voce da saltare', async () => {
    // `if (c) chiaviPrimarie[…] = c` la scartava in silenzio, e il confronto
    // leggeva l'assenza come «manca la chiave primaria»: un falso allarme che
    // nasce dentro lo strumento che serve a trovare i guasti.
    rpc.mockResolvedValue({
      data: {
        tabelle: ['procedures'],
        colonne: ['procedures.id'],
        indici: [],
        chiaviConfig: [],
        chiaviPrimarie: { procedures: 'id' },
      },
      error: null,
    })

    const e = await fotografaSchema()
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.errore).toContain('procedures')
  })

  it('CONTROLLO POSITIVO: una fotografia con almeno una tabella resta valida', async () => {
    // Senza questo, un `fotografaSchema` che rifiutasse tutto passerebbe i due
    // test qui sopra.
    rpc.mockResolvedValue({
      data: {
        tabelle: ['procedures'],
        colonne: [],
        indici: [],
        chiaviConfig: [],
        chiaviPrimarie: {},
      },
      error: null,
    })
    expect((await fotografaSchema()).ok).toBe(true)
  })
})
