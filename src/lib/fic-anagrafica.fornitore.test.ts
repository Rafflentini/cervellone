/**
 * src/lib/fic-anagrafica.fornitore.test.ts — un fornitore va nel SUO elenco.
 *
 * ⚠️ Il difetto, 14 settembre 2026. `fic_crea_cliente` aveva
 * `entities/clients` CABLATO in tutte e tre le chiamate: le due della guardia
 * anti-doppione e quella di creazione. Su Fatture in Cloud clienti e fornitori
 * sono due elenchi SEPARATI.
 *
 * Booking.com B.V. e' un fornitore. Crearlo fra i clienti lo faceva «esistere»
 * in un elenco e mancare nell'altro: la fattura d'ACQUISTO, che vuole un
 * fornitore, non lo avrebbe trovato — e l'anti-doppione, cercando fra i
 * clienti, non lo avrebbe visto nemmeno la volta dopo. Due difetti dallo
 * stesso cablaggio.
 *
 * Nessuna chiamata vera a Fatture in Cloud: l'I/O e' finto, la logica e' quella
 * VERA. Qui si guardano i PERCORSI, che sono la cosa che sbagliava.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stato = {
  risposte: [] as Array<Record<string, unknown>[]>,
  /** Ogni percorso chiamato, in lettura e in scrittura: la prova vera. */
  percorsi: [] as string[],
  creato: null as Record<string, unknown> | null,
}

vi.mock('./fatture-in-cloud', () => ({
  getCompanyId: async () => ({ ok: true as const, id: 42 }),
  ficGet: async (path: string) => {
    stato.percorsi.push(path)
    return { ok: true as const, data: { data: stato.risposte.shift() ?? [] } }
  },
  ficPost: async (path: string, body: Record<string, unknown>) => {
    stato.percorsi.push(path)
    stato.creato = body
    return { ok: true as const, data: { data: { id: 999, name: 'nuovo' } } }
  },
}))

import { executeAnagraficaTool, ANAGRAFICA_TOOLS } from './fic-anagrafica'

const chiama = async (input: Record<string, unknown>) =>
  JSON.parse((await executeAnagraficaTool('fic_crea_cliente', input, 'larealestate'))!)

const BOOKING = {
  nome: 'Booking.com B.V.',
  tipo: 'azienda',
  partita_iva: 'NL805734958B01',
  indirizzo: 'Oosterdokskade 163',
  cap: '1011 DL',
  citta: 'Amsterdam',
  paese: 'Netherlands',
}

beforeEach(() => {
  stato.risposte = []
  stato.percorsi = []
  stato.creato = null
})

describe('un fornitore finisce fra i fornitori, non fra i clienti', () => {
  it('🚨 con elenco «fornitore» ogni chiamata va su entities/suppliers', async () => {
    const r = await chiama({ ...BOOKING, elenco: 'fornitore' })

    expect(r.ok).toBe(true)
    expect(r.creato).toBe(true)
    expect(stato.percorsi.length).toBeGreaterThan(0)
    // Nemmeno UNA sui clienti: se la guardia anti-doppione cercasse li', non
    // troverebbe mai il fornitore gia' esistente e ne creerebbe un altro.
    expect(stato.percorsi.every((p) => p.includes('/entities/suppliers'))).toBe(true)
    expect(stato.percorsi.some((p) => p.includes('/entities/clients'))).toBe(false)
  }, 30_000)

  it('🚨 l anti-doppione cerca nello STESSO elenco: se il fornitore c e gia, non ne crea un altro', async () => {
    stato.risposte = [[{ id: 9, name: 'Booking.com B.V.', vat_number: 'NL805734958B01' }]]

    const r = await chiama({ ...BOOKING, elenco: 'fornitore' })

    expect(r.creato).toBe(false)
    expect(r.cliente_id).toBe(9)
    // La prova che conta: nessuna scrittura.
    expect(stato.creato).toBeNull()
  }, 30_000)

  it('CONTROLLO POSITIVO: senza elenco resta tutto sui CLIENTI, come prima', async () => {
    // Senza questo, spostare tutto sui fornitori passerebbe i test qui sopra e
    // manderebbe ogni ospite degli affitti brevi nell'elenco sbagliato.
    const r = await chiama({ nome: 'Maria Nunez', tipo: 'privato' })

    expect(r.creato).toBe(true)
    expect(stato.percorsi.every((p) => p.includes('/entities/clients'))).toBe(true)
    expect(stato.percorsi.some((p) => p.includes('/entities/suppliers'))).toBe(false)
  }, 30_000)

  it('il tool DICHIARA di saperlo fare: «fornitore» e nello schema', () => {
    // Una capacita' che non e' nello schema, per il modello non esiste — e'
    // lo stesso difetto che ha tenuto nascosto per mesi il download degli
    // allegati Gmail.
    const tool = ANAGRAFICA_TOOLS.find((t) => t.name === 'fic_crea_cliente')!
    const props = (tool.input_schema as { properties: Record<string, { enum?: string[] }> }).properties
    expect(props.elenco?.enum).toEqual(['cliente', 'fornitore'])
  })
})
