/**
 * src/lib/fic-anagrafica.aggiorna.test.ts — CORREGGERE una scheda anagrafica.
 *
 * ⚠️ **Il difetto che questo tool chiude**, 15 settembre 2026. Cervellone
 * sapeva creare un'anagrafica e cercarla, non modificarla. Davanti a una scheda
 * sbagliata l'unica strada era crearne un'altra: fabbricare un DOPPIONE, cioe'
 * il difetto che `fic-anagrafica.ts` esiste per impedire.
 *
 * ⚠️ **E i due difetti che potrebbe INTRODURRE, che sono peggio.**
 *  1. **Cancellare per distrazione.** Se il PUT di Fatture in Cloud fosse una
 *     sostituzione integrale (la documentazione NON lo dichiara), mandare solo
 *     i campi cambiati azzererebbe tutto il resto della scheda. Per questo qui
 *     si guarda il CORPO SPEDITO, non solo l'esito.
 *  2. **Riscrivere la scheda sbagliata.** Senza id ed elenco espliciti si
 *     modifica «il primo che capita» — e su un'anagrafica con doppioni il primo
 *     che capita e' quasi sempre quello morto. Per questo qui si guardano i
 *     PERCORSI CHIAMATI.
 *
 * Corpo spedito e percorsi chiamati: sono le due cose che possono sbagliare, e
 * sono le due cose che questi test guardano.
 *
 * Nessuna chiamata vera a Fatture in Cloud: l'I/O e' finto, la logica e' quella
 * VERA. I dati sono di Booking.com B.V., che e' un'azienda pubblica.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type Scheda = Record<string, unknown>

const stato = {
  /** Ogni percorso chiamato, con il verbo: la prova di DOVE si e' scritto. */
  percorsi: [] as string[],
  /** Le risposte delle GET, in ordine: la prima lettura, poi la rilettura. */
  letture: [] as Array<Scheda | { errore: string }>,
  /** Il corpo dell'ultima PUT. `null` = non e' stato scritto NIENTE. */
  corpoPut: null as Scheda | null,
  /** Se valorizzato, la PUT fallisce con questo errore (com'e', verbatim). */
  errorePut: null as string | null,
}

vi.mock('./fatture-in-cloud', () => ({
  getCompanyId: async () => ({ ok: true as const, id: 42 }),
  ficGet: async (path: string) => {
    stato.percorsi.push(`GET ${path}`)
    const r = stato.letture.shift()
    if (r === undefined) return { ok: false as const, error: 'Errore FIC 404: {"error":{"message":"not found"}}' }
    if ('errore' in r && typeof r.errore === 'string') return { ok: false as const, error: r.errore }
    return { ok: true as const, data: { data: r } }
  },
  ficPost: async () => ({ ok: true as const, data: { data: { id: 1, name: 'nuovo' } } }),
  ficPut: async (path: string, body: Scheda) => {
    stato.percorsi.push(`PUT ${path}`)
    stato.corpoPut = body
    if (stato.errorePut) return { ok: false as const, error: stato.errorePut }
    return { ok: true as const, data: { data: { id: 77 } } }
  },
}))

import { executeAnagraficaTool, ANAGRAFICA_TOOLS } from './fic-anagrafica'

/** La scheda com'e' su Fatture in Cloud prima della correzione. */
const BOOKING: Scheda = {
  id: 77,
  name: 'Booking.com B.V.',
  type: 'company',
  vat_number: 'NL805734958B01',
  tax_code: '',
  address_street: 'Oosterdokskade 163',
  address_postal_code: '1011 DL',
  address_city: 'Amsterdaam',
  address_province: '',
  country: 'Netherlands',
  country_iso: 'NL',
  email: 'partner@example.invalid',
  ei_code: '',
  created_at: '2026-01-02 10:00:00',
  updated_at: '2026-01-02 10:00:00',
}

/** La scheda «prima» e la «dopo», dove la dopo ha applicato `mod`. */
function conRilettura(prima: Scheda, mod: Scheda) {
  stato.letture = [{ ...prima }, { ...prima, ...mod, updated_at: '2026-09-15 08:00:00' }]
}

const chiama = async (input: Record<string, unknown>) =>
  JSON.parse((await executeAnagraficaTool('fic_aggiorna_anagrafica', input, 'larealestate'))!)

const BASE = { id: 77, elenco: 'fornitore' as const }

beforeEach(() => {
  stato.percorsi = []
  stato.letture = []
  stato.corpoPut = null
  stato.errorePut = null
})

