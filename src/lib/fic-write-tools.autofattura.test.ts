/**
 * src/lib/fic-write-tools.autofattura.test.ts — le autofatture in reverse
 * charge per le fatture estere (commissioni Booking a LA REAL ESTATE).
 *
 * 🚨 IL TEST CHE CONTA PIU' DI TUTTI e' il primo: senza `vat_id` il tool NON
 * sceglie un'aliquota — si ferma e restituisce l'elenco VERO letto da Fatture
 * in Cloud. Il motivo e' la conferma unica: con un predefinito sbagliato, un
 * solo «confermo» farebbe nascere quindici documenti fiscali errati allo
 * stesso modo, che e' il danno peggiore che questo sistema possa produrre.
 *
 * ⚠️ Accanto ad ogni «si rifiuta» c'e' il CONTROLLO POSITIVO: un tool che
 * rifiuta sempre passerebbe il primo test senza fare niente di utile.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stato = {
  /** Le righe passate a `insert`: una sola per gruppo di autofatture. */
  inserite: [] as Record<string, unknown>[],
  descrizione: '',
  riga: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  /** L'elenco che Fatture in Cloud restituisce su `settings/vat_types`. */
  aliquote: [] as Record<string, unknown>[],
  anagrafica: [] as Record<string, unknown>[],
  schede: new Map<string, Record<string, unknown>>(),
  /** I payload spediti a `creaDocumentoFIC`, in ordine. */
  creati: [] as Record<string, unknown>[],
  esitiCreazione: [] as Array<{ ok: boolean; id?: string; error?: string }>,
  /** Cosa risponde la RILETTURA per ogni id creato. */
  riletture: new Map<string, Record<string, unknown>>(),
  eliminate: [] as string[],
  /**
   * Cosa risponde la VERIFICA FORMALE di Fatture in Cloud, e cosa le e' stato
   * chiesto. ⚠️ Qui non si stuzza il modulo `fic-verifica-formale`: si stuzza
   * `fetch`, cosi' il test guarda il METODO e l'URL veri che escono — e si
   * accorgerebbe se un giorno qualcuno cambiasse quella GET in un invio.
   */
  verificaFormale: { status: 200, body: JSON.stringify({ data: { success: true } }) },
  chiamateVerifica: [] as Array<{ url: string; method: string }>,
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
            () => [{ id: 'pend-1', societa: 'larealestate', stato: row.stato ?? 'in_attesa' }],
            () => ({ id: 'pend-1', descrizione: stato.descrizione }),
          )
        },
      }),
    },
  }
})

vi.mock('./fatture-in-cloud', () => ({
  ficGet: async (path: string) => {
    if (path.includes('/settings/vat_types')) {
      return { ok: true, data: { data: stato.aliquote, last_page: 1 } }
    }
    const scheda = /\/entities\/(?:clients|suppliers)\/(\d+)$/.exec(path)
    if (scheda) {
      const trovata = stato.schede.get(scheda[1])
      return trovata ? { ok: true, data: { data: trovata } } : { ok: false, error: 'anagrafica non trovata' }
    }
    if (path.includes('/entities/')) return { ok: true, data: { data: stato.anagrafica } }
    const documento = /\/issued_documents\/(.+)$/.exec(path)
    if (documento) {
      const trovato = stato.riletture.get(documento[1])
      return trovato ? { ok: true, data: { data: trovato } } : { ok: false, error: 'documento non trovato su FIC' }
    }
    return { ok: true, data: { data: [] } }
  },
  ficPost: async () => ({ ok: true, data: { data: {} } }),
  ficPut: async () => ({ ok: true, data: { data: {} } }),
  getCompanyId: async () => ({ ok: true, id: '111' }),
  // Serve alla verifica formale, che parla con FIC da sola (una GET).
  getFicToken: () => 'token-finto',
  creaDocumentoFIC: async (payload: Record<string, unknown>) => {
    stato.creati.push(payload)
    const esito = stato.esitiCreazione.shift() ?? { ok: true, id: `doc-${stato.creati.length}` }
    return esito.ok
      ? { ok: true as const, id: esito.id ?? `doc-${stato.creati.length}`, url: null }
      : { ok: false as const, error: esito.error ?? 'rifiutata da FIC' }
  },
  eliminaDocumentoFIC: async (id: string) => { stato.eliminate.push(id); return { ok: true } },
}))

import { executeFicWriteTool, confirmFicStep2, FIC_WRITE_TOOLS } from './fic-write-tools'

/** Le due aliquote che un'azienda ha davvero su FIC: l'ordinaria e una N6.x. */
const ALIQUOTE_FIC = [
  { id: 0, value: 22, description: 'Aliquota 22%' },
  { id: 21, value: 0, description: 'Inversione contabile', ei_type: 'N6.9', ei_description: 'inversione contabile - altri casi' },
]

/**
 * Le commissioni di un mese: tre fatture estere, tre autofatture.
 *
 * Tutte POSTERIORI al 22/07/2026, la data di iscrizione al VIES de LA REAL
 * ESTATE: prima di quella data le stesse fatture NON si integrano affatto.
 * E non c'e' solo Booking: lo schema vale identico per Airbnb.
 */
