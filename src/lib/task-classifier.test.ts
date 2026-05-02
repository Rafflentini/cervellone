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

  it('FIX W1.2: lamentele e dubbi con keyword task NON sono long', () => {
    expect(classifyTask('Perché mi rispondi sempre con il POS?', [])).toBe(false)
    expect(classifyTask('Come mai redigi un POS senza chiedermelo?', [])).toBe(false)
    expect(classifyTask('Non ti ho chiesto un preventivo', [])).toBe(false)
    expect(classifyTask('Smettila con il POS', [])).toBe(false)
    expect(classifyTask('Basta con i preventivi', [])).toBe(false)
    expect(classifyTask('non capisco perché redigi un POS', [])).toBe(false)
  })

  it('FIX W1.2: domande conversazionali NON sono long', () => {
    expect(classifyTask('Chi sei?', [])).toBe(false)
    expect(classifyTask("Cos'è un POS?", [])).toBe(false)
    expect(classifyTask('Come stai?', [])).toBe(false)
    expect(classifyTask('Come mai sei lento?', [])).toBe(false)
  })

  it('FIX W1.2: richieste esplicite RESTANO long anche se cortesi', () => {
    expect(classifyTask('Mi prepari un preventivo completo?', [])).toBe(true)
    expect(classifyTask('Fammi il POS per cantiere Test', [])).toBe(true)
  })
})
