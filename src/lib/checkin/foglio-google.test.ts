/**
 * Conversione indice -> lettera di colonna.
 *
 * Sembra banale, e infatti e' il punto in cui quasi tutte le implementazioni
 * sbagliano: dopo la Z non viene "AA" per addizione ma per un conteggio senza
 * lo zero (bijective base-26). La scheda Soggiorni ha gia' 30 colonne, quindi
 * l'errore non e' teorico — scriverebbe le intestazioni nel posto sbagliato, e
 * il foglio sembrerebbe soltanto un po' strano.
 */
import { describe, it, expect } from 'vitest'
import { lettera } from './foglio-google'

describe('lettera di colonna', () => {
  it('le prime sono ovvie', () => {
    expect(lettera(0)).toBe('A')
    expect(lettera(1)).toBe('B')
    expect(lettera(25)).toBe('Z')
  })

  it('dopo la Z riparte da AA, non da BA', () => {
    expect(lettera(26)).toBe('AA')
    expect(lettera(27)).toBe('AB')
    expect(lettera(51)).toBe('AZ')
    expect(lettera(52)).toBe('BA')
  })

  it('copre le colonne che il foglio usa davvero', () => {
    // Soggiorni ha 30 colonne: la 28esima e la 29esima sono AB e AC.
    expect(lettera(27)).toBe('AB')
    expect(lettera(29)).toBe('AD')
  })

  it('regge anche oltre le due lettere', () => {
    expect(lettera(701)).toBe('ZZ')
    expect(lettera(702)).toBe('AAA')
  })
})
