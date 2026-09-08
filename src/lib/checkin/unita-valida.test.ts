import { describe, test, expect } from 'vitest'
import { normalizzaUnita } from './unita-valida'

const CONFIG = ['Bilocale Mare', 'Trilocale Centro', 'Monolocale Porto']

describe('normalizzaUnita', () => {
  test('un appartamento del Config passa', () => {
    expect(normalizzaUnita('Trilocale Centro', CONFIG)).toEqual({ ok: true, unita: 'Trilocale Centro' })
  })

  // IL DIFETTO che bloccava il go-live del 7 settembre: il campo era libero.
  // Un nome diverso da quelli del Config creava un appartamento FANTASMA, che si
  // sdoppiava nell'elenco e produceva un file Questura in piu'.
  test('un nome inventato viene rifiutato, e si dice quali sono quelli veri', () => {
    const esito = normalizzaUnita('Casa al mare', CONFIG)
    expect(esito.ok).toBe(false)
    if (!esito.ok) expect(esito.errore).toContain('Bilocale Mare')
  })

  // Chi scrive a mano sbaglia gli accenti e le maiuscole, non l'appartamento.
  // Rifiutare "unita 1" quando nel Config c'e' "Unità 1" sarebbe pedanteria che
  // blocca una prenotazione vera.
  test.each([
    ['trilocale centro', 'Trilocale Centro'],
    ['  Trilocale  Centro  ', 'Trilocale Centro'],
    ['TRILOCALE CENTRO', 'Trilocale Centro'],
  ])('«%s» viene ricondotto a «%s»', (scritto, atteso) => {
    expect(normalizzaUnita(scritto, CONFIG)).toEqual({ ok: true, unita: atteso })
  })

  test('accenti sbagliati non fanno perdere una prenotazione', () => {
    expect(normalizzaUnita('unita 1', ['Unità 1'])).toEqual({ ok: true, unita: 'Unità 1' })
  })

  // CONTROLLO POSITIVO sul caso limite: se il Config non ha unita' configurate
  // non si puo' bloccare tutto, o il gestionale diventa inutilizzabile.
  test('senza unita nel Config si accetta quello che arriva', () => {
    expect(normalizzaUnita('Qualsiasi cosa', [])).toEqual({ ok: true, unita: 'Qualsiasi cosa' })
  })

  test('vuota resta un errore', () => {
    expect(normalizzaUnita('   ', CONFIG).ok).toBe(false)
  })
})
