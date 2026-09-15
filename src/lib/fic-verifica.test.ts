/**
 * src/lib/fic-verifica.test.ts — VERIFICARE un documento gia' compilato su
 * Fatture in Cloud: dire cosa non va, regola per regola.
 *
 * Il difetto che chiude: il bot sapeva creare un'autofattura TD17 e una spesa
 * estera, e da poco sapeva modificarle. Non sapeva GUARDARLE. Un documento
 * nato mesi fa — o nato da un tool che allora sbagliava — restava sbagliato
 * per sempre, perche' nessuno apriva i campi uno per uno.
 *
 * ⚠️ Cosa guardano questi test: l'I/O verso Fatture in Cloud e' finto
 * (`vi.mock('./fatture-in-cloud')`), la LOGICA e' quella vera — comprese le
 * difese, che sono il motivo per cui il tool esiste in questa forma.
 *
 * 🚨 Accanto a ogni «si lamenta» c'e' il CONTROLLO POSITIVO: un documento a
 * norma deve risultare a norma. Senza, un tool che si lamenta SEMPRE
 * supererebbe tutte le prove sulle regole e sarebbe peggio di niente — perche'
 * dopo tre falsi allarmi nessuno lo legge piu'.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stato = {
  /** I documenti EMESSI che Fatture in Cloud conosce: id -> documento. */
  emessi: new Map<string, Record<string, unknown>>(),
  /** Le spese RICEVUTE: id -> documento. */
  ricevuti: new Map<string, Record<string, unknown>>(),
  /** Le scritture viste. Su una verifica DEVONO restare vuote. */
  put: [] as Array<{ path: string; body: Record<string, unknown> }>,
  post: [] as Array<{ path: string; body: Record<string, unknown> }>,
  inserite: [] as Record<string, unknown>[],
  descrizione: '',
  riga: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
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
            () => [{ id: 'pend-1', societa: 'larealestate', tipo: 'modifica_documento', stato: row.stato ?? 'in_attesa' }],
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
      const doc = stato.emessi.get(emesso[1])
      return doc ? { ok: true, data: { data: doc } } : { ok: false, error: 'Errore FIC 404: {"error":{"message":"not found"}}' }
    }
    const ricevuto = /\/received_documents\/(\d+)$/.exec(path)
    if (ricevuto) {
      const doc = stato.ricevuti.get(ricevuto[1])
      return doc ? { ok: true, data: { data: doc } } : { ok: false, error: 'Errore FIC 404: {"error":{"message":"not found"}}' }
    }
    return { ok: true, data: { data: [] } }
  },
  ficPut: async (path: string, body: Record<string, unknown>) => {
    stato.put.push({ path, body })
    return { ok: true, data: { data: {} } }
  },
  ficPost: async (path: string, body: Record<string, unknown>) => {
    stato.post.push({ path, body })
    return { ok: true, data: { data: {} } }
  },
  creaDocumentoFIC: async () => ({ ok: true as const, id: 'issued-1', url: null }),
  eliminaDocumentoFIC: async () => ({ ok: true }),
  caricaAllegatoFIC: async () => ({ ok: true as const, token: 'tok-1' }),
  creaSpesaFIC: async () => ({ ok: true as const, id: 'spesa-1', url: null }),
}))

vi.mock('./gmail-tools', () => ({
  readMessage: async () => ({ subject: '', attachments: [] }),
  scaricaAllegato: async () => '',
}))

import {
  verificaDocumento,
  controlliAutofattura,
  controlliSpesa,
  daControllareAMano,
  riepilogo,
  regolaTipoDocumento,
  regolaFatturaCollegata,
  regolaCodiceDestinatario,
  regolaPagamentoStornato,
  regolaElettronica,
  regolaCedenteEstero,
  regolaSpesaNonElettronica,
  regolaAllegato,
  regolaSpesaSaldata,
  regolaChiaveAntiDoppione,
  CODICE_DESTINATARIO_INTEGRAZIONE,
  type EsitoControllo,
} from './fic-verifica'
import { executeFicWriteTool, FIC_WRITE_TOOLS } from './fic-write-tools'
import { DOMINI } from './mappa-officina'

