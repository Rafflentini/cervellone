import { describe, it, expect } from 'vitest'
import { inferDocumentType, extractClientName, buildHistoryContext } from './document-saver'

describe('inferDocumentType', () => {
  it('riconosce POS', () => {
    expect(inferDocumentType('PIANO OPERATIVO DI SICUREZZA per cantiere', 'redigi un POS')).toBe('pos')
    expect(inferDocumentType('<h1>P.O.S.</h1>', 'pos cantiere Rossi')).toBe('pos')
  })
  it('riconosce CME', () => {
    expect(inferDocumentType('COMPUTO METRICO ESTIMATIVO', 'CME per Bianchi')).toBe('cme')
  })
  it('riconosce perizia', () => {
    expect(inferDocumentType('PERIZIA TECNICA', 'fai perizia immobile')).toBe('perizia')
  })
  it('riconosce relazione', () => {
    expect(inferDocumentType('Relazione di calcolo strutturale', 'relazione tecnica')).toBe('relazione')
  })
  it('riconosce SCIA', () => {
    expect(inferDocumentType('SCIA', 'pratica SCIA Comune Marsicovetere')).toBe('scia')
    expect(inferDocumentType('Segnalazione Certificata Inizio Attività', '')).toBe('scia')
  })
  it('riconosce CILA', () => {
    expect(inferDocumentType('CILA', 'pratica CILA')).toBe('cila')
  })
  it('riconosce preventivo', () => {
    expect(inferDocumentType('PREVENTIVO RISTRUTTURAZIONE', 'fammi un preventivo')).toBe('preventivo')
    expect(inferDocumentType('OFFERTA ECONOMICA', 'offerta cliente')).toBe('preventivo')
  })
  it('default altro per documenti generici', () => {
    expect(inferDocumentType('Nota tecnica generica', 'fammi una nota')).toBe('altro')
  })
})

describe('extractClientName', () => {
  it('estrae nome cliente da "per cantiere XXX"', () => {
    expect(extractClientName('redigi un POS per cantiere Rossi Mario in via Roma', '')).toBe('Rossi Mario')
  })
  it('estrae nome da "cliente XXX"', () => {
    expect(extractClientName('preventivo per cliente Bianchi Costruzioni', '')).toBe('Bianchi Costruzioni')
  })
  it('estrae nome da "Sig. XXX"', () => {
    expect(extractClientName('relazione per Sig. Verdi Antonio', '')).toBe('Verdi Antonio')
  })
  it('ritorna null se nessun pattern matcha', () => {
    expect(extractClientName('ciao come va', '')).toBeNull()
  })
  it('usa context history se prompt non ha cliente', () => {
    const result = extractClientName('continua', 'preventivo per cantiere Marsicovetere ABC')
    expect(result).toBe('Marsicovetere ABC')
  })
})

describe('buildHistoryContext', () => {
  it('estrae ultimi 3 messaggi user', () => {
    const history = [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'msg2' },
      { role: 'assistant', content: 'reply2' },
      { role: 'user', content: 'msg3' },
      { role: 'user', content: 'msg4' },
    ]
    const result = buildHistoryContext(history)
    expect(result).toContain('msg2')
    expect(result).toContain('msg3')
    expect(result).toContain('msg4')
    expect(result).not.toContain('reply')
  })
  it('skippa content non-string', () => {
    const history = [
      { role: 'user', content: 'msg1' },
      { role: 'user', content: [{ type: 'image' }] },
    ]
    expect(buildHistoryContext(history)).toBe('msg1')
  })
})
