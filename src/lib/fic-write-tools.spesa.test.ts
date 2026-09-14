/**
 * src/lib/fic-write-tools.spesa.test.ts — registrare la SPESA di un fornitore.
 *
 * Il difetto che chiude: `compila_autofattura` sapeva creare l'integrazione
 * TD17 delle fatture estere, cioe' l'IVA a DEBITO, e nessuno sapeva
 * registrare la fattura d'ACQUISTO a monte. Mezzo adempimento.
 *
 * 🚨 I due test che contano piu' di tutti sono i primi due: senza `vat_id` e
 * senza il conto di pagamento il tool NON prepara niente e restituisce gli
 * elenchi VERI letti da Fatture in Cloud. Il motivo e' la conferma unica —
 * l'Ingegnere legge un'anteprima e dice «confermo» una volta sola: un
 * predefinito sbagliato passerebbe di li' senza che nessuno lo guardi.
 *
 * ⚠️ Accanto a ogni «si rifiuta» c'e' il CONTROLLO POSITIVO: un tool che
 * rifiuta sempre passerebbe ogni guardia senza fare niente di utile.
 *
 * I mock stanno sul livello HTTP (`ficGet`, le due POST, Gmail), non sul
 * motore: quello che si prova qui e' il codice vero.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stato = {
  inserite: [] as Record<string, unknown>[],
  descrizione: '',
  riga: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  aliquote: [] as Record<string, unknown>[],
  conti: [] as Record<string, unknown>[],
  schedeFornitori: new Map<string, Record<string, unknown>>(),
  fornitoriPerNome: [] as Record<string, unknown>[],
  /** Le fatture RICEVUTE che FIC restituisce: la base dell'anti-doppione. */
  ricevute: [] as Record<string, unknown>[],
  ultimaPaginaRicevute: 1,
  /** I path GET visti, per provare che una ricerca e' stata fatta davvero. */
  letture: [] as string[],
  /** Le mail: id -> { subject, attachments }. */
  mail: new Map<string, Record<string, unknown>>(),
  /** I byte che Gmail restituisce (base64), o null per far fallire il download. */
  contenutoAllegato: null as string | null,
  /** I caricamenti multipart: filename + byte. */
  caricati: [] as Array<{ filename: string; byte: number }>,
  esitoCaricamento: { ok: true, token: 'tok-1' } as { ok: boolean; token?: string; error?: string },
  /** I payload spediti a `creaSpesaFIC`. */
  creati: [] as Record<string, unknown>[],
  esitoCreazione: { ok: true, id: 'spesa-1' } as { ok: boolean; id?: string; error?: string },
  /** Cosa risponde la RILETTURA per ogni id creato. */
  riletture: new Map<string, Record<string, unknown>>(),
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
            () => [{ id: 'pend-1', societa: 'larealestate', stato: row.stato ?? 'in_attesa' }],
            () => ({ id: 'pend-1', descrizione: stato.descrizione }),
          )
        },
      }),
    },
  }
})

vi.mock('./fatture-in-cloud', () => ({
  FORMATI_ALLEGATO_FIC: ['png', 'jpg', 'gif', 'pdf', 'zip', 'xls', 'xlsx', 'doc', 'docx'],
  ficGet: async (path: string) => {
    stato.letture.push(path)
    if (path.includes('/settings/vat_types')) return { ok: true, data: { data: stato.aliquote, last_page: 1 } }
    if (path.includes('/info/payment_accounts')) return { ok: true, data: { data: stato.conti } }

    const scheda = /\/entities\/suppliers\/(\d+)$/.exec(path)
    if (scheda) {
      const trovata = stato.schedeFornitori.get(scheda[1])
      return trovata ? { ok: true, data: { data: trovata } } : { ok: false, error: 'anagrafica non trovata' }
    }
    if (path.includes('/entities/suppliers')) return { ok: true, data: { data: stato.fornitoriPerNome } }

    const documento = /\/received_documents\/(.+)$/.exec(path)
    if (documento) {
      const trovato = stato.riletture.get(documento[1])
      return trovato ? { ok: true, data: { data: trovato } } : { ok: false, error: 'documento non trovato su FIC' }
    }
    if (path.endsWith('/received_documents')) {
      // Una pagina VUOTA ferma il giro: per provare il troncamento serve che
      // FIC continui a rispondere con righe, pagina dopo pagina.
      const righe = stato.ricevute.length > 0 || stato.ultimaPaginaRicevute === 1
        ? stato.ricevute
        : [{ id: 1, entity: { name: 'Altro fornitore' }, invoice_number: 'x', date: '2026-01-01', amount_gross: 1 }]
      return { ok: true, data: { data: righe, last_page: stato.ultimaPaginaRicevute } }
    }
    return { ok: true, data: { data: [] } }
  },
  ficPost: async () => ({ ok: true, data: { data: {} } }),
  ficPut: async () => ({ ok: true, data: { data: {} } }),
  getCompanyId: async () => ({ ok: true, id: '111' }),
  creaDocumentoFIC: async () => ({ ok: true as const, id: 'issued-1', url: null }),
  eliminaDocumentoFIC: async (id: string) => { stato.eliminate.push(id); return { ok: true } },
  caricaAllegatoFIC: async (filename: string, contenuto: Buffer) => {
    stato.caricati.push({ filename, byte: contenuto.length })
    return stato.esitoCaricamento.ok
      ? { ok: true as const, token: stato.esitoCaricamento.token ?? 'tok-1' }
      : { ok: false as const, error: stato.esitoCaricamento.error ?? 'caricamento rifiutato' }
  },
  creaSpesaFIC: async (payload: Record<string, unknown>) => {
    stato.creati.push(payload)
    return stato.esitoCreazione.ok
      ? { ok: true as const, id: stato.esitoCreazione.id ?? 'spesa-1', url: null }
      : { ok: false as const, error: stato.esitoCreazione.error ?? 'rifiutata da FIC' }
  },
}))

