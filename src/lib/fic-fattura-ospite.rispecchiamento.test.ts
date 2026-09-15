/**
 * src/lib/fic-fattura-ospite.rispecchiamento.test.ts — IL TEST CHE RISPECCHIA
 * I DUE DOCUMENTI VERI.
 *
 * 🚨 **Perche' e' il primo test e non uno dei tanti.** La fattura di un
 * soggiorno non si deduce: ogni campo viene da uno dei due documenti creati e
 * verificati sul gestionale il 15 settembre 2026 — la 20/2026 a un cliente
 * ITALIANO (`issued_documents/552778017`) e la 3/2026 a un cliente FRANCESE
 * (`issued_documents/552770272`). Questo file li tiene accanto: e' il posto
 * dove la differenza fra i due casi si VEDE invece di doverla ricordare.
 *
 * ⚠️ **I dati identificativi qui sono INVENTATI, e il motivo non e' stilistico:
 * questo repo e' PUBBLICO.** Dai due modelli si sono tenuti la struttura, gli
 * importi e l'aritmetica (516,30 lordo -> 469,36 imponibile; 4 persone x 3
 * notti x 1,50 -> 18,00); si sono sostituiti nome, codice fiscale, indirizzo,
 * citta', numero di prenotazione, e le date di soggiorno sono spostate di un
 * anno. Il brief ammette esplicitamente le differenze su «id, numero e date»:
 * sono esattamente queste. Il codice fiscale inventato e' formalmente valido
 * (carattere di controllo calcolato), altrimenti il test non proverebbe niente
 * sulla strada normale.
 *
 * ⚠️ **Le differenze AMMESSE rispetto alla rilettura dei modelli** — campi che
 * Fatture in Cloud calcola o scrive da se' e che noi NON mandiamo:
 * `amount_net`, `amount_vat`, `amount_gross`, `net_price` sulle righe, `id`,
 * `number`, `year`, `currency`, `entity.entity_type`, `vat.value`,
 * `vat.description`, `payment_account.name`, `ei_raw` (il TD01 lo deriva dal
 * tipo), `ei_status`, `locked`, `rc_center`, `stamp_duty` e la fila di
 * `amount_*` a zero. Su questi il test non pretende niente: li controlla la
 * RILETTURA, non la costruzione.
 */
import { describe, it, expect } from 'vitest'

import {
  costruisciPayloadFatturaOspite,
  leggiDatiFatturaOspite,
  type IdFic,
} from './fic-fattura-ospite'
import { validaCodiceFiscale } from './checkin/valida-codice-fiscale'

/**
 * Gli id LETTI NEI MODELLI. Nel tool arrivano da `risolviIdFic`, che li
 * interroga su Fatture in Cloud; qui si passano a mano perche' cio' che si sta
 * provando e' il DOCUMENTO, non la lettura.
 */
const IDS: IdFic = {
  aliquota10: 3,
  naturaArt15: 15819187,
  contoBanca: 1570742,
  contoContanti: 1565608,
  avvisi: [],
}

/** Persona inventata, codice fiscale formalmente valido. */
const CF_FINTO = 'VRDGPP85R41F205N'

const INGRESSO_ITALIANO = {
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
    codice_fiscale: CF_FINTO,
    indirizzo: 'VIA DELLE PROVE, 1',
    cap: '20121',
    citta: 'MILANO',
    provincia: 'MI',
    paese: 'Italia',
    codice_destinatario: '0000000',
  },
  cliente_id: 900001,
  imposta_soggiorno: { importo: 13.5, persone: 3, notti: 3, tariffa: 1.5 },
}

const INGRESSO_ESTERO = {
  unita: 'Blue Maison 1',
  indirizzo_unita: 'Via Fiumicello, Maratea (PZ)',
  check_in: '2027-08-04',
  check_out: '2027-08-07',
  prenotazione: '7100000002',
  prezzo: 582.12,
  adulti: 2,
  bambini: 2,
  data: '2027-09-15',
  ospite: {
    nome: 'DUPONT MICHEL',
    indirizzo: '12 RUE DES ESSAIS',
    citta: 'PARIS 75008',
    paese: 'Francia',
  },
  cliente_id: 900002,
  imposta_soggiorno: { importo: 18, persone: 4, notti: 3, tariffa: 1.5 },
}

function costruisci(ingresso: Record<string, unknown>) {
  const letto = leggiDatiFatturaOspite(ingresso)
  if (!letto.ok) throw new Error(`i dati del modello non si leggono: ${letto.error}`)
  return costruisciPayloadFatturaOspite(letto.dati, IDS)
}

