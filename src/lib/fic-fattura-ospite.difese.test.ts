/**
 * src/lib/fic-fattura-ospite.difese.test.ts — LE DIFESE della fattura di
 * soggiorno, ognuna col suo CONTROLLO POSITIVO.
 *
 * 🚨 Perche' il controllo positivo accanto a ogni rifiuto: un tool che rifiuta
 * SEMPRE passerebbe ogni guardia di questo file senza saper fatturare niente.
 * Ogni «si ferma» qui dentro ha accanto un «e invece cosi' va avanti», sugli
 * stessi dati, cambiando solo la cosa in prova.
 *
 * ⚠️ I dati identificativi sono INVENTATI (il repo e' PUBBLICO): il codice
 * fiscale «VRDGPP85R41F205N» e' formalmente valido ma di una persona che non
 * esiste, e i numeri di prenotazione non sono quelli veri.
 *
 * I mock stanno sul livello HTTP (`creaDocumentoFIC`, `ficGet`, la ricerca
 * delle emesse, la verifica formale), non sul motore: quello che si prova qui
 * e' il codice vero.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stato = {
  /** Le fatture EMESSE che FIC restituisce: la base dell'anti-doppione. */
  emesse: [] as Record<string, unknown>[],
  ricercaOk: true,
  elencoTroncato: false,
  pagineLette: 1,
  /** Gli anni per cui la ricerca e' stata fatta: prova che sia avvenuta. */
  anniCercati: [] as number[],
  aliquote: [] as Record<string, unknown>[],
  aliquoteOk: true,
  conti: [] as { id: number; nome: string }[],
  contiOk: true,
  /** I payload spediti a `creaDocumentoFIC`. */
  creati: [] as Record<string, unknown>[],
  esitoCreazione: { ok: true, id: '999' } as { ok: boolean; id?: string; url?: string; error?: string },
  /** Cosa risponde la RILETTURA. */
  rilettura: null as Record<string, unknown> | null,
  riletturaOk: true,
  /** Cosa risponde la VERIFICA FORMALE. */
  formale: { esito: 'valido' } as { esito: string; errori?: string[]; motivo?: string },
}

vi.mock('./fatture-in-cloud', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./fatture-in-cloud')>()
  return {
    ...vero,
    getCompanyId: async () => ({ ok: true as const, id: 1614746 }),
    ficGet: async () => (stato.riletturaOk
      ? { ok: true as const, data: { data: stato.rilettura ?? {} } }
      : { ok: false as const, error: 'rilettura non riuscita' }),
    creaDocumentoFIC: async (payload: Record<string, unknown>) => {
      stato.creati.push(payload)
      return stato.esitoCreazione.ok
        ? { ok: true as const, id: stato.esitoCreazione.id!, url: stato.esitoCreazione.url ?? '' }
        : { ok: false as const, error: stato.esitoCreazione.error! }
    },
  }
})

vi.mock('./fic-pagamenti', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./fic-pagamenti')>()
  return {
    ...vero,
    cercaFattureEmesse: async (filtri: { anno?: number }) => {
      stato.anniCercati.push(filtri.anno ?? 0)
      if (!stato.ricercaOk) return { ok: false as const, error: 'Fatture in Cloud non risponde' }
      return {
        ok: true as const,
        valore: {
          documenti: stato.emesse,
          elenco_troncato: stato.elencoTroncato,
          pagine_lette: stato.pagineLette,
        },
      }
    },
    elencoContiPagamentoFic: async () => (stato.contiOk
      ? { ok: true as const, valore: stato.conti }
      : { ok: false as const, error: 'conti non leggibili' }),
  }
})

vi.mock('./fic-aliquote', () => ({
  elencoAliquoteFic: async () => (stato.aliquoteOk
    ? { ok: true as const, righe: stato.aliquote }
    : { ok: false as const, error: 'aliquote non leggibili' }),
}))

vi.mock('./fic-verifica-formale', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./fic-verifica-formale')>()
  return {
    ...vero,
    verificaFormaleXml: async () => stato.formale,
  }
})

import {
  ID_MODELLO,
  NOME_RIGA_IMPOSTA,
  cercaFatturaPrenotazione,
  costruisciPayloadFatturaOspite,
  creaFatturaOspite,
  leggiDatiFatturaOspite,
  risolviIdFic,
  verificaRiletturaFatturaOspite,
  type IdFic,
} from './fic-fattura-ospite'