vi.mock('./gmail-tools', () => ({
  readMessage: async (_casella: string, id: string) => {
    const m = stato.mail.get(id)
    if (!m) throw new Error(`mail ${id} inesistente`)
    return m
  },
  scaricaAllegato: async () => {
    if (stato.contenutoAllegato === null) throw new Error('Gmail non risponde')
    return stato.contenutoAllegato
  },
}))

import { executeFicWriteTool, confirmFicStep2, FIC_WRITE_TOOLS } from './fic-write-tools'

/** Le due aliquote che un'azienda ha davvero su FIC: l'ordinaria e una N6.x. */
const ALIQUOTE_FIC = [
  { id: 0, value: 22, description: 'Aliquota 22%' },
  { id: 21, value: 0, description: 'Inversione contabile', ei_type: 'N6.9', ei_description: 'inversione contabile - altri casi' },
]

const CONTI_FIC = [
  { id: 5, name: 'Intesa Sanpaolo' },
  { id: 9, name: 'Contanti' },
]

const PDF_BASE64 = Buffer.from('%PDF-1.4 finto ma non vuoto').toString('base64')

/** La chiamata buona: la fattura commissioni di Booking, col suo PDF. */
const BUONA = {
  casella: 'larealestate',
  message_id: 'm-1',
  fornitore: 'Booking.com B.V.',
  fornitore_id: 9,
  numero: '1234567890',
  data: '2026-09-01',
  imponibile: 218.44,
  vat_id: 0,
  modalita_pagamento: 'Intesa Sanpaolo',
}

function chiama(over: Record<string, unknown> = {}) {
  return executeFicWriteTool('registra_spesa_fornitore', { ...BUONA, ...over }, 'larealestate')
}

async function json(p: Promise<string | null>) {
  return JSON.parse((await p) ?? '{}')
}

/** La riga pending come la rileggerebbe `confirmFicStep2` dopo la compilazione. */
function rigaDallaCompilazione() {
  const payload = stato.inserite[stato.inserite.length - 1].payload
  return { id: 'pend-1', tipo: 'spesa_ricevuta', payload, conferme: 1, stato: 'in_attesa', societa: 'larealestate' }
}

beforeEach(() => {
  // ⚠️ Corpo a BLOCCO: un corpo conciso restituirebbe l'ultima espressione, e
  // vitest la richiamerebbe come teardown dopo ogni test.
  stato.inserite = []
  stato.descrizione = ''
  stato.riga = null
  stato.updates = []
  stato.aliquote = ALIQUOTE_FIC.map((a) => ({ ...a }))
  stato.conti = CONTI_FIC.map((c) => ({ ...c }))
  stato.schedeFornitori = new Map([['9', { id: 9, name: 'Booking.com B.V.' }]])
  stato.fornitoriPerNome = []
  stato.ricevute = []
  stato.ultimaPaginaRicevute = 1
  stato.letture = []
  stato.mail = new Map([['m-1', { subject: 'Invoice 1234567890', attachments: [{ filename: 'fattura.pdf', attachmentId: 'a-1', sizeBytes: 12_345 }] }]])
  stato.contenutoAllegato = PDF_BASE64
  stato.caricati = []
  stato.esitoCaricamento = { ok: true, token: 'tok-1' }
  stato.creati = []
  stato.esitoCreazione = { ok: true, id: 'spesa-1' }
  stato.riletture = new Map([['spesa-1', { id: 'spesa-1', type: 'expense', attachment_url: 'https://fic/allegato.pdf' }]])
  stato.eliminate = []
})

