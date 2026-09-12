/**
 * Il tool che segna pagate le fatture ricevute: l'anteprima, le esclusioni, il
 * tetto e — soprattutto — l'ESITO PER DOCUMENTO.
 *
 * Una conferma sola per N documenti è una decisione dell'Ingegnere, ma allora
 * l'anteprima deve essere quella vera e l'esito non può essere di gruppo: se 3
 * su 5 riescono, deve dire quali sì e quali no col motivo. Un «fatto» sul
 * gruppo con due fallite sarebbe il difetto peggiore introducibile qui.
 *
 * Nessuna chiamata all'API di Fatture in Cloud: le funzioni di I/O sono finte,
 * la classificazione è quella VERA.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ContoPagamentoFic } from './fic-pagamenti'

/* ---------- stato pilotabile dai test ---------- */

const stato = {
  inserita: null as Record<string, unknown> | null,
  descrizione: '',
  riga: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  conti: [] as ContoPagamentoFic[],
  selezione: [] as Record<string, unknown>[],
  altrePagine: false,
  letture: new Map<number, Record<string, unknown>>(),
  esiti: new Map<number, { ok: boolean; motivo?: string }>(),
  eliminate: [] as string[],
}

/* ---------- mock ---------- */

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
    cercaFattureRicevute: async () => ({
      ok: true as const,
      valore: { documenti: stato.selezione, altre_pagine: stato.altrePagine },
    }),
    leggiFatturaRicevuta: async (id: number) => {
      const doc = stato.letture.get(id)
      return doc
        ? { ok: true as const, valore: doc }
        : { ok: false as const, error: `la fattura ricevuta ${id} non esiste su Fatture in Cloud` }
    },
    segnaPagataFatturaRicevuta: async (id: number) => {
      const e = stato.esiti.get(id)
      if (!e) return { ok: false as const, motivo: 'nessun esito preparato nel test' }
      return e.ok ? { ok: true as const } : { ok: false as const, motivo: e.motivo ?? 'fallita' }
    },
  }
})

import { executeFicWriteTool, confirmFicStep2 } from './fic-write-tools'

/* ---------- fixture ---------- */

function fattura(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 12,
    type: 'expense',
    entity: { id: 5, name: 'EDIL LIMONGI SRL' },
    invoice_number: '123',
    date: '2026-03-04',
    amount_net: 100,
    amount_vat: 22,
    amount_gross: 122,
    payments_list: [{ id: 777, amount: 122, due_date: '2026-03-04', status: 'not_paid' }],
    ...over,
  }
}

function vocePagata() {
  return {
    id: 777,
    amount: 122,
    due_date: '2026-03-04',
    paid_date: '2026-03-04',
    status: 'paid',
    payment_account: { id: 222, name: 'Contanti' },
  }
}

function documentoPagamenti(ids: number[]) {
  return {
    conto: { id: 222, nome: 'Contanti' },
    documenti: ids.map((id) => ({
      id,
      fornitore: 'EDIL LIMONGI SRL',
      numero: `n${id}`,
      data: '2026-03-04',
      importo: 122,
      data_pagamento: '2026-03-04',
      importo_pagamento: 122,
      voce: 0,
      voci: 1,
    })),
  }
}

beforeEach(() => {
  stato.inserita = null
  stato.descrizione = ''
  stato.riga = null
  stato.updates = []
  stato.conti = [{ id: 222, nome: 'Contanti' }, { id: 333, nome: 'Conto Banca Intesa' }]
  stato.selezione = []
  stato.altrePagine = false
  stato.letture = new Map()
  stato.esiti = new Map()
  stato.eliminate = []
})

/* ---------- l'anteprima ---------- */