const CF_VALIDO = 'VRDGPP85R41F205N'
/** Stesso codice col carattere di controllo SBAGLIATO: forma giusta, somma no. */
const CF_STORTO = 'VRDGPP85R41F205A'

const IDS: IdFic = {
  aliquota10: ID_MODELLO.aliquota10,
  naturaArt15: ID_MODELLO.naturaArt15,
  contoBanca: ID_MODELLO.contoBanca,
  contoContanti: ID_MODELLO.contoContanti,
  avvisi: [],
}

const BASE = {
  unita: 'Blue Maison 1',
  indirizzo_unita: 'Via Fiumicello, Maratea (PZ)',
  check_in: '2027-08-19',
  check_out: '2027-08-22',
  prenotazione: '7100000001',
  prezzo: 516.3,
  adulti: 2,
  bambini: 1,
  data: '2027-09-15',
  ospite: {
    nome: 'VERDI GIUSEPPINA',
    codice_fiscale: CF_VALIDO,
    indirizzo: 'VIA DELLE PROVE, 1',
    cap: '20121',
    citta: 'MILANO',
    provincia: 'MI',
    paese: 'Italia',
  },
  cliente_id: 900001,
  imposta_soggiorno: { importo: 13.5, persone: 3, notti: 3, tariffa: 1.5 },
}

function dati(extra: Record<string, unknown> = {}) {
  const letto = leggiDatiFatturaOspite({ ...BASE, ...extra })
  if (!letto.ok) throw new Error(letto.error)
  return letto.dati
}

/** Il pending come lo scrive `compilaFatturaOspite`. */
function pending(extra: Record<string, unknown> = {}) {
  const d = dati(extra)
  return {
    documento: costruisciPayloadFatturaOspite(d, IDS),
    prenotazione: d.prenotazione,
    prezzo: d.prezzo,
    imposta: d.imposta?.importo ?? 0,
    anni: [2027],
    ids: {
      aliquota10: IDS.aliquota10,
      naturaArt15: IDS.naturaArt15,
      contoBanca: IDS.contoBanca,
      contoContanti: IDS.contoContanti,
    },
    cliente_id: 900001,
    intestazione: 'VERDI GIUSEPPINA — soggiorno',
    avvisi: [] as string[],
  }
}