const BOOKING = [
  { fornitore: 'Booking.com B.V.', fornitore_id: 9, numero: '1234567890', data: '2026-08-31', data_ricezione: '2026-09-01', imponibile: 218.44 },
  { fornitore: 'Booking.com B.V.', fornitore_id: 9, numero: '1234567891', data: '2026-08-31', data_ricezione: '2026-09-01', imponibile: 41.9 },
  { fornitore: 'Airbnb Ireland UC', fornitore_id: 12, numero: 'AB-77', data: '2026-08-15', data_ricezione: '2026-08-18', imponibile: 18.32 },
]

/** La serie dedicata alle integrazioni: il tool non la inventa, gliela si dice. */
const SERIE = 'INT'

beforeEach(() => {
  // ⚠️ Corpo a BLOCCO: un corpo conciso restituirebbe l'ultima espressione, e
  // vitest la richiamerebbe come teardown dopo ogni test.
  stato.inserite = []
  stato.descrizione = ''
  stato.riga = null
  stato.updates = []
  stato.aliquote = ALIQUOTE_FIC.map((a) => ({ ...a }))
  stato.anagrafica = []
  stato.schede = new Map([
    ['9', { id: 9, name: 'Booking.com B.V.' }],
    ['12', { id: 12, name: 'Airbnb Ireland UC' }],
  ])
  stato.creati = []
  stato.esitiCreazione = []
  stato.riletture = new Map()
  stato.eliminate = []
  stato.verificaFormale = { status: 200, body: JSON.stringify({ data: { success: true } }) }
  stato.chiamateVerifica = []
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
    stato.chiamateVerifica.push({ url: String(url), method: init?.method ?? 'GET' })
    const { status, body } = stato.verificaFormale
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    } as unknown as Response
  })
})

async function compila(input: Record<string, unknown>) {
  return JSON.parse(String(await executeFicWriteTool('compila_autofattura', input, 'larealestate')))
}

/**
 * 🚨 IL DOCUMENTO MODELLO — `issued_documents/552759661`, letto dal gestionale
 * il 15 settembre 2026.
 *
 * E' l'autofattura TD17 che l'Ingegnere ha CORRETTO A MANO e INVIATO allo SdI
 * (`ei_status: "sent"`, `locked: true`). Non e' un esempio: e' il documento
 * giusto, e questo blocco confronta campo per campo quello che il tool
 * spedisce con quello che c'e' scritto li'.
 *
 * ⚠️ La regola che questo test incarna, dettata dall'Ingegnere dopo mezza
 * giornata persa: **non si indovinano i campi dell'API — si prende il
 * documento CORRETTO e se ne replica il JSON**, cambiando solo i campi
 * variabili. Ogni campo DEDOTTO in questa settimana (da un'etichetta su un
 * PDF, dalla struttura di un XML prodotto per un'altra strada, dalla
 * «prudenza») si e' rivelato sbagliato; ogni campo letto da una FONTE VERA e'
 * stato giusto al primo colpo.
 */
const MODELLO_AUTOFATTURA = {
  type: 'self_supplier_invoice',
  numeration: 'INT',
  date: '2026-09-03',
  amount_net: 239.16,
  amount_gross: 291.78,
  entity: {
    id: 54043577,
    name: 'Booking.com B.V.',
    vat_number: 'NL805734958B01',
    country: 'Paesi Bassi',
    ei_code: 'M5UXCR1',
  },
  extra_data: { debt_vat_detect: true, revenue_detect: false },
  ei_data: { payment_method: 'MP01' },
  ei_raw: {
    FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD17' } } },
    FatturaElettronicaHeader: { CedentePrestatore: { DatiAnagrafici: { RegimeFiscale: 'RF18' } } },
  },
  payments_list: [{ amount: 291.78, due_date: '2026-09-03', status: 'reversed' }],
} as const

/** La fattura estera da cui il modello e' nato, con gli stessi dati variabili. */
const FATTURA_DEL_MODELLO = {
  fornitore: 'Booking.com B.V.',
  fornitore_id: 54043577,
  numero: '1661866743',
  data: '2026-09-03',
  data_ricezione: '2026-09-03',
  imponibile: 239.16,
}

