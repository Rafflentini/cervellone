import { describe, it, expect } from 'vitest'
import { validateValues, applyDefaults, escapeHtml, riempiHtml } from './template-fill-html'
import type { CampoModello } from './document-templates'

const campi: CampoModello[] = [
  { nome: 'titolo', label: 'Titolo', tipo: 'testo', obbligatorio: true },
  { nome: 'nota', label: 'Nota', tipo: 'testo', obbligatorio: false, default: 'n/d' },
  { nome: 'righe', label: 'Righe', tipo: 'tabella', obbligatorio: false,
    colonne: [{ nome: 'voce', tipo: 'testo' }, { nome: 'ore', tipo: 'numero' }] },
]

describe('validateValues', () => {
  it('segnala i campi obbligatori mancanti', () => {
    expect(validateValues(campi, {}).missing).toEqual(['titolo'])
    expect(validateValues(campi, { titolo: 'X' }).ok).toBe(true)
  })
  it('vuoto/whitespace conta come mancante', () => {
    expect(validateValues(campi, { titolo: '   ' }).missing).toEqual(['titolo'])
  })
})

describe('applyDefaults', () => {
  it('applica i default ai campi non forniti', () => {
    const out = applyDefaults(campi, { titolo: 'X' })
    expect(out.nota).toBe('n/d')
    expect(out.titolo).toBe('X')
  })
  it('non sovrascrive un valore fornito', () => {
    expect(applyDefaults(campi, { titolo: 'X', nota: 'mia' }).nota).toBe('mia')
  })
})

describe('escapeHtml', () => {
  it('neutralizza i caratteri pericolosi', () => {
    expect(escapeHtml('<b>&"\'')).toBe('&lt;b&gt;&amp;&quot;&#39;')
  })
})

describe('riempiHtml', () => {
  it('sostituisce gli scalari con escape', () => {
    expect(riempiHtml('<p>{{titolo}}</p>', { titolo: '<x>' })).toBe('<p>&lt;x&gt;</p>')
  })
  it('espande i blocchi tabella', () => {
    const tpl = '<table>{{#righe}}<tr><td>{{voce}}</td><td>{{ore}}</td></tr>{{/righe}}</table>'
    const html = riempiHtml(tpl, { righe: [ { voce: 'a', ore: 2 }, { voce: 'b', ore: 3 } ] })
    expect(html).toBe('<table><tr><td>a</td><td>2</td></tr><tr><td>b</td><td>3</td></tr></table>')
  })
  it('blocco tabella senza dati -> vuoto', () => {
    expect(riempiHtml('<x>{{#righe}}r{{/righe}}</x>', {})).toBe('<x></x>')
  })
  it('scalare mancante -> stringa vuota', () => {
    expect(riempiHtml('<p>{{assente}}</p>', {})).toBe('<p></p>')
  })
})