/** La rilettura di una fattura CORRETTA, come tornerebbe da Fatture in Cloud. */
function riletturaBuona(extra: Record<string, unknown> = {}) {
  return {
    id: 999,
    type: 'invoice',
    e_invoice: true,
    amount_net: 469.36,
    amount_vat: 46.94,
    amount_gross: 529.8,
    entity: { id: 900001 },
    items_list: [
      { name: 'Soggiorno Blue Maison 1 dal 19/08/2027 al 22/08/2027', vat: { id: 3, value: 10 }, gross_price: 516.3 },
      { name: NOME_RIGA_IMPOSTA, vat: { id: 15819187, value: 0, description: 'Iva esclusa ex art. 15' }, gross_price: 13.5, not_taxable: true },
    ],
    payments_list: [
      { amount: 516.3, status: 'paid' },
      { amount: 13.5, status: 'paid' },
    ],
    ei_raw: { FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD01' } } } },
    ...extra,
  }
}

beforeEach(() => {
  stato.emesse = []
  stato.ricercaOk = true
  stato.elencoTroncato = false
  stato.pagineLette = 1
  stato.anniCercati = []
  stato.aliquote = [
    { id: 0, value: 22, description: 'Aliquota 22%' },
    { id: 3, value: 10, description: 'Aliquota 10%' },
    { id: 15819187, value: 0, description: 'Iva esclusa ex art. 15' },
    { id: 777, value: 0, description: 'Esente art. 10' },
  ]
  stato.aliquoteOk = true
  stato.conti = [
    { id: 1570742, nome: 'BANCA MONTEPRUNO' },
    { id: 1565608, nome: 'Contanti' },
  ]
  stato.contiOk = true
  stato.creati = []
  stato.esitoCreazione = { ok: true, id: '999' }
  stato.rilettura = riletturaBuona()
  stato.riletturaOk = true
  stato.formale = { esito: 'valido' }
})

/* ------------------------------------------------------------------ */

describe('🚨 il codice fiscale si VALIDA prima di creare qualsiasi cosa', () => {
  it('un CF col carattere di controllo sbagliato FERMA tutto', () => {
    const letto = leggiDatiFatturaOspite({ ...BASE, ospite: { ...BASE.ospite, codice_fiscale: CF_STORTO } })
    expect(letto.ok).toBe(false)
    if (letto.ok) return
    expect(letto.error).toMatch(/non valido/i)
    // Deve dire che NON ha creato l'anagrafica: e' la frase che spiega
    // all'Ingegnere che non c'e' niente da ripulire.
    expect(letto.error).toMatch(/anagrafica/i)
  })

  it('un CF assente su un cliente ITALIANO ferma tutto', () => {
    const letto = leggiDatiFatturaOspite({ ...BASE, ospite: { ...BASE.ospite, codice_fiscale: undefined } })
    expect(letto.ok).toBe(false)
  })

  it('CONTROLLO POSITIVO: con il CF giusto si va avanti', () => {
    expect(leggiDatiFatturaOspite(BASE).ok).toBe(true)
  })

  it('CONTROLLO POSITIVO: un ospite ESTERO passa senza codice fiscale', () => {
    const letto = leggiDatiFatturaOspite({
      ...BASE,
      ospite: { nome: 'DUPONT MICHEL', indirizzo: '12 RUE DES ESSAIS', citta: 'PARIS 75008', paese: 'Francia' },
    })
    expect(letto.ok).toBe(true)
    if (!letto.ok) return
    expect(letto.dati.estero).toBe(true)
    expect(letto.dati.ospite.codice_fiscale).toBeUndefined()
  })
})

describe('🚨 il divieto del Garante: le date di nascita NON escono da qui', () => {
  it('contano adulti e bambini, e non compaiono da nessuna parte nel documento', () => {
    const d = dati({
      adulti: undefined,
      bambini: undefined,
      date_nascita: ['1985-10-01', '1987-03-12', '2018-06-30'],
    })
    expect(d.adulti).toBe(2)
    expect(d.bambini).toBe(1)

    const documento = JSON.stringify(costruisciPayloadFatturaOspite(d, IDS))
    for (const data of ['1985-10-01', '1987-03-12', '2018-06-30']) {
      expect(documento).not.toContain(data)
    }
    // Ne' la data, ne' il luogo di nascita: nessun campo che li somigli.
    expect(documento).not.toMatch(/birth|nascita|luogo_nascita/i)
  })

  it('CONTROLLO POSITIVO: il conteggio finisce DAVVERO nella descrizione', () => {
    const d = dati({ adulti: undefined, bambini: undefined, date_nascita: ['1985-10-01', '1987-03-12', '2018-06-30'] })
    const righe = costruisciPayloadFatturaOspite(d, IDS).items_list as Record<string, unknown>[]
    expect(righe[0].description).toContain('3 ospiti (2 adulti, 1 bambino)')
  })
})

describe("🚨 l'imposta di soggiorno", () => {
  it('a ZERO non produce ne\' la riga 2 ne\' il secondo pagamento', () => {
    const p = costruisciPayloadFatturaOspite(dati({ imposta_soggiorno: undefined }), IDS)
    expect(p.items_list).toHaveLength(1)
    expect(p.payments_list).toHaveLength(1)
    expect(JSON.stringify(p)).not.toContain(NOME_RIGA_IMPOSTA)
    // E le note non promettono un'imposta che non c'e'.
    expect(String(p.notes)).not.toMatch(/riscossa in contanti/i)
  })

  it('un importo esplicito a 0 si comporta come l\'assenza', () => {
    const p = costruisciPayloadFatturaOspite(dati({ imposta_soggiorno: { importo: 0, persone: 0, notti: 0, tariffa: 1.5 } }), IDS)
    expect(p.items_list).toHaveLength(1)
    expect(p.payments_list).toHaveLength(1)
  })

  it('CONTROLLO POSITIVO: sopra zero la riga 2 e il pagamento 2 ci sono', () => {
    const p = costruisciPayloadFatturaOspite(dati(), IDS)
    expect(p.items_list).toHaveLength(2)
    expect(p.payments_list).toHaveLength(2)
  })

  it('🚨 se persone x notti x tariffa NON fa l\'importo, si rifiuta', () => {
    // La riga direbbe «3 persone x 3 notti x 1,50» e ne addebiterebbe 20: e'
    // denaro di terzi, che va riversato al Comune.
    const letto = leggiDatiFatturaOspite({ ...BASE, imposta_soggiorno: { importo: 20, persone: 3, notti: 3, tariffa: 1.5 } })
    expect(letto.ok).toBe(false)
    if (letto.ok) return
    expect(letto.error).toMatch(/non torna/i)
  })

  it('CONTROLLO POSITIVO: quando il conto torna, passa', () => {
    expect(leggiDatiFatturaOspite({ ...BASE, imposta_soggiorno: { importo: 13.5, persone: 3, notti: 3, tariffa: 1.5 } }).ok).toBe(true)
  })

  it('senza persone/notti/tariffa non si indovina: si rifiuta', () => {
    const letto = leggiDatiFatturaOspite({ ...BASE, imposta_soggiorno: { importo: 13.5 } })
    expect(letto.ok).toBe(false)
  })
})

describe('🚨 ANTI-DOPPIONE', () => {
  it('trova la fattura che cita quella prenotazione e la restituisce', async () => {
    stato.emesse = [{
      id: 552778017,
      number: 20,
      numeration: '',
      date: '2027-09-15',
      amount_gross: 529.8,
      visible_subject: 'Soggiorno Blue Maison 1 dal 19/08/2027 al 22/08/2027 - prenotazione Booking.com n. 7100000001',
    }]
    const r = await cercaFatturaPrenotazione('7100000001', [2027], 'larealestate')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esistente?.id).toBe(552778017)
    expect(r.esistente?.numero).toBe('20')
  })

  it('🚨 la cerca nel VISIBLE_subject: su questi documenti `subject` e\' VUOTO', async () => {
    // Se l'anti-doppione guardasse solo `subject`, non troverebbe MAI niente:
    // sui due modelli veri quel campo e' la stringa vuota.
    stato.emesse = [{
      id: 1,
      subject: '',
      visible_subject: 'Soggiorno X dal 01/01/2027 al 02/01/2027 - prenotazione Booking.com n. 7100000001',
    }]
    const r = await cercaFatturaPrenotazione('7100000001', [2027], 'larealestate')
    expect(r.ok && r.esistente !== null).toBe(true)
  })

  it('CONTROLLO POSITIVO: se non c\'e\', dice che non c\'e\' (e ha CERCATO davvero)', async () => {
    stato.emesse = [{ id: 2, visible_subject: 'Soggiorno Y - prenotazione Booking.com n. 7999999999' }]
    const r = await cercaFatturaPrenotazione('7100000001', [2027], 'larealestate')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.esistente).toBeNull()
    expect(stato.anniCercati).toEqual([2027])
  })

  it('🚨 un elenco TRONCATO e\' un RIFIUTO, non un via libera', async () => {
    stato.elencoTroncato = true
    stato.pagineLette = 10
    const r = await cercaFatturaPrenotazione('7100000001', [2027], 'larealestate')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/troncato/i)
  })

  it('🚨 un elenco che non si legge e\' un RIFIUTO, non un via libera', async () => {
    stato.ricercaOk = false
    const r = await cercaFatturaPrenotazione('7100000001', [2027], 'larealestate')
    expect(r.ok).toBe(false)
  })

  it('un numero di prenotazione troppo corto non e\' una chiave: si rifiuta', async () => {
    const r = await cercaFatturaPrenotazione('12', [2027], 'larealestate')
    expect(r.ok).toBe(false)
  })

  it('creaFatturaOspite NON crea niente se il doppione c\'e\', e non ritenta', async () => {
    stato.emesse = [{
      id: 552778017,
      number: 20,
      date: '2027-09-15',
      amount_gross: 529.8,
      visible_subject: 'prenotazione Booking.com n. 7100000001',
    }]
    const esito = await creaFatturaOspite(pending(), 'larealestate')
    expect(stato.creati).toHaveLength(0)
    expect(esito.creata).toBe(false)
    expect(esito.bloccato).toBe(true)
    expect(esito.messaggio).toMatch(/GIA'/)
    expect(esito.id).toBe('552778017')
  })

  it('CONTROLLO POSITIVO: senza doppione la fattura nasce davvero', async () => {
    const esito = await creaFatturaOspite(pending(), 'larealestate')
    expect(stato.creati).toHaveLength(1)
    expect(esito.creata).toBe(true)
  })
})