describe('🚨 RISPECCHIAMENTO — il payload ricalca l autofattura CORRETTA A MANO', () => {
  beforeEach(() => {
    // L'anagrafica com'e' su Fatture in Cloud: il cedente estero porta paese e
    // partita IVA comunitaria, ed e' da li' che devono arrivare al documento.
    stato.schede.set('54043577', {
      id: MODELLO_AUTOFATTURA.entity.id,
      name: MODELLO_AUTOFATTURA.entity.name,
      vat_number: MODELLO_AUTOFATTURA.entity.vat_number,
      country: MODELLO_AUTOFATTURA.entity.country,
    })
    // L'aliquota ordinaria, che sul modello e' `vat: { id: 0, value: 22 }`.
    stato.aliquote = [{ id: 0, value: 22, description: 'Aliquota 22%' }]
  })

  async function payloadDelModello(): Promise<Record<string, unknown>> {
    await compila({ fatture: [FATTURA_DEL_MODELLO], vat_id: 0, numerazione: MODELLO_AUTOFATTURA.numeration })
    const pending = stato.inserite[0].payload as { documenti: Array<{ payload: Record<string, unknown> }> }
    return pending.documenti[0].payload
  }

  it('🚨 extra_data: LE DUE RILEVAZIONI CONTABILI, che fino a oggi credevamo non impostabili', async () => {
    // La scoperta del 15 settembre 2026. `extra_data` e' un oggetto libero,
    // per questo l'SDK non ne elenca le chiavi — e per questo le due
    // rilevazioni sembravano «solo da interfaccia».
    //
    // Senza `debt_vat_detect` l'IVA 22% dell'integrazione non entra in
    // liquidazione e il reverse charge resta monco; senza `revenue_detect:
    // false` l'imponibile diventa un RICAVO fittizio e gonfia il fatturato.
    const p = await payloadDelModello()

    expect(p.extra_data).toEqual(MODELLO_AUTOFATTURA.extra_data)
  })

  it('entity: id, nome, partita IVA comunitaria e paese arrivano dall anagrafica; ei_code e il NOSTRO', async () => {
    const p = await payloadDelModello()
    const entity = p.entity as Record<string, unknown>

    expect(entity.id).toBe(MODELLO_AUTOFATTURA.entity.id)
    expect(entity.name).toBe(MODELLO_AUTOFATTURA.entity.name)
    expect(entity.vat_number).toBe(MODELLO_AUTOFATTURA.entity.vat_number)
    expect(entity.country).toBe(MODELLO_AUTOFATTURA.entity.country)
    // 🚨 Il codice destinatario e' quello della NOSTRA societa': un'
    // integrazione torna a noi. FIC, lasciato fare, scriverebbe `XXXXXXX`.
    expect(entity.ei_code).toBe(MODELLO_AUTOFATTURA.entity.ei_code)
  })

  it('ei_raw: TD17 e RF18, identici al modello e senza DatiFattureCollegate', async () => {
    // ⚠️ `DatiFattureCollegate` NON deve tornare: passato via API, FIC lo
    // serializza come attributi `2.1.6` sciolti e produce blocchi senza
    // `IdDocumento` — e' il difetto che stamattina ha reso non valide quattro
    // autofatture, e che dall'interfaccia di FIC non si puo' nemmeno
    // cancellare. Il modello, che e' VALIDO e INVIATO, non lo porta.
    const p = await payloadDelModello()

    expect(p.ei_raw).toEqual(MODELLO_AUTOFATTURA.ei_raw)
    expect(JSON.stringify(p.ei_raw)).not.toContain('DatiFattureCollegate')
    expect(JSON.stringify(p)).not.toContain('2.1.6')
  })

  it('type, numerazione, data e imponibile sono quelli del modello', async () => {
    const p = await payloadDelModello()

    expect(p.type).toBe(MODELLO_AUTOFATTURA.type)
    expect(p.numeration).toBe(MODELLO_AUTOFATTURA.numeration)
    // La data dell'integrazione e' quella di RICEZIONE della fattura estera.
    expect(p.date).toBe(MODELLO_AUTOFATTURA.date)
    expect((p.items_list as Array<{ net_price: number }>)[0].net_price).toBe(MODELLO_AUTOFATTURA.amount_net)
    expect((p.items_list as Array<{ vat: { id: number } }>)[0].vat.id).toBe(0)
    expect(p.e_invoice).toBe(true)
  })

  it('⬜ DIVERGENZA DICHIARATA — ei_data.payment_method: il modello dice MP01, noi mandiamo MP05', async () => {
    // 🚨 Questo test non pretende che i due combacino: PINNA la divergenza,
    // perche' sparisca solo quando qualcuno DECIDE, non per distrazione.
    //
    // Il modello — corretto a mano e inviato — porta `MP01`. Il codice manda
    // `MP05` perche' l'Ingegnere ha chiesto esplicitamente di non usare
    // «contanti» su una commissione trattenuta dal bonifico, e la specifica
    // dice che su un reverse charge il campo e' ininfluente. Quale mettere e'
    // una decisione sua: sta nel rapporto, e finche' non risponde resta MP05.
    const p = await payloadDelModello()
    const eiData = p.ei_data as { payment_method: string }

    expect(eiData.payment_method).toBe('MP05')
    expect(MODELLO_AUTOFATTURA.ei_data.payment_method).toBe('MP01')
  })

  it('se l anagrafica del cedente e MUTA su paese e partita IVA, l anteprima lo DICE', async () => {
    // ⚠️ Un AVVISO, non un rifiuto. I due dati non si inventano — si copiano
    // dall'anagrafica o non ci sono — e una guardia che blocca un caso che
    // Fatture in Cloud accetterebbe e' peggio del buco che chiude. Ma restare
    // zitti vorrebbe dire far nascere un'integrazione col cedente monco senza
    // che nessuno lo veda: si scrive nell'anteprima, che e' l'unica cosa che
    // l'Ingegnere legge prima dell'unica conferma.
    stato.schede.set('54043577', { id: 54043577, name: 'Booking.com B.V.' })

    await compila({ fatture: [FATTURA_DEL_MODELLO], vat_id: 0, numerazione: 'INT' })

    expect(stato.descrizione).toContain('PARTITA IVA comunitaria')
    expect(stato.descrizione).toContain('PAESE')
    // Il documento si prepara lo stesso: l'avviso non blocca.
    expect(stato.inserite).toHaveLength(1)
  })

  it('CONTROLLO POSITIVO — con l anagrafica completa NON semina avvisi', async () => {
    // Senza questo, un avviso stampato SEMPRE passerebbe il test qui sopra e
    // insegnerebbe a ignorarlo.
    await compila({ fatture: [FATTURA_DEL_MODELLO], vat_id: 0, numerazione: 'INT' })

    expect(stato.descrizione).not.toContain('PARTITA IVA comunitaria')
    expect(stato.descrizione).not.toContain('l\'anagrafica di questo fornitore')
  })

  it('CONTROLLO POSITIVO — il confronto saprebbe FALLIRE: un payload diverso non passa', async () => {
    // Senza questo, un test che confronta `p.extra_data` con se stesso
    // passerebbe anche a rilevazioni sbagliate.
    const p = await payloadDelModello()

    expect(p.extra_data).not.toEqual({ debt_vat_detect: false, revenue_detect: true })
    expect(p.ei_raw).not.toEqual({})
    expect((p.entity as Record<string, unknown>).ei_code).not.toBe('XXXXXXX')
  })
})