/**
 * L'AUTOFATTURA TD17 A NORMA: quella che l'Ingegnere ha fornito come modello.
 * Tutte le prove sui rilievi partono da QUESTA e le tolgono un pezzo per
 * volta, cosi' il rilievo e' attribuibile al pezzo tolto e non a caso.
 */
function autofattura(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 77,
    type: 'self_supplier_invoice',
    number: 3,
    numeration: 'INT',
    date: '2026-08-03',
    entity: {
      id: 9,
      name: 'Booking.com B.V.',
      ei_code: 'M5UXCR1',
      vat_number: 'NL805734958B01',
      address_street: 'Oosterdoksstraat 80',
      address_city: 'Amsterdam',
      country: 'Paesi Bassi',
    },
    notes: 'Riferimento: Booking.com B.V., fattura n.NC2CQ del 2026-07-31.',
    items_list: [{ id: 501, name: 'Commissioni luglio 2026', qty: 1, net_price: 218.44, vat: { id: 21, value: 0 } }],
    amount_net: 218.44,
    amount_vat: 0,
    amount_gross: 218.44,
    e_invoice: true,
    ei_status: null,
    payments_list: [{ amount: 218.44, due_date: '2026-08-03', status: 'reversed' }],
    ei_raw: {
      FatturaElettronicaBody: {
        DatiGenerali: {
          DatiGeneraliDocumento: { TipoDocumento: 'TD17' },
          DatiFattureCollegate: { IdDocumento: 'NC2CQ', Data: '2026-07-31' },
        },
      },
    },
    locked: false,
    ...over,
  }
}

/** La SPESA a norma: la fattura del fornitore estero, col suo PDF, saldata. */
function spesa(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 55,
    type: 'expense',
    invoice_number: 'NC2CQ',
    date: '2026-07-31',
    entity: { id: 9, name: 'Booking.com B.V.', vat_number: 'NL805734958B01' },
    amount_net: 218.44,
    amount_vat: 0,
    amount_gross: 218.44,
    e_invoice: false,
    attachment_url: 'https://compute.fattureincloud.it/att/booking.pdf',
    payments_list: [{ amount: 218.44, due_date: '2026-07-31', status: 'paid', paid_date: '2026-07-31' }],
    ...over,
  }
}

/** La voce di una regola, per chiave. Fallisce forte se la regola non c'e'. */
function voce(controlli: EsitoControllo[], regola: string): EsitoControllo {
  const c = controlli.find((x) => x.regola === regola)
  expect(c, `la regola «${regola}» non compare nell'esito`).toBeDefined()
  return c!
}

async function json(p: Promise<string | null>) {
  return JSON.parse((await p) ?? '{}')
}

function verifica(input: Record<string, unknown>) {
  return json(executeFicWriteTool('verifica_documento_fic', input, 'larealestate'))
}

beforeEach(() => {
  stato.emessi = new Map([['77', autofattura()]])
  stato.ricevuti = new Map([['55', spesa()]])
  stato.put = []
  stato.post = []
  stato.inserite = []
  stato.descrizione = ''
  stato.riga = null
  stato.updates = []
})

// ————————————————————————————————————————————————————————————————————————

describe('🚨 IL CONTROLLO POSITIVO: un documento a norma risulta a norma', () => {
  it('l autofattura TD17 del modello passa tutte e sei le regole', () => {
    const c = controlliAutofattura(autofattura())
    expect(riepilogo(c)).toEqual({ a_norma: 6, rilievi: 0, non_verificati: 0 })
    // Su un documento a posto non si propone nessuna riscrittura.
    expect(c.every((x) => x.correzione === null)).toBe(true)
  })

  it('la spesa estera del modello passa tutte e quattro le regole', () => {
    const c = controlliSpesa(spesa())
    expect(riepilogo(c)).toEqual({ a_norma: 4, rilievi: 0, non_verificati: 0 })
    expect(c.every((x) => x.correzione === null)).toBe(true)
  })

  it('ogni controllo porta SEMPRE cosa dice la regola e cosa c e davvero', () => {
    for (const c of [...controlliAutofattura(autofattura()), ...controlliSpesa(spesa())]) {
      expect(c.dice.length, `la regola ${c.regola} non dice cosa pretende`).toBeGreaterThan(10)
      expect(c.trovato.length, `la regola ${c.regola} non dice cosa ha trovato`).toBeGreaterThan(0)
      expect(typeof c.correggibile_via_api).toBe('boolean')
    }
  })
})

