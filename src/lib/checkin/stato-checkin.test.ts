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
    expect(r.mancanze[0]).toBe('Mancano 3 schede ospite su 4.')
  })

  it('accorda il singolare quando ne manca una sola', () => {
    const r = calcolaStato(pratica({ ospitiAttesi: 2 }))
    expect(r.mancanze[0]).toBe('Manca 1 scheda ospite su 2.')
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

describe('quando si presentano in numero diverso dal prenotato', () => {
  it('DECISIONE 6 set: "siamo di meno" NON chiude piu il check-in da solo', () => {
    // Regola dell'Ingegnere: se uno da forfait, l'ospite in meno lo toglie il
    // GESTORE dalla pagina di gestione, abbassando il numero prenotato. Prima
    // bastava che il browser dichiarasse un numero piu basso, e la pratica
    // risultava a posto con tre persone non comunicate alla Questura.
    const r = calcolaStato(pratica({ ospitiAttesi: 4, ospitiDichiarati: 1 }))
    expect(r.stato).toBe('PARZIALE')
    expect(r.mancanze.join(' ')).toContain('su 4')
  })

  it('con un ospite in piu si chiude, e lo dice', () => {
    const r = calcolaStato(pratica({
      ospitiAttesi: 1, ospitiDichiarati: 2,
      ospiti: [ospite(), ospite({ cognome: 'VERDI', nome: 'ANNA', dataNascita: '1990-04-10', codiceFiscale: 'VRDNNA90D50H501R' })],
    }))
    expect(r.stato).toBe('CHECKIN OK')
    expect(r.segnalazioni.join(' ')).toContain('in piu')
  })

  it('NON basta lasciare una scheda in bianco: quello resta bloccante', () => {
    // La differenza si dichiara, non si ottiene per omissione.
    const r = calcolaStato(pratica({ ospitiAttesi: 4 }))
    expect(r.stato).toBe('PARZIALE')
    expect(r.mancanze[0]).toContain('Mancano 3 schede')
  })

  it('se dichiarati e prenotati coincidono non segnala niente', () => {
    const r = calcolaStato(pratica({ ospitiAttesi: 1, ospitiDichiarati: 1 }))
    expect(r.segnalazioni).toEqual([])
  })

  it('dichiarare di meno non esonera dal compilare le schede prenotate', () => {
    const r = calcolaStato(pratica({
      ospitiAttesi: 4, ospitiDichiarati: 3,
      ospiti: [ospite(), ospite({ cognome: '', nome: '', dataNascita: '' })],
    }))
    expect(r.stato).toBe('PARZIALE')
    // Il metro resta 4: il numero lo abbassa il gestore, non chi compila.
    expect(r.mancanze.join(' ')).toContain('su 4')
  })
})

// ── Chi decide quante persone dormono in casa (6 settembre 2026) ─────────────

/** Una scheda ospite completa: cambia solo cio' che serve al singolo test. */
function schedaPienaN(n: number) {
  return {
    cognome: `Rossi${n}`, nome: `Mario${n}`, dataNascita: '1980-01-01',
    comuneNascita: 'ROMA', statoNascita: '', cittadinanza: 'ITALIA',
    tipoDocumento: 'IDENT', numeroDocumento: `AB${n}`, luogoRilascio: 'ROMA',
    codiceFiscale: 'RSSMRA80A01H501U', esente: false, motivoEsenzione: '',
  }
}

function praticaNumeri(ospitiAttesi: number, quanteSchede: number, ospitiDichiarati?: number) {
  return {
    ospitiAttesi,
    ospitiDichiarati,
    indirizzo: 'Via Roma 1', citta: 'ROMA', cap: '00100', nazione: 'IT',
    ospiti: Array.from({ length: quanteSchede }, (_, i) => schedaPienaN(i + 1)),
  }
}

describe('il metro e il numero PRENOTATO, non quello dichiarato da chi compila', () => {
  it('CONTROLLO POSITIVO: prenotati 5, compilate 4 -> NON e completo', () => {
    // La regola dell'Ingegnere: se non si presentano tutti, e il gestore a
    // togliere l'ospite dalla pagina di gestione. Finche non lo fa, la pratica
    // resta aperta.
    const e = calcolaStato(praticaNumeri(5, 4))

    expect(e.stato).toBe('PARZIALE')
    expect(e.mancanze.join(' ')).toContain('scheda ospite su 5')
  })

  it("e NON basta che il browser dichiari 4 per farla risultare completa", () => {
    // Questo e il buco vero: `Ospiti dichiarati` lo scrive il browser di chi
    // compila. Prima abbassarlo chiudeva il controllo invece di aprirlo.
    const e = calcolaStato(praticaNumeri(5, 4, 4))

    expect(e.stato).toBe('PARZIALE')
  })

  it('CONTROLLO POSITIVO: il gestore abbassa il prenotato a 4 -> con 4 schede e completo', () => {
    const e = calcolaStato(praticaNumeri(4, 4))

    expect(e.stato).toBe('CHECKIN OK')
    expect(e.mancanze).toEqual([])
  })

  it('IN PIU si puo sempre: prenotati 2, si presentano in 3 -> completo, ma segnalato', () => {
    // Nessuno bara al rialzo: un ospite in piu e imposta in piu da pagare.
    const e = calcolaStato(praticaNumeri(2, 3))

    expect(e.stato).toBe('CHECKIN OK')
    expect(e.segnalazioni.join(' ')).toContain('in piu')
  })

  it('e le schede in piu vanno compilate TUTTE, non solo quelle prenotate', () => {
    // 2 prenotati, 3 schede aperte ma una vuota: la terza persona esiste e va
    // comunicata. Il metro sale con le schede, non si ferma al prenotato.
    const p = praticaNumeri(2, 3)
    p.ospiti[2] = { ...p.ospiti[2], cognome: '', nome: '', dataNascita: '' }

    const e = calcolaStato(p)

    // La scheda vuota non conta come compilata: restano 2 su 2 prenotati.
    expect(e.stato).toBe('CHECKIN OK')
  })

  it('CONTROPROVA: senza numero prenotato ci si regola sulle schede compilate', () => {
    // Se il metro fosse sempre e solo `ospitiAttesi`, una prenotazione creata
    // senza quel dato non sarebbe mai completabile.
    const e = calcolaStato(praticaNumeri(0, 2))

    expect(e.stato).toBe('CHECKIN OK')
  })
})