describe('🚨 l\'IVA non si indovina', () => {
  it('SENZA vat_id il tool si RIFIUTA e restituisce l elenco VERO delle aliquote', async () => {
    const out = await compila({ fatture: BOOKING })

    expect(out.need).toBe('vat_id')
    // L'elenco e' quello letto da Fatture in Cloud, natura N6.9 compresa: non
    // una lista scritta a mano nel codice.
    expect(out.aliquote_disponibili).toEqual(ALIQUOTE_FIC)
    expect(JSON.stringify(out.aliquote_disponibili)).toContain('N6.9')
    // Niente pending, niente documenti: non ha scelto un'aliquota per conto suo.
    expect(stato.inserite).toHaveLength(0)
    expect(stato.creati).toHaveLength(0)
    expect(String(out.messaggio)).toMatch(/non scelgo io/i)
  })

  it('il contesto normativo e un INDICAZIONE per l Ingegnere, non un id gia scelto', async () => {
    // 14 set 2026: l'Ingegnere e in regime ORDINARIO e una commissione di
    // piattaforma estera si integra all'aliquota ordinaria. Quel fatto puo
    // essere DETTO, ma non deve diventare un predefinito: il rifiuto non deve
    // nominare ne un id ne una percentuale, altrimenti il tool ha scelto.
    const out = await compila({ fatture: BOOKING })

    const contesto = String(out.contesto_per_l_ingegnere)
    expect(contesto).toMatch(/ordinaria/i)
    expect(contesto).toMatch(/scelga LUI/i)
    expect(contesto).not.toMatch(/\d+\s*%/)
    expect(contesto).not.toMatch(/vat_id\s*[:=]\s*\d/)
    expect(out.vat_id).toBeUndefined()
  })

  it('un vat_id INVENTATO non passa: non esiste fra le aliquote dell azienda', async () => {
    const out = await compila({ fatture: BOOKING, vat_id: 999, numerazione: SERIE })

    expect(out.need).toBe('vat_id')
    expect(String(out.messaggio)).toContain('999')
    expect(stato.inserite).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO — con vat_id indicato prepara il documento DAVVERO', async () => {
    // Senza questo test, un tool che rifiuta sempre passerebbe quello sopra.
    const out = await compila({ fatture: BOOKING, vat_id: 21, numerazione: SERIE })

    expect(out.ok).toBe(true)
    expect(out.need).toBeUndefined()
    expect(out.id).toBe('pend-1')
    expect(out.da_creare).toBe(3)
    expect(stato.inserite).toHaveLength(1)
    expect(stato.inserite[0].tipo).toBe('autofattura')
    // L'aliquota riportata e' quella LETTA da FIC, con la sua natura.
    expect(String(out.iva.etichetta)).toContain('N6.9')
  })
})