describe('🚨 un campo non passato non si tocca, e un campo vuoto non cancella', () => {
  it('cambia SOLO il campo chiesto: nel corpo spedito tutti gli altri ci sono ancora, col valore di prima', async () => {
    conRilettura(BOOKING, { address_city: 'Amsterdam' })

    const r = await chiama({ ...BASE, citta: 'Amsterdam' })

    expect(r.ok).toBe(true)
    expect(r.modificato).toBe(true)
    // 🚨 LA PROVA VERA: il corpo spedito. Se il PUT fosse una sostituzione
    // integrale, un corpo con la sola citta' azzererebbe indirizzo, email,
    // partita IVA: una cancellazione silenziosa travestita da correzione.
    expect(stato.corpoPut).not.toBeNull()
    expect(stato.corpoPut!.address_city).toBe('Amsterdam')
    expect(stato.corpoPut!.address_street).toBe('Oosterdokskade 163')
    expect(stato.corpoPut!.email).toBe('partner@example.invalid')
    expect(stato.corpoPut!.vat_number).toBe('NL805734958B01')
    expect(stato.corpoPut!.name).toBe('Booking.com B.V.')
    // L'id sta nell'URL e le date le gestisce il server: non si rispediscono.
    expect(stato.corpoPut).not.toHaveProperty('id')
    expect(stato.corpoPut).not.toHaveProperty('created_at')
  })

  it('🚨 una stringa VUOTA non cancella: il campo resta com era e il tool lo DICHIARA', async () => {
    conRilettura(BOOKING, { address_city: 'Amsterdam' })

    const r = await chiama({ ...BASE, citta: 'Amsterdam', cap: '', email: '   ' })

    // Il CAP e la mail spediti sono quelli di prima, non vuoti.
    expect(stato.corpoPut!.address_postal_code).toBe('1011 DL')
    expect(stato.corpoPut!.email).toBe('partner@example.invalid')
    // E non lo fa in silenzio: chi ha scritto '' credendo di cancellare deve
    // sapere che non e' successo, altrimenti torna e lo rifa'.
    expect(r.campi_ignorati_perche_vuoti).toEqual(['cap', 'email'])
    expect(JSON.stringify(r)).toMatch(/non vuol dire/)
  })

  it('un campo passato UGUALE a com e non fa scrivere niente', async () => {
    stato.letture = [{ ...BOOKING }]

    const r = await chiama({ ...BASE, citta: 'Amsterdaam' })

    expect(stato.corpoPut).toBeNull()
    expect(r.modificato).toBe(false)
    expect(r.motivo).toMatch(/gia/)
  })

  it('senza nessun campo da cambiare NON manda un PUT a vuoto', async () => {
    stato.letture = [{ ...BOOKING }]

    const r = await chiama({ ...BASE })

    expect(stato.corpoPut).toBeNull()
    expect(r.ok).toBe(false)
    expect(r.modificato).toBe(false)
  })
})

describe('🚨 l elenco sbagliato non viene toccato', () => {
  it('con elenco «fornitore» ogni chiamata va su entities/suppliers', async () => {
    conRilettura(BOOKING, { address_city: 'Amsterdam' })

    await chiama({ ...BASE, citta: 'Amsterdam' })

    expect(stato.percorsi.length).toBe(3) // lettura, scrittura, rilettura
    expect(stato.percorsi.every((p) => p.includes('/entities/suppliers/77'))).toBe(true)
    expect(stato.percorsi.some((p) => p.includes('/entities/clients'))).toBe(false)
  })

  it('CONTROLLO POSITIVO: con elenco «cliente» va tutto sui CLIENTI', async () => {
    // Senza questo, cablare `suppliers` passerebbe il test qui sopra e
    // manderebbe ogni correzione di un ospite nell'elenco sbagliato.
    conRilettura({ ...BOOKING, name: 'Maria Nunez', type: 'person' }, { address_city: 'Maratea' })

    const r = await chiama({ id: 77, elenco: 'cliente', citta: 'Maratea' })

    expect(r.ok).toBe(true)
    expect(stato.percorsi.every((p) => p.includes('/entities/clients/77'))).toBe(true)
    expect(stato.percorsi.some((p) => p.includes('/entities/suppliers'))).toBe(false)
  })

  it('senza ELENCO rifiuta e non legge nemmeno: non si indovina cliente o fornitore', async () => {
    const r = await chiama({ id: 77, citta: 'Amsterdam' })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/elenco/)
    expect(stato.percorsi).toEqual([])
  })

  it('senza ID rifiuta e manda a fic_cerca_anagrafica', async () => {
    const r = await chiama({ elenco: 'fornitore', nome: 'Booking.com B.V.', citta: 'Amsterdam' })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/id/)
    expect(r.cosa_faccio_adesso).toMatch(/fic_cerca_anagrafica/)
    expect(stato.percorsi).toEqual([])
    expect(stato.corpoPut).toBeNull()
  })

  it('CONTROLLO POSITIVO: con id ed elenco la modifica passa', async () => {
    // Senza questo, un tool che rifiuta SEMPRE supererebbe i due test qui
    // sopra e nessuno se ne accorgerebbe.
    conRilettura(BOOKING, { address_city: 'Amsterdam' })

    const r = await chiama({ ...BASE, citta: 'Amsterdam' })

    expect(r.ok).toBe(true)
    expect(r.modifiche).toEqual([{ campo: 'citta', prima: 'Amsterdaam', dopo: 'Amsterdam' }])
  })
})

