import { describe, it, expect, vi, beforeEach } from 'vitest'

const righe: Array<{ role: string; testo: string; istante?: string }> = []
const embedding: string[] = []
let ritardo = 0
let esito: boolean = true

vi.mock('./memory', () => ({
  saveMessageOnly: async (_c: string, role: string, testo: string, istante?: string) => {
    if (ritardo) await new Promise((r) => setTimeout(r, ritardo))
    righe.push({ role, testo, istante })
    return esito
  },
  saveEmbeddingOnly: async (_c: string, _r: string, testo: string) => { embedding.push(testo); return true },
}))

const sfondo: Promise<unknown>[] = []
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => { sfondo.push(p) } }))

import { salvaRispostaTurno } from './salva-risposta'

beforeEach(() => {
  righe.length = 0; embedding.length = 0; sfondo.length = 0; ritardo = 0; esito = true
  vi.restoreAllMocks()
})

describe('salvaRispostaTurno', () => {
  it('scrive la riga con l istante del turno e genera l embedding', async () => {
    await salvaRispostaTurno({ conversationId: 'c1', testo: 'risposta', turnoFallito: false, istante: '2026-09-09T00:00:00Z', tag: 'tg' })
    expect(righe).toEqual([{ role: 'assistant', testo: 'risposta', istante: '2026-09-09T00:00:00Z' }])
    await Promise.all(sfondo)
    expect(embedding).toEqual(['risposta'])
  })

  it('un turno fallito entra nella storia ma NON in memoria semantica', async () => {
    await salvaRispostaTurno({ conversationId: 'c1', testo: 'errore', turnoFallito: true, istante: 'x', tag: 'tg' })
    expect(righe).toHaveLength(1)
    await Promise.all(sfondo)
    expect(embedding).toEqual([])
  })

  it('una scrittura lenta non tiene appeso il turno, ma non si perde', async () => {
    ritardo = 6_000
    await salvaRispostaTurno({ conversationId: 'c1', testo: 'lenta', turnoFallito: false, istante: 'x', tag: 'tg' })
    expect(righe).toHaveLength(0)
    await Promise.all(sfondo)
    expect(righe).toHaveLength(1)
  }, 20_000)

  it('se la riga NON entra, l embedding non si genera', async () => {
    esito = false
    const errori: string[] = []
    vi.spyOn(console, 'error').mockImplementation((m) => { errori.push(String(m)) })
    await salvaRispostaTurno({ conversationId: 'c1', testo: 'x', turnoFallito: false, istante: 'x', tag: 'tg' })
    await Promise.all(sfondo)
    expect(embedding).toEqual([])
    expect(errori.join(' ')).toContain('RISPOSTA NON SALVATA')
  })

  it('senza conversazione, o con testo vuoto, non scrive niente', async () => {
    await salvaRispostaTurno({ conversationId: '', testo: 'x', turnoFallito: false, istante: 'x', tag: 'tg' })
    await salvaRispostaTurno({ conversationId: 'c1', testo: '   ', turnoFallito: false, istante: 'x', tag: 'tg' })
    expect(righe).toEqual([])
  })
})
