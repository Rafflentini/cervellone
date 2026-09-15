/**
 * src/lib/fic-write-tools.registro-td17.test.ts — l'INTEGRAZIONE aggiorna il
 * registro dei portali, e solo su un fatto verificato.
 *
 * 🚨 Tre fatti diversi, tre esiti diversi, mai confusi:
 *  - creata, RILETTA e passata dalla verifica formale → `td17_generata`;
 *  - creata e riletta ma BOCCIATA dalla verifica formale → `da_verificare`,
 *    con l'id (il documento ESISTE: rifarlo sarebbe un doppione);
 *  - creata ma NON confermata dalla rilettura → `da_verificare`, con l'id solo
 *    nella NOTA. E' l'id 552625594 del 15 settembre 2026, restituito da una
 *    POST fallita e inseguito per un'ora: il registro non deve CITARLO come
 *    documento, perche' forse non esiste.
 *
 * ⚠️ Si provano gli ADATTATORI: `aggiornaRegistroPortali` e' sostituito e
 * osservato — il suo comportamento e' gia' provato in `registro-portali.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AggiornamentoRegistro, EsitoRegistro } from './registro-portali'

const stato = {
  riga: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  creati: [] as Record<string, unknown>[],
  esitiCreazione: [] as Array<{ ok: boolean; id?: string; error?: string }>,
  riletture: new Map<string, Record<string, unknown>>(),
  verificaFormale: { status: 200, body: JSON.stringify({ data: { success: true } }) },
}

const registro = {
  chiamate: [] as AggiornamentoRegistro[],
  esito: { ok: true, scritto: true, id: 'riga-1', stato: 'td17_generata', avanzato: true } as EsitoRegistro,
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
        insert: () => catena(() => [{ id: 'pend-1' }], () => ({ id: 'pend-1' })),
        select: () => catena(() => (stato.riga ? [stato.riga] : []), () => stato.riga),
        update: (row: Record<string, unknown>) => {
          stato.updates.push(row)
          return catena(() => [{ id: 'pend-1', societa: 'larealestate' }], () => ({ id: 'pend-1' }))
        },
      }),
    },
  }
})

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
  ficGet: async (path: string) => {
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
  getFicToken: () => 'token-finto',
  creaDocumentoFIC: async (payload: Record<string, unknown>) => {
    stato.creati.push(payload)
    const esito = stato.esitiCreazione.shift() ?? { ok: true, id: `doc-${stato.creati.length}` }
    return esito.ok
      ? { ok: true as const, id: esito.id ?? `doc-${stato.creati.length}`, url: null }
      : { ok: false as const, error: esito.error ?? 'rifiutata da FIC' }
  },
  eliminaDocumentoFIC: async () => ({ ok: true }),
  caricaAllegatoFIC: async () => ({ ok: true as const, token: 'tok' }),
  creaSpesaFIC: async () => ({ ok: false as const, error: 'non previsto' }),
  FORMATI_ALLEGATO_FIC: ['pdf'],
}))

import { confirmFicStep2 } from './fic-write-tools'

/** Una sola integrazione: le commissioni Booking di agosto. */
const UNA = [{
  fornitore: 'Booking.com B.V.',
  numero: '1234567890',
  data: '2026-08-31',
  data_ricezione: '2026-09-01',
  imponibile: 218.44,
  payload: {
    type: 'self_supplier_invoice',
    entity: { id: 9, name: 'Booking.com B.V.' },
    date: '2026-09-01',
    items_list: [{ name: 'commissioni', qty: 1, net_price: 218.44, vat: { id: 21 } }],
  },
}]

function pendingConfermato(documenti: Array<Record<string, unknown>>) {
  return {
    id: 'pend-1',
    tipo: 'autofattura',
    stato: 'in_attesa',
    conferme: 1,
    societa: 'larealestate',
    payload: { vat: { id: 21, etichetta: 'id 21 — 0% — Inversione contabile' }, numerazione: 'INT', documenti },
  }
}

