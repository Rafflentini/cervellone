/**
 * Quando la pratica si puo' dichiarare chiusa.
 *
 * CHECKIN OK e' l'unica cosa che l'Ingegnere guardera' davvero. Se compare
 * quando manca qualcosa, quel qualcosa non lo cerca piu' nessuno — che e'
 * esattamente il modo in cui la memoria persistente e' rimasta rotta per tre
 * mesi dichiarandosi `ok` ogni notte.
 *
 * Quindi i test che contano non sono quelli sul caso pieno: sono quelli sui
 * casi incompleti, che NON devono passare.
 */
import { describe, it, expect } from 'vitest'
import { calcolaStato, type OspiteDaControllare, type PraticaDaControllare } from './stato-checkin'

function ospite(over: Partial<OspiteDaControllare> = {}): OspiteDaControllare {
  return {
    cognome: 'ROSSI', nome: 'MARIO', dataNascita: '1980-01-01',
    comuneNascita: 'ROMA', statoNascita: '', cittadinanza: 'ITALIA',
    tipoDocumento: 'IDENT', numeroDocumento: 'AB1234567',
    codiceFiscale: 'RSSMRA80A01H501U',
    ...over,
  }
}

function pratica(over: Partial<PraticaDaControllare> = {}): PraticaDaControllare {
  return {
    ospitiAttesi: 1,
    ospiti: [ospite()],
    indirizzo: 'Via Roma 1', cap: '00100', citta: 'ROMA', nazione: 'IT',
    ...over,
  }
}

describe('CHECKIN OK', () => {
  it('compare solo quando c e davvero tutto', () => {
    const r = calcolaStato(pratica())
    expect(r.stato).toBe('CHECKIN OK')
    expect(r.mancanze).toEqual([])
  })
})

describe('il conteggio degli ospiti — il controllo che nessuno farebbe a mano', () => {
  it('NON dichiara OK se le schede sono meno di quelle prenotate', () => {
    // Due persone dormirebbero in casa senza essere comunicate alla Questura,
    // e il foglio non mostrerebbe niente di strano.
    const r = calcolaStato(pratica({ ospitiAttesi: 4 }))
    expect(r.stato).toBe('PARZIALE')
    expect(r.mancanze[0]).toContain('Mancano 3 schede ospite su 4')
  })

  it('accorda il singolare quando ne manca una sola', () => {
    const r = calcolaStato(pratica({ ospitiAttesi: 2 }))
    expect(r.mancanze[0]).toContain('Mancano 1 scheda ospite su 2')
  })

  it('non conta le schede lasciate in bianco', () => {
    const vuota = ospite({ cognome: '', nome: '', dataNascita: '' })
    const r = calcolaStato(pratica({ ospitiAttesi: 2, ospiti: [ospite(), vuota] }))
    expect(r.stato).toBe('PARZIALE')
  })

  it('con tutte le schede compilate dichiara OK', () => {
    const r = calcolaStato(pratica({
      ospitiAttesi: 2,
      ospiti: [ospite(), ospite({ cognome: 'VERDI', nome: 'ANNA', codiceFiscale: 'VRDNNA90D50H501R', dataNascita: '1990-04-10' })],
    }))
    expect(r.stato).toBe('CHECKIN OK')
  })
})

describe('cosa manca a un ospite', () => {
  const casi: Array<[string, Partial<OspiteDaControllare>, string]> = [
    ['senza data di nascita', { dataNascita: '' }, 'data di nascita'],
    ['senza luogo di nascita', { comuneNascita: '', statoNascita: '' }, 'luogo di nascita'],
    ['senza cittadinanza', { cittadinanza: '' }, 'cittadinanza'],
    ['senza numero documento', { numeroDocumento: '' }, 'numero del documento'],
    ['senza codice fiscale, se italiano', { codiceFiscale: '' }, 'codice fiscale'],
    ['con codice fiscale storpiato', { codiceFiscale: 'RSSMRA80A01H501X' }, 'non valido'],
  ]

  it('distingue "manca" da "non valido": a chi compila dicono due cose diverse', () => {
    const manca = calcolaStato(pratica({ ospiti: [ospite({ codiceFiscale: '' })] }))
    expect(manca.mancanze).toContain('Ospite 1: codice fiscale.')
    expect(manca.mancanze.join(' ')).not.toContain('non valido')

    const storto = calcolaStato(pratica({ ospiti: [ospite({ codiceFiscale: 'RSSMRA80A01H501X' })] }))
    expect(storto.mancanze).toContain('Ospite 1: codice fiscale non valido.')
  })

  for (const [nome, over, atteso] of casi) {
    it(`non dichiara OK ${nome}`, () => {
      const r = calcolaStato(pratica({ ospiti: [ospite(over)] }))
      expect(r.stato).not.toBe('CHECKIN OK')
      expect(r.mancanze.join(' ')).toContain(atteso)
    })
  }

  it('a uno straniero il codice fiscale non lo chiede', () => {
    const r = calcolaStato(pratica({
      ospiti: [ospite({
        cognome: 'MULLER', nome: 'HANS', cittadinanza: 'GERMANIA',
        comuneNascita: '', statoNascita: 'GERMANIA', codiceFiscale: '',
      })],
    }))
    expect(r.stato).toBe('CHECKIN OK')
  })

  it('ma se lo straniero ne scrive uno sbagliato lo segnala', () => {
    const r = calcolaStato(pratica({
      ospiti: [ospite({
        cittadinanza: 'GERMANIA', comuneNascita: '', statoNascita: 'GERMANIA',
        codiceFiscale: 'NONVALIDO1234567',
      })],
    }))
    expect(r.stato).toBe('PARZIALE')
  })
})

describe('i dati che servono alla fattura', () => {
  it('senza indirizzo non e OK, anche se gli ospiti sono a posto', () => {
    const r = calcolaStato(pratica({ indirizzo: '' }))
    expect(r.stato).toBe('PARZIALE')
    expect(r.mancanze.join(' ')).toContain('Indirizzo')
  })

  it('senza comune non e OK', () => {
    expect(calcolaStato(pratica({ citta: '' })).stato).toBe('PARZIALE')
  })

  it('a un italiano il CAP lo chiede', () => {
    expect(calcolaStato(pratica({ cap: '' })).stato).toBe('PARZIALE')
  })

  it('a uno straniero no', () => {
    expect(calcolaStato(pratica({ cap: '', nazione: 'DE' })).stato).toBe('CHECKIN OK')
  })
})

describe('DA COMPILARE', () => {
  it('e lo stato di una pratica appena creata', () => {
    const r = calcolaStato(pratica({ ospitiAttesi: 2, ospiti: [] }))
    expect(r.stato).toBe('DA COMPILARE')
  })

  it('vale anche se ci sono schede tutte in bianco', () => {
    const vuota = ospite({ cognome: '', nome: '', dataNascita: '' })
    const r = calcolaStato(pratica({ ospitiAttesi: 2, ospiti: [vuota, vuota] }))
    expect(r.stato).toBe('DA COMPILARE')
  })
})

describe('le mancanze si elencano tutte insieme', () => {
  it('cosi chi completa rimedia in una volta sola', () => {
    const r = calcolaStato(pratica({
      ospitiAttesi: 2,
      ospiti: [ospite({ numeroDocumento: '', codiceFiscale: '' })],
      indirizzo: '', cap: '',
    }))
    expect(r.mancanze.length).toBeGreaterThanOrEqual(5)
  })
})