describe('🚨 l esito viene dalla RILETTURA, non dalla risposta della PUT', () => {
  it('se la rilettura NON conferma la modifica, lo dichiara invece di dire «fatto»', async () => {
    // La PUT risponde ok, ma la scheda riletta e' rimasta com'era: e' il caso
    // in cui un tool ingenuo dice «fatto» e nessuno va a controllare.
    stato.letture = [{ ...BOOKING }, { ...BOOKING }]

    const r = await chiama({ ...BASE, citta: 'Amsterdam' })

    expect(r.ok).toBe(false)
    expect(r.non_confermate).toEqual([
      { campo: 'citta', prima: 'Amsterdaam', chiesto: 'Amsterdam', riletto: 'Amsterdaam' },
    ])
    expect(r.error).toMatch(/NON dire che e' fatto/)
  })

  it('il PRIMA e il DOPO sono i valori VERI riletti, non quelli chiesti', async () => {
    // FIC normalizza: chiedo «  Amsterdam  », lui salva «Amsterdam». Il
    // rapporto deve dire cosa c'e' scritto sul gestionale.
    conRilettura(BOOKING, { address_city: 'Amsterdam' })

    const r = await chiama({ ...BASE, citta: 'Amsterdam' })

    expect(r.modifiche[0].prima).toBe('Amsterdaam')
    expect(r.modifiche[0].dopo).toBe('Amsterdam')
  })

  it('se la rilettura non riesce, non dice ne si ne no: dice che non lo sa', async () => {
    stato.letture = [{ ...BOOKING }, { errore: 'Errore FIC 500: {"error":{"message":"boom"}}' }]

    const r = await chiama({ ...BASE, citta: 'Amsterdam' })

    expect(r.ok).toBe(false)
    expect(r.modificato).toBeNull()
    expect(r.error).toMatch(/500/)
  })

  it('🚨 una CHIAVE FISCALE che si muove senza che gliel abbia chiesto e un esito NEGATIVO', async () => {
    // Non e' un'avvertenza: e' il danno che la guardia dell'identita' impedisce,
    // entrato da un'altra porta (un PUT che sostituisce, un campo derivato).
    conRilettura(BOOKING, { address_city: 'Amsterdam', vat_number: 'NL999999999B99' })

    const r = await chiama({ ...BASE, citta: 'Amsterdam' })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/CHIAVE FISCALE/)
    expect(r.error).toMatch(/vat_number/)
  })

  it('CONTROLLO POSITIVO: un campo DERIVATO che segue quello chiesto non fa gridare al lupo', async () => {
    // Cambiando `country` Fatture in Cloud aggiorna `country_iso` da solo.
    // Una guardia che segnalasse anche quello bloccherebbe il caso normale.
    conRilettura(BOOKING, { country: 'Italia', country_iso: 'IT' })

    const r = await chiama({ ...BASE, paese: 'Italia' })

    expect(r.ok).toBe(true)
    expect(r.avvertenze).toBeUndefined()
  })
})