beforeEach(() => {
  stato.riga = pendingConfermato(UNA)
  stato.updates = []
  stato.creati = []
  stato.esitiCreazione = []
  stato.riletture = new Map()
  stato.verificaFormale = { status: 200, body: JSON.stringify({ data: { success: true } }) }
  registro.chiamate = []
  registro.esito = { ok: true, scritto: true, id: 'riga-1', stato: 'td17_generata', avanzato: true }
  vi.stubGlobal('fetch', async () => {
    const { status, body } = stato.verificaFormale
    return { ok: status >= 200 && status < 300, status, text: async () => body } as unknown as Response
  })
})

describe('compila_autofattura aggiorna il registro dei portali', () => {
  it('✅ riletta E formalmente valida: lo stato avanza a td17_generata, col numero letto da FIC', async () => {
    stato.riletture.set('doc-1', { id: 'doc-1', type: 'self_supplier_invoice', number: 1, numeration: 'INT' })

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('AUTOFATTURE CREATE')
    expect(registro.chiamate).toHaveLength(1)
    expect(registro.chiamate[0]).toMatchObject({
      societa: 'larealestate',
      fornitore: 'Booking.com B.V.',
      numero: '1234567890',
      data: '2026-08-31',
      dataRicezione: '2026-09-01',
      regime: 'RC',
      stato: 'td17_generata',
      td17FicId: 'doc-1',
      td17Numero: '1/INT',
    })
  })

  it('🚨 creata ma BOCCIATA dalla verifica formale: da_verificare, e l id C E (il documento esiste)', async () => {
    stato.riletture.set('doc-1', { id: 'doc-1', type: 'self_supplier_invoice', number: 1, numeration: 'INT' })
    stato.verificaFormale = {
      status: 200,
      body: JSON.stringify({ data: { success: false, error: 'attributo 2.1.6 non ammesso' } }),
    }

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('CREATE MA NON VALIDE')
    expect(registro.chiamate[0].stato).toBe('da_verificare')
    // Il documento ESISTE: l'id si scrive, cosi' nessuno lo rifa'.
    expect(registro.chiamate[0].td17FicId).toBe('doc-1')
    expect(String(registro.chiamate[0].nota)).toContain('BOCCIATA')
  })

  it('🚨 rilettura che NON conferma: da_verificare, e l id solo nella NOTA', async () => {
    // Nessuna rilettura registrata -> FIC risponde «documento non trovato».
    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('DA VERIFICARE A MANO')
    expect(registro.chiamate[0].stato).toBe('da_verificare')
    expect(registro.chiamate[0].td17FicId).toBeUndefined()
    expect(String(registro.chiamate[0].nota)).toContain('doc-1')
  })

  it('🚨 una creazione RIFIUTATA da FIC non tocca il registro: non e nato niente', async () => {
    stato.esitiCreazione = [{ ok: false, error: '422 entity.name' }]
    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('NESSUNA autofattura creata')
    expect(registro.chiamate).toHaveLength(0)
  })

  it('🚨 registro non scritto DOPO la creazione: il tool lo DICE, con l id vero', async () => {
    stato.riletture.set('doc-1', { id: 'doc-1', type: 'self_supplier_invoice', number: 1, numeration: 'INT' })
    registro.esito = { ok: false, errore: 'connection reset' }

    const out = await confirmFicStep2('pend-1')

    expect(out).toContain('AUTOFATTURE CREATE')          // il documento c'e'
    expect(out).toContain('REGISTRO PORTALI NON AGGIORNATO')
    expect(out).toContain('doc-1')
    expect(out).toContain('NON rifarlo')
  })

  it('CONTROLLO POSITIVO — quando il registro si scrive, nessun allarme', async () => {
    stato.riletture.set('doc-1', { id: 'doc-1', type: 'self_supplier_invoice', number: 1, numeration: 'INT' })
    const out = await confirmFicStep2('pend-1')
    expect(out).toContain('AUTOFATTURE CREATE')
    expect(out).not.toContain('REGISTRO PORTALI NON AGGIORNATO')
  })
})
