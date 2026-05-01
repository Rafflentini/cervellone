import { describe, it, expect } from 'vitest'
import { classifyTask } from './task-classifier'

describe('classifyTask', () => {
  it('classifica chat veloce per saluti brevi', () => {
    expect(classifyTask('ciao', [])).toBe(false)
    expect(classifyTask('come stai?', [])).toBe(false)
    expect(classifyTask('grazie', [])).toBe(false)
  })

  it('classifica chat veloce per domande brevi', () => {
    expect(classifyTask('che ore sono?', [])).toBe(false)
    expect(classifyTask('quanti cantieri attivi ho?', [])).toBe(false)
  })

  it('classifica come lungo per redazione documenti', () => {
    expect(classifyTask('redigi un POS per cantiere Rossi', [])).toBe(true)
    expect(classifyTask('prepara un preventivo completo per Bianchi', [])).toBe(true)
    expect(classifyTask('elabora la perizia tecnica', [])).toBe(true)
  })

  it('classifica come lungo per documenti tecnici specifici', () => {
    expect(classifyTask('fai il POS', [])).toBe(true)
    expect(classifyTask('serve un computo metrico estimativo', [])).toBe(true)
    expect(classifyTask('relazione di calcolo strutturale', [])).toBe(true)
    expect(classifyTask('CME e quadro economico', [])).toBe(true)
  })

  it('classifica come lungo se ci sono file > 100KB', () => {
    const bigFile = [{ type: 'document', source: { data: 'x'.repeat(150_000) } }]
    expect(classifyTask('cosa ne pensi?', bigFile)).toBe(true)
  })

  it('classifica come veloce se ci sono file piccoli', () => {
    const smallFile = [{ type: 'image', source: { data: 'x'.repeat(50_000) } }]
    expect(classifyTask('descrivi la foto', smallFile)).toBe(false)
  })

  it('case-insensitive sui keyword', () => {
    expect(classifyTask('REDIGI UN POS', [])).toBe(true)
    expect(classifyTask('Preparami un Preventivo', [])).toBe(true)
  })
})
