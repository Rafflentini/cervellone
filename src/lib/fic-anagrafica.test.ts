/**
 * src/lib/fic-anagrafica.test.ts — creare un cliente su Fatture in Cloud.
 *
 * ⚠️ **Il difetto che questo tool chiude.** Fino al 13 set 2026 il bot NON
 * sapeva creare un'anagrafica: in tutto il codice c'era una sola chiamata a
 * `entities/clients`, ed era una **lettura**. Per La Real Estate è il caso
 * normale — affitti brevi, quasi ogni ospite è nuovo.
 *
 * ⚠️ **E il difetto che questo tool potrebbe INTRODURRE, che è peggio.** Su un
 * via-vai di ospiti l'errore che si accumula non è il nome scritto male: è lo
 * stesso ospite inserito **due volte**. Un'anagrafica piena di doppioni non si
 * accorge di esserlo, e il giorno che si cercano le fatture di qualcuno se ne
 * trovano metà. Per questo qui i test sulla guardia anti-doppione sono più di
 * quelli sulla creazione.
 *
 * Nessuna chiamata vera a Fatture in Cloud: l'I/O è finto, la logica è quella
 * VERA.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stato = {
  /** Le risposte di ricerca, per query: cosa «c'è già» in anagrafica. */
  risposte: [] as Array<Record<string, unknown>[]>,
  /** Le query effettivamente inviate, per verificare che si cerchi su due chiavi. */
  queryViste: [] as string[],
  /** Il corpo dell'ultima POST: `null` = non è stato creato niente. */
  creato: null as Record<string, unknown> | null,
  rispostaCreazione: { id: 999, name: 'nuovo' } as Record<string, unknown> | undefined,
}

vi.mock('./fatture-in-cloud', () => ({
  getCompanyId: async () => ({ ok: true as const, id: 42 }),
  ficGet: async (_path: string, query?: Record<string, unknown>) => {
    if (query?.q) stato.queryViste.push(String(query.q))
    return { ok: true as const, data: { data: stato.risposte.shift() ?? [] } }
  },
  ficPost: async (_path: string, body: Record<string, unknown>) => {
    stato.creato = body
    return { ok: true as const, data: { data: stato.rispostaCreazione } }
  },
}))

import { executeAnagraficaTool, nomeNormalizzato, ANAGRAFICA_TOOLS } from './fic-anagrafica'

const chiama = async (input: Record<string, unknown>) =>
  JSON.parse((await executeAnagraficaTool('fic_crea_cliente', input, 'larealestate'))!)

beforeEach(() => {
  stato.risposte = []
  stato.queryViste = []
  stato.creato = null
  stato.rispostaCreazione = { id: 999, name: 'nuovo' }
})

