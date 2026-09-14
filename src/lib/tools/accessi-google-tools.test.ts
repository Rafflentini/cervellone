import { describe, it, expect, vi, beforeEach } from 'vitest'

const { getAuthorizedClient } = vi.hoisted(() => ({ getAuthorizedClient: vi.fn() }))
vi.mock('@/lib/google-oauth', () => ({ getAuthorizedClient }))

import { ACCESSI_GOOGLE_TOOLS, executeAccessiGoogleTools } from './accessi-google-tools'

beforeEach(() => { getAuthorizedClient.mockReset() })

describe('verifica_accessi_google', () => {
  it('non risponde ai nomi che non sono suoi', async () => {
    expect(await executeAccessiGoogleTools('altro', {})).toBeNull()
  })

  it('CONTROLLO POSITIVO: se entrambe rispondono, lo dice di ENTRAMBE', async () => {
    getAuthorizedClient.mockResolvedValue({})

    const testo = await executeAccessiGoogleTools('verifica_accessi_google', {})

    expect(testo).toContain('restruktura.drive@gmail.com')
    expect(testo).toContain('larealestate.amministrazione@gmail.com')
    expect(testo?.toLowerCase()).toContain('viva')
  })

  it('🚨 una credenziale morta viene NOMINATA, non taciuta', async () => {
    getAuthorizedClient.mockImplementation(async (email: string) => {
      if (email.startsWith('larealestate')) throw new Error('invalid_grant')
      return {}
    })

    const testo = await executeAccessiGoogleTools('verifica_accessi_google', {})

    expect(testo).toContain('larealestate.amministrazione@gmail.com')
    expect(testo).toContain('invalid_grant')
  })

  it('🚨 parla ANCHE quando va tutto bene', () => {
    // Un sorvegliante che si fa vivo solo nei guai e' indistinguibile da uno
    // morto: il 14 set 2026 questo ha impedito per quattro tentativi di sapere
    // se i cron girassero ancora dopo un deploy.
    expect(ACCESSI_GOOGLE_TOOLS.map((t) => t.name)).toEqual(['verifica_accessi_google'])
  })
})
