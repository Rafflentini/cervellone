import { describe, it, expect } from 'vitest'
import { normalizeSlug } from './document-templates'

describe('normalizeSlug', () => {
  it('minuscola, alfanumerico+underscore, niente accenti/spazi', () => {
    expect(normalizeSlug('CIGO Allegato 10')).toBe('cigo_allegato_10')
    expect(normalizeSlug('  Contratto d’appalto! ')).toBe('contratto_d_appalto')
    expect(normalizeSlug('perizia—2026')).toBe('perizia_2026')
  })
  it('collassa underscore multipli e taglia ai bordi', () => {
    expect(normalizeSlug('a   b')).toBe('a_b')
    expect(normalizeSlug('__x__')).toBe('x')
  })
})
