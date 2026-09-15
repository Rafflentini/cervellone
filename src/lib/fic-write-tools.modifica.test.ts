/**
 * src/lib/fic-write-tools.modifica.test.ts — MODIFICARE un documento gia'
 * creato su Fatture in Cloud invece di cancellarlo e rifarlo.
 *
 * Il difetto che chiude: il bot sapeva compilare un'autofattura e sapeva
 * cancellarla, e basta. Un documento con un dato sbagliato si poteva solo
 * cancellare e rifare — e su una serie di numerazione fiscale questo lascia un
 * BUCO, perche' il numero bruciato non torna.
 *
 * ⚠️ Cosa guardano questi test: i PERCORSI chiamati e il CORPO spedito. L'I/O
 * verso Fatture in Cloud e' finto (`vi.mock('./fatture-in-cloud')`), la logica
 * e' quella vera — comprese le difese, che sono il motivo per cui il tool
 * esiste in questa forma e non in una piu' comoda.
 *
 * ⚠️ Accanto a ogni «si rifiuta» c'e' il CONTROLLO POSITIVO: che una modifica
 * legittima passi ancora. Senza, un tool che rifiuta SEMPRE supererebbe tutte
 * le prove sulle guardie e non servirebbe a niente.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stato = {
  /** I documenti emessi che Fatture in Cloud conosce: id -> documento. */
  documenti: new Map<string, Record<string, unknown>>(),
  /** Le PUT viste: percorso e corpo spedito. E' la prova che conta. */
  put: [] as Array<{ path: string; body: Record<string, unknown> }>,
  /** Cosa risponde la PUT. Un rifiuto porta il testo VERO di FIC. */
  esitoPut: { ok: true } as { ok: boolean; error?: string },
  /**
   * Cosa fa Fatture in Cloud quando accetta la PUT. Il predefinito e' il
   * comportamento onesto: applica il corpo. I test della rilettura che non
   * conferma lo sostituiscono con uno che NON applica.
   */
  applicaPut: null as null | ((doc: Record<string, unknown>, body: Record<string, unknown>) => Record<string, unknown>),
  inserite: [] as Record<string, unknown>[],
  descrizione: '',
  riga: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  /** Gli id passati a `eliminaDocumentoFIC`: deve restare VUOTO. */
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
          stato.inserite.push(row)
          return catena(() => [{ id: 'pend-1' }], () => ({ id: 'pend-1' }))
        },
        select: () => catena(() => (stato.riga ? [stato.riga] : []), () => stato.riga),
        update: (row: Record<string, unknown>) => {
          stato.updates.push(row)
          if (typeof row.descrizione === 'string' && row.descrizione) stato.descrizione = row.descrizione
          return catena(
            () => [{ id: 'pend-1', societa: 'restruktura', tipo: 'modifica_documento', stato: row.stato ?? 'in_attesa' }],
            () => ({ id: 'pend-1', descrizione: stato.descrizione }),
          )
        },
      }),
    },
  }
})

vi.mock('./fatture-in-cloud', () => ({
  FORMATI_ALLEGATO_FIC: ['pdf'],
  getCompanyId: async () => ({ ok: true, id: '111' }),
  ficGet: async (path: string) => {
    const emesso = /\/issued_documents\/(\d+)$/.exec(path)
    if (emesso) {
      const doc = stato.documenti.get(emesso[1])
      return doc ? { ok: true, data: { data: doc } } : { ok: false, error: 'Errore FIC 404: {"error":{"message":"not found"}}' }
    }
    return { ok: true, data: { data: [] } }
  },
  ficPut: async (path: string, body: Record<string, unknown>) => {
    stato.put.push({ path, body })
    if (!stato.esitoPut.ok) return { ok: false, error: stato.esitoPut.error ?? 'Errore FIC 400: rifiutata' }
    const id = (/\/issued_documents\/(\d+)$/.exec(path) ?? [])[1]
    const doc = stato.documenti.get(id)
    if (doc) stato.documenti.set(id, (stato.applicaPut ?? applicaDavvero)(doc, body))
    return { ok: true, data: { data: stato.documenti.get(id) } }
  },
  ficPost: async () => ({ ok: true, data: { data: {} } }),
  creaDocumentoFIC: async () => ({ ok: true as const, id: 'issued-1', url: null }),
  eliminaDocumentoFIC: async (id: string) => { stato.eliminate.push(id); return { ok: true } },
  caricaAllegatoFIC: async () => ({ ok: true as const, token: 'tok-1' }),
  creaSpesaFIC: async () => ({ ok: true as const, id: 'spesa-1', url: null }),
}))

