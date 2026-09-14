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

  it('La Real Estate ha partita IVA propria', () => {
    const s = getSocieta('larealestate')
    expect(s.piva).toBe('02232730768')
    expect(s.aliquotaIvaDefault).toBe(10)
  })

  // LA DECISIONE, 14 settembre 2026 (audit avversariale): `googleAccount` e'
  // stato tolto dal registro perche' senza un solo chiamante era la seconda
  // copia degli stessi indirizzi che vivono in `caselle.ts`. Questo test
  // prova che sia rimasto tolto e non torni per distrazione.
  it("il registro NON ha un campo 'googleAccount': la casella Google si chiede a caselle.ts", () => {
    for (const s of listaSocieta()) {
      expect(Object.keys(s)).not.toContain('googleAccount')
    }
  })

  // Task 7: il campo `sede` non esisteva. Per Restruktura riusa ESATTAMENTE
  // RESTRUKTURA.sedeLegale (src/v19/prompts/identita.ts) — non una terza forma
  // inventata qui, e non la forma diversa scritta nella memoria di progetto:
  // la forma definitiva la decide Raffaele.
  it('ogni societa ha una sede, e quella di Restruktura riusa identita.ts', () => {
    expect(getSocieta('restruktura').sede).toBe("Via Roma 60, 85050 Marsicovetere (PZ)")
    expect(getSocieta('larealestate').sede).toBe('Via Civita 8, Maratea (PZ)')
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
