/**
 * Il tool che segna INCASSATE le fatture emesse: stessa doppia conferma delle
 * ricevute, stesso pending, e — soprattutto — le stesse guardie.
 *
 * 🚨 La guardia che conta di più: «annulla» su un pagamento già scritto NON
 * deve cancellare la fattura. Qui la fattura è NOSTRA, emessa e magari già
 * trasmessa allo SdI: `eliminaDocumentoFIC` la distruggerebbe davvero.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ContoPagamentoFic } from './fic-pagamenti'

const stato = {
  inserita: null as Record<string, unknown> | null,
  descrizione: '',
  riga: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  conti: [] as ContoPagamentoFic[],
  letture: new Map<number, Record<string, unknown>>(),
  esitiEmesse: new Map<number, { ok: boolean; motivo?: string }>(),
  scrittureRicevute: 0,
  scrittureEmesse: 0,
  eliminate: [] as string[],
}

vi.mock('./supabase', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const catena = (lista: () => unknown[], singolo: () => unknown): any => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {}
    const me = () => b
    b.eq = me
    b.in = me
    b.gte = me
    b.order = me
    b.limit = me
    b.maybeSingle = async () => ({ data: singolo(), error: null })
    b.single = async () => ({ data: singolo(), error: null })
    b.select = () => catena(lista, singolo)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    b.then = (risolvi: any) => Promise.resolve({ data: lista(), error: null }).then(risolvi)
    return b
  }
  return {
    supabase: {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          stato.inserita = row
          return catena(() => [{ id: 'pend-1' }], () => ({ id: 'pend-1' }))
        },
        select: () => catena(() => (stato.riga ? [stato.riga] : []), () => stato.riga),
        update: (row: Record<string, unknown>) => {
          stato.updates.push(row)
          if (typeof row.descrizione === 'string' && row.descrizione) stato.descrizione = row.descrizione
          return catena(
            () => [{ id: 'pend-1', societa: 'restruktura', stato: row.stato ?? 'in_attesa' }],
            () => ({ id: 'pend-1', descrizione: stato.descrizione }),
          )
        },
      }),
    },
  }
})

vi.mock('./fatture-in-cloud', () => ({
  ficGet: async () => ({ ok: true, data: { data: [] } }),
  getCompanyId: async () => ({ ok: true, id: '111' }),
  creaDocumentoFIC: async () => ({ ok: true, id: 'doc-1', url: null }),
  eliminaDocumentoFIC: async (id: string) => { stato.eliminate.push(id); return { ok: true } },
}))

vi.mock('./fic-pagamenti', async (importOriginal) => {
  const reale = await importOriginal<typeof import('./fic-pagamenti')>()
  return {
    ...reale,
    elencoContiPagamentoFic: async () => ({ ok: true as const, valore: stato.conti }),
    leggiFatturaEmessa: async (id: number) => {
      const doc = stato.letture.get(id)
      return doc
        ? { ok: true as const, valore: doc }
        : { ok: false as const, error: `la fattura emessa ${id} non esiste su Fatture in Cloud` }
    },
    segnaPagataFatturaEmessa: async (id: number) => {
      stato.scrittureEmesse++
      const e = stato.esitiEmesse.get(id)
      if (!e) return { ok: false as const, motivo: 'nessun esito preparato nel test' }
      return e.ok ? { ok: true as const } : { ok: false as const, motivo: e.motivo ?? 'fallita' }
    },
    segnaPagataFatturaRicevuta: async () => {
      stato.scrittureRicevute++
      return { ok: true as const }
    },
  }
})

import { executeFicWriteTool, confirmFicStep2, FIC_WRITE_TOOLS } from './fic-write-tools'

function emessa(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 533024661,
    type: 'invoice',
    entity: { id: 9, name: 'Condominio Residence Vallina II' },
    number: 19,
    numeration: '-ED',
    date: '2026-06-15',
    amount_gross: 501.05,
    payments_list: [{ id: 91, amount: 501.05, due_date: '2026-07-15', status: 'not_paid' }],
    ...over,
  }
}

beforeEach(() => {
  stato.inserita = null
  stato.descrizione = ''
  stato.riga = null
  stato.updates = []
  stato.conti = [{ id: 222, nome: 'Contanti' }, { id: 333, nome: 'Intesa Sanpaolo' }]
  stato.letture = new Map()
  stato.esitiEmesse = new Map()
  stato.scrittureRicevute = 0
  stato.scrittureEmesse = 0
  stato.eliminate = []
})

const INPUT = { id: 533024661, modalita_pagamento: 'Intesa', data_pagamento: '2026-06-15' }

describe('il tool esiste e si trova con le parole dell Ingegnere', () => {
  it('segna_fatture_emesse_pagate e nel registro, e la descrizione parla di incassi e bonifici', () => {
    const t = FIC_WRITE_TOOLS.find((d) => d.name === 'segna_fatture_emesse_pagate')
    expect(t).toBeDefined()
    const d = (t?.description ?? '').toLowerCase()
    for (const parola of ['emessa', 'incass', 'bonifico', 'cliente', 'pagata', 'doppia conferma']) {
      expect(d, parola).toContain(parola)
    }
    expect((t?.input_schema as { required?: string[] }).required).toContain('data_pagamento')
  })
})

describe('anteprima e pending: tipo pagamento_emessa, doppia conferma', () => {
  it('con id, conto e data del bonifico prepara e chiede la conferma', async () => {
    stato.letture.set(533024661, emessa())
    const out = JSON.parse(String(await executeFicWriteTool('segna_fatture_emesse_pagate', INPUT, 'restruktura')))
    expect(out.ok).toBe(true)
    expect(out.da_scrivere).toBe(1)
    expect(stato.inserita?.tipo).toBe('pagamento_emessa')
    expect(String(out.anteprima)).toContain('EMESSE')
    expect(String(out.anteprima)).toContain('19-ED')
    expect(String(out.anteprima)).toContain('Intesa Sanpaolo')
    expect(String(out.anteprima)).toContain('2026-06-15')
    expect(String(out.conferma_1)).toContain('fic_ok')
    // Niente e' stato scritto: solo il pending.
    expect(stato.scrittureEmesse).toBe(0)
  })

  it('senza la data del bonifico rifiuta PRIMA di creare il pending', async () => {
    stato.letture.set(533024661, emessa())
    const { data_pagamento: _d, ...senzaData } = INPUT
    void _d
    const out = JSON.parse(String(await executeFicWriteTool('segna_fatture_emesse_pagate', senzaData, 'restruktura')))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/data/i)
    expect(stato.inserita).toBeNull()
  })

  it('l anteprima dice «cliente», non «fornitore»', async () => {
    stato.letture.set(533024661, emessa())
    const out = JSON.parse(String(await executeFicWriteTool('segna_fatture_emesse_pagate', INPUT, 'restruktura')))
    expect(String(out.anteprima).toLowerCase()).not.toContain('fornitore')
    expect(String(out.anteprima).toLowerCase()).toContain('cliente')
  })
})

describe('la seconda conferma scrive sulle EMESSE, mai sulle ricevute', () => {
  it('esegue la scrittura emessa e chiude la riga', async () => {
    stato.riga = {
      id: 'pend-1',
      tipo: 'pagamento_emessa',
      stato: 'in_attesa',
      conferme: 1,
      societa: 'restruktura',
      payload: {
        conto: { id: 333, nome: 'Intesa Sanpaolo' },
        data_pagamento: '2026-06-15',
        documenti: [{ id: 533024661, fornitore: 'Condominio Residence Vallina II', numero: '19-ED', data: '2026-06-15', importo: 501.05, data_pagamento: '2026-06-15', importo_pagamento: 501.05, voce: 0, voci: 1 }],
      },
    }
    stato.esitiEmesse.set(533024661, { ok: true })
    const out = await confirmFicStep2('pend-1')
    expect(out).toContain('INCASSI REGISTRATI')
    expect(out).toContain('19-ED')
    expect(stato.scrittureEmesse).toBe(1)
    expect(stato.scrittureRicevute).toBe(0)
    expect(stato.updates.some((u) => u.stato === 'creata')).toBe(true)
  })
})

describe('annullare un incasso non deve CANCELLARE la fattura emessa', () => {
  // 🚨 Il `fic_document_id` qui e' l'id della NOSTRA fattura, gia' emessa e
  // magari trasmessa: senza la guardia il ramo delle bozze la eliminerebbe.
  it('un incasso gia scritto non si annulla da qui, e non cancella niente', async () => {
    stato.riga = { id: 'pend-1', tipo: 'pagamento_emessa', stato: 'creata', fic_document_id: '533024661', societa: 'restruktura' }
    const out = JSON.parse(String(await executeFicWriteTool('elimina_bozza_fic', { id: 'pend-1' }, 'restruktura')))
    expect(out.ok).toBe(false)
    expect(stato.eliminate).toEqual([])
  })

  it('un incasso ancora in attesa si annulla, senza toccare FIC', async () => {
    stato.riga = { id: 'pend-1', tipo: 'pagamento_emessa', stato: 'in_attesa', fic_document_id: null, societa: 'restruktura' }
    const out = JSON.parse(String(await executeFicWriteTool('elimina_bozza_fic', { id: 'pend-1' }, 'restruktura')))
    expect(out.ok).toBe(true)
    expect(out.stato).toBe('annullata')
    expect(stato.eliminate).toEqual([])
  })
})

describe('la conferma a parole riconosce anche il verbo INCASSI', () => {
  // 🚨 Trovato dall'audit del 14 set 2026: riconosceva solo «PAGAMENTI
  // REGISTRATI», quindi un incasso RIUSCITO veniva riferito come «NON
  // riuscita» — la stessa bugia gia' chiusa per le ricevute, rifatta sull'altro verso.
  beforeEach(() => {
    stato.riga = {
      id: 'pend-1',
      tipo: 'pagamento_emessa',
      payload: {
        conto: { id: 333, nome: 'Intesa Sanpaolo' },
        data_pagamento: '2026-06-15',
        documenti: [{ id: 533024661, fornitore: 'Condominio Residence Vallina II', numero: '19-ED', data: '2026-06-15', importo: 501.05, data_pagamento: '2026-06-15', importo_pagamento: 501.05, voce: 0, voci: 1 }],
      },
      conferme: 1,
      stato: 'in_attesa',
      societa: 'restruktura',
      created_at: new Date().toISOString(),
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      descrizione: 'Segno INCASSATE 1 fatture EMESSE su Fatture in Cloud',
    }
  })

  it('un incasso riuscito NON viene riferito come fallito', async () => {
    stato.esitiEmesse.set(533024661, { ok: true })
    const out = JSON.parse(String(await executeFicWriteTool('conferma_bozza_fic', { id: 'pend-1' }, 'restruktura')))
    expect(out.passo).toBe(2)
    expect(String(out.messaggio)).toContain('INCASSI REGISTRATI')
    expect(out.documento_creato).toBe(true)
    expect(out.avviso).toBeNull()
  })

  it('un incasso fallito viene detto fallito (controllo positivo)', async () => {
    stato.esitiEmesse.set(533024661, { ok: false, motivo: 'no' })
    const out = JSON.parse(String(await executeFicWriteTool('conferma_bozza_fic', { id: 'pend-1' }, 'restruktura')))
    expect(out.documento_creato).toBe(false)
    expect(String(out.avviso)).toContain('NON e riuscita')
  })
})

describe('l importo del bonifico deve combaciare al centesimo', () => {
  it('un bonifico diverso dalla voce ESCLUDE la fattura e lo dice', async () => {
    stato.letture.set(533024661, emessa())
    const out = JSON.parse(String(await executeFicWriteTool('segna_fatture_emesse_pagate', { ...INPUT, importo_bonifico: 500 }, 'restruktura')))
    expect(out.ok).toBe(false)
    expect(JSON.stringify(out.escluse)).toContain('non combaciano al centesimo')
    expect(stato.inserita).toBeNull()
  })

  it('un bonifico uguale alla voce passa (controllo positivo)', async () => {
    stato.letture.set(533024661, emessa())
    const out = JSON.parse(String(await executeFicWriteTool('segna_fatture_emesse_pagate', { ...INPUT, importo_bonifico: 501.05 }, 'restruktura')))
    expect(out.ok).toBe(true)
    expect(out.da_scrivere).toBe(1)
  })

  it('senza id non si puo indicare', async () => {
    const out = JSON.parse(String(await executeFicWriteTool('segna_fatture_emesse_pagate', { cliente: 'Vallina', anno: 2026, modalita_pagamento: 'Intesa', data_pagamento: '2026-06-15', importo_bonifico: 501.05 }, 'restruktura')))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('solo su UNA fattura')
  })
})

describe('l anteprima mostra l importo che verra SCRITTO quando non e il lordo', () => {
  it('con ritenuta d acconto la voce vale meno del lordo, e l anteprima lo dice', async () => {
    // Condominio: lordo 501,05, ritenuta 4% sul netto → la voce del piano e' 484,62.
    stato.letture.set(533024661, emessa({ payments_list: [{ id: 91, amount: 484.62, due_date: '2026-07-15', status: 'not_paid' }] }))
    const out = JSON.parse(String(await executeFicWriteTool('segna_fatture_emesse_pagate', INPUT, 'restruktura')))
    expect(out.ok).toBe(true)
    expect(String(out.anteprima)).toContain('si scrive 484,62')
    expect(String(out.anteprima)).toContain('totale 484,62')
  })
})