describe('REGOLA 1 — il tipo documento SdI TD17', () => {
  it('🚨 TD17 assente: rilievo GRAVE, non e un integrazione', () => {
    const c = regolaTipoDocumento(autofattura({
      ei_raw: { FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: {} } } },
    }))
    expect(c.esito).toBe('rilievo')
    expect(c.gravita).toBe('grave')
    expect(c.trovato).toContain('nessun TipoDocumento')
    expect(c.conseguenza).toContain('adempimento')
  })

  it('un TIPO DIVERSO (TD01) e un rilievo grave, non un a norma', () => {
    const c = regolaTipoDocumento(autofattura({
      ei_raw: { FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD01' } } } },
    }))
    expect(c.esito).toBe('rilievo')
    expect(c.trovato).toBe('TD01')
  })

  it('🚨 ei_raw ILLEGGIBILE: «non verificato», MAI «a posto»', () => {
    for (const raw of [undefined, {}, null]) {
      const c = regolaTipoDocumento(autofattura({ ei_raw: raw }))
      expect(c.esito, `con ei_raw=${JSON.stringify(raw)}`).toBe('non_verificato')
      expect(c.trovato).toContain('NON VERIFICATO')
      // La differenza che conta: non finisce fra i passati.
      expect(c.esito).not.toBe('a_norma')
    }
  })

  it('CONTROLLO POSITIVO: col TD17 al suo posto e a norma', () => {
    expect(regolaTipoDocumento(autofattura()).esito).toBe('a_norma')
  })
})

