/**
 * src/lib/fic-write-tools.registro.test.ts — CHI SCRIVE I DOCUMENTI AGGIORNA
 * IL REGISTRO.
 *
 * Il difetto che chiude: un registro che vive separato da chi crea i documenti
 * e' carta straccia in tre settimane. E' cosi' che e' morta la memoria di
 * lavoro di questo progetto — flag acceso, tabella mai scritta, nessuno se
 * n'e' accorto per tre mesi.
 *
 * 🚨 E il secondo difetto, quello che costa di piu': UN REGISTRO CHE MENTE E'
 * PEGGIO DI NESSUN REGISTRO. Se la scrittura sul registro fallisce DOPO che il
 * documento su Fatture in Cloud e' nato, il tool lo DICE, con l'id vero.
 *
 * ⚠️ Qui si provano gli ADATTATORI, non il motore: `aggiornaRegistroPortali` e'
 * sostituito e osservato, perche' il suo comportamento e' gia' provato in
 * `registro-portali.test.ts`. Quello che questo file pretende e' che i due tool
 * lo chiamino, col dato giusto, nel momento giusto — e che dicano la verita'
 * quando risponde male.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AggiornamentoRegistro, EsitoRegistro } from './registro-portali'

const stato = {
  inserite: [] as Record<string, unknown>[],
  descrizione: '',
  riga: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  aliquote: [] as Record<string, unknown>[],
  conti: [] as Record<string, unknown>[],
  schedeFornitori: new Map<string, Record<string, unknown>>(),
  mail: new Map<string, Record<string, unknown>>(),
  contenutoAllegato: null as string | null,
  esitoCreazione: { ok: true, id: 'spesa-1' } as { ok: boolean; id?: string; error?: string },
  riletture: new Map<string, Record<string, unknown>>(),
}

const registro = {
  chiamate: [] as AggiornamentoRegistro[],
  esito: { ok: true, scritto: true, id: 'riga-1', stato: 'spesa_registrata', avanzato: true } as EsitoRegistro,
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

// 🚨 Il motore del registro e' sostituito; `avvisoRegistroNonScritto` e
// `portaleDelFornitore` restano QUELLI VERI: sono parte dell'adattatore.
vi.mock('./registro-portali', async (originale) => {
  const reale = await originale<typeof import('./registro-portali')>()
  return {
    ...reale,
    aggiornaRegistroPortali: async (a: AggiornamentoRegistro) => {
      registro.chiamate.push(a)
      return registro.esito
    },
  }
})

vi.mock('./fatture-in-cloud', () => ({
  FORMATI_ALLEGATO_FIC: ['png', 'jpg', 'gif', 'pdf', 'zip', 'xls', 'xlsx', 'doc', 'docx'],
  ficGet: async (path: string) => {
    if (path.includes('/settings/vat_types')) return { ok: true, data: { data: stato.aliquote, last_page: 1 } }
    if (path.includes('/info/payment_accounts')) return { ok: true, data: { data: stato.conti } }
    const scheda = /\/entities\/suppliers\/(\d+)$/.exec(path)
    if (scheda) {
      const trovata = stato.schedeFornitori.get(scheda[1])
      return trovata ? { ok: true, data: { data: trovata } } : { ok: false, error: 'anagrafica non trovata' }
    }
    if (path.includes('/entities/suppliers')) return { ok: true, data: { data: [] } }
    const documento = /\/received_documents\/(.+)$/.exec(path)
    if (documento) {
      const trovato = stato.riletture.get(documento[1])
      return trovato ? { ok: true, data: { data: trovato } } : { ok: false, error: 'documento non trovato su FIC' }
    }
    if (path.endsWith('/received_documents')) return { ok: true, data: { data: [], last_page: 1 } }
    return { ok: true, data: { data: [] } }
  },
  ficPost: async () => ({ ok: true, data: { data: {} } }),
  ficPut: async () => ({ ok: true, data: { data: {} } }),
  getCompanyId: async () => ({ ok: true, id: '111' }),
  creaDocumentoFIC: async () => ({ ok: true as const, id: 'issued-1', url: null }),
  eliminaDocumentoFIC: async () => ({ ok: true }),
  caricaAllegatoFIC: async () => ({ ok: true as const, token: 'tok-1' }),
  creaSpesaFIC: async () => (stato.esitoCreazione.ok
    ? { ok: true as const, id: stato.esitoCreazione.id ?? 'spesa-1', url: null }
    : { ok: false as const, error: stato.esitoCreazione.error ?? 'rifiutata da FIC' }),
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

import { executeFicWriteTool, confirmFicStep2 } from './fic-write-tools'

const PDF_BASE64 = Buffer.from('%PDF-1.4 finto ma non vuoto').toString('base64')

/** La fattura commissioni di Booking, coi dati che finiscono nel registro. */
const BUONA = {
  casella: 'larealestate',
  message_id: 'm-1',
  fornitore: 'Booking.com B.V.',
  fornitore_id: 9,
  numero: '1234567890',
  data: '2026-09-01',
  data_ricezione: '2026-09-02',
  struttura: 'Blue Maison',
  struttura_id: '14744428',
  periodo_dal: '2026-08-01',
  periodo_al: '2026-08-31',
  imponibile: 218.44,
  vat_id: 0,
  modalita_pagamento: 'Intesa Sanpaolo',
}

