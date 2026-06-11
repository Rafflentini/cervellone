import { describe, it, expect, vi } from 'vitest'
import { normalizeSlug, stripUnsafeHtml, createTemplate } from './document-templates'

// Mock Supabase so createTemplate tests don't need a real DB connection
vi.mock('@/lib/supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      upsert: vi.fn().mockResolvedValue({ error: null }),
    }),
  }),
}))

describe('normalizeSlug', () => {
  it('minuscola, alfanumerico+underscore, niente accenti/spazi', () => {
    expect(normalizeSlug('CIGO Allegato 10')).toBe('cigo_allegato_10')
    expect(normalizeSlug("  Contratto d'appalto! ")).toBe('contratto_d_appalto')
    expect(normalizeSlug('perizia—2026')).toBe('perizia_2026')
  })
  it('collassa underscore multipli e taglia ai bordi', () => {
    expect(normalizeSlug('a   b')).toBe('a_b')
    expect(normalizeSlug('__x__')).toBe('x')
  })
})

describe('stripUnsafeHtml', () => {
  it('rimuove blocchi script e mantiene il contenuto safe', () => {
    const input = '<p>testo</p><script>alert(1)</script><p>fine</p>'
    const out = stripUnsafeHtml(input)
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('alert(1)')
    expect(out).toContain('<p>testo</p>')
    expect(out).toContain('<p>fine</p>')
  })
  it('rimuove handler on* inline', () => {
    const input = '<img src="x" onerror="alert(1)" />'
    const out = stripUnsafeHtml(input)
    expect(out).not.toContain('onerror')
    expect(out).toContain('src="x"')
  })
  it('rimpiazza javascript: con #', () => {
    const input = '<a href="javascript:void(0)">link</a>'
    const out = stripUnsafeHtml(input)
    expect(out).not.toContain('javascript:')
    expect(out).toContain('link')
  })
  it('non altera HTML sicuro', () => {
    const input = '<p style="color:red">Ciao {{nome}}</p>'
    expect(stripUnsafeHtml(input)).toBe(input)
  })
})

describe('createTemplate validations', () => {
  it('B_html senza html_template -> errore', async () => {
    const res = await createTemplate({
      slug: 'test_b',
      titolo: 'Test B',
      tipo_sorgente: 'html',
      metodo: 'B_html',
      campi: [],
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/html_template/)
  })

  it('html_template > 500KB -> errore', async () => {
    const res = await createTemplate({
      slug: 'test_big',
      titolo: 'Test Big',
      tipo_sorgente: 'html',
      metodo: 'B_html',
      campi: [],
      html_template: 'x'.repeat(500_001),
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/troppo grande/)
  })

  it('B_html con html_template valido -> ok', async () => {
    const res = await createTemplate({
      slug: 'test_valid',
      titolo: 'Test Valid',
      tipo_sorgente: 'html',
      metodo: 'B_html',
      campi: [],
      html_template: '<p>{{campo}}</p>',
    })
    expect(res.ok).toBe(true)
  })
})
