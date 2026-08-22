/**
 * Le credenziali Google devono essere scelte PER CASELLA.
 *
 * Prima: `getAuthorizedClient()` prendeva la riga con `updated_at` più recente.
 * Ma un listener riscrive `updated_at` a ogni rinnovo automatico del token, che
 * avviene in sottofondo: con due caselle collegate, quale fosse quella attiva
 * cambiava DA SOLO, senza errori e in modo intermittente. La stessa funzione
 * serve Drive, Gmail, Calendar e il salvataggio documenti — cioè un documento
 * de La Real Estate poteva finire nel Drive di Restruktura.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Registra su quale email viene fatta la query e quale riga viene restituita
let emailRichiesta: string | null = null

const CREDENZIALI: Record<string, { refresh_token: string }> = {
  'restruktura.drive@gmail.com': { refresh_token: 'REFRESH-RESTRUKTURA' },
  'larealestate.amministrazione@gmail.com': { refresh_token: 'REFRESH-LAREALESTATE' },
}

vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      select: () => ({
        eq: (_col: string, valore: string) => {
          emailRichiesta = valore
          const riga = CREDENZIALI[valore]
          return {
            maybeSingle: async () => ({
              data: riga ? { ...riga, access_token: 'a', access_token_expires_at: null } : null,
              error: null,
            }),
            single: async () => ({
              data: riga ? { ...riga, access_token: 'a', access_token_expires_at: null } : null,
              error: riga ? null : { message: 'not found' },
            }),
          }
        },
      }),
      update: () => ({ eq: async () => ({ error: null }) }),
      upsert: async () => ({ error: null }),
    }),
  }),
}))

const setCredentialsSpy = vi.fn()
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials = setCredentialsSpy
        on = vi.fn()
        getAccessToken = vi.fn().mockResolvedValue({ token: 'ok' })
      },
    },
  },
}))

describe('credenziali Google per casella', () => {
  beforeEach(() => {
    emailRichiesta = null
    setCredentialsSpy.mockClear()
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'id'
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret'
  })

  it('interroga il database sulla casella richiesta', async () => {
    const { getAuthorizedClient } = await import('./google-oauth')
    await getAuthorizedClient('larealestate.amministrazione@gmail.com')

    expect(emailRichiesta).toBe('larealestate.amministrazione@gmail.com')
  })

  // Il cuore del task: la casella richiesta vince SEMPRE, anche se l'altra
  // e stata aggiornata dopo da un rinnovo automatico del token.
  it('usa il refresh token della casella richiesta, non dell ultima aggiornata', async () => {
    const { getAuthorizedClient } = await import('./google-oauth')
    await getAuthorizedClient('restruktura.drive@gmail.com')

    expect(setCredentialsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ refresh_token: 'REFRESH-RESTRUKTURA' })
    )
  })

  it('casella sconosciuta: ritorna null senza ripiegare su un altra', async () => {
    const { getAuthorizedClient } = await import('./google-oauth')
    const client = await getAuthorizedClient('inesistente@gmail.com')

    expect(client).toBeNull()
    expect(setCredentialsSpy).not.toHaveBeenCalled()
  })
})
