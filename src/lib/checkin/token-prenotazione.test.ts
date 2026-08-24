/**
 * I token dei collegamenti.
 *
 * Questi test non servono a dimostrare che un link valido funziona: quello si
 * vede subito. Servono a dimostrare che i link SBAGLIATI non funzionano — il
 * token di un ospite su un'altra prenotazione, quello di una prenotazione
 * spacciato per quello di un ospite, un link dopo la scadenza.
 *
 * Sono documenti d'identita' di persone che non si conoscono fra loro: qui un
 * buco non e' un difetto, e' una violazione di dati.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  generaToken, verificaToken, linkScaduto, linkPrenotazione, linkOspite,
} from './token-prenotazione'

const SEGRETO_ORIGINALE = process.env.CHECKIN_SECRET

beforeEach(() => { process.env.CHECKIN_SECRET = 'segreto-di-prova-24-agosto' })
afterEach(() => {
  if (SEGRETO_ORIGINALE === undefined) delete process.env.CHECKIN_SECRET
  else process.env.CHECKIN_SECRET = SEGRETO_ORIGINALE
})

const P1 = { tipo: 'prenotazione', id: 'SOG-20260824-101530' } as const
const P2 = { tipo: 'prenotazione', id: 'SOG-20260824-999999' } as const

describe('un token valido', () => {
  it('verifica se stesso', () => {
    expect(verificaToken(P1, generaToken(P1))).toBe(true)
  })

  it('e stabile: lo stesso ambito produce sempre lo stesso token', () => {
    // Se cambiasse, i link gia inviati smetterebbero di funzionare.
    expect(generaToken(P1)).toBe(generaToken(P1))
  })
})

describe('i token che NON devono funzionare', () => {
  it('quello di una prenotazione non apre un altra prenotazione', () => {
    expect(verificaToken(P2, generaToken(P1))).toBe(false)
  })

  it('quello di un ospite non apre la prenotazione intera', () => {
    const tOspite = generaToken({ tipo: 'ospite', id: P1.id, progressivo: 2 })
    expect(verificaToken(P1, tOspite)).toBe(false)
  })

  it('quello di un ospite non apre la scheda di un altro ospite', () => {
    const t2 = generaToken({ tipo: 'ospite', id: P1.id, progressivo: 2 })
    expect(verificaToken({ tipo: 'ospite', id: P1.id, progressivo: 3 }, t2)).toBe(false)
  })

  it('rifiuta un token vuoto, nullo o troncato', () => {
    const buono = generaToken(P1)!
    expect(verificaToken(P1, '')).toBe(false)
    expect(verificaToken(P1, null)).toBe(false)
    expect(verificaToken(P1, buono.slice(0, -1))).toBe(false)
    expect(verificaToken(P1, buono + 'a')).toBe(false)
  })

  it('rifiuta ogni storpiatura di un carattere', () => {
    const buono = generaToken(P1)!
    for (let i = 0; i < buono.length; i++) {
      const ch = buono[i] === 'a' ? 'b' : 'a'
      const storpiato = buono.slice(0, i) + ch + buono.slice(i + 1)
      expect(verificaToken(P1, storpiato), storpiato).toBe(false)
    }
  })
})

describe('senza segreto configurato', () => {
  it('non genera token', () => {
    delete process.env.CHECKIN_SECRET
    expect(generaToken(P1)).toBeNull()
  })

  it('non apre niente a nessuno, invece di aprire a tutti', () => {
    // Il difetto speculare: senza segreto, un confronto ingenuo farebbe
    // combaciare due stringhe vuote e il link diventerebbe pubblico.
    delete process.env.CHECKIN_SECRET
    expect(verificaToken(P1, '')).toBe(false)
    expect(verificaToken(P1, 'qualsiasi')).toBe(false)
  })
})

describe('ruotare il segreto invalida i link', () => {
  it('un token generato col vecchio segreto non passa col nuovo', () => {
    const vecchio = generaToken(P1)!
    process.env.CHECKIN_SECRET = 'un-altro-segreto'
    expect(verificaToken(P1, vecchio)).toBe(false)
  })
})

describe('scadenza', () => {
  const oggi = (s: string) => new Date(`${s}T12:00:00Z`)

  it('un link resta buono durante il soggiorno', () => {
    expect(linkScaduto('2026-08-20', oggi('2026-08-18'))).toBe(false)
  })

  it('resta buono nei giorni subito dopo il check-out', () => {
    expect(linkScaduto('2026-08-20', oggi('2026-08-25'))).toBe(false)
  })

  it('scade dopo la finestra', () => {
    expect(linkScaduto('2026-08-20', oggi('2026-09-10'))).toBe(true)
  })

  it('senza data di check-out non blocca: non si puo dire', () => {
    expect(linkScaduto('', oggi('2026-09-10'))).toBe(false)
  })
})

describe('i link', () => {
  it('quello della prenotazione porta id e token', () => {
    const l = linkPrenotazione('https://x.it', P1.id)!
    expect(l).toContain(`p=${P1.id}`)
    expect(l).toContain(`t=${generaToken(P1)}`)
    expect(l).not.toContain('o=')
  })

  it('quello dell ospite porta anche il progressivo', () => {
    const l = linkOspite('https://x.it', P1.id, 3)!
    expect(l).toContain('o=3')
  })

  it('senza segreto non produce un link mezzo fatto', () => {
    delete process.env.CHECKIN_SECRET
    expect(linkPrenotazione('https://x.it', P1.id)).toBeNull()
  })
})