describe('il payload spedito a Fatture in Cloud', () => {
  it('🚨 ha type self_supplier_invoice e nasce ELETTRONICA: senza, non si puo trasmettere allo SdI', async () => {
    await compila({ fatture: BOOKING, vat_id: 21, numerazione: SERIE })

    const payload = (stato.inserite[0].payload as { documenti: Array<{ payload: Record<string, unknown> }> })
    for (const d of payload.documenti) {
      // ⚠️ self_SUPPLIER_invoice: chi emette e' il cliente, il fornitore estero
      // e' il fornitore. `self_own_invoice` sarebbe il documento sbagliato.
      expect(d.payload.type).toBe('self_supplier_invoice')
      // 15 set 2026: era `false`, e su Fatture in Cloud il tasto per
      // trasmettere non compariva nemmeno. Un'integrazione TD17 si assolve
      // TRASMETTENDOLA: nascere non elettronica la rendeva inutile.
      expect(d.payload.e_invoice).toBe(true)
      expect((d.payload.items_list as Array<{ vat: { id: number } }>)[0].vat.id).toBe(21)
    }
  })

  it('🚨 il codice TD17 sta in `ei_raw`, NON nel campo `type`', async () => {
    // Senza questa struttura il documento non e' un'integrazione TD17: e' una
    // normale autofattura, corretta in apparenza e sbagliata nella sostanza.
    // E' il punto su cui il lavoro poteva essere silenziosamente sbagliato.
    await compila({ fatture: BOOKING, vat_id: 21, numerazione: SERIE })

    const payload = (stato.inserite[0].payload as { documenti: Array<{ payload: Record<string, unknown> }> })
    for (const d of payload.documenti) {
      const eiRaw = d.payload.ei_raw as {
        FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: string } } }
      }
      expect(eiRaw.FatturaElettronicaBody.DatiGenerali.DatiGeneraliDocumento.TipoDocumento).toBe('TD17')
      // Il `type` resta quello della FORMA del documento su Fatture in Cloud:
      // sono due cose diverse, e confonderle e' esattamente il difetto.
      expect(d.payload.type).toBe('self_supplier_invoice')
    }
  })

  it('🚨 la data dell integrazione e quella di RICEZIONE, una per fattura — non oggi', async () => {
    await compila({ fatture: BOOKING, vat_id: 21, numerazione: SERIE })

    const payload = (stato.inserite[0].payload as {
      documenti: Array<{ numero: string; data: string; data_ricezione: string; imponibile: number; payload: Record<string, unknown> }>
    })
    // Le tre fatture hanno DUE date di ricezione diverse: se ci fosse una data
    // unica di gruppo, la terza sarebbe datata sbagliata.
    expect(payload.documenti[0].payload.date).toBe('2026-09-01')
    expect(payload.documenti[2].payload.date).toBe('2026-08-18')
    // Numero e data della fattura estera restano quelli originali.
    expect(payload.documenti[0].data).toBe('2026-08-31')
    expect(payload.documenti[2].imponibile).toBe(18.32)
    expect((payload.documenti[2].payload.items_list as Array<{ net_price: number }>)[0].net_price).toBe(18.32)
    // Serie DEDICATA: senza, FIC numererebbe fra le fatture attive.
    expect(payload.documenti[0].payload.numeration).toBe(SERIE)
    // Il riferimento alla fattura originale viaggia nelle note.
    expect(String(payload.documenti[0].payload.notes)).toContain('1234567890')
    expect(String(payload.documenti[0].payload.notes)).toContain('2026-08-31')
  })

  it('una data di documento passata a mano viene RIFIUTATA: non e una scelta', async () => {
    const out = await compila({ fatture: BOOKING, vat_id: 21, numerazione: SERIE, data_documento: '2026-09-30' })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/ricezione/i)
    expect(stato.inserite).toHaveLength(0)
  })
})

describe('🚨 la guardia del VIES: prima dell iscrizione non si integra affatto', () => {
  // LA REAL ESTATE e' iscritta VIES dal 22/07/2026 (societa.ts). Una fattura
  // Booking anteriore riporta IVA italiana al 22% e si registra come normale
  // acquisto con IVA detraibile: autofatturarla produce un documento
  // illegittimo. E' un RIFIUTO, non un avviso.
  it('una fattura ricevuta PRIMA del 22/07/2026 viene rifiutata, col motivo', async () => {
    const out = await compila({
      fatture: [{ fornitore: 'Booking.com B.V.', fornitore_id: 9, numero: 'LUG-1', data: '2026-06-30', data_ricezione: '2026-07-02', imponibile: 300 }],
      vat_id: 21,
      numerazione: SERIE,
    })

    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/VIES/)
    expect(out.vies_dal).toBe('2026-07-22')
    expect(stato.inserite).toHaveLength(0)
  })

  it('una sola fattura fuori data ferma TUTTO il gruppo, non solo se stessa', async () => {
    const out = await compila({
      fatture: [
        ...BOOKING,
        { fornitore: 'Booking.com B.V.', fornitore_id: 9, numero: 'LUG-1', data: '2026-06-30', data_ricezione: '2026-07-02', imponibile: 300 },
      ],
      vat_id: 21,
      numerazione: SERIE,
    })

    expect(out.ok).toBe(false)
    // Una conferma sola per N documenti non puo' nascondere un documento
    // illegittimo in fondo all'elenco.
    expect(stato.inserite).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO — il giorno stesso dell iscrizione passa', async () => {
    // Senza questo, una guardia che rifiuta SEMPRE passerebbe i due test qui
    // sopra e il tool non servirebbe a niente.
    const out = await compila({
      fatture: [{ fornitore: 'Booking.com B.V.', fornitore_id: 9, numero: 'VIES-0', data: '2026-07-22', data_ricezione: '2026-07-22', imponibile: 300 }],
      vat_id: 21,
      numerazione: SERIE,
    })

    expect(out.ok).toBe(true)
    expect(out.da_creare).toBe(1)
  })
})

describe('quello che il tool non inventa: la serie e l anagrafica del cedente', () => {
  it('senza `numerazione` si ferma e la CHIEDE: non usa la serie delle fatture attive', async () => {
    const out = await compila({ fatture: BOOKING, vat_id: 21 })

    expect(out.need).toBe('numerazione')
    expect(String(out.messaggio)).toMatch(/dedicata/i)
    expect(stato.inserite).toHaveLength(0)
  })

  it('un fornitore che NON e in anagrafica viene rifiutato: senza P.IVA comunitaria non e un documento valido', async () => {
    // `resolveClientEntity` da solo compilerebbe col solo nome, avvisando.
    // Su un'integrazione l'avviso non basta: mancano i dati del cedente.
    const out = await compila({
      fatture: [{ fornitore: 'Piattaforma Sconosciuta Ltd', numero: 'X-1', data: '2026-08-01', data_ricezione: '2026-08-02', imponibile: 50 }],
      vat_id: 21,
      numerazione: SERIE,
    })

    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/anagrafica/i)
    expect(stato.inserite).toHaveLength(0)
  })
})

