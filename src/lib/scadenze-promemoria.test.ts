import { describe, it, expect } from 'vitest'
import {
  soglieDa,
  soglieGiaMandate,
  promemoriaDiOggi,
  marcatore,
  quantoManca,
} from './scadenze-promemoria'

describe('le soglie dei promemoria', () => {
  it('con 30 giorni di preavviso avvisa a 30, a 7 e il giorno stesso', () => {
    expect(soglieDa(30)).toEqual([30, 7, 0])
  })

  it('con un preavviso corto non inventa una soglia piu lontana del preavviso', () => {
    // Con 5 giorni di preavviso, un avviso "a 7 giorni" arriverebbe PRIMA di
    // quello iniziale: non ha senso.
    expect(soglieDa(5)).toEqual([5, 0])
  })

  it('il giorno della scadenza c e SEMPRE, comunque sia configurata la riga', () => {
    // E l ultimo momento utile: non deve dipendere da come qualcuno ha
    // compilato reminder_days tre mesi fa.
    expect(soglieDa(0)).toEqual([0])
    expect(soglieDa(1)).toContain(0)
    expect(soglieDa(90)).toContain(0)
  })

  it('non duplica la soglia quando il preavviso e gia di 7 giorni', () => {
    expect(soglieDa(7)).toEqual([7, 0])
  })

  it('un preavviso negativo o assurdo non manda in crisi il calcolo', () => {
    expect(soglieDa(-3)).toEqual([0])
  })
})

describe('quali promemoria sono gia partiti', () => {
  it('riconosce i segni lasciati dal codice nuovo', () => {
    expect(soglieGiaMandate(['30:2026-08-06', '7:2026-08-29'], 30).sort((a, b) => b - a)).toEqual([30, 7])
  })

  it('una data secca del formato VECCHIO chiude solo la soglia piu larga', () => {
    // Le righe scritte prima del 5 set 2026 contengono solo la data. Se le
    // ignorassimo, la prima notte col codice nuovo rimanderebbe un avviso gia
    // dato; se le contassimo come "tutte fatte", i richiami ravvicinati non
    // partirebbero mai.
    expect(soglieGiaMandate(['2026-06-04'], 30)).toEqual([30])
  })

  it('un archivio vuoto non ha nulla di gia mandato', () => {
    expect(soglieGiaMandate([], 30)).toEqual([])
  })

  it('ignora la roba che non riconosce invece di romperti il cron', () => {
    expect(soglieGiaMandate(['boh', ''], 30)).toEqual([])
  })
})

describe('il promemoria di oggi', () => {
  const SOGLIE = [30, 7, 0]

  it('CONTROLLO POSITIVO: a 30 giorni esatti parte il primo avviso', () => {
    expect(promemoriaDiOggi(30, SOGLIE, [])).toEqual({ soglia: 30, assorbite: [] })
  })

  it('il giorno dopo NON ne parte un altro: uno per soglia, non uno al giorno', () => {
    // E la ragione per cui il vecchio codice era "a colpo singolo". Il rimedio
    // non deve trasformarsi in una mail ogni mattina, o verra ignorata.
    expect(promemoriaDiOggi(29, SOGLIE, [30])).toBeNull()
  })

  it('a una settimana parte il richiamo', () => {
    expect(promemoriaDiOggi(7, SOGLIE, [30])).toEqual({ soglia: 7, assorbite: [] })
  })

  it('il giorno della scadenza parte l ultimo avviso', () => {
    expect(promemoriaDiOggi(0, SOGLIE, [30, 7])).toEqual({ soglia: 0, assorbite: [] })
  })

  it('sono TRE in tutto lungo la vita della scadenza, non uno e non trenta', () => {
    const fatte: number[] = []
    let partiti = 0
    for (let giorni = 45; giorni >= 0; giorni--) {
      const p = promemoriaDiOggi(giorni, SOGLIE, fatte)
      if (p) {
        partiti++
        fatte.push(p.soglia, ...p.assorbite)
      }
    }
    expect(partiti).toBe(3)
  })

  it('una scadenza registrata TARDI riceve l avviso stretto, non quello lontano', () => {
    // Registrata quando mancano 4 giorni: dire "fra 30 giorni" sarebbe falso.
    // La soglia da 30 viene assorbita, cosi domani non riparte.
    expect(promemoriaDiOggi(4, SOGLIE, [])).toEqual({ soglia: 7, assorbite: [30] })
  })

  it('le soglie assorbite non fanno partire nulla il giorno dopo', () => {
    const p = promemoriaDiOggi(4, SOGLIE, [])!
    const fatte = [p.soglia, ...p.assorbite]
    expect(promemoriaDiOggi(3, SOGLIE, fatte)).toBeNull()
  })

  it('una scadenza lontana non riceve niente', () => {
    expect(promemoriaDiOggi(60, SOGLIE, [])).toBeNull()
  })

  it('una scadenza GIA PASSATA non riceve niente: la segnala il controllo settimanale', () => {
    // Scelta del 3 set, non una svista: sono cose da sistemare una volta, non
    // da ricordare ogni mattina.
    expect(promemoriaDiOggi(-1, SOGLIE, [])).toBeNull()
    expect(promemoriaDiOggi(-90, SOGLIE, [])).toBeNull()
  })

  it('con preavviso corto gli avvisi sono due, non tre', () => {
    const soglie = soglieDa(5)
    expect(promemoriaDiOggi(5, soglie, [])).toEqual({ soglia: 5, assorbite: [] })
    expect(promemoriaDiOggi(0, soglie, [5])).toEqual({ soglia: 0, assorbite: [] })
  })
})

describe('come si scrive quanto manca', () => {
  it('oggi, domani, e poi i giorni', () => {
    expect(quantoManca(0)).toBe('oggi')
    expect(quantoManca(1)).toBe('domani')
    expect(quantoManca(7)).toBe('fra 7 giorni')
  })

  it('il marcatore porta soglia e giorno, cosi si sa cosa e partito e quando', () => {
    expect(marcatore(7, '2026-08-29')).toBe('7:2026-08-29')
  })
})