describe('anteprima: e l unica cosa che l Ingegnere legge prima di una conferma per tutte', () => {
  beforeEach(() => {
    stato.selezione = [
      fattura({ id: 12, invoice_number: '123' }),
      fattura({ id: 13, invoice_number: '124', amount_gross: 244, payments_list: [{ id: 1, amount: 244, status: 'not_paid' }] }),
      // già pagate: escluse
      fattura({ id: 14, invoice_number: '125', payments_list: [vocePagata()] }),
      fattura({ id: 15, invoice_number: '126', payments_list: [vocePagata()] }),
      // piano a più voci: esclusa
      fattura({
        id: 16,
        invoice_number: '127',
        payments_list: [
          { id: 1, amount: 61, due_date: '2026-03-04', status: 'not_paid' },
          { id: 2, amount: 61, due_date: '2026-04-04', status: 'not_paid' },
        ],
      }),
    ]
  })

  it('mostra 2 da scrivere e 3 ESCLUSE col motivo', async () => {
    const risposta = await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026, modalita_pagamento: 'Contanti' },
      'restruktura',
    )
    const out = JSON.parse(String(risposta))
    expect(out.ok).toBe(true)
    expect(out.da_scrivere).toBe(2)
    expect(out.escluse).toHaveLength(3)

    const anteprima = String(out.anteprima)
    expect(anteprima).toContain('DA SCRIVERE: 2')
    expect(anteprima).toContain('ESCLUSE, non verranno toccate: 3')
    expect(anteprima).toContain('GIÀ pagata')
    expect(anteprima).toContain('2 voci')
  })

  it('mostra fornitore, numero, data, importo, la data di pagamento e il totale', async () => {
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026, modalita_pagamento: 'Contanti' },
      'restruktura',
    )))
    const anteprima = String(out.anteprima)
    expect(anteprima).toContain('EDIL LIMONGI SRL')
    expect(anteprima).toContain('n.123')
    expect(anteprima).toContain('2026-03-04')
    expect(anteprima).toContain('122,00')
    expect(anteprima).toContain('pagamento il 2026-03-04')
    // 122 + 244 = 366: il totale del gruppo, non la somma di quel che si vede.
    expect(anteprima).toContain('totale 366,00')
  })

  it('nomina societa, partita IVA e modalita di pagamento', async () => {
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026, modalita_pagamento: 'Contanti' },
      'restruktura',
    )))
    const anteprima = String(out.anteprima)
    expect(anteprima).toContain('RESTRUKTURA')
    expect(anteprima).toContain('02087420762')
    expect(anteprima).toContain('Contanti')
    expect(anteprima).toContain('conto FIC id 222')
  })

  it('non scrive niente: prepara e chiede la doppia conferma', async () => {
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026, modalita_pagamento: 'Contanti' },
      'restruktura',
    )))
    expect(out.stato).toBe('in_attesa')
    expect(out.conferma_1).toBe('/fic_ok_pend-1')
    expect(String(out.anteprima)).toContain('/fic_ok_pend-1')
    expect(stato.inserita?.tipo).toBe('pagamento_ricevuta')
    expect(stato.inserita?.societa).toBe('restruktura')
    expect(stato.inserita?.conferme).toBe(0)
  })

  it('un elenco lungo si taglia DICHIARANDO quante righe non sono mostrate', async () => {
    stato.selezione = Array.from({ length: 30 }, (_, i) => fattura({ id: 100 + i, invoice_number: `n${i}` }))
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026, modalita_pagamento: 'Contanti' },
      'restruktura',
    )))
    const anteprima = String(out.anteprima)
    expect(anteprima).toContain('DA SCRIVERE: 30')
    expect(anteprima).toContain('altre 10 fatture da scrivere NON mostrate')
  })

  it('se nessuna si puo scrivere, lo dice elencando le escluse', async () => {
    stato.selezione = [
      fattura({ id: 14, payments_list: [vocePagata()] }),
      fattura({ id: 15, payments_list: [vocePagata()] }),
    ]
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026, modalita_pagamento: 'Contanti' },
      'restruktura',
    )))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('non ho scritto niente')
    expect(out.escluse).toHaveLength(2)
    expect(stato.inserita).toBeNull()
  })
})

/* ---------- il tetto ---------- */

describe('il tetto: una scrittura di massa non deve scappare', () => {
  it('51 documenti vengono RIFIUTATI, chiedendo di restringere', async () => {
    stato.selezione = Array.from({ length: 51 }, (_, i) => fattura({ id: 200 + i }))
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026, modalita_pagamento: 'Contanti' },
      'restruktura',
    )))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('51')
    expect(out.error).toContain('tetto di 50')
    expect(out.error).toContain('restringi')
    expect(out.tetto).toBe(50)
    expect(stato.inserita).toBeNull()
  })

  // Controllo positivo: 50 passano. Senza questo, il test sopra sarebbe verde
  // anche se il tool rifiutasse SEMPRE.
  it('50 documenti passano', async () => {
    stato.selezione = Array.from({ length: 50 }, (_, i) => fattura({ id: 200 + i }))
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026, modalita_pagamento: 'Contanti' },
      'restruktura',
    )))
    expect(out.ok).toBe(true)
    expect(out.da_scrivere).toBe(50)
  })

  // Un elenco che continua su un'altra pagina NON e' l'insieme descritto.
  it('se la selezione continua su altre pagine, rifiuta', async () => {
    stato.selezione = Array.from({ length: 10 }, (_, i) => fattura({ id: 300 + i }))
    stato.altrePagine = true
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026, modalita_pagamento: 'Contanti' },
      'restruktura',
    )))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('più di 10')
    expect(stato.inserita).toBeNull()
  })

  it('senza nessun criterio non segna pagate «tutte» le spese', async () => {
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { modalita_pagamento: 'Contanti' },
      'restruktura',
    )))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('almeno un criterio')
  })
})

