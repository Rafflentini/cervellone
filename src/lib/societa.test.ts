import { describe, it, expect } from 'vitest'
import { getSocieta, listaSocieta, risolviSocieta } from './societa'

describe('registro societa', () => {
  it('conosce le due societa', () => {
    expect(listaSocieta().map(s => s.codice).sort()).toEqual(['larealestate', 'restruktura'])
  })

  it('ogni societa dichiara QUALE variabile leggere, mai il valore', () => {
    for (const s of listaSocieta()) {
      expect(s.ficTokenEnv).toMatch(/^FIC_/)
      // il registro non deve MAI contenere un token: solo il nome della variabile
      expect(JSON.stringify(s)).not.toMatch(/eyJ|Bearer |[a-f0-9]{32}/)
    }
  })

  it('La Real Estate ha partita IVA e casella proprie', () => {
    const s = getSocieta('larealestate')
    expect(s.piva).toBe('02232730768')
    expect(s.googleAccount).toBe('larealestate.amministrazione@gmail.com')
    expect(s.aliquotaIvaDefault).toBe(10)
  })

  it('risolve il nome scritto dall utente, anche parziale', () => {
    expect(risolviSocieta('la real estate')).toBe('larealestate')
    expect(risolviSocieta('LAREALESTATE')).toBe('larealestate')
    expect(risolviSocieta('restruktura srl')).toBe('restruktura')
  })

  it('NON indovina quando il testo e ambiguo', () => {
    expect(risolviSocieta('fattura di agosto')).toBeNull()
    expect(risolviSocieta('')).toBeNull()
  })
})