describe('🚨 NIENTE SI INDOVINA: aliquota e conto vengono da Fatture in Cloud', () => {
  it('senza vat_id NON prepara niente e restituisce l elenco VERO delle aliquote', async () => {
    const r = await json(chiama({ vat_id: undefined }))

    expect(r.need).toBe('vat_id')
    expect(r.aliquote_disponibili).toHaveLength(2)
    expect(r.aliquote_disponibili[1].ei_type).toBe('N6.9')
    // Niente e' stato preparato: nessun pending, nessuna scrittura su FIC.
    expect(stato.inserite).toHaveLength(0)
    expect(stato.creati).toHaveLength(0)
  })

  it('🚨 nel rifiuto non c e NESSUNA percentuale: un suggerimento sarebbe gia una scelta', async () => {
    const r = await json(chiama({ vat_id: undefined }))
    const testo = String(r.messaggio)
    // Il messaggio non deve contenere ne' «22» ne' «%»: l'elenco vero viaggia
    // nel campo accanto, che e' un DATO, non un consiglio.
    expect(testo).not.toMatch(/\d+\s*%/)
    expect(testo).not.toMatch(/\b(22|10|4)\b/)
  })

  it('un vat_id che non esiste su quell azienda viene rifiutato', async () => {
    const r = await json(chiama({ vat_id: 999 }))

    expect(r.need).toBe('vat_id')
    expect(String(r.messaggio)).toContain('999')
    expect(stato.inserite).toHaveLength(0)
  })

  it('senza modalita_pagamento NON prepara niente e restituisce l elenco VERO dei conti', async () => {
    const r = await json(chiama({ modalita_pagamento: undefined }))

    expect(r.need).toBe('modalita_pagamento')
    expect(r.conti_disponibili).toEqual([{ id: 5, nome: 'Intesa Sanpaolo' }, { id: 9, nome: 'Contanti' }])
    expect(stato.inserite).toHaveLength(0)
  })

  it('un conto che non esiste viene rifiutato con l elenco vero, non scelto a caso', async () => {
    const r = await json(chiama({ modalita_pagamento: 'Banca che non c e' }))

    expect(r.need).toBe('modalita_pagamento')
    expect(String(r.messaggio)).toContain('Intesa Sanpaolo')
    expect(stato.inserite).toHaveLength(0)
  })

  it('un aliquota di cui FIC non dice il valore ferma tutto: l IVA non si calcola a naso', async () => {
    stato.aliquote = [{ id: 0, description: 'Aliquota senza value' }]

    const r = await json(chiama({ vat_id: 0 }))

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('non so quanta IVA')
    expect(stato.inserite).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: con aliquota e conto veri prepara, e l IVA la calcola sul valore LETTO da FIC', async () => {
    const r = await json(chiama())

    expect(r.ok).toBe(true)
    expect(r.id).toBe('pend-1')
    expect(r.imponibile).toBe(218.44)
    expect(r.iva).toBe(48.06)
    expect(r.totale).toBe(266.5)
    expect(stato.inserite).toHaveLength(1)
    expect(stato.inserite[0].tipo).toBe('spesa_ricevuta')
    // ...e su Fatture in Cloud non e' stato scritto ancora niente.
    expect(stato.creati).toHaveLength(0)
    expect(stato.caricati).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: con l aliquota N6.9 al 0% l IVA e zero e il totale e l imponibile', async () => {
    const r = await json(chiama({ vat_id: 21 }))

    expect(r.ok).toBe(true)
    expect(r.iva).toBe(0)
    expect(r.totale).toBe(218.44)
  })
})