/* ---------- la modalità di pagamento ---------- */

describe('la modalita di pagamento la sceglie lui, fra quelle di FIC', () => {
  beforeEach(() => { stato.selezione = [fattura()] })

  // 🔬 Mutazione: una lista fissa nel codice. Questo test morirebbe, perche'
  // l'elenco restituito e' esattamente quello che espone Fatture in Cloud.
  it('senza modalita torna l elenco VERO dei conti dell azienda', async () => {
    stato.conti = [{ id: 7, nome: 'Cassa di cantiere' }, { id: 8, nome: 'Conto BPER' }]
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026 },
      'restruktura',
    )))
    expect(out.need).toBe('modalita_pagamento')
    expect(out.modalita_disponibili).toEqual([
      { id: 7, nome: 'Cassa di cantiere' },
      { id: 8, nome: 'Conto BPER' },
    ])
    expect(out.fatture_selezionate).toBe(1)
    expect(stato.inserita).toBeNull()
  })

  it('una modalita inesistente non viene scritta: torna l elenco', async () => {
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026, modalita_pagamento: 'bonifico postale' },
      'restruktura',
    )))
    expect(out.need).toBe('modalita_pagamento')
    expect(String(out.messaggio)).toContain('non è fra i conti di pagamento')
    expect(stato.inserita).toBeNull()
  })
})

/* ---------- l'esito per documento ---------- */

describe('esito PER DOCUMENTO, costruito dalle riletture', () => {
  beforeEach(() => {
    stato.riga = {
      id: 'pend-1',
      tipo: 'pagamento_ricevuta',
      payload: documentoPagamenti([1, 2, 3, 4, 5]),
      conferme: 1,
      stato: 'in_attesa',
      societa: 'restruktura',
      created_at: '2026-09-12T08:00:00Z',
      updated_at: '2026-09-12T08:00:00Z',
      descrizione: 'Segno PAGATE 5 fatture RICEVUTE su Fatture in Cloud',
    }
  })

  // 🔬 Mutazione: far riportare «tutte pagate». Questo test muore.
  it('3 riuscite su 5: nomina le 3 e le 2 no, col motivo', async () => {
    stato.esiti.set(1, { ok: true })
    stato.esiti.set(2, { ok: true })
    stato.esiti.set(3, { ok: true })
    stato.esiti.set(4, { ok: false, motivo: "l'API ha risposto ok ma rileggendo il pagamento non risulta" })
    stato.esiti.set(5, { ok: false, motivo: 'risulta GIÀ pagata' })

    const messaggio = await confirmFicStep2('pend-1')

    expect(messaggio).toContain('PAGAMENTI REGISTRATI IN PARTE')
    expect(messaggio).toContain('3 su 5')
    expect(messaggio).not.toContain('5 su 5')
    expect(messaggio).toContain('RIUSCITE (3)')
    expect(messaggio).toContain('NON RIUSCITE (2)')
    for (const id of [1, 2, 3, 4, 5]) expect(messaggio).toContain(`[${id}]`)
    expect(messaggio).toContain('rileggendo il pagamento non risulta')
    expect(messaggio).toContain('risulta GIÀ pagata')
  })

  // Controllo positivo: il messaggio «tutte riuscite» esiste ed e'
  // raggiungibile — altrimenti il test sopra passerebbe anche con un tool che
  // dichiara sempre un parziale.
  it('5 su 5: lo dice, e dichiara che sono verificate rileggendo', async () => {
    for (const id of [1, 2, 3, 4, 5]) stato.esiti.set(id, { ok: true })
    const messaggio = await confirmFicStep2('pend-1')
    expect(messaggio).toContain('PAGAMENTI REGISTRATI su RESTRUKTURA')
    expect(messaggio).toContain('5 su 5')
    expect(messaggio).not.toContain('IN PARTE')
    expect(messaggio).toContain('verificate rileggendo ogni fattura')
  })

  it('nessuna riuscita: lo dice e riporta la riga a una conferma, ritentabile', async () => {
    for (const id of [1, 2, 3, 4, 5]) stato.esiti.set(id, { ok: false, motivo: 'token scaduto' })
    const messaggio = await confirmFicStep2('pend-1')
    expect(messaggio).toContain('NESSUN pagamento registrato')
    expect(messaggio).toContain('0 su 5')
    expect(stato.updates).toContainEqual(expect.objectContaining({ conferme: 1 }))
    expect(stato.updates).not.toContainEqual(expect.objectContaining({ stato: 'creata' }))
  })

  it('con almeno una scritta la riga si CHIUDE, e l audit registra quali', async () => {
    stato.esiti.set(1, { ok: true })
    for (const id of [2, 3, 4, 5]) stato.esiti.set(id, { ok: false, motivo: 'no' })
    await confirmFicStep2('pend-1')
    expect(stato.updates).toContainEqual(expect.objectContaining({ stato: 'creata', fic_document_id: '1' }))
  })

  it('serve la prima conferma: senza, non scrive niente', async () => {
    stato.riga = { ...(stato.riga as Record<string, unknown>), conferme: 0 }
    for (const id of [1, 2, 3, 4, 5]) stato.esiti.set(id, { ok: true })
    const messaggio = await confirmFicStep2('pend-1')
    expect(messaggio).toContain('Serve prima la prima conferma')
    expect(stato.updates).not.toContainEqual(expect.objectContaining({ stato: 'creata' }))
  })

  it('un pending gia elaborato non si riscrive', async () => {
    stato.riga = { ...(stato.riga as Record<string, unknown>), stato: 'creata' }
    const messaggio = await confirmFicStep2('pend-1')
    expect(messaggio).toContain('gia elaborata')
  })
})

