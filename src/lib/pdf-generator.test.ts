/**
 * Test unit per generatePdfFromHtml — mocka puppeteer-core e @sparticuz/chromium.
 * Vedi docs/superpowers/specs/2026-05-08-cervellone-pdf-puppeteer-design.md
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPdfBytes = Buffer.from('%PDF-1.7\n'.padEnd(30000, ' '))

vi.mock('puppeteer-core', () => ({
  default: {
    launch: vi.fn(),
  },
}))

vi.mock('@sparticuz/chromium', () => ({
  default: {
    args: ['--no-sandbox'],
    executablePath: vi.fn(async () => '/tmp/chromium'),
    headless: 'shell',
    setHeadlessMode: vi.fn(),
    setGraphicsMode: false,
  },
}))

import puppeteer from 'puppeteer-core'
import { generatePdfFromHtml } from './pdf-generator'

function makeMockBrowser(opts: {
  setContent?: ReturnType<typeof vi.fn>
  pdf?: ReturnType<typeof vi.fn>
  close?: ReturnType<typeof vi.fn>
} = {}) {
  const setContent = opts.setContent ?? vi.fn(async () => undefined)
  const pdf = opts.pdf ?? vi.fn(async () => mockPdfBytes)
  const closePage = vi.fn(async () => undefined)
  const closeBrowser = opts.close ?? vi.fn(async () => undefined)
  return {
    newPage: vi.fn(async () => ({
      setContent,
      pdf,
      close: closePage,
    })),
    close: closeBrowser,
  }
}

describe('generatePdfFromHtml', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns Buffer with PDF magic bytes', async () => {
    vi.mocked(puppeteer.launch).mockResolvedValueOnce(makeMockBrowser() as never)

    const buf = await generatePdfFromHtml('<p>test</p>', 'Test Doc')

    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.subarray(0, 5).toString('ascii')).toBe('%PDF-')
    expect(puppeteer.launch).toHaveBeenCalledOnce()
  })

  it('wraps HTML fragment with boilerplate when missing <html>', async () => {
    const setContent = vi.fn(async () => undefined)
    vi.mocked(puppeteer.launch).mockResolvedValueOnce(makeMockBrowser({ setContent }) as never)

    await generatePdfFromHtml('<p>frammento</p>', 'Test')

    const passedHtml = setContent.mock.calls[0][0] as string
    expect(passedHtml).toContain('<!DOCTYPE html>')
    expect(passedHtml).toContain('<title>Test</title>')
    expect(passedHtml).toContain('<p>frammento</p>')
  })

  it('does NOT double-wrap if HTML already has <html> tag', async () => {
    const setContent = vi.fn(async () => undefined)
    vi.mocked(puppeteer.launch).mockResolvedValueOnce(makeMockBrowser({ setContent }) as never)

    const fullDoc = '<!DOCTYPE html><html><head><title>Mio</title></head><body>x</body></html>'
    await generatePdfFromHtml(fullDoc, 'Ignored')

    const passedHtml = setContent.mock.calls[0][0] as string
    expect(passedHtml).toBe(fullDoc)
  })

  it('escapes HTML in title to prevent injection', async () => {
    const setContent = vi.fn(async () => undefined)
    vi.mocked(puppeteer.launch).mockResolvedValueOnce(makeMockBrowser({ setContent }) as never)

    await generatePdfFromHtml('<p>x</p>', 'Doc <script>alert(1)</script>')

    const passedHtml = setContent.mock.calls[0][0] as string
    expect(passedHtml).toContain('Doc &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(passedHtml).not.toContain('<title>Doc <script>')
  })

  it('always closes browser, even on pdf error', async () => {
    const closeBrowser = vi.fn(async () => undefined)
    const pdf = vi.fn(async () => {
      throw new Error('pdf render failed')
    })
    vi.mocked(puppeteer.launch).mockResolvedValueOnce(makeMockBrowser({ pdf, close: closeBrowser }) as never)

    await expect(generatePdfFromHtml('<p>x</p>', 'T')).rejects.toThrow('pdf render failed')
    expect(closeBrowser).toHaveBeenCalledOnce()
  })

  it('uses A4 + printBackground + margins + footer template', async () => {
    const pdf = vi.fn(async () => mockPdfBytes)
    vi.mocked(puppeteer.launch).mockResolvedValueOnce(makeMockBrowser({ pdf }) as never)

    await generatePdfFromHtml('<p>x</p>', 'T')

    expect(pdf).toHaveBeenCalledOnce()
    const opts = pdf.mock.calls[0][0] as Record<string, unknown>
    expect(opts.format).toBe('A4')
    expect(opts.printBackground).toBe(true)
    expect(opts.displayHeaderFooter).toBe(true)
    expect(opts.footerTemplate).toContain('RESTRUKTURA')
    expect(opts.footerTemplate).toContain('pageNumber')
  })
})