describe('🚨 il pagamento e per COMPENSAZIONE: la spesa nasce saldata, fuori dallo scadenzario', () => {
  it('il piano pagamenti e ESPLICITO, pagato alla data del documento, sul conto scelto', async () => {
    await chiama()
    const payload = (stato.inserite[0].payload as Record<string, unknown>)
    const fic = (payload as { payload: Record<string, unknown> }).payload
    const pagamenti = fic.payments_list as Array<Record<string, unknown>>

    expect(pagamenti).toHaveLength(1)
    expect(pagamenti[0].status).toBe('paid')
    expect(pagamenti[0].paid_date).toBe('2026-09-01')
    expect(pagamenti[0].due_date).toBe('2026-09-01')
    expect(pagamenti[0].amount).toBe(266.5)
    expect(pagamenti[0].payment_account).toEqual({ id: 5 })
  })

  it('il documento e una SPESA (received_documents), non una fattura emessa', async () => {
    await chiama()
    const fic = ((stato.inserite[0].payload as Record<string, unknown>).payload as Record<string, unknown>)

    expect(fic.type).toBe('expense')
    expect(fic.invoice_number).toBe('1234567890')
    expect(fic.amount_net).toBe(218.44)
    expect(fic.amount_vat).toBe(48.06)
    expect(fic.amount_gross).toBe(266.5)
    // 🚨 Niente e_invoice e niente numerazione nostra: non si emette nulla.
    expect(fic.e_invoice).toBeUndefined()
  })

  it('l anteprima DICE che non va nello scadenzario, perche e quello che l Ingegnere conferma', async () => {
    const r = await json(chiama())
    expect(String(r.anteprima)).toContain('scadenzario')
    expect(String(r.anteprima)).toContain('COMPENSAZIONE')
  })
})

describe('🚨 ANTI-DOPPIONE: due volte lo stesso costo e la stessa IVA a credito', () => {
  it('se su FIC c e gia quel fornitore con quel numero, NON prepara e riporta l id esistente', async () => {
    stato.ricevute = [{ id: 777, entity: { name: 'Booking.com B.V.' }, invoice_number: '1234567890', date: '2026-09-01', amount_gross: 266.5 }]

    const r = await json(chiama())

    expect(r.ok).toBe(false)
    expect(r.id_esistente).toBe(777)
    expect(stato.inserite).toHaveLength(0)
  })

  it('riconosce lo stesso numero scritto diverso: «FT 123/2026» e «ft123-2026»', async () => {
    stato.ricevute = [{ id: 778, entity: { name: 'Booking.com B.V.' }, invoice_number: 'ft123-2026', date: '2026-09-01', amount_gross: 10 }]

    const r = await json(chiama({ numero: 'FT 123/2026' }))

    expect(r.ok).toBe(false)
    expect(r.id_esistente).toBe(778)
  })

  it('🚨 se l elenco e TRONCATO si RIFIUTA: un elenco incompleto non e un «non c e»', async () => {
    stato.ricevute = []
    // FIC dichiara 99 pagine e continua a dare righe: si cammina fino al
    // tetto e si esce SENZA aver finito. Su un elenco cosi' non si puo' dire
    // che il doppione non c'e'.
    stato.ultimaPaginaRicevute = 99

    const r = await json(chiama())

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('TRONCATO')
    expect(stato.inserite).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: con un numero diverso dello stesso fornitore prepara normalmente', async () => {
    stato.ricevute = [{ id: 779, entity: { name: 'Booking.com B.V.' }, invoice_number: '999', date: '2026-09-01', amount_gross: 10 }]

    const r = await json(chiama())

    expect(r.ok).toBe(true)
    expect(stato.inserite).toHaveLength(1)
  })

  it('CONTROLLO POSITIVO: la ricerca viene fatta DAVVERO, su received_documents', async () => {
    await chiama()
    expect(stato.letture.some((p) => p.endsWith('/received_documents'))).toBe(true)
  })
})

describe('l allegato: non si indovina quale, e non si finge di averlo letto', () => {
  it('con piu allegati e senza nome_file si RIFIUTA e li elenca', async () => {
    stato.mail.set('m-1', {
      subject: 'Invoice',
      attachments: [
        { filename: 'fattura.pdf', attachmentId: 'a-1', sizeBytes: 1000 },
        { filename: 'estratto.pdf', attachmentId: 'a-2', sizeBytes: 2000 },
      ],
    })

    const r = await json(chiama())

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('fattura.pdf')
    expect(String(r.error)).toContain('estratto.pdf')
    expect(stato.inserite).toHaveLength(0)
  })

  it('CONTROLLO POSITIVO: con nome_file sceglie quello e prepara', async () => {
    stato.mail.set('m-1', {
      subject: 'Invoice',
      attachments: [
        { filename: 'fattura.pdf', attachmentId: 'a-1', sizeBytes: 1000 },
        { filename: 'estratto.pdf', attachmentId: 'a-2', sizeBytes: 2000 },
      ],
    })

    const r = await json(chiama({ nome_file: 'estratto.pdf' }))

    expect(r.ok).toBe(true)
    expect(r.allegato).toBe('estratto.pdf')
  })

  it('una mail senza allegati si rifiuta: la spesa non nasce senza il suo documento', async () => {
    stato.mail.set('m-1', { subject: 'Nessun file', attachments: [] })

    const r = await json(chiama())

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('non ha allegati')
  })

  it('un formato che FIC non accetta si rifiuta PRIMA, non con un 400 di Fatture in Cloud', async () => {
    stato.mail.set('m-1', { subject: 'Invoice', attachments: [{ filename: 'fattura.eml', attachmentId: 'a-1', sizeBytes: 100 }] })

    const r = await json(chiama())

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('formato')
  })
})