describe('🚨 gli id di IVA e conti si LEGGONO da Fatture in Cloud', () => {
  it('li legge e prende quelli veri', async () => {
    const r = await risolviIdFic('larealestate')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ids.aliquota10).toBe(3)
    expect(r.ids.naturaArt15).toBe(15819187)
    expect(r.ids.contoBanca).toBe(1570742)
    expect(r.ids.contoContanti).toBe(1565608)
    expect(r.ids.avvisi).toEqual([])
  })

  it('riconosce la natura art. 15 dalla DESCRIZIONE, non dal valore', async () => {
    // Qui l'id del modello NON c'e' piu': deve trovarla lo stesso, e non
    // prendere «Esente art. 10», che ha lo stesso valore 0.
    stato.aliquote = [
      { id: 3, value: 10, description: 'Aliquota 10%' },
      { id: 777, value: 0, description: 'Esente art. 10' },
      { id: 4242, value: 0, description: 'Iva esclusa ex art. 15' },
    ]
    const r = await risolviIdFic('larealestate')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ids.naturaArt15).toBe(4242)
  })

  it('se la LETTURA non riesce ripiega sul modello e lo DICHIARA', async () => {
    stato.aliquoteOk = false
    stato.contiOk = false
    const r = await risolviIdFic('larealestate')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ids.aliquota10).toBe(ID_MODELLO.aliquota10)
    expect(r.ids.contoBanca).toBe(ID_MODELLO.contoBanca)
    expect(r.ids.avvisi).toHaveLength(2)
    expect(r.ids.avvisi.join('\n')).toMatch(/uso gli id del modello/i)
  })

  it('🚨 se la lettura RIESCE ma l\'aliquota 10% non c\'e\', si RIFIUTA (niente ripiego)', async () => {
    // Diverso dal caso sopra, e di proposito: qui sappiamo che quell'azienda
    // non ha il 10%, e scriverlo lo stesso metterebbe un'aliquota inesistente
    // su un documento fiscale.
    stato.aliquote = [{ id: 0, value: 22, description: 'Aliquota 22%' }]
    const r = await risolviIdFic('larealestate')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/10%/)
  })

  it('🚨 se manca la natura art. 15, si RIFIUTA', async () => {
    stato.aliquote = [{ id: 3, value: 10, description: 'Aliquota 10%' }]
    const r = await risolviIdFic('larealestate')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toMatch(/art\. 15/)
  })

  it('🚨 se il conto dell\'incasso non c\'e\', si RIFIUTA', async () => {
    stato.conti = [{ id: 1565608, nome: 'Contanti' }]
    const r = await risolviIdFic('larealestate')
    expect(r.ok).toBe(false)
  })
})