describe('🚨 la guardia anti-doppione: il rischio vero degli affitti brevi', () => {
  it('se il CODICE FISCALE combacia NON crea, e restituisce chi c e gia', async () => {
    stato.risposte = [[{ id: 7, name: 'Mario Rossi', tax_code: 'RSSMRA80A01H501U' }]]
    const r = await chiama({ nome: 'Rossi Mario', codice_fiscale: 'rssmra80a01h501u' })
    expect(r.ok).toBe(true)
    expect(r.creato).toBe(false)
    expect(r.cliente_id).toBe(7)
    // La prova che conta: NESSUNA scrittura.
    expect(stato.creato).toBeNull()
  })

  it('⭐ se il NOME combacia NON crea, anche senza codice fiscale', async () => {
    // Il caso degli ospiti stranieri: spesso il CF non c'e', e allora il nome
    // e' l'unica difesa. Cercare solo per CF li lascerebbe passare tutti due
    // volte.
    stato.risposte = [[{ id: 11, name: 'Maria Nuñez' }]]
    const r = await chiama({ nome: 'maria nunez' })
    expect(r.creato).toBe(false)
    expect(r.cliente_id).toBe(11)
    expect(stato.creato).toBeNull()
  })

  it('CONTROLLO POSITIVO — se non c e nessuno, CREA davvero', async () => {
    // Senza questo, tutti i test sopra passerebbero anche se il tool non
    // creasse mai niente.
    stato.risposte = [[]]
    const r = await chiama({ nome: 'Ospite Nuovo', citta: 'Maratea' })
    expect(r.ok).toBe(true)
    expect(r.creato).toBe(true)
    expect(r.cliente_id).toBe(999)
    expect(stato.creato).toMatchObject({ name: 'Ospite Nuovo', type: 'person', address_city: 'Maratea' })
  })

  it('cerca su DUE chiavi indipendenti: la fiscale e il nome', async () => {
    // Il cavo, non solo la spina: se cercasse su una sola, la meta' dei
    // doppioni passerebbe. E il difetto non si vedrebbe dal risultato.
    stato.risposte = [[], []]
    await chiama({ nome: 'Mario Rossi', codice_fiscale: 'RSSMRA80A01H501U' })
    expect(stato.queryViste.some((q) => q.includes('tax_code'))).toBe(true)
    expect(stato.queryViste.some((q) => q.includes('name contains'))).toBe(true)
  })

  it('se ce ne sono DUE che combaciano, lo DICE e non sceglie da solo', async () => {
    stato.risposte = [[{ id: 3, name: 'Mario Rossi' }, { id: 4, name: 'Mario Rossi' }]]
    const r = await chiama({ nome: 'Mario Rossi', codice_fiscale: 'RSSMRA80A01H501U' })
    expect(r.clienti).toHaveLength(2)
    expect(r.cosa_faccio_adesso).toMatch(/CHIEDI all'Ingegnere/i)
  })
})

describe('il confronto dei nomi: quando due scritture sono la stessa persona', () => {
  it('accenti, maiuscole, punteggiatura e spazi non fanno due persone', () => {
    expect(nomeNormalizzato('Sig. Mario  ROSSI')).toBe('sig mario rossi')
    expect(nomeNormalizzato('Maria Nuñez')).toBe('maria nunez')
    expect(nomeNormalizzato("D'Angelo, Luca")).toBe('d angelo luca')
  })

  it('CONTROLLO POSITIVO — due persone diverse restano diverse', () => {
    // Senza, una normalizzazione troppo aggressiva farebbe collassare nomi
    // distinti, e il tool RIFIUTEREBBE di creare clienti veri — un difetto
    // silenzioso nella direzione opposta.
    expect(nomeNormalizzato('Mario Rossi')).not.toBe(nomeNormalizzato('Marco Rossi'))
    expect(nomeNormalizzato('Rossi Mario')).not.toBe(nomeNormalizzato('Mario Rossi'))
  })
})

describe('quello che non si sa, non si dichiara', () => {
  it("se FIC risponde senza id NON dice «creato»", async () => {
    // Il cliente potrebbe esserci davvero: dirlo con un id inventato manderebbe
    // la fattura sull'anagrafica sbagliata. Meglio dichiarare l'incertezza.
    stato.risposte = [[]]
    stato.rispostaCreazione = { name: 'senza id' }
    const r = await chiama({ nome: 'Ospite Nuovo' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/non so se il cliente sia stato creato/i)
  })

  it('un privato e «person», un azienda e «company»', async () => {
    stato.risposte = [[]]
    await chiama({ nome: 'Ditta Tal dei Tali Srl', tipo: 'azienda', partita_iva: '02087420762' })
    expect(stato.creato).toMatchObject({ type: 'company', vat_number: '02087420762' })
  })

  it('i campi vuoti NON vengono spediti: un indirizzo vuoto non e un indirizzo', async () => {
    stato.risposte = [[]]
    await chiama({ nome: 'Ospite', indirizzo: '   ', citta: '' })
    expect(stato.creato).not.toHaveProperty('address_street')
    expect(stato.creato).not.toHaveProperty('address_city')
  })
})

describe('la descrizione dice al modello quello che deve sapere', () => {
  it('spiega che NON crea doppioni e cosa fare con l id', () => {
    const d = ANAGRAFICA_TOOLS[0].description
    expect(d).toMatch(/NON crea doppioni/)
    expect(d).toMatch(/cliente_id/)
    expect(d).toMatch(/compila_fattura_emessa/)
  })

  it("dice di NON inventare il codice destinatario", () => {
    // «Un segnaposto non e' una dichiarazione»: il 9 set 2026 il bot ha messo
    // valori "ragionevoli" in una pratica INPS.
    const d = JSON.stringify(ANAGRAFICA_TOOLS[0].input_schema)
    expect(d).toMatch(/non inventarlo/i)
  })
})