describe('i dati che non si inventano', () => {
  it('un imponibile in formato italiano viene RIFIUTATO, non letto cento volte tanto', async () => {
    const r = await json(chiama({ imponibile: '1.234,56' }))

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('imponibile')
    expect(stato.inserite).toHaveLength(0)
  })

  it('una data fuori formato viene rifiutata', async () => {
    const r = await json(chiama({ data: '01/09/2026' }))

    expect(r.ok).toBe(false)
    expect(stato.inserite).toHaveLength(0)
  })

  it('senza numero della fattura non si prepara: e la chiave dell anti-doppione', async () => {
    const r = await json(chiama({ numero: undefined }))

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('numero')
  })

  it('senza la mail non si prepara: la spesa si registra CON il suo documento', async () => {
    const r = await json(chiama({ message_id: undefined }))

    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('message_id')
  })
})

describe('🚨 la creazione: l esito viene dalla RILETTURA, non dalla risposta della POST', () => {
  it('CONTROLLO POSITIVO: scarica il PDF, lo carica, crea, rilegge e lo DICE', async () => {
    await chiama()
    stato.riga = rigaDallaCompilazione()

    const messaggio = await confirmFicStep2('pend-1')

    expect(messaggio).toMatch(/^SPESA REGISTRATA/)
    expect(stato.caricati).toEqual([{ filename: 'fattura.pdf', byte: Buffer.from(PDF_BASE64, 'base64').length }])
    expect(stato.creati).toHaveLength(1)
    // Il token del caricamento finisce sul documento: senza, la spesa
    // nascerebbe senza il suo PDF.
    expect(stato.creati[0].attachment_token).toBe('tok-1')
    expect(messaggio).toContain('spesa-1')
  })

  it('POST riuscita ma rilettura che NON conferma: DA VERIFICARE, non un successo', async () => {
    stato.riletture = new Map()
    await chiama()
    stato.riga = rigaDallaCompilazione()

    const messaggio = await confirmFicStep2('pend-1')

    expect(messaggio).toMatch(/^SPESA DA VERIFICARE/)
    expect(messaggio).not.toMatch(/^SPESA REGISTRATA/)
    // Non si ritenta: la riga si CHIUDE, perche' il documento potrebbe esserci.
    expect(stato.updates.some((u) => u.stato === 'creata')).toBe(true)
  })

  it('🚨 documento creato ma allegato ASSENTE nella rilettura: DA VERIFICARE', async () => {
    // Una fattura d'acquisto registrata senza il suo PDF e' meta' del lavoro
    // fatto e l'altra meta' persa in silenzio.
    stato.riletture = new Map([['spesa-1', { id: 'spesa-1', type: 'expense', attachment_url: '' }]])
    await chiama()
    stato.riga = rigaDallaCompilazione()

    const messaggio = await confirmFicStep2('pend-1')

    expect(messaggio).toMatch(/^SPESA DA VERIFICARE/)
    expect(messaggio).toContain('allegato')
  })

  it('la rilettura che NON espone il campo dell allegato non lo dichiara assente: lo dichiara NON VISTO', async () => {
    // «Non l'ho visto» e «non c'e'» sono due cose diverse: trattarle uguali
    // renderebbe sospetta ogni spesa per un capriccio del fieldset.
    stato.riletture = new Map([['spesa-1', { id: 'spesa-1', type: 'expense' }]])
    await chiama()
    stato.riga = rigaDallaCompilazione()

    const messaggio = await confirmFicStep2('pend-1')

    expect(messaggio).toMatch(/^SPESA REGISTRATA/)
    expect(messaggio).toContain('NON l\'ho verificato')
  })

  it('🚨 se il PDF non si scarica, su Fatture in Cloud non viene scritto NIENTE', async () => {
    await chiama()
    stato.riga = rigaDallaCompilazione()
    stato.contenutoAllegato = null

    const messaggio = await confirmFicStep2('pend-1')

    expect(messaggio).toMatch(/^SPESA NON REGISTRATA/)
    expect(stato.caricati).toHaveLength(0)
    expect(stato.creati).toHaveLength(0)
  })

  it('se il caricamento dell allegato fallisce, il documento non nasce', async () => {
    await chiama()
    stato.riga = rigaDallaCompilazione()
    stato.esitoCaricamento = { ok: false, error: 'FIC ha rifiutato il file' }

    const messaggio = await confirmFicStep2('pend-1')

    expect(messaggio).toMatch(/^SPESA NON REGISTRATA/)
    expect(stato.creati).toHaveLength(0)
  })

  it('🚨 ANTI-DOPPIONE anche alla conferma: se nel frattempo la fattura c e, non si crea', async () => {
    await chiama()
    stato.riga = rigaDallaCompilazione()
    // Fra la compilazione e la conferma la stessa fattura entra da un altro canale.
    stato.ricevute = [{ id: 777, entity: { name: 'Booking.com B.V.' }, invoice_number: '1234567890', date: '2026-09-01', amount_gross: 266.5 }]

    const messaggio = await confirmFicStep2('pend-1')

    expect(messaggio).toMatch(/^SPESA NON REGISTRATA/)
    expect(messaggio).toContain('777')
    expect(stato.creati).toHaveLength(0)
    expect(stato.caricati).toHaveLength(0)
  })

  it('una creazione rifiutata da FIC lascia la riga RITENTABILE, non chiusa', async () => {
    await chiama()
    stato.riga = rigaDallaCompilazione()
    stato.esitoCreazione = { ok: false, error: '422 campo mancante' }

    const messaggio = await confirmFicStep2('pend-1')

    expect(messaggio).toMatch(/^SPESA NON REGISTRATA/)
    expect(stato.updates.some((u) => u.conferme === 1)).toBe(true)
    expect(stato.updates.some((u) => u.stato === 'creata')).toBe(false)
  })
})

