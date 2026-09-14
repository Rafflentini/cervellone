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
