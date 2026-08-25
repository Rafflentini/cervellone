/**
 * Inizializzazione del foglio di check-in.
 *
 * Due proprieta' contano piu' di tutte, e sono entrambe sulla ripetizione:
 *
 *  1. Rieseguire l'inizializzazione su un foglio gia' pronto NON deve toccare
 *     un solo dato. L'11 agosto il foglio e' rimasto vuoto perche' nessuno ha
 *     cliccato "inizializza"; il rischio speculare e' che qualcuno lo clicchi
 *     due volte a stagione avviata e cancelli i soggiorni registrati.
 *
 *  2. Se qualcosa non riesce, deve DIRLO. Gli helper generici di drive.ts
 *     restituiscono la stringa dell'errore come se fosse un risultato: qui no.
 */
import { describe, it, expect } from 'vitest'
import { inizializzaFoglioCheckin, type FoglioApi } from './foglio-init'
import { COL_SOGGIORNI, CONFIG_DEFAULT, schedeDelFoglio } from './foglio-schema'

/** Foglio finto in memoria: schede -> righe. */
function fintoFoglio(iniziale: Record<string, string[][]> = {}) {
  const dati: Record<string, string[][]> = JSON.parse(JSON.stringify(iniziale))
  const chiamate: string[] = []
  const api: FoglioApi = {
    async elencaSchede() {
      chiamate.push('elencaSchede')
      return Object.keys(dati)
    },
    async creaScheda(_id, nome) {
      chiamate.push(`creaScheda:${nome}`)
      dati[nome] = []
    },
    async leggiPrimaRiga(_id, nome) {
      return dati[nome]?.[0] ?? []
    },
    async scrivi(_id, nome, valori) {
      chiamate.push(`scrivi:${nome}`)
      dati[nome] = valori
    },
    async scriviIntestazioniInCoda(_id, nome, daColonna, intestazioni) {
      chiamate.push(`intestazioniInCoda:${nome}:${daColonna}:${intestazioni.length}`)
      dati[nome][0] = [...(dati[nome][0] ?? []), ...intestazioni]
    },
    async congelaIntestazione(_id, nome) {
      chiamate.push(`congela:${nome}`)
    },
  }
  return { api, dati, chiamate }
}

describe('foglio mai inizializzato', () => {
  it('crea tutte le schede e ci scrive le intestazioni', async () => {
    const { api, dati, chiamate } = fintoFoglio({ Foglio1: [] })
    const esito = await inizializzaFoglioCheckin('FOGLIO-X', api)

    expect(esito.ok).toBe(true)
    // Derivato dallo schema: il test deve rompersi se una scheda non viene
    // creata, non ogni volta che se ne aggiunge una.
    expect(esito.create).toEqual(schedeDelFoglio().map((s) => s.nome))
    expect(dati.Soggiorni[0]).toEqual([...COL_SOGGIORNI])
    expect(chiamate).toContain('congela:Soggiorni')
  })

  it('popola il Config con i valori di partenza, non solo l intestazione', async () => {
    const { api, dati } = fintoFoglio({ Foglio1: [] })
    await inizializzaFoglioCheckin('FOGLIO-X', api)
    expect(dati.Config).toEqual(CONFIG_DEFAULT)
  })

  it('lascia in pace le schede che gia c erano', async () => {
    const { api, dati } = fintoFoglio({ Foglio1: [['roba', 'mia']] })
    await inizializzaFoglioCheckin('FOGLIO-X', api)
    expect(dati.Foglio1).toEqual([['roba', 'mia']])
  })
})