describe('🚨 annullare una spesa non deve cancellare la fattura sbagliata', () => {
  it('una spesa GIA registrata non si cancella da qui: eliminaDocumentoFIC parla di issued_documents', async () => {
    stato.riga = { id: 'pend-1', tipo: 'spesa_ricevuta', stato: 'creata', fic_document_id: '4321', societa: 'larealestate' }

    const r = await json(executeFicWriteTool('elimina_bozza_fic', { id: 'pend-1' }, 'larealestate'))

    expect(r.ok).toBe(false)
    // La prova che conta: NESSUNA eliminazione e' partita verso FIC.
    expect(stato.eliminate).toEqual([])
  })

  it('CONTROLLO POSITIVO: una spesa ancora in attesa si annulla, e niente parte verso FIC', async () => {
    stato.riga = { id: 'pend-1', tipo: 'spesa_ricevuta', stato: 'in_attesa', fic_document_id: null, societa: 'larealestate' }

    const r = await json(executeFicWriteTool('elimina_bozza_fic', { id: 'pend-1' }, 'larealestate'))

    expect(r.ok).toBe(true)
    expect(r.stato).toBe('annullata')
    expect(stato.eliminate).toEqual([])
  })
})

describe('il tool e dichiarato, cosi il modello sa che esiste', () => {
  it('registra_spesa_fornitore sta nell elenco dei tool di scrittura FIC', () => {
    const tool = FIC_WRITE_TOOLS.find((t) => t.name === 'registra_spesa_fornitore')
    expect(tool).toBeDefined()
    expect(tool?.input_schema).toBeDefined()
    const req = (tool?.input_schema as { required: string[] }).required
    expect(req).toContain('imponibile')
    expect(req).toContain('message_id')
    // 🚨 vat_id e modalita_pagamento NON sono obbligatori nello schema, ed e'
    // voluto: senza, il tool deve poter tornare l'elenco vero e CHIEDERE.
    expect(req).not.toContain('vat_id')
    expect(req).not.toContain('modalita_pagamento')
  })

  it('la descrizione non suggerisce nessuna aliquota', () => {
    const tool = FIC_WRITE_TOOLS.find((t) => t.name === 'registra_spesa_fornitore')
    expect(tool?.description).not.toMatch(/\d+\s*%/)
  })
})