describe('REGOLA 2 — i dati fattura collegata', () => {
  it('assenti: rilievo, e la correzione proposta e modifica_documento_fic', () => {
    const c = regolaFatturaCollegata(autofattura({
      ei_raw: { FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD17' } } } },
    }))
    expect(c.esito).toBe('rilievo')
    expect(c.correggibile_via_api).toBe(true)
    expect(c.correzione?.tool).toBe('modifica_documento_fic')
    expect(c.correzione?.parametri.id).toBe(77)
    // 🚨 Numero e data della fattura estera non le inventa il tool.
    expect(c.correzione?.serve_da_te).toContain('numero e data')
  })

  it('un riferimento a META e un rilievo: sembra compilato e non lo e', () => {
    const c = regolaFatturaCollegata(autofattura({
      ei_raw: {
        FatturaElettronicaBody: {
          DatiGenerali: {
            DatiGeneraliDocumento: { TipoDocumento: 'TD17' },
            DatiFattureCollegate: { IdDocumento: 'NC2CQ' },
          },
        },
      },
    }))
    expect(c.esito).toBe('rilievo')
    expect(c.trovato).toContain('META')
  })

  it('🚨 ei_raw illeggibile: «non verificato», e NESSUNA correzione proposta', () => {
    const c = regolaFatturaCollegata(autofattura({ ei_raw: undefined }))
    expect(c.esito).toBe('non_verificato')
    // Proporre di riscrivere ei_raw senza averlo letto cancellerebbe il TD17.
    expect(c.correzione).toBeNull()
  })

  it('CONTROLLO POSITIVO: numero e data insieme = a norma', () => {
    expect(regolaFatturaCollegata(autofattura()).esito).toBe('a_norma')
  })
})

describe('REGOLA 3 — il codice destinatario e il NOSTRO', () => {
  it('🚨 XXXXXXX: rilievo, e la correzione proposta e COMPLETA', () => {
    const doc = autofattura()
    ;(doc.entity as Record<string, unknown>).ei_code = 'XXXXXXX'
    const c = regolaCodiceDestinatario(doc)

    expect(c.esito).toBe('rilievo')
    expect(c.trovato).toBe('XXXXXXX')
    expect(c.conseguenza).toContain('ESTERI')
    expect(c.correggibile_via_api).toBe(true)
    expect(c.correzione).toEqual({
      tool: 'modifica_documento_fic',
      parametri: { id: 77, codice_destinatario: CODICE_DESTINATARIO_INTEGRAZIONE },
      // Qui non serve niente dall'Ingegnere: il valore giusto lo sappiamo.
      serve_da_te: null,
    })
  })

  it('un codice qualsiasi diverso dal nostro e comunque un rilievo', () => {
    const doc = autofattura()
    ;(doc.entity as Record<string, unknown>).ei_code = 'ABCDEFG'
    expect(regolaCodiceDestinatario(doc).esito).toBe('rilievo')
  })

  it('entity letta ma senza ei_code: rilievo, non «non verificato»', () => {
    const c = regolaCodiceDestinatario(autofattura({ entity: { id: 9, name: 'Booking.com B.V.' } }))
    expect(c.esito).toBe('rilievo')
    expect(c.trovato).toContain('nessun codice destinatario')
  })

  it('🚨 entity ASSENTE: «non verificato» — non sappiamo cosa c e scritto', () => {
    const c = regolaCodiceDestinatario(autofattura({ entity: undefined }))
    expect(c.esito).toBe('non_verificato')
    expect(c.correzione).toBeNull()
  })

  it('CONTROLLO POSITIVO: M5UXCR1 = a norma', () => {
    expect(regolaCodiceDestinatario(autofattura()).esito).toBe('a_norma')
  })
})

describe('REGOLA 4 — il piano pagamenti STORNATO', () => {
  it('🚨 not_paid: rilievo, e la conseguenza nomina lo SCADENZARIO e il sollecito', () => {
    const c = regolaPagamentoStornato(autofattura({
      payments_list: [{ amount: 218.44, due_date: '2026-08-03', status: 'not_paid' }],
    }))
    expect(c.esito).toBe('rilievo')
    expect(c.trovato).toBe('not_paid')
    expect(c.conseguenza).toContain('scadenzario')
    expect(c.conseguenza).toContain('sollecito')
    // Lo stato del piano non lo cambia modifica_documento_fic: si dice invece
    // di proporre una chiamata che non esiste.
    expect(c.correggibile_via_api).toBe(false)
    expect(c.come).toContain('Fatture in Cloud')
  })

  it('basta UNA voce non stornata perche sia un rilievo', () => {
    const c = regolaPagamentoStornato(autofattura({
      payments_list: [{ status: 'reversed' }, { status: 'not_paid' }],
    }))
    expect(c.esito).toBe('rilievo')
  })

  it('piano VUOTO: rilievo, non a norma', () => {
    expect(regolaPagamentoStornato(autofattura({ payments_list: [] })).esito).toBe('rilievo')
  })

  it('🚨 payments_list non leggibile: «non verificato»', () => {
    const c = regolaPagamentoStornato(autofattura({ payments_list: undefined }))
    expect(c.esito).toBe('non_verificato')
  })

  it('CONTROLLO POSITIVO: tutte reversed = a norma', () => {
    expect(regolaPagamentoStornato(autofattura()).esito).toBe('a_norma')
  })
})

describe('REGOLA 5 — e_invoice', () => {
  it('🚨 false: rilievo GRAVE, non si trasmette allo SdI', () => {
    const c = regolaElettronica(autofattura({ e_invoice: false }))
    expect(c.esito).toBe('rilievo')
    expect(c.gravita).toBe('grave')
    expect(c.conseguenza).toContain('Sistema di Interscambio')
  })

  it('🚨 assente: «non verificato», non «false» e non «a posto»', () => {
    const c = regolaElettronica(autofattura({ e_invoice: undefined }))
    expect(c.esito).toBe('non_verificato')
  })

  it('CONTROLLO POSITIVO: true = a norma', () => {
    expect(regolaElettronica(autofattura()).esito).toBe('a_norma')
  })
})

describe('REGOLA 6 — il cedente estero: partita IVA e indirizzo', () => {
  it('senza partita IVA: rilievo, e il documento e formalmente incompleto', () => {
    const c = regolaCedenteEstero(autofattura({
      entity: { id: 9, name: 'Booking.com B.V.', address_street: 'Oosterdoksstraat 80', address_city: 'Amsterdam' },
    }))
    expect(c.esito).toBe('rilievo')
    expect(c.conseguenza).toContain('partita IVA')
    expect(c.come).toContain('ANAGRAFICA')
  })

  it('senza indirizzo: rilievo, ma di taglia minore della partita IVA mancante', () => {
    const c = regolaCedenteEstero(autofattura({
      entity: { id: 9, name: 'Booking.com B.V.', vat_number: 'NL805734958B01' },
    }))
    expect(c.esito).toBe('rilievo')
    expect(c.gravita).toBe('avviso')
  })

  it('🚨 entity assente: «non verificato»', () => {
    expect(regolaCedenteEstero(autofattura({ entity: undefined })).esito).toBe('non_verificato')
  })

  it('CONTROLLO POSITIVO: P.IVA e indirizzo valorizzati = a norma', () => {
    expect(regolaCedenteEstero(autofattura()).esito).toBe('a_norma')
  })
})

describe('LE REGOLE DELLA SPESA', () => {
  it('REGOLA 7 — e_invoice true su una spesa estera e un rilievo', () => {
    const c = regolaSpesaNonElettronica(spesa({ e_invoice: true }))
    expect(c.esito).toBe('rilievo')
    expect(c.conseguenza).toContain('provenienza falsa')
  })

  it('REGOLA 7 — e_invoice assente: «non verificato»', () => {
    expect(regolaSpesaNonElettronica(spesa({ e_invoice: undefined })).esito).toBe('non_verificato')
  })

  it('REGOLA 7 — CONTROLLO POSITIVO: false = a norma', () => {
    expect(regolaSpesaNonElettronica(spesa()).esito).toBe('a_norma')
  })

  it('REGOLA 8 — senza allegato e un rilievo', () => {
    const c = regolaAllegato(spesa({ attachment_url: undefined }))
    expect(c.esito).toBe('rilievo')
    expect(c.conseguenza).toContain('giustifica')
    // Rifare la spesa crea un doppione: va detto nella stessa frase.
    expect(c.come).toContain('DOPPIONE')
  })

  it('REGOLA 8 — vale anche il solo attachment_token', () => {
    expect(regolaAllegato(spesa({ attachment_url: undefined, attachment_token: 'tok-9' })).esito).toBe('a_norma')
  })

  it('REGOLA 8 — CONTROLLO POSITIVO: allegato presente = a norma', () => {
    expect(regolaAllegato(spesa()).esito).toBe('a_norma')
  })

  it('REGOLA 9 — not_paid: rilievo, con la correzione che passa da segna_fatture_ricevute_pagate', () => {
    const c = regolaSpesaSaldata(spesa({ payments_list: [{ status: 'not_paid' }] }))
    expect(c.esito).toBe('rilievo')
    expect(c.correggibile_via_api).toBe(true)
    expect(c.correzione?.tool).toBe('segna_fatture_ricevute_pagate')
    expect(c.correzione?.parametri.id).toBe(55)
    expect(c.correzione?.serve_da_te).toContain('conto')
  })

  it('REGOLA 9 — piano vuoto: rilievo', () => {
    expect(regolaSpesaSaldata(spesa({ payments_list: [] })).esito).toBe('rilievo')
  })

  it('REGOLA 9 — payments_list non leggibile: «non verificato»', () => {
    expect(regolaSpesaSaldata(spesa({ payments_list: undefined })).esito).toBe('non_verificato')
  })

  it('REGOLA 9 — CONTROLLO POSITIVO: paid = a norma', () => {
    expect(regolaSpesaSaldata(spesa()).esito).toBe('a_norma')
  })

  it('REGOLA 10 — senza numero: rilievo GRAVE, salta la chiave anti-doppione', () => {
    const c = regolaChiaveAntiDoppione(spesa({ invoice_number: '' }))
    expect(c.esito).toBe('rilievo')
    expect(c.gravita).toBe('grave')
    expect(c.conseguenza).toContain('seconda volta')
  })

  it('REGOLA 10 — senza data: rilievo', () => {
    expect(regolaChiaveAntiDoppione(spesa({ date: '' })).esito).toBe('rilievo')
  })

  it('REGOLA 10 — CONTROLLO POSITIVO: numero e data = a norma', () => {
    expect(regolaChiaveAntiDoppione(spesa()).esito).toBe('a_norma')
  })
})

describe('⬜ quello che l API non permette di controllare, e che va DETTO', () => {
  it('sull autofattura nomina «Rileva ricavo» e cosa succede se e sbagliato', () => {
    const [v] = daControllareAMano('autofattura')
    expect(v.voce).toContain('Rileva ricavo')
    expect(v.deve_essere).toContain('NO')
    expect(v.se_sbagliato).toContain('fatturato')
    expect(v.perche_non_via_api).toContain('IssuedDocument')
  })

  it('sulla spesa nomina «Rileva IVA a debito» e la doppia contabilizzazione', () => {
    const [v] = daControllareAMano('spesa')
    expect(v.voce).toContain('Rileva IVA a debito')
    expect(v.se_sbagliato).toContain('DUE VOLTE')
  })
})

describe('🚨 un documento TRASMESSO non si tocca: si verifica, non si corregge', () => {
  it('locked: la verifica esce lo stesso, i rilievi restano, le correzioni SPARISCONO', async () => {
    const doc = autofattura({ locked: true })
    ;(doc.entity as Record<string, unknown>).ei_code = 'XXXXXXX'
    stato.emessi.set('77', doc)

    const esito = await verificaDocumento(77, 'autofattura', 'larealestate')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return

    // La verifica si e' fatta: il rilievo c'e'.
    const c = voce(esito.valore.controlli, 'codice_destinatario')
    expect(c.esito).toBe('rilievo')
    // Ma la correzione no, e il perche' e' scritto.
    expect(c.correggibile_via_api).toBe(false)
    expect(c.correzione).toBeNull()
    expect(c.come).toContain('NOTA DI VARIAZIONE')
    expect(esito.valore.correzione_bloccata).toContain('BLOCCATO')
  })

  it('stato SdI «sent»: stessa cosa, la correzione non parte', async () => {
    stato.emessi.set('77', autofattura({ ei_status: 'sent', payments_list: [{ status: 'not_paid' }] }))
    const esito = await verificaDocumento(77, 'autofattura', 'larealestate')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.valore.correzione_bloccata).toContain('Sistema di Interscambio')
    expect(esito.valore.controlli.every((c) => c.correzione === null)).toBe(true)
    // 🚨 CONTROLLO POSITIVO del blocco: il rilievo NON e' stato zittito.
    expect(voce(esito.valore.controlli, 'pagamento_stornato').esito).toBe('rilievo')
  })

  it('CONTROLLO POSITIVO: su un documento NON trasmesso la correzione si propone', async () => {
    const doc = autofattura()
    ;(doc.entity as Record<string, unknown>).ei_code = 'XXXXXXX'
    stato.emessi.set('77', doc)
    const esito = await verificaDocumento(77, 'autofattura', 'larealestate')
    expect(esito.ok).toBe(true)
    if (!esito.ok) return
    expect(esito.valore.correzione_bloccata).toBeNull()
    expect(voce(esito.valore.controlli, 'codice_destinatario').correzione?.tool).toBe('modifica_documento_fic')
  })
})

