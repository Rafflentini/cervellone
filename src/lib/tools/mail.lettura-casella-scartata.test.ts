import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `caselle: ['info']` non e' un errore di battitura da ignorare: e' una
 * casella che l'utente ha nominato e che questo trasporto non puo' guardare
 * (non e' Google). Prima di questa cura spariva muta — nessuna valida,
 * `caselleRichieste` tornava `undefined`, ed `executeGmailWrapper` guardava
 * TUTTE le caselle Google come se 'info' non fosse mai stata chiesta (audit
 * avversariale, 14 settembre 2026 — la stessa perdita silenziosa che
 * `leggiSuTutteLeGoogle` esiste per chiudere dal lato opposto).
 */

const { listInbox } = vi.hoisted(() => ({ listInbox: vi.fn() }))

vi.mock('../supabase', () => ({ supabase: {} }))
vi.mock('../gmail-tools', () => ({ listInbox }))
vi.mock('../gmail-summary', () => ({ buildDailySummary: async () => '' }))
vi.mock('@/v19/tools/email', () => ({ MAIL_TOOL_EXECUTORS: {}, MAIL_TOOL_DEFINITIONS: [] }))
vi.mock('@/lib/sent-mail', () => ({ recordSentMail: async () => {} }))

import { executeGmailWrapper } from './mail'

beforeEach(() => {
  listInbox.mockReset()
  listInbox.mockResolvedValue([])
})

describe('caselle richieste ma non Google: dette, non taciute', () => {
  it("🚨 caselle: ['info'] (nessuna valida) → lo dice, non guarda tutte le Google in silenzio", async () => {
    const esito = await executeGmailWrapper('gmail_list_inbox', { caselle: ['info'] })

    expect(esito).toContain('info')
    expect(esito).toContain('NON consultate')
    // Ha comunque guardato le Google (fallback quando nessuna valida resta):
    // e' il comportamento voluto, ma va DETTO che 'info' non c'entra.
    expect(listInbox).toHaveBeenCalled()
  })

  it("🚨 caselle: ['drive', 'pippo'] → 'drive' viene guardata, 'pippo' compare come scartata", async () => {
    const esito = await executeGmailWrapper('gmail_list_inbox', { caselle: ['drive', 'pippo'] })

    expect(esito).toContain('pippo')
    expect(esito).toContain('NON consultate')
    expect(listInbox).toHaveBeenCalledTimes(1)
    expect(listInbox.mock.calls[0][0]).toBe('drive')
  })

  it('CONTROLLO POSITIVO: caselle tutte valide → nessuna nota di scarto', async () => {
    const esito = await executeGmailWrapper('gmail_list_inbox', { caselle: ['drive', 'larealestate'] })
    expect(esito).not.toContain('NON consultate')
  })
})