describe('la conferma MASSIVA: N autofatture, UNA conferma', () => {
  it('tre autofatture producono UN SOLO pending, e l anteprima le nomina tutte e tre', async () => {
    const out = await compila({ fatture: BOOKING, vat_id: 21, numerazione: SERIE })

    expect(stato.inserite).toHaveLength(1)

    const anteprima = String(out.anteprima)
    // Ogni autofattura, con fornitore, numero della fattura originale, data e
    // imponibile: una conferma sola vale solo se l'anteprima e' quella vera.
    expect(anteprima).toContain('Booking.com B.V.')
    expect(anteprima).toContain('Airbnb Ireland UC')
    for (const f of BOOKING) {
      expect(anteprima, f.numero).toContain(`n.${f.numero}`)
      expect(anteprima, f.data).toContain(f.data)
    }
    expect(anteprima).toContain('218,44')
    expect(anteprima).toContain('41,90')
    expect(anteprima).toContain('18,32')
    // L'aliquota scelta, e il fatto che non si trasmette niente.
    expect(anteprima).toContain('N6.9')
    expect(anteprima).toContain('self_supplier_invoice')
    expect(anteprima).toMatch(/NON vengono trasmesse/)
    // Una sola coppia di comandi per tutte e tre.
    expect(String(out.conferma_1)).toContain('fic_ok')
    // Niente e' ancora nato su Fatture in Cloud.
    expect(stato.creati).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO — una sola autofattura continua a funzionare', async () => {
    const out = await compila({ fatture: [BOOKING[2]], vat_id: 21, numerazione: SERIE })

    expect(out.ok).toBe(true)
    expect(out.da_creare).toBe(1)
    expect(stato.inserite).toHaveLength(1)
    expect(String(out.anteprima)).toContain('Airbnb Ireland UC')
  })
})