vi.mock('./gmail-tools', () => ({
  readMessage: async () => ({ subject: '', attachments: [] }),
  scaricaAllegato: async () => '',
}))

/**
 * Fatture in Cloud che si comporta bene: applica il corpo e RICALCOLA i totali
 * dalle righe (sull'integrazione in reverse charge l'IVA e' zero, quindi netto
 * e lordo coincidono).
 */
function applicaDavvero(doc: Record<string, unknown>, body: Record<string, unknown>): Record<string, unknown> {
  const nuovo = { ...doc, ...body }
  if (Array.isArray(body.items_list)) {
    const totale = (body.items_list as Array<Record<string, unknown>>)
      .reduce((s, r) => s + Number(r.qty ?? 1) * Number(r.net_price ?? 0), 0)
    nuovo.amount_net = Math.round(totale * 100) / 100
    nuovo.amount_gross = Math.round(totale * 100) / 100
  }
  return nuovo
}

import { executeFicWriteTool, confirmFicStep2, A_CONFERMA_SINGOLA, FIC_WRITE_TOOLS } from './fic-write-tools'

/** L'autofattura TD17 vera: due righe, il riferimento alla fattura estera, mai trasmessa. */
function documento(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 77,
    type: 'self_supplier_invoice',
    number: 3,
    numeration: 'INT',
    date: '2026-08-03',
    entity: { id: 9, name: 'Booking.com B.V.', ei_code: 'M5UXCR1', created_at: '2026-01-01', updated_at: '2026-01-02' },
    notes: 'Riferimento: Booking.com B.V., fattura n.NC2CQ del 2026-07-31.',
    items_list: [
      { id: 501, name: 'Commissioni luglio 2026', qty: 1, net_price: 218.44, gross_price: 218.44, vat: { id: 21, value: 0 } },
      { id: 502, name: 'Fee pagamenti luglio 2026', qty: 1, net_price: 18.32, gross_price: 18.32, vat: { id: 21, value: 0 } },
    ],
    amount_net: 236.76,
    amount_vat: 0,
    amount_gross: 236.76,
    e_invoice: true,
    ei_status: null,
    ei_raw: {
      FatturaElettronicaBody: {
        DatiGenerali: {
          DatiGeneraliDocumento: { TipoDocumento: 'TD17' },
          DatiFattureCollegate: { IdDocumento: 'NC2CQ', Data: '2026-07-31' },
        },
      },
    },
    locked: false,
    created_at: '2026-08-03T10:00:00Z',
    updated_at: '2026-08-03T10:00:00Z',
    url: 'https://compute.fattureincloud.it/doc/xyz.pdf',
    ...over,
  }
}

async function json(p: Promise<string | null>) {
  return JSON.parse((await p) ?? '{}')
}

function compila(input: Record<string, unknown>) {
  return json(executeFicWriteTool('modifica_documento_fic', { id: 77, ...input }, 'restruktura'))
}

/** La riga pending come la rileggerebbe `confirmFicStep2` dopo la compilazione. */
function rigaDallaCompilazione(over: Record<string, unknown> = {}) {
  const payload = stato.inserite[stato.inserite.length - 1].payload
  return { id: 'pend-1', tipo: 'modifica_documento', payload, conferme: 1, stato: 'in_attesa', societa: 'restruktura', ...over }
}

