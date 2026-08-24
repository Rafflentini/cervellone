/**
 * I parametri vengono dal foglio, non dal codice.
 *
 * Il rischio da coprire e' il ripiego silenzioso: se una cella del Config viene
 * svuotata e il codice ci mette zero, l'imposta di soggiorno diventa zero per
 * tutti — e il Comune non riceve niente senza che nessuno veda un errore. Il
 * ripiego deve essere la regola nota, non lo zero.
 */
import { describe, it, expect } from 'vitest'
import {
  regoleDaConfig, unitaDaConfig, cercatoreCatastale, chiaveLuogo, type VoceTabella,
} from './foglio-lettura'
import { REGOLE_MARATEA } from './imposta-soggiorno'

describe('regole dal Config', () => {
  it('usa i valori del foglio quando ci sono', () => {
    const r = regoleDaConfig({
      tassa_importo: '3', tassa_max_notti: '4', esenzione_eta_max: '11',
      tassa_stagione_dal: '01/04', tassa_stagione_al: '30/09', tassa_in_vigore_dal: '01/04/2027',
    })
    expect(r).toEqual({
      tariffa: 3, maxPernottamenti: 4, esenzioneEtaMax: 11,
      stagioneDal: '01/04', stagioneAl: '30/09', inVigoreDal: '01/04/2027',
    })
  })

  it('accetta la virgola decimale, che chi compila usa naturalmente', () => {
    expect(regoleDaConfig({ tassa_importo: '2,50' }).tariffa).toBe(2.5)
  })

  it('con una cella svuotata NON ripiega su zero', () => {
    // Zero significherebbe "nessuna imposta dovuta": un ammanco verso il Comune
    // che non produce alcun errore visibile.
    const r = regoleDaConfig({ tassa_importo: '' })
    expect(r.tariffa).toBe(REGOLE_MARATEA.tariffa)
    expect(r.tariffa).toBeGreaterThan(0)
  })

  it('con un valore illeggibile ripiega sulla regola nota', () => {
    expect(regoleDaConfig({ tassa_max_notti: 'cinque' }).maxPernottamenti)
      .toBe(REGOLE_MARATEA.maxPernottamenti)
  })

  it('su un Config completamente vuoto restituisce le regole di Maratea', () => {
    expect(regoleDaConfig({})).toEqual(REGOLE_MARATEA)
  })
})

describe('unita', () => {
  it('le separa e toglie gli spazi di troppo', () => {
    expect(unitaDaConfig({ unita: 'Unità 1| Unità 2 |Unità 3' }))
      .toEqual(['Unità 1', 'Unità 2', 'Unità 3'])
  })
  it('scarta le voci vuote invece di offrire una tendina con un buco', () => {
    expect(unitaDaConfig({ unita: 'Unità 1||Unità 2|' })).toEqual(['Unità 1', 'Unità 2'])
  })
  it('senza unita configurate restituisce un elenco vuoto, non un finto default', () => {
    expect(unitaDaConfig({})).toEqual([])
  })
})

describe('ricerca del codice catastale', () => {
  const voci: VoceTabella[] = [
    { denominazione: 'ROMA', provincia: 'RM', catastale: 'H501', alloggiati: '058091001', tipo: 'COMUNE' },
    { denominazione: "REGGIO NELL'EMILIA", provincia: 'RE', catastale: 'H223', alloggiati: '', tipo: 'COMUNE' },
    { denominazione: 'GERMANIA', provincia: '', catastale: 'Z112', alloggiati: '100000100', tipo: 'STATO' },
  ]
  const cerca = cercatoreCatastale(voci)

  it('trova a prescindere da maiuscole, accenti e punteggiatura', () => {
    expect(cerca('roma')).toBe('H501')
    expect(cerca('Reggio nell Emilia')).toBe('H223')
    expect(cerca('  GERMANIA ')).toBe('Z112')
  })

  it('restituisce vuoto per un luogo che non c e, senza inventare', () => {
    expect(cerca('Atlantide')).toBe('')
  })

  it('normalizza allo stesso modo scritture diverse dello stesso nome', () => {
    expect(chiaveLuogo("Sant'Angelo")).toBe(chiaveLuogo('SANT ANGELO'))
  })
})
