import { describe, it, expect } from 'vitest'
import { detectStrategy } from './file-pipeline'

describe('detectStrategy', () => {
  it.each([
    // NATIVE — whitelist explicit
    ['application/pdf', 'doc.pdf', 'native'],
    ['image/jpeg', 'foto.jpg', 'native'],
    ['image/png', 'screenshot.png', 'native'],
    ['image/webp', 'foto.webp', 'native'],
    ['image/heic', 'apple.heic', 'native'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'doc.docx', 'native'],
    ['application/msword', 'old.doc', 'native'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet.xlsx', 'native'],
    ['application/vnd.ms-excel', 'old.xls', 'native'],
    ['application/vnd.oasis.opendocument.spreadsheet', 'sheet.ods', 'native'],
    ['text/plain', 'note.txt', 'native'],
    ['text/csv', 'data.csv', 'native'],
    ['text/markdown', 'README.md', 'native'],
    // CUSTOM — Files API
    ['application/octet-stream', 'DURC.pdf.p7m', 'files-api'],
    ['application/dxf', 'tavola.dxf', 'files-api'],
    ['application/acad', 'pianta.dwg', 'files-api'],
    ['application/xml', 'fattura.xml', 'files-api'],
    ['text/xml', 'fattura.xml', 'files-api'],
    ['application/zip', 'archive.zip', 'files-api'],
    ['message/rfc822', 'email.eml', 'files-api'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'slides.pptx', 'files-api'],
    ['', 'unknown.xyz', 'files-api'],
    ['application/octet-stream', 'random.bin', 'files-api'],
  ])('%s + %s → %s', (mime, name, expected) => {
    expect(detectStrategy(mime, name)).toBe(expected)
  })
})