describe('il tool verifica_documento_fic', () => {
  it('🚨 CONTROLLO POSITIVO: documento a norma → nessun rilievo, e NIENTE scritto', async () => {
    const out = await verifica({ id: 77, tipo: 'autofattura' })

    expect(out.ok).toBe(true)
    expect(out.riepilogo).toEqual({ a_norma: 6, rilievi: 0, non_verificati: 0 })
    expect(out.documento.numero).toBe('3INT')
    expect(out.documento.controparte).toBe('Booking.com B.V.')
    // 🚨 Verificare e' LEGGERE: niente scritture, niente pending, niente conferme.
    expect(stato.put).toEqual([])
    expect(stato.post).toEqual([])
    expect(stato.inserite).toEqual([])
  })

  it('l esito e un ELENCO PER REGOLA, non un riassunto', async () => {
    const out = await verifica({ id: 77, tipo: 'autofattura' })
    expect(out.controlli).toHaveLength(6)
    expect(out.controlli.map((c: EsitoControllo) => c.regola)).toEqual([
      'tipo_documento_sdi', 'fattura_collegata', 'codice_destinatario',
      'pagamento_stornato', 'elettronica', 'cedente_estero',
    ])
    // Le rilevazioni contabili escono SEMPRE, anche quando tutto il resto passa.
    expect(out.da_controllare_a_mano).toHaveLength(1)
  })

  it('un documento pieno di difetti: ogni rilievo col suo dettaglio', async () => {
    stato.emessi.set('77', autofattura({
      entity: { id: 9, name: 'Booking.com B.V.', ei_code: 'XXXXXXX' },
      payments_list: [{ status: 'not_paid' }],
      e_invoice: false,
      ei_raw: { FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD01' } } } },
    }))
    const out = await verifica({ id: 77, tipo: 'autofattura' })
    expect(out.riepilogo).toEqual({ a_norma: 0, rilievi: 6, non_verificati: 0 })
    expect(voce(out.controlli, 'tipo_documento_sdi').gravita).toBe('grave')
    expect(voce(out.controlli, 'elettronica').gravita).toBe('grave')
  })

  it('🚨 i NON VERIFICATI viaggiano in una colonna a parte, mai sommati ai passati', async () => {
    stato.emessi.set('77', autofattura({ ei_raw: undefined, e_invoice: undefined }))
    const out = await verifica({ id: 77, tipo: 'autofattura' })
    expect(out.riepilogo.non_verificati).toBe(3)
    expect(out.riepilogo.a_norma).toBe(3)
    expect(out.riepilogo.rilievi).toBe(0)
  })

  it('la spesa: stesso giro sull altro registro', async () => {
    const out = await verifica({ id: 55, tipo: 'spesa' })
    expect(out.ok).toBe(true)
    expect(out.riepilogo).toEqual({ a_norma: 4, rilievi: 0, non_verificati: 0 })
    expect(out.da_controllare_a_mano[0].voce).toContain('Rileva IVA a debito')
    expect(stato.put).toEqual([])
  })

  it('🚨 senza «tipo» non indovina il registro: rifiuta e spiega perche', async () => {
    const out = await verifica({ id: 77 })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('registro')
    expect(out.error).toContain('sovrappongono')
  })

  it('un tipo che non conosce non viene interpretato', async () => {
    const out = await verifica({ id: 77, tipo: 'fattura' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('registro')
  })

  it('senza id non verifica niente', async () => {
    const out = await verifica({ tipo: 'autofattura' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('id del documento')
  })

  it('🚨 se Fatture in Cloud non trova il documento lo dice, e non dichiara «a norma»', async () => {
    const out = await verifica({ id: 999, tipo: 'autofattura' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('999')
    expect(out.controlli).toBeUndefined()
  })

  it('un id di spesa passato come autofattura NON viene verificato su un altro documento', async () => {
    // 55 esiste fra le spese, non fra gli emessi: il tool deve dirlo, non
    // ripiegare sull'altro registro e verificare il documento sbagliato.
    const out = await verifica({ id: 55, tipo: 'autofattura' })
    expect(out.ok).toBe(false)
    expect(out.error).toContain('55')
  })
})

describe('il tool e nel registro, e lo dice al modello', () => {
  it('verifica_documento_fic sta in FIC_WRITE_TOOLS con lo schema giusto', () => {
    const t = FIC_WRITE_TOOLS.find((d) => d.name === 'verifica_documento_fic')
    expect(t).toBeDefined()
    const schema = t!.input_schema as { required: string[]; properties: Record<string, { enum?: string[] }> }
    expect(schema.required).toEqual(['id', 'tipo'])
    expect(schema.properties.tipo.enum).toEqual(['autofattura', 'spesa'])
  })

  it('🚨 la descrizione dice che NON scrive, cosa NON puo correggere, e come si legge un «non verificato»', () => {
    const d = FIC_WRITE_TOOLS.find((t) => t.name === 'verifica_documento_fic')!.description
    // Una capacita' che non sta nello SCHEMA, per il modello non esiste.
    expect(d).toContain('NON SCRIVE NIENTE')
    expect(d).toContain('Rileva ricavo')
    expect(d).toContain('Rileva IVA a debito')
    expect(d).toContain('non_verificato')
    expect(d).toContain('nota di variazione')
  })

  it('sta nel perimetro CONTABILE dell officina', () => {
    const contabile = DOMINI.find((r) => r.nome.toLowerCase().includes('contab'))
    expect(contabile, 'il reparto contabile non esiste piu con questo nome').toBeDefined()
    expect(contabile!.tool).toContain('verifica_documento_fic')
  })
})