describe('la seconda conferma crea i documenti, e l esito viene dalla RILETTURA', () => {
  function pendingConfermato(documenti: Array<Record<string, unknown>>) {
    return {
      id: 'pend-1',
      tipo: 'autofattura',
      stato: 'in_attesa',
      conferme: 1,
      societa: 'larealestate',
      payload: {
        vat: { id: 21, etichetta: 'id 21 — 0% — Inversione contabile — natura N6.9' },
        numerazione: 'INT',
        documenti,
      },
    }
  }

  const DUE = [
    {
      fornitore: 'Booking.com B.V.',
      numero: '1234567890',
      data: '2026-08-31',
      imponibile: 218.44,
      payload: { type: 'self_supplier_invoice', entity: { id: 9, name: 'Booking.com B.V.' }, date: '2026-09-01', e_invoice: false, items_list: [{ name: 'x', qty: 1, net_price: 218.44, vat: { id: 21 } }] },
    },
    {
      fornitore: 'Airbnb Ireland UC',
      numero: 'AB-77',
      data: '2026-08-15',
      imponibile: 18.32,
      payload: { type: 'self_supplier_invoice', entity: { id: 12, name: 'Airbnb Ireland UC' }, date: '2026-09-01', e_invoice: false, items_list: [{ name: 'y', qty: 1, net_price: 18.32, vat: { id: 21 } }] },
    },
  ]

  it('due su due create e rilette: le crea davvero e chiude la riga', async () => {
    stato.riga = pendingConfermato(DUE)
    stato.riletture.set('doc-1', { id: 'doc-1', type: 'self_supplier_invoice' })
    stato.riletture.set('doc-2', { id: 'doc-2', type: 'self_supplier_invoice' })

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('AUTOFATTURE CREATE')
    expect(out).not.toContain('IN PARTE')
    expect(stato.creati).toHaveLength(2)
    expect(stato.updates.some((u) => u.stato === 'creata')).toBe(true)
  })

  it('🚨 se una non nasce NON dice «fatte tutte»: dice quale si e quale no, col motivo', async () => {
    stato.riga = pendingConfermato(DUE)
    stato.esitiCreazione = [{ ok: true, id: 'doc-1' }, { ok: false, error: '422 entity.name' }]
    stato.riletture.set('doc-1', { id: 'doc-1', type: 'self_supplier_invoice' })

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('AUTOFATTURE CREATE IN PARTE')
    expect(out).toContain('1 su 2')
    expect(out).toContain('NON CREATE')
    expect(out).toContain('422 entity.name')
    expect(out).toContain('AB-77')
  })

  it('🚨 se la POST risponde ma la RILETTURA no, non e una riuscita: e da verificare a mano', async () => {
    // L'esito non viene dalla risposta della POST. Qui FIC dice 200 e poi il
    // documento non si rilegge: contarlo fra le riuscite sarebbe una bugia.
    stato.riga = pendingConfermato([DUE[0]])
    stato.esitiCreazione = [{ ok: true, id: 'doc-1' }]
    // nessuna rilettura preparata: il documento non si rilegge

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('NESSUNA autofattura creata')
    expect(out).toContain('DA VERIFICARE A MANO')
    // La riga si CHIUDE lo stesso: ritentare creerebbe il doppione di un
    // documento che forse esiste gia'.
    expect(stato.updates.some((u) => u.stato === 'creata')).toBe(true)
  })

  it('una rilettura che torna un tipo DIVERSO non vale come conferma', async () => {
    stato.riga = pendingConfermato([DUE[0]])
    stato.riletture.set('doc-1', { id: 'doc-1', type: 'invoice' })

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('DA VERIFICARE A MANO')
    expect(out).toContain('invoice')
  })

  it('🚨 un documento che risulta TD01 invece di TD17 viene dichiarato sospetto', async () => {
    // Il documento c'e', ma non e' l'integrazione che l'Ingegnere ha
    // confermato: contarlo fra le riuscite sarebbe la bugia peggiore.
    stato.riga = pendingConfermato([DUE[0]])
    stato.riletture.set('doc-1', {
      id: 'doc-1',
      type: 'self_supplier_invoice',
      ei_raw: { FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD01' } } } },
    })

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('DA VERIFICARE A MANO')
    expect(out).toContain('TD01')
  })

  it('CONTROLLO POSITIVO — una rilettura SENZA ei_raw non rende sospetto niente', async () => {
    // ⚠️ `ei_raw` assente vuol dire «non l'ho visto», non «non c'e'». Se
    // l'assenza contasse come errore, OGNI autofattura risulterebbe sospetta
    // per un guasto di lettura — e la segnalazione non varrebbe piu' niente.
    stato.riga = pendingConfermato([DUE[0]])
    stato.riletture.set('doc-1', { id: 'doc-1', type: 'self_supplier_invoice' })

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('AUTOFATTURE CREATE')
    expect(out).not.toContain('DA VERIFICARE A MANO')
  })

  it('CONTROLLO POSITIVO — con TD17 riletto la creazione e riuscita', async () => {
    stato.riga = pendingConfermato([DUE[0]])
    stato.riletture.set('doc-1', {
      id: 'doc-1',
      type: 'self_supplier_invoice',
      ei_raw: { FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD17' } } } },
    })

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('AUTOFATTURE CREATE')
    expect(out).not.toContain('DA VERIFICARE A MANO')
  })
})

/**
 * 🚨 LA VERIFICA FORMALE — il presidio che stamattina non c'era.
 *
 * Il 15 settembre 2026 il tool ha creato QUATTRO integrazioni TD17 con dentro
 * attributi `2.1.6` che rendevano l'XML non valido, ha riletto ognuna, ha
 * trovato id e tipo giusti, e ha detto «AUTOFATTURE CREATE: 4 su 4». Le ha
 * scoperte l'Ingegnere aprendo a mano la Verifica formale sul gestionale, e ha
 * dovuto rifarle tutte e quattro.
 *
 * Da qui in poi il tool quella verifica la chiede lui, e se l'XML non passa
 * NON dichiara successo.
 */
describe('🚨 dopo la creazione si chiede la VERIFICA FORMALE a Fatture in Cloud', () => {
  function pendingPronto() {
    return {
      id: 'pend-1',
      tipo: 'autofattura',
      stato: 'in_attesa',
      conferme: 1,
      societa: 'larealestate',
      payload: {
        vat: { id: 21, etichetta: 'id 21 — Inversione contabile' },
        numerazione: 'INT',
        documenti: [{
          fornitore: 'Booking.com B.V.',
          numero: '1661866743',
          data: '2026-09-03',
          imponibile: 239.16,
          payload: { type: 'self_supplier_invoice', entity: { id: 54043577 }, date: '2026-09-03', items_list: [{ name: 'x', net_price: 239.16, vat: { id: 21 } }] },
        }],
      },
    }
  }

  beforeEach(() => {
    stato.riga = pendingPronto()
    stato.riletture.set('doc-1', {
      id: 'doc-1',
      type: 'self_supplier_invoice',
      ei_raw: { FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD17' } } } },
    })
  })

  it('⛔ chiede in GET l endpoint di VERIFICA, non quello di invio', async () => {
    // La difesa non e' una promessa nel commento: si guarda il metodo e l'URL
    // VERI che escono dal codice. Se un giorno qualcuno trasformasse questa
    // chiamata in una trasmissione allo SdI, questo test lo dice.
    await confirmFicStep2('pend-1')

    expect(stato.chiamateVerifica).toHaveLength(1)
    expect(stato.chiamateVerifica[0].method).toBe('GET')
    expect(stato.chiamateVerifica[0].url).toContain('/c/111/issued_documents/doc-1/e_invoice/xml_verify')
    // ⛔ Nessuna chiamata di INVIO, in nessuna forma.
    for (const c of stato.chiamateVerifica) {
      expect(c.url).not.toMatch(/e_invoice\/send/)
      expect(c.method).toBe('GET')
    }
  })

  it('🚨 se l XML NON e valido il tool NON dichiara successo e riporta gli errori TESTUALI', async () => {
    stato.verificaFormale = {
      status: 400,
      body: JSON.stringify({
        error: {
          message: 'Validation XML',
          validation_result: { xml_errors: [
            'DatiFattureCollegate: dovrebbe esserci l\'elemento IdDocumento',
            'CedentePrestatore: RegimeFiscale mancante',
          ] },
        },
      }),
    }

    const out = await confirmFicStep2('pend-1')

    expect(out).not.toContain('AUTOFATTURE CREATE su')
    expect(out).toContain('CREATE MA NON VALIDE')
    // L'id del documento creato c'e': va corretto a mano, non rifatto.
    expect(out).toContain('doc-1')
    // Gli errori si riportano INTERI: parafrasarli cancellerebbe la parte che
    // dice quale campo e' sbagliato.
    expect(out).toContain('dovrebbe esserci l\'elemento IdDocumento')
    expect(out).toContain('RegimeFiscale mancante')
  })

  it('🚨 un XML non valido NON rende il gruppo ritentabile: il documento esiste gia', async () => {
    // Se la riga tornasse a `conferme: 1`, un secondo «confermo» creerebbe la
    // COPIA di un documento che sta gia' su Fatture in Cloud — due documenti
    // sbagliati invece di uno.
    stato.verificaFormale = {
      status: 400,
      body: JSON.stringify({ error: { message: 'Validation XML', validation_result: { xml_errors: ['x'] } } }),
    }

    await confirmFicStep2('pend-1')

    expect(stato.updates.some((u) => u.conferme === 1)).toBe(false)
    expect(stato.updates.some((u) => u.stato === 'creata')).toBe(true)
  })

  it('CONTROLLO POSITIVO — quando NON nasce niente il gruppo resta ritentabile', async () => {
    // Senza questo, una guardia che non rimette MAI `conferme: 1` passerebbe
    // il test qui sopra senza fare niente di utile.
    stato.esitiCreazione = [{ ok: false, error: '422 campo mancante' }]

    await confirmFicStep2('pend-1')

    expect(stato.updates.some((u) => u.conferme === 1)).toBe(true)
  })

  it('🚨 una verifica che NON si e potuta fare non e una verifica passata', async () => {
    // Il difetto di famiglia di questa casa: il guasto travestito da esito
    // buono. Un 403 (all'app manca lo scope) non dice niente sull'XML.
    stato.verificaFormale = { status: 403, body: JSON.stringify({ error: { message: 'insufficient scope' } }) }

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('AUTOFATTURE CREATE')
    expect(out).toContain('Verifica formale NON ESEGUITA')
    expect(out).toContain('issued_documents.invoices:r')
  })

  it('CONTROLLO POSITIVO — con XML valido lo dice, e non semina avvisi a vuoto', async () => {
    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('AUTOFATTURE CREATE')
    expect(out).toContain('XML VALIDO')
    expect(out).not.toContain('NON ESEGUITA')
    expect(out).not.toContain('CREATE MA NON VALIDE')
  })

  it('un 200 che NON dice se e valido non vale come «valido»', async () => {
    stato.verificaFormale = { status: 200, body: JSON.stringify({ data: {} }) }

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('Verifica formale NON ESEGUITA')
  })
})

describe('annullare un gruppo di autofatture', () => {
  it('se sono gia state create NON le cancella da qui: sono N documenti in una riga sola', async () => {
    stato.riga = { id: 'pend-1', tipo: 'autofattura', stato: 'creata', fic_document_id: 'doc-1,doc-2', societa: 'larealestate' }

    const out = JSON.parse(String(await executeFicWriteTool('elimina_bozza_fic', { id: 'pend-1' }, 'larealestate')))

    expect(out.ok).toBe(false)
    expect(out.ids_documenti).toBe('doc-1,doc-2')
    // 🚨 `eliminaDocumentoFIC` non deve essere chiamato con «doc-1,doc-2».
    expect(stato.eliminate).toHaveLength(0)
  })

  it('prima della conferma si annulla e basta: non era nato niente', async () => {
    stato.riga = { id: 'pend-1', tipo: 'autofattura', stato: 'in_attesa', fic_document_id: null, societa: 'larealestate' }

    const out = JSON.parse(String(await executeFicWriteTool('elimina_bozza_fic', { id: 'pend-1' }, 'larealestate')))

    expect(out.ok).toBe(true)
    expect(out.stato).toBe('annullata')
    expect(stato.eliminate).toHaveLength(0)
  })
})

describe('il tool si trova con le parole dell Ingegnere', () => {
  it('compila_autofattura e nel registro e la descrizione dice cosa NON decide', async () => {
    const t = FIC_WRITE_TOOLS.find((d) => d.name === 'compila_autofattura')
    expect(t).toBeDefined()
    const d = (t?.description ?? '').toLowerCase()
    for (const parola of ['autofattur', 'reverse charge', 'estere', 'booking', 'self_supplier_invoice', 'vat_id', 'td17', 'ei_raw']) {
      expect(d, parola).toContain(parola)
    }
    // ⚠️ `vat_id` NON e' fra i required dello schema: se lo fosse, il modello
    // sarebbe spinto a inventarne uno pur di chiamare il tool.
    const schema = t?.input_schema as { required?: string[] }
    expect(schema.required).toContain('fatture')
    expect(schema.required).not.toContain('vat_id')
  })
})

describe('i dati della fattura originale non si inventano', () => {
  it('senza numero rifiuta, e non prepara niente', async () => {
    const out = await compila({ fatture: [{ fornitore: 'Booking.com B.V.', fornitore_id: 9, data: '2026-08-31', data_ricezione: '2026-09-01', imponibile: 10 }], vat_id: 21, numerazione: SERIE })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/numero/i)
    expect(stato.inserite).toHaveLength(0)
  })

  it('un imponibile in formato ambiguo viene RIFIUTATO, non interpretato', async () => {
    // "1.234,56" letto col parser degli importi italiani darebbe 1234.56, ma
    // "18.32" darebbe 1832: qui si rifiuta invece di indovinare quale dei due
    // e' il caso.
    const out = await compila({
      fatture: [{ fornitore: 'Booking.com B.V.', fornitore_id: 9, numero: 'X', data: '2026-08-31', data_ricezione: '2026-09-01', imponibile: '1.234,56' }],
      vat_id: 21, numerazione: SERIE,
    })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toMatch(/imponibile/i)
    expect(stato.inserite).toHaveLength(0)
  })
})
