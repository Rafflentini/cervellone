import { describe, it, expect } from 'vitest'
import {
  byteDi,
  staNelTettoKeepalive,
  tagliaAiByte,
  TETTO_KEEPALIVE_BYTE,
  TETTO_BEACON_BYTE,
} from './chat-save-limits'

describe('byteDi — pesa i byte, non i caratteri', () => {
  it('un carattere ASCII pesa un byte', () => {
    expect(byteDi('abc')).toBe(3)
  })

  // Questo e il difetto che una misura in caratteri non vedrebbe: su testo
  // tecnico italiano il peso reale e molto superiore alla lunghezza.
  it('accenti e simboli pesano di piu', () => {
    expect(byteDi('à')).toBeGreaterThan(1)
    expect(byteDi('€')).toBeGreaterThan(1)
    expect(byteDi('m²')).toBeGreaterThan(2)
  })

  it('un testo tecnico italiano pesa piu della sua lunghezza', () => {
    const riga = 'Superficie 120,50 m² — importo € 3.456,78 — perché così è più preciso\n'
    const testo = riga.repeat(200)
    expect(byteDi(testo)).toBeGreaterThan(testo.length)
  })
})

describe('staNelTettoKeepalive', () => {
  it('un messaggio corto puo usare keepalive', () => {
    expect(staNelTettoKeepalive(JSON.stringify({ content: 'ok' }))).toBe(true)
  })

  // Il caso critico: keepalive impone il tetto SEMPRE, anche a pagina aperta.
  // Attivarlo su un corpo troppo grande fa fallire il salvataggio in silenzio.
  it('una risposta lunga NON deve usare keepalive', () => {
    const lungo = 'x'.repeat(TETTO_KEEPALIVE_BYTE + 1)
    expect(staNelTettoKeepalive(lungo)).toBe(false)
  })

  it('la soglia si misura in byte: un testo accentato la supera prima', () => {
    // meta dei caratteri del test precedente, ma piu byte
    const accentato = 'à'.repeat(Math.floor(TETTO_KEEPALIVE_BYTE / 2) + 10)
    expect(accentato.length).toBeLessThan(TETTO_KEEPALIVE_BYTE)
    expect(staNelTettoKeepalive(accentato)).toBe(false)
  })
})

describe('tagliaAiByte', () => {
  it('lascia intatto un testo che ci sta', () => {
    expect(tagliaAiByte('breve', 100)).toBe('breve')
  })

  it('il risultato non supera MAI il tetto in byte', () => {
    const testo = 'perché è così — €120,50 m²\n'.repeat(5000)
    const tagliato = tagliaAiByte(testo, 1000)
    expect(byteDi(tagliato)).toBeLessThanOrEqual(1000)
    expect(tagliato.length).toBeGreaterThan(0)
  })

  it('conserva il piu possibile invece di tagliare a caso', () => {
    const testo = 'a'.repeat(5000)
    const tagliato = tagliaAiByte(testo, 1000)
    expect(tagliato).toHaveLength(1000)
  })

  it('col tetto di default regge un documento lungo', () => {
    const documento = 'Voce di computo 01.A01.001 — 120,50 m² a € 34,56\n'.repeat(4000)
    const tagliato = tagliaAiByte(documento)
    expect(byteDi(tagliato)).toBeLessThanOrEqual(TETTO_BEACON_BYTE)
  })
})
