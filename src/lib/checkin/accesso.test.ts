/**
 * Dal collegamento al livello di accesso.
 *
 * Il modo tipico in cui questi controlli cedono non e' un attacco raffinato: e'
 * un caso limite che nessuno ha provato. Un parametro vuoto, uno zero, un
 * numero negativo, un token giusto ma dell'ambito sbagliato.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { risolviAccesso } from './accesso'
import { generaToken } from './token-prenotazione'

const ORIG_SECRET = process.env.CHECKIN_SECRET
const ORIG_TOKEN = process.env.CHECKIN_TOKEN

beforeEach(() => {
  process.env.CHECKIN_SECRET = 'segreto-di-prova'
  process.env.CHECKIN_TOKEN = 'token-generale-di-prova'
})
afterEach(() => {
  if (ORIG_SECRET === undefined) delete process.env.CHECKIN_SECRET; else process.env.CHECKIN_SECRET = ORIG_SECRET
  if (ORIG_TOKEN === undefined) delete process.env.CHECKIN_TOKEN; else process.env.CHECKIN_TOKEN = ORIG_TOKEN
})

const ID = 'SOG-20260824-101530'
const tPren = () => generaToken({ tipo: 'prenotazione', id: ID })!
const tOsp = (n: number) => generaToken({ tipo: 'ospite', id: ID, progressivo: n })!

describe('token generale', () => {
  it('apre come gestore', () => {
    const r = risolviAccesso('token-generale-di-prova', ID, null, null)
    expect(r).toMatchObject({ ok: true, livello: { tipo: 'gestore' } })
  })

  it('apre anche senza indicare una prenotazione', () => {
    const r = risolviAccesso('token-generale-di-prova', null, null, null)
    expect(r.ok).toBe(true)
  })

  it('uno sbagliato non apre niente', () => {
    expect(risolviAccesso('sbagliato', ID, null, null).ok).toBe(false)
  })
})

describe('token di prenotazione', () => {
  it('apre come intestatario', () => {
    const r = risolviAccesso(null, ID, tPren(), null)
    expect(r).toMatchObject({ ok: true, livello: { tipo: 'prenotazione' }, id: ID })
  })

  it('non apre un altra prenotazione', () => {
    expect(risolviAccesso(null, 'SOG-ALTRA', tPren(), null).ok).toBe(false)
  })

  it('senza id non apre', () => {
    expect(risolviAccesso(null, null, tPren(), null).ok).toBe(false)
  })

  it('senza token non apre', () => {
    expect(risolviAccesso(null, ID, null, null).ok).toBe(false)
  })
})

describe('token di ospite', () => {
  it('apre come quell ospite, e solo quello', () => {
    const r = risolviAccesso(null, ID, tOsp(2), '2')
    expect(r).toMatchObject({ ok: true, livello: { tipo: 'ospite', progressivo: 2 } })
  })

  it('non apre la scheda di un altro ospite', () => {
    expect(risolviAccesso(null, ID, tOsp(2), '3').ok).toBe(false)
  })

  it('non apre la prenotazione intera', () => {
    // Stesso token, ma senza il parametro o: verrebbe letto come token di
    // prenotazione, che e' una firma diversa.
    expect(risolviAccesso(null, ID, tOsp(2), null).ok).toBe(false)
  })

  it('rifiuta un progressivo che non e un numero valido', () => {
    for (const o of ['0', '-1', 'due', '1.5', ' ']) {
      expect(risolviAccesso(null, ID, tOsp(1), o).ok, `o=${o}`).toBe(false)
    }
  })
})

describe('senza segreti configurati', () => {
  it('non apre a nessuno', () => {
    delete process.env.CHECKIN_SECRET
    delete process.env.CHECKIN_TOKEN
    expect(risolviAccesso('', ID, '', null).ok).toBe(false)
    expect(risolviAccesso(null, ID, 'qualsiasi', null).ok).toBe(false)
  })
})