describe('il modello ITALIANO — fattura 20/2026', () => {
  const p = costruisci(INGRESSO_ITALIANO)

  it('il codice fiscale del fixture e\' davvero valido (se no, il test non prova niente)', () => {
    expect(validaCodiceFiscale(CF_FINTO).valido).toBe(true)
  })

  it('la testata rispecchia il documento vero', () => {
    expect(p.type).toBe('invoice')
    expect(p.date).toBe('2027-09-15')
    expect(p.e_invoice).toBe(true)
    // ✅ Dubbio chiuso dal modello completo: `use_gross_prices` c'e' davvero.
    expect(p.use_gross_prices).toBe(true)
    // 🚨 Trappola 3: numerazione Principale = stringa VUOTA.
    expect(p.numeration).toBe('')
    // 🚨 Sul modello `subject` e' vuoto e il testo sta in `visible_subject`.
    expect(p.subject).toBe('')
    expect(p.visible_subject).toBe(
      'Soggiorno Blue Maison 1 dal 19/08/2027 al 22/08/2027 - prenotazione Booking.com n. 7100000001',
    )
  })

  it('🚨 il metodo di pagamento sta SOLO in ei_data: a livello di documento non si scrive', () => {
    // Trappola 1: sul modello `payment_method` e' `{id: null, name: ""}`, cioe'
    // VUOTO. La specifica diceva di riempirlo: vince il modello.
    expect(p.payment_method).toBeUndefined()
    expect(p.ei_data).toEqual({ payment_method: 'MP05' })
  })

  it('🚨 revenue_detect e\' TRUE: una fattura al cliente e\' un ricavo', () => {
    // Trappola 2: sull'integrazione TD17 vale `false`. Qui no.
    expect(p.extra_data).toEqual({ debt_vat_detect: true, revenue_detect: true })
  })

  it('l\'anagrafica italiana porta il codice fiscale e il codice destinatario', () => {
    expect(p.entity).toEqual({
      id: 900001,
      name: 'VERDI GIUSEPPINA',
      tax_code: CF_FINTO,
      address_street: 'VIA DELLE PROVE, 1',
      address_postal_code: '20121',
      address_city: 'MILANO',
      address_province: 'MI',
      country: 'Italia',
      ei_code: '0000000',
    })
  })

  it('le note rispecchiano quelle del documento vero', () => {
    expect(p.notes).toBe(
      'Importo incassato tramite Booking.com (Pagamenti tramite Booking.com) - prenotazione n. 7100000001. '
      + 'Prestazione di alloggio in struttura ricettiva extralberghiera, IVA 10% inclusa nel prezzo. '
      + 'Imposta di soggiorno riscossa in contanti in struttura e riversata al Comune di Maratea '
      + '(esclusa art. 15 DPR 633/72).',
    )
  })

  it('riga 1 — il soggiorno, al LORDO e con l\'aliquota 10%', () => {
    const righe = p.items_list as Record<string, unknown>[]
    expect(righe[0]).toEqual({
      name: 'Soggiorno Blue Maison 1 dal 19/08/2027 al 22/08/2027',
      qty: 1,
      vat: { id: 3 },
      description:
        'Servizio di alloggio in casa vacanze Blue Maison 1, Via Fiumicello, Maratea (PZ) - '
        + '3 notti, 3 ospiti (2 adulti, 1 bambino) - prenotazione Booking.com n. 7100000001. '
        + 'Pulizia finale inclusa. Imposta di soggiorno esclusa.',
      gross_price: 516.3,
    })
  })

  it('riga 2 — l\'imposta di soggiorno, natura art. 15 e fuori base imponibile', () => {
    const righe = p.items_list as Record<string, unknown>[]
    expect(righe).toHaveLength(2)
    expect(righe[1]).toEqual({
      name: 'Imposta di soggiorno Comune di Maratea',
      qty: 1,
      vat: { id: 15819187 },
      description:
        'Imposta di soggiorno riscossa in struttura per conto del Comune di Maratea: '
        + '3 persone x 3 notti x 1,50 euro - prenotazione Booking.com n. 7100000001. '
        + 'Somma esclusa dalla base imponibile IVA ai sensi dell\'art. 15 c.1 n. 3 DPR 633/72.',
      gross_price: 13.5,
      not_taxable: true,
    })
  })

  it('i due pagamenti: il prezzo al check-out in banca, l\'imposta al check-in in contanti', () => {
    expect(p.payments_list).toEqual([
      { amount: 516.3, due_date: '2027-09-15', paid_date: '2027-08-22', status: 'paid', payment_account: { id: 1570742 } },
      { amount: 13.5, due_date: '2027-09-15', paid_date: '2027-08-19', status: 'paid', payment_account: { id: 1565608 } },
    ])
  })

  it('i pagamenti sommano il totale del documento (prezzo + imposta)', () => {
    const somma = (p.payments_list as Record<string, unknown>[])
      .reduce((t, v) => t + Number(v.amount), 0)
    expect(Math.round(somma * 100) / 100).toBe(529.8)
  })
})

