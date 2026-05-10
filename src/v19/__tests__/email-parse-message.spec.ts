import { describe, it, expect } from 'vitest'
import { parseRfc822, toSnippet } from '../tools/email/parse-message'

const SAMPLE = Buffer.from(
  'From: sender@example.com\r\n' +
    'To: info@restruktura.it\r\n' +
    'Subject: Test fattura\r\n' +
    'Date: Mon, 11 May 2026 10:00:00 +0200\r\n' +
    'Message-ID: <abc123@example.com>\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    '\r\n' +
    'Corpo della mail con testo che contiene oltre 200 caratteri usato per validare lo snippet. Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
)

describe('parse-message', () => {
  it('estrae header e body da RFC822', async () => {
    const p = await parseRfc822(SAMPLE)
    expect(p.from).toBe('sender@example.com')
    expect(p.to).toEqual(['info@restruktura.it'])
    expect(p.subject).toBe('Test fattura')
    expect(p.messageId).toBe('<abc123@example.com>')
    expect(p.text).toContain('Corpo della mail')
    expect(p.attachments).toEqual([])
    expect(p.date instanceof Date).toBe(true)
  })

  it('toSnippet ritorna max 200 char', () => {
    const long = 'a'.repeat(500)
    expect(toSnippet(long).length).toBeLessThanOrEqual(200)
  })

  it('toSnippet collassa whitespace e trim', () => {
    expect(toSnippet('   hello\n\n  world  \t\t  ')).toBe('hello world')
  })
})
