import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stesso schema di mail.test.ts: isola il modulo dai suoi import pesanti
// (googleapis dentro gmail-tools, env a load-time di ../supabase) così il
// test resta veloce invece di cadere per timeout.
vi.mock('../supabase', () => ({ supabase: {} }))
vi.mock('../gmail-summary', () => ({ buildDailySummary: async () => ({ digest: '' }) }))
vi.mock('@/v19/tools/email', () => ({ MAIL_TOOL_EXECUTORS: {}, MAIL_TOOL_DEFINITIONS: [] }))
vi.mock('@/lib/sent-mail', () => ({ recordSentMail: async () => {} }))
vi.mock('../gmail-tools', () => ({
  readMessage: vi.fn(),
  listInbox: async () => [],
  searchGmail: async () => [],
  readThread: async () => [],
  createDraft: async () => ({}),
  listDrafts: async () => [],
  showDraft: vi.fn(),
  deleteDraft: async () => {},
  sendDraft: async () => ({}),
  applyLabel: async () => {},
  removeLabel: async () => {},
  listLabels: async () => [],
  markAsRead: async () => {},
  archive: async () => {},
  trash: async () => {},
}))

import { readMessage } from '../gmail-tools'
import { executeGmailWrapper } from './mail'

const messaggioFinto = {
  id: 'm1', threadId: 't1', from: 'a@b.it', to: 'c@d.it', subject: 'ciao',
  snippet: '', date: '2026-09-14T10:00:00Z', labelIds: [], hasAttachments: false,
  bodyText: 'corpo del messaggio', bodyHtml: '', headers: {}, attachments: [],
}

/** Errore 404 dell'API Google — la forma vera (gaxios mette lo status qui). */
const errore404 = () => Object.assign(new Error('Requested entity was not found.'), { code: 404 })
/** Errore VERO — token morto, non un 404. */
const erroreVero = () => Object.assign(new Error('invalid_grant: token morto'), { code: 401 })

describe('gmail_read_message: "non trovato" in una casella non e un guasto (Correzione 1)', () => {
  beforeEach(() => {
    vi.mocked(readMessage).mockReset()
  })

  it('trovato in una casella, "non trovato" nell altra: nessun avviso di guasto nel testo', async () => {
    vi.mocked(readMessage).mockImplementation(async (casella) => {
      if (casella === 'larealestate') throw errore404()
      return messaggioFinto
    })

    const testo = await executeGmailWrapper('gmail_read_message', { message_id: 'm1' })

    expect(testo).not.toContain('⚠️')
    expect(testo).not.toContain('larealestate')
    expect(testo).toContain('corpo del messaggio')
  })

  it('🚨 CONTROLLO POSITIVO: un errore VERO (token morto, 401) resta un avviso di guasto', async () => {
    // Prova che il predicato "non trovato" non sia diventato una scusa per
    // ingoiare tutto: un 401 vero deve ancora comparire nel testo.
    vi.mocked(readMessage).mockImplementation(async (casella) => {
      if (casella === 'drive') throw erroreVero()
      throw errore404()
    })

    const testo = await executeGmailWrapper('gmail_read_message', { message_id: 'm1' })

    expect(testo).toContain('⚠️ NON ho potuto guardare in drive')
    expect(testo).toContain('token morto')
  })

  it('nessuna casella ha l id: testo informativo, non un allarme', async () => {
    vi.mocked(readMessage).mockImplementation(async () => { throw errore404() })

    const testo = await executeGmailWrapper('gmail_read_message', { message_id: 'm1' })

    expect(testo).toContain('non trovato in nessuna casella')
    expect(testo).not.toContain('⚠️')
  })
})
