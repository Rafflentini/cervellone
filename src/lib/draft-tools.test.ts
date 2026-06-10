import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock delle dipendenze ──
// Risultato configurabile per la prossima query Supabase (tabella unica: documents).
let nextResult: { data: unknown; error: unknown } = { data: null, error: null }

function makeBuilder() {
  const builder: Record<string, unknown> = {}
  const self = () => builder
  // metodi che ritornano il builder (chaining)
  for (const m of ['select', 'update', 'insert', 'eq', 'order']) builder[m] = self
  // terminali che risolvono il risultato
  builder.single = () => Promise.resolve(nextResult)
  builder.maybeSingle = () => Promise.resolve(nextResult)
  builder.limit = () => Promise.resolve(nextResult)
  // thenable: `await supabase.from().update().eq()` risolve a nextResult
  builder.then = (resolve: (v: unknown) => void) => resolve(nextResult)
  return builder
}

vi.mock('./supabase-server', () => ({
  getSupabaseServer: vi.fn(() => ({ from: () => makeBuilder() })),
}))
vi.mock('./pdf-generator', () => ({
  generatePdfFromHtml: vi.fn(async () => Buffer.from('%PDF-fake')),
}))
vi.mock('./drive', () => ({
  uploadBinaryToDrive: vi.fn(async () => ({ id: 'file1', webViewLink: 'http://drive/file1' })),
  assertWriteAllowed: vi.fn(async () => {}),
  DrivePolicyError: class DrivePolicyError extends Error {},
}))

import {
  listRecentDrafts,
  getDraft,
  updateDraft,
  saveDraftPdfToDrive,
  wrapPlainTextAsHtml,
  looksLikeHtml,
} from './draft-tools'
import { generatePdfFromHtml } from './pdf-generator'
import { uploadBinaryToDrive } from './drive'

beforeEach(() => {
  vi.clearAllMocks()
  nextResult = { data: null, error: null }
})

describe('draft-tools', () => {
  it('getDraft ritorna ok + url /doc/<id>', async () => {
    nextResult = { data: { name: 'POS', content: '<h1>POS</h1>', type: 'html' }, error: null }
    const r = await getDraft('x')
    expect(r.ok).toBe(true)
    expect(r.name).toBe('POS')
    expect(r.url).toBe('/doc/x')
    expect(r.content).toContain('POS')
  })

  it('getDraft ritorna ok:false se non trovato', async () => {
    nextResult = { data: null, error: { message: 'not found' } }
    const r = await getDraft('zzz')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('updateDraft (modifica in-place) ritorna lo stesso link /doc/<id>', async () => {
    nextResult = { data: null, error: null }
    const r = await updateDraft('x', '<h1>nuovo paragrafo</h1>')
    expect(r).toContain('/doc/x')
  })

  it('listRecentDrafts senza bozze → "Nessuna bozza"', async () => {
    nextResult = { data: [], error: null }
    const r = await listRecentDrafts('conv1')
    expect(r).toContain('Nessuna bozza')
  })

  it('listRecentDrafts elenca i documenti con link', async () => {
    nextResult = { data: [{ id: 'a1', name: 'Preventivo Rossi', type: 'html', created_at: '2026-06-01T10:00:00Z' }], error: null }
    const r = await listRecentDrafts('conv1')
    expect(r).toContain('Preventivo Rossi')
    expect(r).toContain('/doc/a1')
  })

  it('saveDraftPdfToDrive happy path (HTML) → genera PDF + carica su Drive', async () => {
    nextResult = { data: { name: 'POS', content: '<h1>POS</h1>', type: 'html' }, error: null }
    const r = await saveDraftPdfToDrive('x', 'folder1')
    expect(generatePdfFromHtml).toHaveBeenCalled()
    expect(uploadBinaryToDrive).toHaveBeenCalled()
    expect(r).toContain('http://drive/file1')
    // content già HTML → passato tale e quale (nessun wrap aggiuntivo, niente <br> spuri)
    const passed = (generatePdfFromHtml as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string
    expect(passed).toBe('<h1>POS</h1>')
  })

  it('B: saveDraftPdfToDrive su auto-bozza (testo piatto) → wrappa in HTML prima del PDF', async () => {
    nextResult = {
      data: {
        name: 'Sollecito',
        content: 'Gentile Cliente,\n\nLa & invitiamo <subito>.\nSecondo rigo.',
        type: 'auto-bozza',
      },
      error: null,
    }
    const r = await saveDraftPdfToDrive('x', 'folder1')
    expect(r).toContain('http://drive/file1')
    const passed = (generatePdfFromHtml as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as string
    // wrappato in <p>, newline interni → <br>, caratteri speciali escapati
    expect(passed).toContain('<p>')
    expect(passed).toContain('<br>')
    expect(passed).toContain('&amp;')
    expect(passed).toContain('&lt;subito&gt;')
    // niente tag raw non escapati del content originale
    expect(passed).not.toContain('<subito>')
  })
})

describe('wrapPlainTextAsHtml / looksLikeHtml', () => {
  it('wrappa testo piatto in paragrafi e <br>', () => {
    const out = wrapPlainTextAsHtml('Riga uno\nRiga due\n\nNuovo paragrafo')
    expect(out).toBe('<p>Riga uno<br>Riga due</p>\n<p>Nuovo paragrafo</p>')
  })

  it('escapa &, <, >, ", \'', () => {
    const out = wrapPlainTextAsHtml(`a & b <x> "y" 'z'`)
    expect(out).toContain('&amp;')
    expect(out).toContain('&lt;x&gt;')
    expect(out).toContain('&quot;')
    expect(out).toContain('&#039;')
    expect(out).not.toContain('<x>')
  })

  it('testo vuoto → <p></p>', () => {
    expect(wrapPlainTextAsHtml('')).toBe('<p></p>')
    expect(wrapPlainTextAsHtml('   \n  ')).toBe('<p></p>')
  })

  it('looksLikeHtml: true per HTML, false per testo piatto', () => {
    expect(looksLikeHtml('<h1>Titolo</h1>')).toBe(true)
    expect(looksLikeHtml('<p>par</p>')).toBe(true)
    expect(looksLikeHtml('Testo piatto con *grassetto* Telegram e emoji 😀')).toBe(false)
    expect(looksLikeHtml('Oggetto: x\n\nGentile cliente')).toBe(false)
  })
})
