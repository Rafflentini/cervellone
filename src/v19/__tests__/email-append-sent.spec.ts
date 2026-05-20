import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../tools/email/connection', () => ({
  openImap: vi.fn(),
  closeImap: vi.fn(),
}))
import { appendToSent } from '../tools/email/append-sent'
import { openImap, closeImap } from '../tools/email/connection'

describe('appendToSent', () => {
  beforeEach(() => vi.clearAllMocks())

  it('appende su "Sent" se presente nella list', async () => {
    const client = {
      list: vi.fn().mockResolvedValue([{ path: 'INBOX' }, { path: 'Sent' }, { path: 'Trash' }]),
      append: vi.fn().mockResolvedValue({ uid: 555, path: 'Sent' }),
    }
    ;(openImap as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(client)
    const res = await appendToSent('info', Buffer.from('raw'))
    expect(client.append).toHaveBeenCalledWith('Sent', expect.any(Buffer), ['\\Seen'])
    expect(res.path).toBe('Sent')
    expect(res.uid).toBe(555)
    expect(closeImap).toHaveBeenCalled()
  })

  it('fallback a "INBOX.Sent" se "Sent" assente', async () => {
    const client = {
      list: vi.fn().mockResolvedValue([{ path: 'INBOX' }, { path: 'INBOX.Sent' }]),
      append: vi.fn().mockResolvedValue({ uid: 7, path: 'INBOX.Sent' }),
    }
    ;(openImap as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(client)
    const res = await appendToSent('info', Buffer.from('raw'))
    expect(res.path).toBe('INBOX.Sent')
  })

  it('throw se nessuna Sent folder trovata', async () => {
    const client = { list: vi.fn().mockResolvedValue([{ path: 'INBOX' }]) }
    ;(openImap as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(client)
    await expect(appendToSent('info', Buffer.from('raw'))).rejects.toThrow(/Sent folder/i)
    expect(closeImap).toHaveBeenCalled()
  })

  it('throw se client.append fallisce (es. permission/quota) — caller gestisce atomicità', async () => {
    // Contratto: appendToSent throw qualsiasi errore IMAP. sendEmailInternal
    // wrappa la chiamata in try/catch per non rollbackare la SMTP send già
    // andata a buon fine (vedi email-send.spec.ts test atomicità).
    const client = {
      list: vi.fn().mockResolvedValue([{ path: 'Sent' }]),
      append: vi.fn().mockRejectedValue(new Error('NO Permission denied')),
    }
    ;(openImap as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(client)
    await expect(appendToSent('info', Buffer.from('raw'))).rejects.toThrow(/Permission denied/)
    expect(closeImap).toHaveBeenCalled()
  })
})
