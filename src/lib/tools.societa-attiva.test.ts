/**
 * Dal web NON si poteva cambiare societa'.
 *
 * `setSocietaAttiva` aveva un solo chiamante in tutto il repo: il comando
 * `/societa` di Telegram. Quindi ogni conversazione nata sulla chat web
 * restava per sempre su `restruktura` — il default — e il blocco iniettato nel
 * contesto AFFERMAVA quella societa' con autorita', invitando per giunta a
 * usare un comando che sul web non esiste.
 *
 * Il danno non e' teorico: `confirmSalStep2` riceve la societa' attiva, quindi
 * un SAL de La Real Estate confermato dalla chat web usciva intestato a
 * Restruktura, con la partita IVA sbagliata in fondo al PDF.
 *
 * La forma giusta e' un TOOL, non un comando: `getToolDefinitions()` non
 * conosce i canali, quindi un tool nasce equipollente per costruzione.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSet = vi.fn()
const mockGet = vi.fn()
vi.mock('./societa-attiva', async (importOriginal) => {
  const vero = await importOriginal<typeof import('./societa-attiva')>()
  return { ...vero, setSocietaAttiva: mockSet, getSocietaAttiva: mockGet }
})

beforeEach(() => {
  vi.clearAllMocks()
  mockSet.mockResolvedValue({ ok: true })
  mockGet.mockResolvedValue('restruktura')
})

describe('imposta_societa_attiva — il tool che mancava al web', () => {
  it('e dichiarato fra i tool, quindi lo vedono ENTRAMBI i canali', async () => {
    const { getToolDefinitions } = await import('./tools')
    const nomi = getToolDefinitions().map((t) => t.name)
    expect(nomi).toContain('imposta_societa_attiva')
  }, 30_000)

  it('scrive la societa scelta per QUESTA conversazione', async () => {
    const { executeTool } = await import('./tools')
    const esito = await executeTool('imposta_societa_attiva', { societa: 'larealestate' }, 'conv-1')
    expect(mockSet).toHaveBeenCalledWith('conv-1', 'larealestate')
    expect(esito).toContain('LA REAL ESTATE')
  })

  // Un codice inventato non deve produrre operazioni su un'azienda fantasma.
  it('un codice sconosciuto non scrive niente', async () => {
    const { executeTool } = await import('./tools')
    const esito = await executeTool('imposta_societa_attiva', { societa: 'acme' }, 'conv-1')
    expect(mockSet).not.toHaveBeenCalled()
    expect(esito.toLowerCase()).toContain('non riconosciut')
  })

  it('senza conversazione non scrive niente', async () => {
    const { executeTool } = await import('./tools')
    const esito = await executeTool('imposta_societa_attiva', { societa: 'larealestate' }, undefined)
    expect(mockSet).not.toHaveBeenCalled()
    expect(esito).toContain('Contesto conversazione non disponibile')
  })

  it('se la scrittura fallisce lo DICE, non finge', async () => {
    mockSet.mockResolvedValue({ ok: false, error: 'tabella assente' })
    const { executeTool } = await import('./tools')
    const esito = await executeTool('imposta_societa_attiva', { societa: 'larealestate' }, 'conv-1')
    expect(esito).toContain('⚠️')
    expect(esito).toContain('tabella assente')
  })

  // CONTROLLO POSITIVO sul blocco di contesto: finche' il testo invitava a
  // "usare /societa", un utente del web leggeva l'istruzione per un comando
  // che sul suo canale non esiste.
  it('il blocco di contesto non manda piu l utente su un comando che il web non ha', async () => {
    const { bloccoSocietaAttiva } = await import('./societa-attiva')
    const { getSocieta } = await import('./societa')
    const testo = bloccoSocietaAttiva(getSocieta('restruktura')!)
    expect(testo).not.toContain('/societa')
    expect(testo).toContain('imposta_societa_attiva')
  })
})