/* ---------- la conferma a parole ---------- */

describe('la conferma a parole riferisce l esito senza mentire', () => {
  beforeEach(() => {
    stato.riga = {
      id: 'pend-1',
      tipo: 'pagamento_ricevuta',
      payload: documentoPagamenti([1, 2]),
      conferme: 1,
      stato: 'in_attesa',
      societa: 'restruktura',
      created_at: new Date().toISOString(),
      // vecchio di un minuto: la distanza minima fra le due conferme e' passata
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      descrizione: 'Segno PAGATE 2 fatture RICEVUTE su Fatture in Cloud',
    }
  })

  // Senza il riconoscimento del prefisso, un pagamento RIUSCITO veniva
  // riferito come «NON riuscito»: il codice avrebbe mentito sull'esito di una
  // scrittura contabile.
  it('un pagamento riuscito NON viene riferito come fallito', async () => {
    stato.esiti.set(1, { ok: true })
    stato.esiti.set(2, { ok: true })
    const out = JSON.parse(String(await executeFicWriteTool('conferma_bozza_fic', { id: 'pend-1' }, 'restruktura')))
    expect(out.passo).toBe(2)
    expect(out.documento_creato).toBe(true)
    expect(out.esito_parziale).toBe(false)
    expect(out.avviso).toBeNull()
  })

  it('un parziale viene dichiarato parziale, con l ordine di non dire «fatte tutte»', async () => {
    stato.esiti.set(1, { ok: true })
    stato.esiti.set(2, { ok: false, motivo: 'rileggendo non risulta' })
    const out = JSON.parse(String(await executeFicWriteTool('conferma_bozza_fic', { id: 'pend-1' }, 'restruktura')))
    expect(out.esito_parziale).toBe(true)
    expect(String(out.avviso)).toContain('solo ALCUNE')
    expect(String(out.avviso)).toContain('Non dire «fatte tutte»')
  })

  it('se non e riuscito niente, dice che NON e riuscito', async () => {
    stato.esiti.set(1, { ok: false, motivo: 'no' })
    stato.esiti.set(2, { ok: false, motivo: 'no' })
    const out = JSON.parse(String(await executeFicWriteTool('conferma_bozza_fic', { id: 'pend-1' }, 'restruktura')))
    expect(out.documento_creato).toBe(false)
    expect(String(out.avviso)).toContain('NON e riuscita')
  })
})

