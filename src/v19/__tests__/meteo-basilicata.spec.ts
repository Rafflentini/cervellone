import { describe, it, expect, vi } from 'vitest'
import { scaricaBollettinoBasilicata } from '../tools/meteo-basilicata'
import { BollettinoNotFoundError } from '../tools/meteo-basilicata.errors'

function makePdfBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'ascii'),
    Buffer.alloc(2000, 0x20),
    Buffer.from('\n%%EOF\n', 'ascii'),
  ])
}

describe('scaricaBollettinoBasilicata', () => {
  it('scarica con URL .pdf lowercase quando ok', async () => {
    const pdf = makePdfBuffer()
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('Bollettino_Criticita_Regione_Basilicata_15_04_2026.pdf')
      return new Response(pdf as any, {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })
    }) as unknown as typeof fetch
    const r = await scaricaBollettinoBasilicata(new Date('2026-04-15'), { fetchImpl })
    expect(r.fonte).toBe('CFD Basilicata')
    expect(r.pdfUrl).toMatch(/15_04_2026\.pdf$/)
    expect(r.filename).toBe('Bollettino_Criticita_Basilicata_2026-04-15.pdf')
    expect(r.pdfBuffer.length).toBeGreaterThan(1000)
  })

  it('fallback su .PDF uppercase se .pdf 404', async () => {
    const pdf = makePdfBuffer()
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('.pdf')) return new Response('not found', { status: 404 })
      return new Response(pdf as any, { status: 200, headers: { 'content-type': 'application/pdf' } })
    }) as unknown as typeof fetch
    const r = await scaricaBollettinoBasilicata(new Date('2024-10-01'), { fetchImpl })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatch(/\.pdf$/)
    expect(calls[1]).toMatch(/\.PDF$/)
    expect(r.pdfBuffer.length).toBeGreaterThan(1000)
  })

  it('lancia BollettinoNotFoundError se entrambi 404', async () => {
    const fetchImpl = vi.fn(async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
    await expect(
      scaricaBollettinoBasilicata(new Date('2026-04-15'), { fetchImpl }),
    ).rejects.toBeInstanceOf(BollettinoNotFoundError)
  })

  it('respinge risposta non-PDF (magic bytes wrong)', async () => {
    const fakeHtml = Buffer.from('<html>error page</html>'.repeat(200))
    const fetchImpl = vi.fn(async () => new Response(fakeHtml as any, { status: 200 })) as unknown as typeof fetch
    await expect(
      scaricaBollettinoBasilicata(new Date('2026-04-15'), { fetchImpl }),
    ).rejects.toBeInstanceOf(BollettinoNotFoundError)
  })

  it('usa User-Agent custom Cervellone', async () => {
    const pdf = makePdfBuffer()
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      expect(init.headers['User-Agent']).toContain('Cervellone-Restruktura')
      return new Response(pdf as any, { status: 200, headers: { 'content-type': 'application/pdf' } })
    }) as unknown as typeof fetch
    await scaricaBollettinoBasilicata(new Date('2026-04-15'), { fetchImpl })
    expect(fetchImpl).toHaveBeenCalled()
  })
})