function compila(over: Record<string, unknown> = {}) {
  return executeFicWriteTool('registra_spesa_fornitore', { ...BUONA, ...over }, 'larealestate')
}

async function compilaEConferma(over: Record<string, unknown> = {}): Promise<string> {
  const compilata = JSON.parse((await compila(over)) ?? '{}')
  expect(compilata.ok, `la compilazione non e' arrivata al pending: ${JSON.stringify(compilata)}`).toBe(true)
  const payload = stato.inserite[stato.inserite.length - 1].payload
  stato.riga = { id: 'pend-1', tipo: 'spesa_ricevuta', payload, conferme: 1, stato: 'in_attesa', societa: 'larealestate' }
  return confirmFicStep2('pend-1')
}

beforeEach(() => {
  stato.inserite = []
  stato.descrizione = ''
  stato.riga = null
  stato.updates = []
  stato.aliquote = [{ id: 0, value: 22, description: 'Aliquota 22%' }]
  stato.conti = [{ id: 5, name: 'Intesa Sanpaolo' }]
  stato.schedeFornitori = new Map([['9', { id: 9, name: 'Booking.com B.V.' }]])
  stato.mail = new Map([['m-1', { subject: 'Invoice 1234567890', attachments: [{ filename: 'fattura.pdf', attachmentId: 'a-1', sizeBytes: 12_345 }] }]])
  stato.contenutoAllegato = PDF_BASE64
  stato.esitoCreazione = { ok: true, id: 'spesa-1' }
  stato.riletture = new Map([['spesa-1', { id: 'spesa-1', type: 'expense', attachment_url: 'https://fic/allegato.pdf' }]])
  registro.chiamate = []
  registro.esito = { ok: true, scritto: true, id: 'riga-1', stato: 'spesa_registrata', avanzato: true }
})

