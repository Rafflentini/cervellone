/**
 * L'elenco dei comuni.
 *
 * Questi test proteggono da due errori che non darebbero alcun segnale:
 *
 *  - scegliere il comune sbagliato fra due omonimi, che vuol dire calcolare il
 *    codice fiscale di un'altra persona;
 *  - riempire il CAP con uno dei tanti di una citta' grande, che vuol dire
 *    scrivere in fattura un indirizzo sbagliato dall'aria giusta.
 */
import { describe, it, expect } from 'vitest'
import { tuttiIComuni, cercaComuni, trovaComune, etichetta, chiave } from './comuni'

describe('completezza dei dati', () => {
  it('contiene tutti i comuni italiani', () => {
    expect(tuttiIComuni().length).toBeGreaterThan(7800)
  })

  it('ogni comune ha il codice catastale: senza, il CF non si calcola', () => {
    expect(tuttiIComuni().filter((c) => !c.catastale)).toHaveLength(0)
  })

  it('ogni comune ha la sigla di provincia', () => {
    expect(tuttiIComuni().filter((c) => !c.sigla)).toHaveLength(0)
  })

  it('i codici catastali sono unici', () => {
    const cod = tuttiIComuni().map((c) => c.catastale)
    expect(new Set(cod).size).toBe(cod.length)
  })
})

describe('CAP', () => {
  it('lo porta quando il comune ne ha uno solo', () => {
    expect(trovaComune('Maratea')?.cap).toBe('85046')
    expect(trovaComune('Potenza')?.cap).toBe('85100')
  })

  it('lo lascia VUOTO per le citta con molti CAP, invece di sceglierne uno', () => {
    // Roma ne ha 82: scriverne uno a caso in fattura sarebbe un indirizzo
    // sbagliato che non insospettisce nessuno.
    expect(trovaComune('Roma')?.cap).toBe('')
    expect(trovaComune('Milano')?.cap).toBe('')
  })
})

describe('omonimi', () => {
  it('senza provincia NON sceglie: restituisce null', () => {
    // Calliano esiste in AT e in TN, con codici catastali diversi.
    expect(trovaComune('Calliano')).toBeNull()
  })

  it('con la provincia trova quello giusto', () => {
    expect(trovaComune('Calliano', 'AT')?.catastale).toBe('B418')
    expect(trovaComune('Calliano', 'TN')?.catastale).toBe('B419')
  })

  it('vale per tutti e sei i casi noti', () => {
    const casi: Array<[string, string, string]> = [
      ['Calliano', 'AT', 'B418'], ['Calliano', 'TN', 'B419'],
      ['Castro', 'BG', 'C337'], ['Castro', 'LE', 'M261'],
      ['Livo', 'CO', 'E623'], ['Livo', 'TN', 'E624'],
      ['Peglio', 'CO', 'G415'], ['Peglio', 'PU', 'G416'],
      ['Samone', 'TO', 'H753'], ['Samone', 'TN', 'H754'],
      ['San Teodoro', 'ME', 'I328'], ['San Teodoro', 'SS', 'I329'],
    ]
    for (const [nome, sigla, cod] of casi) {
      expect(trovaComune(nome, sigla)?.catastale, `${nome} (${sigla})`).toBe(cod)
    }
  })

  it('con una provincia che non c entra non ripiega sull altro', () => {
    expect(trovaComune('Calliano', 'RM')).toBeNull()
  })
})

describe('ricerca', () => {
  it('mette prima chi comincia con quello che hai scritto', () => {
    const r = cercaComuni('marat')
    expect(r[0].nome.toUpperCase().startsWith('MARAT')).toBe(true)
  })

  it('trova a prescindere da accenti e apostrofi', () => {
    expect(cercaComuni("reggio nell'emilia").length).toBeGreaterThan(0)
    expect(chiave("Sant'Angelo")).toBe(chiave('SANT ANGELO'))
  })

  it('non risponde a una lettera sola: sarebbero migliaia di risultati', () => {
    expect(cercaComuni('m')).toEqual([])
  })

  it('non restituisce piu voci di quante ne sono state chieste', () => {
    expect(cercaComuni('san', 5).length).toBeLessThanOrEqual(5)
  })
})

describe('etichetta', () => {
  it('porta sempre la sigla, perche il nome da solo puo essere ambiguo', () => {
    const c = trovaComune('Maratea')!
    // Maiuscolo: e' la forma richiesta dal tracciato Alloggiati Web, ed e' la
    // stessa del resto del form. Una sola forma evita che lo stesso comune
    // finisca scritto in due modi nel foglio.
    expect(etichetta(c)).toBe('MARATEA (PZ)')
  })

  it('tutti i nomi sono in maiuscolo, senza eccezioni', () => {
    const diversi = tuttiIComuni().filter((c) => c.nome !== c.nome.toUpperCase())
    expect(diversi).toHaveLength(0)
  })
})