/* ---------- l'annullo ---------- */

describe('annullare un pagamento non deve CANCELLARE la fattura del fornitore', () => {
  // 🚨 Senza la guardia, `elimina_bozza_fic` su un pagamento «creato»
  // chiamerebbe eliminaDocumentoFIC col `fic_document_id`, che qui e' l'id
  // della fattura DEL FORNITORE: un «annulla» che distrugge un documento
  // fiscale altrui.
  it('un pagamento gia scritto non si annulla da qui, e non cancella niente', async () => {
    stato.riga = {
      id: 'pend-1',
      tipo: 'pagamento_ricevuta',
      stato: 'creata',
      fic_document_id: '12,13',
      societa: 'restruktura',
    }
    const out = JSON.parse(String(await executeFicWriteTool('elimina_bozza_fic', { id: 'pend-1' }, 'restruktura')))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('non cancello le fatture del fornitore')
    expect(stato.eliminate).toEqual([])
  })

  // Controllo positivo: su una BOZZA nostra la cancellazione avviene davvero.
  // Senza questo, il test sopra sarebbe verde anche con eliminaDocumentoFIC
  // rimosso del tutto.
  it('su una bozza di fattura EMESSA, invece, cancella da FIC', async () => {
    stato.riga = {
      id: 'pend-2',
      tipo: 'fattura_emessa',
      stato: 'creata',
      fic_document_id: 'doc-9',
      societa: 'restruktura',
    }
    const out = JSON.parse(String(await executeFicWriteTool('elimina_bozza_fic', { id: 'pend-2' }, 'restruktura')))
    expect(out.ok).toBe(true)
    expect(stato.eliminate).toEqual(['doc-9'])
  })

  it('un pagamento ancora in attesa si annulla, senza toccare FIC', async () => {
    stato.riga = {
      id: 'pend-1',
      tipo: 'pagamento_ricevuta',
      stato: 'in_attesa',
      fic_document_id: null,
      societa: 'restruktura',
    }
    const out = JSON.parse(String(await executeFicWriteTool('elimina_bozza_fic', { id: 'pend-1' }, 'restruktura')))
    expect(out.ok).toBe(true)
    expect(out.stato).toBe('annullata')
    expect(stato.eliminate).toEqual([])
  })
})

/* ---------- il caso singolo ---------- */

describe('il caso singolo e il massivo con un elemento', () => {
  it('con un id legge quella fattura e prepara la scrittura', async () => {
    stato.letture.set(12, fattura())
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { id: 12, modalita_pagamento: 'Contanti' },
      'restruktura',
    )))
    expect(out.ok).toBe(true)
    expect(out.da_scrivere).toBe(1)
    expect(String(out.anteprima)).toContain('[12]')
  })

  it('una fattura che non esiste lo dice, senza pending', async () => {
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { id: 999, modalita_pagamento: 'Contanti' },
      'restruktura',
    )))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('non esiste')
    expect(stato.inserita).toBeNull()
  })

  it('la voce si puo indicare solo su UNA fattura', async () => {
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { fornitore: 'Limongi', anno: 2026, modalita_pagamento: 'Contanti', voce: 2 },
      'restruktura',
    )))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('solo su UNA fattura')
  })

  it('una data di pagamento malformata viene rifiutata', async () => {
    stato.letture.set(12, fattura())
    const out = JSON.parse(String(await executeFicWriteTool(
      'segna_fatture_ricevute_pagate',
      { id: 12, modalita_pagamento: 'Contanti', data_pagamento: '04/03/2026' },
      'restruktura',
    )))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('YYYY-MM-DD')
  })
})

/* ---------- la descrizione del tool ---------- */

describe('il tool si trova cercandolo con le parole dell Ingegnere', () => {
  it('la descrizione contiene le parole con cui lo si cercherebbe', async () => {
    const { FIC_WRITE_TOOLS } = await import('./fic-write-tools')
    const tool = FIC_WRITE_TOOLS.find((t) => t.name === 'segna_fatture_ricevute_pagate')
    expect(tool).toBeDefined()
    const testo = `${tool?.name} ${tool?.description}`.toLowerCase()
    for (const parola of ['segna pagata', 'saldata', 'contanti', 'fattura ricevuta', 'fornitore', 'modalita di pagamento']) {
      expect(testo).toContain(parola)
    }
  })
})