describe('il modello ESTERO — fattura 3/2026, cliente francese', () => {
  const p = costruisci(INGRESSO_ESTERO)

  it('🚨 tax_code NON c\'e\' proprio: non e\' la stringa vuota, e\' la chiave assente', () => {
    const entity = p.entity as Record<string, unknown>
    // Spedire `tax_code: ""` a Fatture in Cloud non e' «lascia stare»: e'
    // «cancella quello che c'e'».
    expect('tax_code' in entity).toBe(false)
  })

  it('l\'anagrafica estera: CAP 00000, provincia EE, nazione per esteso, ei_code XXXXXXX', () => {
    expect(p.entity).toEqual({
      id: 900002,
      name: 'DUPONT MICHEL',
      address_street: '12 RUE DES ESSAIS',
      address_postal_code: '00000',
      address_city: 'PARIS 75008',
      address_province: 'EE',
      country: 'Francia',
      ei_code: 'XXXXXXX',
    })
  })

  it('🚨 nessun campo della LINGUA: nei due modelli non esiste, e non si inventa', () => {
    // La specifica chiedeva «lingua italiana anche per gli stranieri». In
    // NESSUNO dei due documenti veri compare un campo della lingua: se e' un
    // attributo dell'anagrafica si vedra' leggendo un'anagrafica, non qui.
    const chiavi = Object.keys(p).concat(Object.keys(p.entity as Record<string, unknown>))
    expect(chiavi.filter((k) => /lang|lingua|locale/i.test(k))).toEqual([])
  })

  it('il resto e\' IDENTICO al caso italiano: stessa aliquota, stesse trappole', () => {
    expect(p.type).toBe('invoice')
    expect(p.e_invoice).toBe(true)
    expect(p.use_gross_prices).toBe(true)
    expect(p.numeration).toBe('')
    expect(p.subject).toBe('')
    expect(p.payment_method).toBeUndefined()
    expect(p.ei_data).toEqual({ payment_method: 'MP05' })
    expect(p.extra_data).toEqual({ debt_vat_detect: true, revenue_detect: true })
    expect(p.visible_subject).toBe(
      'Soggiorno Blue Maison 1 dal 04/08/2027 al 07/08/2027 - prenotazione Booking.com n. 7100000002',
    )
  })

  it('le righe rispecchiano il documento francese (4 ospiti: 2 adulti, 2 bambini)', () => {
    const righe = p.items_list as Record<string, unknown>[]
    expect(righe[0]).toEqual({
      name: 'Soggiorno Blue Maison 1 dal 04/08/2027 al 07/08/2027',
      qty: 1,
      vat: { id: 3 },
      description:
        'Servizio di alloggio in casa vacanze Blue Maison 1, Via Fiumicello, Maratea (PZ) - '
        + '3 notti, 4 ospiti (2 adulti, 2 bambini) - prenotazione Booking.com n. 7100000002. '
        + 'Pulizia finale inclusa. Imposta di soggiorno esclusa.',
      gross_price: 582.12,
    })
    expect(righe[1]).toMatchObject({
      name: 'Imposta di soggiorno Comune di Maratea',
      vat: { id: 15819187 },
      gross_price: 18,
      not_taxable: true,
    })
    expect(righe[1].description).toBe(
      'Imposta di soggiorno riscossa in struttura per conto del Comune di Maratea: '
      + '4 persone x 3 notti x 1,50 euro - prenotazione Booking.com n. 7100000002. '
      + 'Somma esclusa dalla base imponibile IVA ai sensi dell\'art. 15 c.1 n. 3 DPR 633/72.',
    )
  })

  it('i pagamenti sommano 600,12 come sul documento vero', () => {
    const somma = (p.payments_list as Record<string, unknown>[])
      .reduce((t, v) => t + Number(v.amount), 0)
    expect(Math.round(somma * 100) / 100).toBe(600.12)
  })

  it('l\'imponibile atteso dalla rilettura e\' il lordo scorporato al 10%', () => {
    // Non lo scriviamo noi — lo calcola FIC — ma e' il numero che la rilettura
    // dovra' confermare: 582,12 / 1,1 = 529,20, come sul documento vero.
    expect(Math.round((582.12 / 1.1) * 100) / 100).toBe(529.2)
  })
})

describe('le parole del documento: singolare e plurale', () => {
  it('«1 notte», «1 ospite», «1 persona» — non «1 notti»', () => {
    const p = costruisci({
      ...INGRESSO_ITALIANO,
      check_in: '2027-08-19',
      check_out: '2027-08-20',
      adulti: 1,
      bambini: 0,
      imposta_soggiorno: { importo: 1.5, persone: 1, notti: 1, tariffa: 1.5 },
    })
    const righe = p.items_list as Record<string, unknown>[]
    expect(righe[0].description).toContain('1 notte, 1 ospite (1 adulto)')
    expect(righe[1].description).toContain('1 persona x 1 notte x 1,50 euro')
  })

  it('CONTROLLO POSITIVO: al plurale le stesse frasi cambiano davvero', () => {
    const righe = costruisci(INGRESSO_ITALIANO).items_list as Record<string, unknown>[]
    expect(righe[0].description).toContain('3 notti, 3 ospiti (2 adulti, 1 bambino)')
    expect(righe[1].description).toContain('3 persone x 3 notti x 1,50 euro')
  })
})
