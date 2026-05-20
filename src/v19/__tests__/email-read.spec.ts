import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../tools/email/connection', () => ({
  openImap: vi.fn(),
  closeImap: vi.fn(),
}))
vi.mock('../tools/email/audit', () => ({ logEmail: vi.fn() }))

import { readEmail } from '../tools/email/read-email'
import { openImap, closeImap } from '../tools/email/connection'

type FakeMsg = {
  uid: number
  envelope: {
    from: Array<{ address: string }>
    to: Array<{ address: string }>
    subject: string
    date: Date
    messageId: string
  }
  flags: Set<string>
  size: number
}

function fakeClient(messages: FakeMsg[]) {
  return {
    mailboxOpen: vi.fn().mockResolvedValue({ exists: messages.length }),
    mailboxClose: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line require-yield
    fetch: vi.fn().mockImplementation(async function* () {
      for (const m of messages) {
        yield {
          uid: m.uid,
          envelope: m.envelope,
          flags: m.flags,
          size: m.size,
          bodyStructure: { childNodes: [] },
        }
      }
    }),
    search: vi.fn().mockResolvedValue(messages.map((m) => m.uid)),
  } as unknown as Parameters<typeof readEmail>[0] extends never ? never : any
}

describe('read_email', () => {
  beforeEach(() => vi.clearAllMocks())

  it('ritorna lista UID + metadata da INBOX', async () => {
    const client = fakeClient([
      {
        uid: 101,
        envelope: {
          from: [{ address: 'a@x.com' }],
          to: [{ address: 'info@restruktura.it' }],
          subject: 'Hello',
          date: new Date('2026-05-10T10:00:00Z'),
          messageId: '<m1@x>',
        },
        flags: new Set(['\\Seen']),
        size: 1024,
      },
    ])
    ;(openImap as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(client)

    const r = await readEmail({ account: 'info', folder: 'INBOX', limit: 10 })
    expect(r.messages.length).toBe(1)
    expect(r.messages[0].uid).toBe(101)
    expect(r.messages[0].from).toBe('a@x.com')
    expect(r.messages[0].subject).toBe('Hello')
    expect(r.messages[0].seen).toBe(true)
    expect(closeImap).toHaveBeenCalled()
  })

  it('applica filtro since', async () => {
    const client = fakeClient([])
    ;(openImap as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(client)
    await readEmail({ account: 'info', since: '2026-05-01', limit: 5 })
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({ since: expect.any(Date) }),
      expect.anything(),
    )
  })

  it('chiude IMAP anche su errore', async () => {
    const client = fakeClient([])
    client.mailboxOpen = vi.fn().mockRejectedValue(new Error('boom'))
    ;(openImap as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(client)
    await expect(readEmail({ account: 'info' })).rejects.toThrow('boom')
    expect(closeImap).toHaveBeenCalled()
  })
})
