import { describe, it, expect } from 'vitest'
import { leggiSuTutteLeGoogle } from '../politica-caselle'

describe('lettura su piu caselle', () => {
  it('senza caselle indicate guarda TUTTE le Google, e marca la provenienza', async () => {
    const esito = await leggiSuTutteLeGoogle(undefined, async (c) => [{ id: `msg-${c}` }])

    expect(esito.risultati).toHaveLength(2)
    expect(esito.risultati.map((r) => r.casella).sort()).toEqual(['drive', 'larealestate'])
    expect(esito.caselleFallite).toEqual([])
  })

  it('con le caselle indicate guarda SOLO quelle', async () => {
    const esito = await leggiSuTutteLeGoogle(['larealestate'], async (c) => [{ id: `msg-${c}` }])

    expect(esito.risultati).toHaveLength(1)
    expect(esito.risultati[0].casella).toBe('larealestate')
  })

  it('🚨 una casella che FALLISCE non sparisce: finisce nell esito', async () => {
    // Un elenco parziale che sembra completo e' il difetto di famiglia di
    // questa casa: quattro mesi di fatture estere a zero, sei rapporti di
    // autodiagnosi mai consegnati. Chi legge deve sapere che manca un pezzo.
    const esito = await leggiSuTutteLeGoogle(undefined, async (c) => {
      if (c === 'larealestate') throw new Error('token morto')
      return [{ id: `msg-${c}` }]
    })

    expect(esito.risultati).toHaveLength(1)
    expect(esito.caselleFallite).toHaveLength(1)
    expect(esito.caselleFallite[0].casella).toBe('larealestate')
    expect(esito.caselleFallite[0].errore).toContain('token morto')
  })

  it('CONTROLLO POSITIVO: se falliscono TUTTE, non finge un risultato vuoto', async () => {
    // «nessuna mail trovata» e «non ho potuto guardare» sono cose diverse.
    const esito = await leggiSuTutteLeGoogle(undefined, async () => { throw new Error('giu') })

    expect(esito.risultati).toEqual([])
    expect(esito.caselleFallite).toHaveLength(2)
  })
})

// Correzione 1 (14 settembre 2026): il fan-out ha senso per cercare ed
// elencare, non per leggere per ID — un ID sta in UNA casella sola, l'altra
// dira' sempre «non trovato», e prima di questa correzione quel «non trovato»
// finiva in `caselleFallite` come se fosse un guasto: un falso allarme a ogni
// singola lettura per ID.
describe('lettura per ID: "non trovato" non e un guasto', () => {
  const nonTrovato = (e: unknown) => e instanceof Error && e.message === 'non trovato'

  it('una casella risponde "non trovato" e l altra ha il messaggio: un risultato, caselleFallite vuoto', async () => {
    const esito = await leggiSuTutteLeGoogle(undefined, async (c) => {
      if (c === 'drive') throw new Error('non trovato')
      return [{ id: `msg-${c}` }]
    }, { nonTrovato })

    expect(esito.risultati).toHaveLength(1)
    expect(esito.risultati[0].casella).toBe('larealestate')
    expect(esito.caselleFallite).toEqual([])
  })

  it('🚨 CONTROLLO POSITIVO: un errore VERO (token morto) finisce comunque in caselleFallite', async () => {
    // Senza questo controllo, un predicato "nonTrovato" che dicesse sempre
    // vero passerebbe il test sopra e avrebbe spento la guardia: la perdita
    // silenziosa, il difetto peggiore, tornata dalla porta opposta.
    const esito = await leggiSuTutteLeGoogle(undefined, async (c) => {
      if (c === 'drive') throw new Error('token morto')
      throw new Error('non trovato')
    }, { nonTrovato })

    expect(esito.risultati).toEqual([])
    expect(esito.caselleFallite).toHaveLength(1)
    expect(esito.caselleFallite[0].casella).toBe('drive')
    expect(esito.caselleFallite[0].errore).toContain('token morto')
  })

  it('nessuna casella ha l id: zero risultati, caselleFallite vuoto (un dato, non un guasto)', async () => {
    const esito = await leggiSuTutteLeGoogle(undefined, async () => { throw new Error('non trovato') }, { nonTrovato })

    expect(esito.risultati).toEqual([])
    expect(esito.caselleFallite).toEqual([])
  })
})