describe('eseguita due volte', () => {
  it('non ricrea le schede e non riscrive niente', async () => {
    const { api } = fintoFoglio({ Foglio1: [] })
    await inizializzaFoglioCheckin('FOGLIO-X', api)
    const secondo = await inizializzaFoglioCheckin('FOGLIO-X', api)

    expect(secondo.ok).toBe(true)
    expect(secondo.create).toEqual([])
    expect(secondo.giaPronte).toEqual(schedeDelFoglio().map((s) => s.nome))
  })

  it('NON cancella i soggiorni gia registrati', async () => {
    // Il caso che rovinerebbe una stagione: reinizializzare a lavoro avviato.
    const soggiorni = [[...COL_SOGGIORNI], ['SOG-1', '', 'Unità 1']]
    const { api, dati, chiamate } = fintoFoglio({
      Soggiorni: soggiorni, Ospiti: [], Config: [], Tabelle: [],
    })
    await inizializzaFoglioCheckin('FOGLIO-X', api)

    expect(dati.Soggiorni).toHaveLength(2)
    expect(dati.Soggiorni[1][0]).toBe('SOG-1')
    expect(chiamate).not.toContain('scrivi:Soggiorni')
  })

  it('completa una scheda esistente ma rimasta senza intestazione', async () => {
    // Caso reale possibile: scheda creata a mano e mai compilata.
    const { api, dati, chiamate } = fintoFoglio({
      Soggiorni: [], Ospiti: [], Config: [], Tabelle: [],
    })
    await inizializzaFoglioCheckin('FOGLIO-X', api)
    expect(dati.Soggiorni[0]).toEqual([...COL_SOGGIORNI])
    expect(chiamate).toContain('scrivi:Soggiorni')
  })
})

describe('quando qualcosa non riesce', () => {
  it('lo dichiara invece di restituire un successo', async () => {
    const { api } = fintoFoglio({ Foglio1: [] })
    api.creaScheda = async () => { throw new Error('quota Google esaurita') }

    const esito = await inizializzaFoglioCheckin('FOGLIO-X', api)
    expect(esito.ok).toBe(false)
    expect(esito.errore).toContain('quota Google esaurita')
  })

  it('dice quali schede aveva gia creato prima di fermarsi', async () => {
    const { api } = fintoFoglio({ Foglio1: [] })
    let n = 0
    const creaVera = api.creaScheda
    api.creaScheda = async (id, nome) => {
      if (++n > 2) throw new Error('interrotto')
      return creaVera(id, nome)
    }
    const esito = await inizializzaFoglioCheckin('FOGLIO-X', api)
    expect(esito.ok).toBe(false)
    expect(esito.create).toEqual(['Soggiorni', 'Ospiti'])
  })
})

describe('lo schema che cresce', () => {
  it('aggiunge in coda le colonne nuove a una scheda gia in uso', async () => {
    // Le colonne si aggiungono, non si riordinano: spostarne una sposterebbe i
    // dati sotto di essa, e il foglio resterebbe pieno di valori plausibili ma
    // slittati di una posizione.
    // Le ultime due colonne dello schema di OGGI, qualunque siano: il test non
    // deve rompersi ogni volta che lo schema cresce, deve rompersi se le
    // colonne nuove smettono di essere aggiunte.
    const nuove = COL_SOGGIORNI.slice(-2) as unknown as string[]
    const vecchie = COL_SOGGIORNI.slice(0, -2) as unknown as string[]
    const { api, dati, chiamate } = fintoFoglio({
      Soggiorni: [vecchie, ['SOG-1', 'x']], Ospiti: [], Config: [], Tabelle: [],
    })
    const esito = await inizializzaFoglioCheckin('FOGLIO-X', api)

    expect(esito.ok).toBe(true)
    expect(esito.colonneAggiunte).toEqual(nuove.map((c) => `Soggiorni: ${c}`))
    // I dati che c erano non sono stati toccati.
    expect(dati.Soggiorni[1][0]).toBe('SOG-1')
    expect(chiamate).not.toContain('scrivi:Soggiorni')
  })

  it('su una scheda gia allineata non aggiunge niente', async () => {
    const { api } = fintoFoglio({
      Soggiorni: [COL_SOGGIORNI as unknown as string[]], Ospiti: [], Config: [], Tabelle: [],
    })
    const esito = await inizializzaFoglioCheckin('FOGLIO-X', api)
    expect(esito.colonneAggiunte.filter((c) => c.startsWith('Soggiorni'))).toEqual([])
  })
})