/** Compila e conferma: e' il giro completo, quello che fa l'Ingegnere. */
async function compilaEConferma(input: Record<string, unknown>) {
  const anteprima = await compila(input)
  expect(anteprima.ok, `l'anteprima e' stata rifiutata: ${anteprima.error}`).toBe(true)
  stato.riga = rigaDallaCompilazione()
  return confirmFicStep2('pend-1')
}

/** Le righe del corpo spedito nell'ultima PUT. */
function righeSpedite() {
  return stato.put[stato.put.length - 1].body.items_list as Array<Record<string, unknown>>
}

beforeEach(() => {
  // ⚠️ Corpo a BLOCCO: un corpo conciso restituirebbe l'ultima espressione, e
  // vitest la richiamerebbe come teardown dopo ogni test.
  stato.documenti = new Map([['77', documento()]])
  stato.put = []
  stato.esitoPut = { ok: true }
  stato.applicaPut = null
  stato.inserite = []
  stato.descrizione = ''
  stato.riga = null
  stato.updates = []
  stato.eliminate = []
})

describe('l anteprima: il PRIMA e il DOPO, campo per campo', () => {
  it('🚨 CONTROLLO POSITIVO — una modifica legittima passa, e l anteprima mostra prima → dopo', async () => {
    const out = await compila({ data: '2026-08-05' })

    expect(out.ok).toBe(true)
    expect(out.anteprima).toContain('data: 2026-08-03 → 2026-08-05')
    // L'identita' del documento sta nell'anteprima: senza, «confermo» varrebbe
    // per un documento che l'Ingegnere non ha riconosciuto.
    expect(out.anteprima).toContain('3INT')
    expect(out.anteprima).toContain('Booking.com B.V.')
    expect(stato.inserite[0].tipo).toBe('modifica_documento')
    // 🚨 Preparare non e' scrivere: niente e' partito verso Fatture in Cloud.
    expect(stato.put).toEqual([])
  })

  it('senza id non prepara niente', async () => {
    const out = await json(executeFicWriteTool('modifica_documento_fic', { data: '2026-08-05' }, 'restruktura'))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('id del documento')
    expect(stato.inserite).toEqual([])
  })

  it('senza dire COSA cambiare non prepara niente', async () => {
    const out = await compila({})
    expect(out.ok).toBe(false)
    expect(out.error).toContain('non mi hai detto COSA cambiare')
    expect(stato.put).toEqual([])
  })

  it('🚨 un documento che NON esiste torna un errore vero, non un «fatto»', async () => {
    stato.documenti = new Map()
    const out = await compila({ data: '2026-08-05' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('non esiste su Fatture in Cloud')
    expect(out.error).toContain('Non ho preparato niente')
    expect(stato.inserite).toEqual([])
  })

  it('🚨 un documento BLOCCATO (locked) si rifiuta: non e un avviso', async () => {
    stato.documenti = new Map([['77', documento({ locked: true })]])
    const out = await compila({ data: '2026-08-05' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('BLOCCATO')
    expect(out.error).toContain('NOTA DI VARIAZIONE')
    expect(stato.put).toEqual([])
    expect(stato.inserite).toEqual([])
  })

  it('🚨 un documento gia mandato allo SdI si rifiuta, e dice lo stato VERO', async () => {
    stato.documenti = new Map([['77', documento({ ei_status: 'accepted' })]])
    const out = await compila({ data: '2026-08-05' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('accepted')
    expect(out.error).toContain('NOTA DI VARIAZIONE')
    expect(stato.put).toEqual([])
  })

  it('uno stato SdI SCONOSCIUTO vale «trasmesso»: si sbaglia dalla parte che non riscrive', async () => {
    stato.documenti = new Map([['77', documento({ ei_status: 'uno_stato_mai_visto' })]])
    const out = await compila({ data: '2026-08-05' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('uno_stato_mai_visto')
  })

  it('un valore gia scritto non fa toccare il documento', async () => {
    const out = await compila({ data: '2026-08-03' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('gia\' scritto cosi\'')
    expect(stato.put).toEqual([])
  })

  it('🚨 un campo VUOTO non vuol dire «cancella»', async () => {
    const out = await compila({ note: '   ' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('non lo leggo come «cancella»')
  })

  it('una riga che non esiste si rifiuta, ed elenca quelle che ci sono', async () => {
    const out = await compila({ righe: [{ riga: 5, importo: 10 }] })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('la riga 5 non esiste')
    expect(out.error).toContain('Commissioni luglio 2026')
  })

  it('🚨 senza ei_raw non si tocca la fattura collegata: riscriverla cancellerebbe il TD17', async () => {
    const senzaEiRaw = documento()
    delete senzaEiRaw.ei_raw
    stato.documenti = new Map([['77', senzaEiRaw]])

    const out = await compila({ fattura_collegata: { numero: 'NC2CQ', data: '2026-07-30' } })

    expect(out.ok).toBe(false)
    expect(out.error).toContain('TD17')
    expect(stato.put).toEqual([])
  })

  it('CONTROLLO POSITIVO — con ei_raw, la fattura collegata si cambia', async () => {
    const out = await compila({ fattura_collegata: { numero: 'NC2CQ', data: '2026-07-30' } })
    expect(out.ok).toBe(true)
    expect(out.anteprima).toContain('fattura collegata · data: 2026-07-31 → 2026-07-30')
    // Il numero non cambia: si dichiara invariato invece di sparire.
    expect(out.anteprima).toContain('Gia\' cosi\'')
  })
})

describe('la scrittura: si rilegge il documento e si riporta quello che c e davvero', () => {
  it('🚨 CONTROLLO POSITIVO — la PUT va sul documento giusto e il corpo e il documento INTERO', async () => {
    const messaggio = await compilaEConferma({ data: '2026-08-05' })

    expect(stato.put).toHaveLength(1)
    expect(stato.put[0].path).toBe('/c/111/issued_documents/77')

    const corpo = stato.put[0].body
    // Il campo chiesto, cambiato.
    expect(corpo.date).toBe('2026-08-05')
    // 🚨 E tutto il resto rispedito com'era: e' l'unica forma corretta sotto
    // ENTRAMBE le semantiche possibili del PUT (sostituzione o modifica
    // parziale), visto che la documentazione non dichiara quale sia.
    expect(corpo.number).toBe(3)
    expect(corpo.numeration).toBe('INT')
    expect(corpo.notes).toBe('Riferimento: Booking.com B.V., fattura n.NC2CQ del 2026-07-31.')
    expect((corpo.items_list as unknown[])).toHaveLength(2)
    expect(corpo.ei_raw).toEqual(documento().ei_raw)
    expect((corpo.entity as Record<string, unknown>).name).toBe('Booking.com B.V.')

    // I campi di sola lettura NON si rispediscono: FIC li calcola o li governa.
    for (const campo of ['id', 'amount_net', 'amount_vat', 'amount_gross', 'ei_status', 'locked', 'created_at', 'updated_at', 'url']) {
      expect(corpo, `${campo} non doveva essere rispedito`).not.toHaveProperty(campo)
    }
    // Le date di sistema dell'anagrafica non si rispediscono nemmeno lì dentro.
    expect(corpo.entity).not.toHaveProperty('created_at')

    expect(messaggio).toContain('DOCUMENTO MODIFICATO')
    expect(messaggio).toContain('data: 2026-08-03 → 2026-08-05')
    // La riga si chiude: una modifica scritta non si ritenta.
    expect(stato.updates.some((u) => u.stato === 'creata' && u.fic_document_id === '77')).toBe(true)
  })

  it('🚨 un campo NON passato resta com era', async () => {
    await compilaEConferma({ data: '2026-08-05' })

    const corpo = stato.put[0].body
    expect(corpo.notes).toBe(documento().notes)
    expect(righeSpedite()).toEqual(documento().items_list)
    // E nel documento vero, dopo, non e' cambiato altro che la data.
    const dopo = stato.documenti.get('77') as Record<string, unknown>
    expect(dopo.notes).toBe(documento().notes)
    expect(dopo.number).toBe(3)
  })

  it('🚨 la rilettura che NON conferma si dichiara, invece di dire «fatto»', async () => {
    // Fatture in Cloud risponde ok ma non applica niente: e' esattamente il
    // caso in cui fidarsi della risposta della PUT direbbe una bugia.
    stato.applicaPut = (doc) => doc

    const messaggio = await compilaEConferma({ data: '2026-08-05' })

    expect(messaggio).toContain('MODIFICA DA VERIFICARE')
    expect(messaggio).not.toContain('DOCUMENTO MODIFICATO')
    // Dice il valore VERO riletto, non quello che avrebbe voluto.
    expect(messaggio).toContain("rileggendo c'e' «2026-08-03»")
  })

  it('🚨 se Fatture in Cloud rifiuta, si riporta la SUA risposta: stato e testo, non un interpretazione', async () => {
    stato.esitoPut = { ok: false, error: 'Errore FIC 403: {"error":{"message":"Forbidden: document is not editable"}}' }

    const messaggio = await compilaEConferma({ data: '2026-08-05' })

    expect(messaggio).toContain('DOCUMENTO NON MODIFICATO')
    expect(messaggio).toContain('403')
    expect(messaggio).toContain('Forbidden: document is not editable')
    // Niente e' stato scritto: la riga torna a una conferma e si puo' ritentare.
    expect(stato.updates.some((u) => u.conferme === 1)).toBe(true)
    expect(stato.updates.some((u) => u.stato === 'creata')).toBe(false)
  })

  it('🚨 se il documento viene trasmesso FRA l anteprima e la conferma, non si scrive', async () => {
    const anteprima = await compila({ data: '2026-08-05' })
    expect(anteprima.ok).toBe(true)
    // Nel frattempo l'Ingegnere lo manda allo SdI da Fatture in Cloud.
    stato.documenti.set('77', documento({ locked: true, ei_status: 'sent' }))
    stato.riga = rigaDallaCompilazione()

    const messaggio = await confirmFicStep2('pend-1')

    expect(messaggio).toContain('DOCUMENTO NON MODIFICATO')
    expect(messaggio).toContain('BLOCCATO')
    expect(stato.put).toEqual([])
  })

  it('🚨 se il PRIMA e cambiato fra l anteprima e la conferma, non si scrive', async () => {
    const anteprima = await compila({ data: '2026-08-05' })
    expect(anteprima.ok).toBe(true)
    // Qualcun altro ha gia' toccato la data: il «confermo» valeva per un
    // prima/dopo che adesso non e' piu' quello.
    stato.documenti.set('77', documento({ date: '2026-08-04' }))
    stato.riga = rigaDallaCompilazione()

    const messaggio = await confirmFicStep2('pend-1')

    expect(messaggio).toContain('CAMBIATO da quando hai letto l\'anteprima')
    expect(messaggio).toContain('2026-08-04')
    expect(stato.put).toEqual([])
  })

  it('una riga si corregge per posizione, e le altre non si muovono', async () => {
    const messaggio = await compilaEConferma({ righe: [{ riga: 2, importo: 20.5, descrizione: 'Fee pagamenti luglio 2026 (corretta)' }] })

    const righe = righeSpedite()
    expect(righe).toHaveLength(2)
    // La riga NON toccata esce di qui identica, id compreso.
    expect(righe[0]).toEqual((documento().items_list as unknown[])[0])
    expect(righe[1].name).toBe('Fee pagamenti luglio 2026 (corretta)')
    expect(righe[1].net_price).toBe(20.5)
    expect(righe[1].id).toBe(502)
    // 🚨 `gross_price` e' derivato: rispedirlo vecchio accanto a un netto nuovo
    // vorrebbe dire dare a FIC due verita' in contraddizione.
    expect(righe[1]).not.toHaveProperty('gross_price')
    expect(righe[0]).toHaveProperty('gross_price')

    expect(messaggio).toContain('DOCUMENTO MODIFICATO')
    expect(messaggio).toContain('Totale ricalcolato da Fatture in Cloud: 236.76 → 238.94')
  })

  it('la fattura collegata si riscrive SENZA perdere il TD17', async () => {
    const messaggio = await compilaEConferma({ fattura_collegata: { numero: 'NC2CQNXC5QL2', data: '2026-07-30' } })

    const raw = stato.put[0].body.ei_raw as Record<string, unknown>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const generali = (raw.FatturaElettronicaBody as any).DatiGenerali
    expect(generali.DatiGeneraliDocumento.TipoDocumento).toBe('TD17')
    expect(generali.DatiFattureCollegate).toEqual({ IdDocumento: 'NC2CQNXC5QL2', Data: '2026-07-30' })
    expect(messaggio).toContain('DOCUMENTO MODIFICATO')
  })

  it('🚨 se cambia qualcosa che NON doveva, si dichiara', async () => {
    // FIC applica la data ma per un guasto suo sposta anche il numero: il
    // controllo degli invarianti esiste perche' la semantica del PUT non e'
    // documentata e una sostituzione integrale puo' perdere pezzi.
    stato.applicaPut = (doc, body) => ({ ...applicaDavvero(doc, body), number: 4 })

    const messaggio = await compilaEConferma({ data: '2026-08-05' })

    expect(messaggio).toContain('MODIFICA DA VERIFICARE')
    expect(messaggio).toContain('numero era «3INT», ora «4INT»')
  })
})

describe('le altre difese di casa, sul tipo nuovo', () => {
  it('🚨 la conferma e UNA SOLA, come per tutti gli altri documenti', () => {
    expect(A_CONFERMA_SINGOLA.has('modifica_documento')).toBe(true)
  })

  it('🚨 «annulla» su una modifica gia scritta NON cancella il documento', async () => {
    stato.riga = { id: 'pend-1', tipo: 'modifica_documento', stato: 'creata', fic_document_id: '77', societa: 'restruktura' }

    const out = await json(executeFicWriteTool('elimina_bozza_fic', { id: 'pend-1' }, 'restruktura'))

    expect(out.ok).toBe(false)
    expect(out.error).toContain('NON cancello il documento')
    // 🚨 La prova che conta: nessuna chiamata di eliminazione e' partita. Il
    // `fic_document_id` qui e' un documento che esisteva PRIMA di noi.
    expect(stato.eliminate).toEqual([])
  })

  it('CONTROLLO POSITIVO — «annulla» prima della conferma chiude la riga, e non cancella niente', async () => {
    stato.riga = { id: 'pend-1', tipo: 'modifica_documento', stato: 'in_attesa', fic_document_id: null, societa: 'restruktura' }

    const out = await json(executeFicWriteTool('elimina_bozza_fic', { id: 'pend-1' }, 'restruktura'))

    expect(out.ok).toBe(true)
    expect(out.stato).toBe('annullata')
    expect(stato.eliminate).toEqual([])
  })

  it('il tool e nell elenco, con l id obbligatorio e le due regole in descrizione', () => {
    const tool = FIC_WRITE_TOOLS.find((t) => t.name === 'modifica_documento_fic')
    expect(tool).toBeDefined()
    expect((tool!.input_schema as { required: string[] }).required).toEqual(['id'])
    // Una capacita' che non sta nella descrizione, per il modello NON ESISTE:
    // e queste due sono le regole che deve riportare all'Ingegnere.
    expect(tool!.description).toContain('NOTA DI VARIAZIONE')
    expect(tool!.description).toContain('PRIMA e il DOPO')
  })
})