describe('🚨 partita IVA e codice fiscale: le chiavi con cui si riconosce un soggetto', () => {
  it('cambiare una P.IVA gia presente e DIVERSA: si FERMA, non scrive, e dice nome vecchio e valori', async () => {
    stato.letture = [{ ...BOOKING }]

    const r = await chiama({ ...BASE, partita_iva: 'NL111111111B11' })

    expect(r.ok).toBe(false)
    expect(stato.corpoPut).toBeNull() // la prova che conta: NIENTE e' stato scritto
    expect(r.scheda.nome).toBe('Booking.com B.V.')
    expect(r.cambi_richiesti).toEqual([
      { campo: 'partita_iva', valore_attuale: 'NL805734958B01', valore_nuovo: 'NL111111111B11' },
    ])
    expect(r.cosa_faccio_adesso).toMatch(/CHIEDI/)
  })

  it('vale anche per il CODICE FISCALE', async () => {
    stato.letture = [{ ...BOOKING, tax_code: 'NL805734958B01' }]

    const r = await chiama({ ...BASE, codice_fiscale: 'XX000000000X00' })

    expect(r.ok).toBe(false)
    expect(stato.corpoPut).toBeNull()
    expect(r.cambi_richiesti[0].campo).toBe('codice_fiscale')
  })

  it('CONTROLLO POSITIVO: RIEMPIRE una chiave fiscale VUOTA non chiede nessuna conferma', async () => {
    // E' il caso normale di una scheda incompleta — meta' del motivo per cui
    // questo tool esiste. Una guardia che bloccasse anche questo sarebbe
    // peggio del buco che chiude.
    conRilettura(BOOKING, { tax_code: 'RSSMRA80A01H501U' })

    const r = await chiama({ ...BASE, codice_fiscale: 'RSSMRA80A01H501U' })

    expect(r.ok).toBe(true)
    expect(r.modifiche).toEqual([{ campo: 'codice_fiscale', prima: '', dopo: 'RSSMRA80A01H501U' }])
  })

  it('CONTROLLO POSITIVO: la stessa P.IVA scritta con spazi o minuscole NON e un cambio', async () => {
    stato.letture = [{ ...BOOKING }]

    const r = await chiama({ ...BASE, partita_iva: 'nl 805734958 b01' })

    expect(stato.corpoPut).toBeNull()
    expect(r.modificato).toBe(false)
    expect(r.motivo).toMatch(/gia/)
  })

  it('CONTROLLO POSITIVO: correggere un CAP non chiede nessuna conferma', async () => {
    conRilettura(BOOKING, { address_postal_code: '1011 DK' })

    const r = await chiama({ ...BASE, cap: '1011 DK' })

    expect(r.ok).toBe(true)
    expect(r.modificato).toBe(true)
  })

  it('con conferma_cambio_identita il cambio si fa — e l esito lo DICE forte', async () => {
    conRilettura(BOOKING, { vat_number: 'NL111111111B11' })

    const r = await chiama({ ...BASE, partita_iva: 'NL111111111B11', conferma_cambio_identita: true })

    expect(r.ok).toBe(true)
    expect(stato.corpoPut!.vat_number).toBe('NL111111111B11')
    expect(r.avvertenze.join(' ')).toMatch(/CHIAVE FISCALE/)
    expect(r.avvertenze.join(' ')).toMatch(/NL805734958B01/)
    expect(r.avvertenze.join(' ')).toMatch(/NL111111111B11/)
  })
})

describe('🚨 se Fatture in Cloud risponde male, si dice COM HA RISPOSTO', () => {
  it('il 403 arriva con lo stato e il testo veri, senza spiegazioni inventate', async () => {
    // La notte del 14 set La Real Estate ha dato «403 No permission» a raffica
    // e il bot ha inventato due spiegazioni diverse, entrambe sbagliate.
    conRilettura(BOOKING, {})
    stato.errorePut = 'Errore FIC 403: {"error":{"message":"No permission"}}'

    const r = await chiama({ ...BASE, citta: 'Amsterdam' })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/403/)
    expect(r.error).toMatch(/No permission/)
    expect(r.cosa_faccio_adesso).toMatch(/COM'E'/)
  })

  it('un 404 in lettura riporta l errore vero E dice che l id non e in quell elenco', async () => {
    stato.letture = [{ errore: 'Errore FIC 404: {"error":{"message":"Entity not found"}}' }]

    const r = await chiama({ ...BASE, citta: 'Amsterdam' })

    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/404/)
    expect(r.error).toMatch(/Entity not found/)
    expect(r.error).toMatch(/FORNITORI/)
    expect(stato.corpoPut).toBeNull()
  })
})

describe('il tool DICHIARA cosa sa e cosa NON sa fare', () => {
  // Una capacita' che non e' nello schema, per il modello NON ESISTE — ed e'
  // lo stesso difetto che ha tenuto nascosto per mesi il download degli
  // allegati Gmail.
  const tool = ANAGRAFICA_TOOLS.find((t) => t.name === 'fic_aggiorna_anagrafica')!

  it('e registrato in ANAGRAFICA_TOOLS', () => {
    expect(tool).toBeDefined()
  })

  it('id ed elenco sono OBBLIGATORI nello schema', () => {
    const s = tool.input_schema as { required: string[]; properties: Record<string, { enum?: string[] }> }
    expect(s.required).toEqual(['id', 'elenco'])
    expect(s.properties.elenco.enum).toEqual(['cliente', 'fornitore'])
  })

  it('la descrizione dice che NON cancella e che vuole l id', () => {
    expect(tool.description).toMatch(/NON CANCELLA NIENTE/)
    expect(tool.description).toMatch(/fic_cerca_anagrafica/)
    expect(tool.description).toMatch(/DOPPIONE/)
  })

  it('CONTROLLO POSITIVO: fic_crea_cliente e ancora li e ancora suo', async () => {
    // Il dispatch e' una catena di `if`: sbagliarne l'ordine spegnerebbe la
    // creazione senza che nessun test della modifica se ne accorga.
    expect(ANAGRAFICA_TOOLS.find((t) => t.name === 'fic_crea_cliente')).toBeDefined()
    expect(await executeAnagraficaTool('fic_tool_che_non_esiste', {}, 'larealestate')).toBeNull()
  })
})