describe('🚨 la RILETTURA: l\'esito non e\' la risposta della POST', () => {
  const atteso = { id: '999', prezzo: 516.3, imposta: 13.5, naturaArt15: 15819187, aliquota10: 3, clienteId: 900001 }

  it('su una fattura giusta non trova niente da ridire', () => {
    const e = verificaRiletturaFatturaOspite(riletturaBuona(), atteso)
    expect(e.problemi).toEqual([])
    expect(e.nonVisti).toEqual([])
  })

  it('🚨 se la natura e\' stata riscritta in N4, lo DICE', () => {
    // E' il caso vero: dall'interfaccia la spunta «anticipazione» mette N4.
    const doc = riletturaBuona({
      items_list: [
        { name: 'Soggiorno X', vat: { id: 3, value: 10 } },
        { name: NOME_RIGA_IMPOSTA, vat: { id: 999999, value: 0, description: 'Esenti art. 10' }, not_taxable: true },
      ],
    })
    const e = verificaRiletturaFatturaOspite(doc, atteso)
    expect(e.problemi.join('\n')).toMatch(/N4/)
  })

  it('🚨 se il prezzo NON e\' stato scorporato, lo DICE', () => {
    // `use_gross_prices` ignorato: FIC avrebbe preso 516,30 come imponibile.
    const e = verificaRiletturaFatturaOspite(riletturaBuona({ amount_net: 516.3, amount_vat: 51.63 }), atteso)
    expect(e.problemi.join('\n')).toMatch(/imponibile/i)
  })

  it('se il totale non e\' prezzo + imposta, lo DICE', () => {
    const e = verificaRiletturaFatturaOspite(riletturaBuona({ amount_gross: 516.3 }), atteso)
    expect(e.problemi.join('\n')).toMatch(/totale/i)
  })

  it('se un pagamento NON risulta saldato, lo DICE (finirebbe nello scadenzario)', () => {
    const e = verificaRiletturaFatturaOspite(
      riletturaBuona({ payments_list: [{ amount: 516.3, status: 'paid' }, { amount: 13.5, status: 'not_paid' }] }),
      atteso,
    )
    expect(e.problemi.join('\n')).toMatch(/saldate/i)
  })

  it('se la fattura e\' intestata a un\'altra anagrafica, lo DICE', () => {
    const e = verificaRiletturaFatturaOspite(riletturaBuona({ entity: { id: 111 } }), atteso)
    expect(e.problemi.join('\n')).toMatch(/intestata/i)
  })

  it('se il TipoDocumento SdI non e\' TD01, lo DICE', () => {
    const e = verificaRiletturaFatturaOspite(
      riletturaBuona({ ei_raw: { FatturaElettronicaBody: { DatiGenerali: { DatiGeneraliDocumento: { TipoDocumento: 'TD17' } } } } }),
      atteso,
    )
    expect(e.problemi.join('\n')).toMatch(/TD01/)
  })

  it('⚠️ un campo che FIC non espone e\' «non visto», NON un problema', () => {
    const doc = riletturaBuona()
    delete (doc as Record<string, unknown>).ei_raw
    delete (doc as Record<string, unknown>).amount_net
    const e = verificaRiletturaFatturaOspite(doc, atteso)
    expect(e.problemi).toEqual([])
    expect(e.nonVisti).toContain('amount_net')
    expect(e.nonVisti).toContain('ei_raw.TipoDocumento')
  })
})