describe('registra_spesa_fornitore aggiorna il registro', () => {
  it('🚨 lo stato avanza SOLO dopo la rilettura, e porta con se i dati della fattura del portale', async () => {
    const messaggio = await compilaEConferma()

    expect(messaggio).toContain('SPESA REGISTRATA')
    expect(registro.chiamate).toHaveLength(1)
    expect(registro.chiamate[0]).toMatchObject({
      societa: 'larealestate',
      fornitore: 'Booking.com B.V.',
      numero: '1234567890',
      data: '2026-09-01',
      dataRicezione: '2026-09-02',
      struttura: 'Blue Maison',
      strutturaId: '14744428',
      periodoDal: '2026-08-01',
      periodoAl: '2026-08-31',
      stato: 'spesa_registrata',
      spesaFicId: 'spesa-1',
    })
    expect(messaggio).toContain('Registro portali: riga aggiornata')
  })

  it('🚨 rilettura che NON conferma: stato fermo a da_verificare e l id solo nella NOTA', async () => {
    // E' l'id 552625594 del 15 settembre 2026: una POST che risponde non e'
    // un documento che esiste. Scriverlo fra i documenti citati farebbe citare
    // al registro un documento che forse non c'e'.
    stato.riletture = new Map()
    const messaggio = await compilaEConferma()

    expect(messaggio).toContain('SPESA DA VERIFICARE')
    expect(registro.chiamate).toHaveLength(1)
    expect(registro.chiamate[0].stato).toBe('da_verificare')
    expect(registro.chiamate[0].spesaFicId).toBeUndefined()
    expect(registro.chiamate[0].nota).toContain('spesa-1')
  })

  it('CONTROLLO POSITIVO — con la rilettura che conferma, lo stato avanza davvero', async () => {
    // Senza, un adattatore che scrivesse SEMPRE `da_verificare` passerebbe il
    // test sopra e renderebbe il registro inutile.
    const messaggio = await compilaEConferma()
    expect(messaggio).toContain('SPESA REGISTRATA')
    expect(registro.chiamate[0].stato).toBe('spesa_registrata')
  })

  it('🚨 registro non scritto DOPO che il documento e nato: il tool lo DICE, con l id vero', async () => {
    registro.esito = { ok: false, errore: 'connection reset' }
    const messaggio = await compilaEConferma()

    expect(messaggio).toContain('SPESA REGISTRATA')           // il documento c'e'
    expect(messaggio).toContain('REGISTRO PORTALI NON AGGIORNATO')
    expect(messaggio).toContain('spesa-1')                    // l'id VERO
    expect(messaggio).toContain('NON rifarlo')
  })

  it('CONTROLLO POSITIVO — quando il registro si scrive, nessun allarme', async () => {
    const messaggio = await compilaEConferma()
    expect(messaggio).not.toContain('REGISTRO PORTALI NON AGGIORNATO')
  })

  it('l anteprima avvisa se manca la data di ricezione: la riga nascerebbe senza scadenza', async () => {
    const compilata = JSON.parse((await compila({ data_ricezione: undefined })) ?? '{}')
    expect(compilata.anteprima).toContain('SENZA scadenza di invio')

    const conRicezione = JSON.parse((await compila()) ?? '{}')
    // CONTROLLO POSITIVO: con la data, l'anteprima dice la scadenza e non avvisa.
    expect(conRicezione.anteprima).toContain('entro il 15 del mese successivo')
    expect(conRicezione.anteprima).not.toContain('SENZA scadenza di invio')
  })

  it('una data di ricezione scritta male si RIFIUTA: non si prepara niente', async () => {
    const esito = JSON.parse((await compila({ data_ricezione: '02/09/2026' })) ?? '{}')
    expect(esito.ok).toBe(false)
    expect(String(esito.error)).toContain('YYYY-MM-DD')
    expect(stato.inserite).toHaveLength(0)
  })

  it('con un fornitore che non e un portale il registro risponde «non mi riguarda» e nessuno mente', async () => {
    registro.esito = { ok: true, scritto: false, motivo: 'Studio Legale Rossi non e\' un portale (Booking/Airbnb).' }
    stato.schedeFornitori = new Map([['9', { id: 9, name: 'Studio Legale Rossi' }]])
    const messaggio = await compilaEConferma({ fornitore: 'Studio Legale Rossi' })

    expect(messaggio).toContain('SPESA REGISTRATA')
    expect(messaggio).not.toContain('REGISTRO PORTALI NON AGGIORNATO')
    expect(messaggio).not.toContain('Registro portali: riga aggiornata')
  })
})
