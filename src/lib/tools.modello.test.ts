/**
 * Il modello si vede e si cambia da tutti e due i canali.
 *
 * Prima esistevano solo `/opus`, `/sonnet` e `/modello` su Telegram, ma il
 * valore e' GLOBALE: chi lavorava dalla chat web subiva in silenzio la scelta
 * fatta sull'altro canale, senza modo di saperlo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockLeggi = vi.fn()
const mockImposta = vi.fn()
vi.mock('./modello-attivo', () => ({
  leggiModelloAttivo: () => mockLeggi(),
  impostaModello: (s: string, m: number) => mockImposta(s, m),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockLeggi.mockResolvedValue('🧠 Modello attivo: claude-sonnet-5')
  mockImposta.mockResolvedValue('🧠 Modello: Opus')
})

describe('i tool del modello', () => {
  it('sono dichiarati, quindi li vedono ENTRAMBI i canali', async () => {
    const { getToolDefinitions } = await import('./tools')
    const nomi = getToolDefinitions().map((t) => t.name)
    expect(nomi).toContain('modello_attivo')
    expect(nomi).toContain('imposta_modello')
  }, 30_000)

  it('modello_attivo riporta quello che dice il registro', async () => {
    const { executeTool } = await import('./tools')
    expect(await executeTool('modello_attivo', {}, 'c1')).toContain('sonnet')
  })

  it('imposta_modello passa scelta e minuti', async () => {
    const { executeTool } = await import('./tools')
    await executeTool('imposta_modello', { modello: 'Opus', minuti: 90 }, 'c1')
    expect(mockImposta).toHaveBeenCalledWith('opus', 90)
  })

  it('senza minuti si sta su un ora', async () => {
    const { executeTool } = await import('./tools')
    await executeTool('imposta_modello', { modello: 'opus' }, 'c1')
    expect(mockImposta).toHaveBeenCalledWith('opus', 60)
  })

  // Opus costa: un "minuti: 100000" scritto per sbaglio dal modello terrebbe
  // acceso il costoso per due mesi.
  it('i minuti hanno un tetto', async () => {
    const { executeTool } = await import('./tools')
    await executeTool('imposta_modello', { modello: 'opus', minuti: 100000 }, 'c1')
    expect(mockImposta.mock.calls[0][1]).toBeLessThanOrEqual(480)
  })

  it('minuti assurdi o mancanti non rompono niente', async () => {
    const { executeTool } = await import('./tools')
    await executeTool('imposta_modello', { modello: 'opus', minuti: -5 }, 'c1')
    expect(mockImposta).toHaveBeenCalledWith('opus', 60)
  })
})
