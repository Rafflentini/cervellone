import { describe, it, expect, vi, beforeEach } from 'vitest'

// ⚠️ vi.hoisted: una `const` normale finirebbe in TDZ sotto la factory issata.
const { getAuthorizedClient } = vi.hoisted(() => ({ getAuthorizedClient: vi.fn() }))
vi.mock('@/lib/google-oauth', () => ({ getAuthorizedClient }))

const { gmailApi } = vi.hoisted(() => ({
  gmailApi: {
    users: {
      messages: {
        list: vi.fn(async () => ({ data: { messages: [] } })),
        get: vi.fn(async () => ({ data: {} })),
      },
    },
  },
}))
vi.mock('googleapis', () => ({ google: { gmail: () => gmailApi } }))

import { listInbox } from './gmail-tools'

beforeEach(() => {
  // ⚠️ corpo a BLOCCO: `() => mock.mockReset()` restituirebbe la spia, e vitest
  // la richiamerebbe come teardown dopo ogni test.
  getAuthorizedClient.mockReset()
  getAuthorizedClient.mockResolvedValue({})
  gmailApi.users.messages.list.mockClear()
})

describe('gmail-tools — la casella la dice il chiamante', () => {
  it('🚨 apre la casella CHIESTA, non quella di Restruktura', async () => {
    await listInbox('larealestate')

    expect(getAuthorizedClient).toHaveBeenCalledWith('larealestate.amministrazione@gmail.com')
  })

  it('CONTROLLO POSITIVO: chiedendo drive apre quella di Restruktura', async () => {
    // Senza questo, una funzione che apre SEMPRE La Real Estate passerebbe il
    // test qui sopra — e avremmo spostato il difetto invece di chiuderlo.
    await listInbox('drive')

    expect(getAuthorizedClient).toHaveBeenCalledWith('restruktura.drive@gmail.com')
  })

  it('🚨 una casella TopHost non e apribile da qui, e lo DICE', async () => {
    // `info` e `raffaele` non hanno un account Google: aprirle con questo
    // trasporto e' un errore del chiamante, non una casella vuota.
    await expect(listInbox('info' as never)).rejects.toThrow(/non e una casella Google|info/)
  })
})
