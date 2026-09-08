import { describe, test, expect } from 'vitest'
import { avvisoImmagini } from './avviso-immagini'

describe('avvisoImmagini', () => {
  // L'8 set 2026 il Preventivo Extra B e' stato consegnato con la foto rotta e
  // dichiarato a posto tre volte di fila. Il documento non puo' uscire con un
  // "fatto" liscio se le immagini non sono entrate.
  test('quando una foto non entra, lo dice a chiare lettere', () => {
    const avviso = avvisoImmagini(['1Zg97_TDKOoUWeAAYsTQ-TrlH5m601rXU'])
    expect(avviso).toContain('⚠️')
    expect(avviso).toContain('1 immagine')
    expect(avviso).toContain('1Zg97_TDKOoUWeAAYsTQ-TrlH5m601rXU')
  })

  test('al plurale conta bene', () => {
    expect(avvisoImmagini(['a1', 'b2', 'c3'])).toContain('3 immagini')
  })

  // CONTROLLO POSITIVO: senza, una funzione che avvisa SEMPRE passerebbe i test
  // qui sopra e infilerebbe un allarme in fondo a ogni documento riuscito.
  test('quando sono entrate tutte non aggiunge niente', () => {
    expect(avvisoImmagini([])).toBe('')
  })
})