describe('🚨 creaFatturaOspite: tre esiti, mai due', () => {
  it('CREATA: nata, riletta e passata dalla verifica formale', async () => {
    const esito = await creaFatturaOspite(pending(), 'larealestate')
    expect(esito.creata).toBe(true)
    expect(esito.da_verificare).toBe(false)
    expect(esito.id).toBe('999')
    expect(esito.messaggio).toMatch(/XML VALIDO/)
    expect(esito.messaggio).toMatch(/NON e' stata trasmessa allo SdI/)
  })

  it('🚨 se la VERIFICA FORMALE boccia l\'XML, NON e\' un successo', async () => {
    stato.formale = { esito: 'errori', errori: ['2.2.1.16 <Natura> non ammessa'] }
    const esito = await creaFatturaOspite(pending(), 'larealestate')
    expect(esito.creata).toBe(false)
    expect(esito.da_verificare).toBe(true)
    // Il documento ESISTE: l'id si dice, e non si ritenta.
    expect(esito.id).toBe('999')
    expect(esito.bloccato).toBe(true)
    expect(esito.messaggio).toMatch(/2\.2\.1\.16/)
    expect(esito.messaggio).toMatch(/NON la rifaccio/i)
  })

  it('⚠️ una verifica formale NON ESEGUITA si dichiara, non si conta come passata', async () => {
    stato.formale = { esito: 'non_verificato', motivo: 'scope mancante' }
    const esito = await creaFatturaOspite(pending(), 'larealestate')
    expect(esito.messaggio).toMatch(/NON ESEGUITA/)
    expect(esito.da_verificare).toBe(true)
  })

  it('🚨 se la rilettura non conferma, e\' DA VERIFICARE e NON si ritenta', async () => {
    stato.rilettura = riletturaBuona({ amount_net: 516.3 })
    const esito = await creaFatturaOspite(pending(), 'larealestate')
    expect(esito.creata).toBe(false)
    expect(esito.da_verificare).toBe(true)
    expect(esito.bloccato).toBe(true)
    expect(esito.id).toBe('999')
    expect(esito.messaggio).toMatch(/NON CONFORME/)
  })

  it('se la rilettura non si fa affatto, e\' DA VERIFICARE (non un fallimento)', async () => {
    stato.riletturaOk = false
    const esito = await creaFatturaOspite(pending(), 'larealestate')
    expect(esito.da_verificare).toBe(true)
    expect(esito.bloccato).toBe(true)
  })

  it('NON CREATA: se FIC rifiuta la POST, non c\'e\' nessun id da citare', async () => {
    stato.esitoCreazione = { ok: false, error: '422 entity.name' }
    const esito = await creaFatturaOspite(pending(), 'larealestate')
    expect(esito.creata).toBe(false)
    expect(esito.da_verificare).toBe(false)
    expect(esito.id).toBeNull()
  })

  it('gli avvisi sugli id NON letti da FIC arrivano fino all\'esito', async () => {
    const p = { ...pending(), avvisi: ['⚠️ Le aliquote IVA NON si sono lette: uso gli id del modello.'] }
    const esito = await creaFatturaOspite(p, 'larealestate')
    expect(esito.messaggio).toMatch(/uso gli id del modello/)
  })
})
