import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { renderDocx } from '../render/docx'
import type { DocxDocument } from '../render/types'

async function unzipDocx(buf: Buffer): Promise<{ documentXml: string; files: string[] }> {
  const zip = await JSZip.loadAsync(buf)
  const documentXml = (await zip.file('word/document.xml')?.async('string')) ?? ''
  const files = Object.keys(zip.files)
  return { documentXml, files }
}

function isZipMagic(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b
}

describe('renderDocx', () => {
  it('produce un DOCX (ZIP) valido per documento minimale', async () => {
    const doc: DocxDocument = {
      title: 'Test V19',
      sections: [{ kind: 'paragraph', text: 'Hello world' }],
    }
    const buf = await renderDocx(doc)
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(isZipMagic(buf)).toBe(true)
    const { documentXml, files } = await unzipDocx(buf)
    expect(files).toContain('word/document.xml')
    expect(documentXml).toContain('Hello world')
    expect(documentXml).toContain('Test V19')
  })

  it('rende tabella nativa Word (presenza w:tbl, w:tr, w:tc)', async () => {
    const doc: DocxDocument = {
      title: 'Test Tabella',
      sections: [
        {
          kind: 'table',
          columns: [
            { header: 'Col A' },
            { header: 'Col B' },
          ],
          rows: [
            ['a1', 'b1'],
            ['a2', 'b2'],
          ],
        },
      ],
    }
    const buf = await renderDocx(doc)
    const { documentXml } = await unzipDocx(buf)
    expect(documentXml).toContain('<w:tbl>')
    expect(documentXml.match(/<w:tr/g)?.length ?? 0).toBeGreaterThanOrEqual(3) // 1 header + 2 data
    expect(documentXml.match(/<w:tc/g)?.length ?? 0).toBeGreaterThanOrEqual(6) // 3*2
  })

  it('header tabella con bgColor inserisce shading XML', async () => {
    const doc: DocxDocument = {
      title: 'Header Color',
      sections: [
        {
          kind: 'table',
          columns: [{ header: 'X' }],
          headerStyle: { bgColor: 'C00000', color: 'FFFFFF', bold: true },
          rows: [['v1']],
        },
      ],
    }
    const buf = await renderDocx(doc)
    const { documentXml } = await unzipDocx(buf)
    expect(documentXml.toLowerCase()).toContain('c00000')
  })

  it('cell borders all inserisce w:tcBorders', async () => {
    const doc: DocxDocument = {
      title: 'Borders',
      sections: [
        {
          kind: 'table',
          columns: [{ header: 'X' }],
          cellBorders: 'all',
          rows: [['v1']],
        },
      ],
    }
    const buf = await renderDocx(doc)
    const { documentXml } = await unzipDocx(buf)
    expect(documentXml).toContain('<w:tcBorders>')
  })

  it('include footer Restruktura di default', async () => {
    const doc: DocxDocument = {
      title: 'Footer Test',
      sections: [{ kind: 'paragraph', text: 'body' }],
    }
    const buf = await renderDocx(doc)
    const { documentXml } = await unzipDocx(buf)
    expect(documentXml).toContain('RESTRUKTURA')
    expect(documentXml).toContain('02087420762')
  })

  it('heading level 1/2/3 vanno renderizzati', async () => {
    const doc: DocxDocument = {
      title: 'Headings',
      sections: [
        { kind: 'heading', level: 1, text: 'Cap 1' },
        { kind: 'heading', level: 2, text: 'Sez 1.1' },
        { kind: 'heading', level: 3, text: 'Par 1.1.1' },
      ],
    }
    const buf = await renderDocx(doc)
    const { documentXml } = await unzipDocx(buf)
    expect(documentXml).toContain('Cap 1')
    expect(documentXml).toContain('Sez 1.1')
    expect(documentXml).toContain('Par 1.1.1')
  })
})
