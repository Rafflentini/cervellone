import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./document-templates', () => ({
  getTemplate: vi.fn(),
  listTemplates: vi.fn(),
  createTemplate: vi.fn(),
  normalizeSlug: (s: string) => s.toLowerCase(),
}))
vi.mock('./drive', () => ({ uploadBinaryToDrive: vi.fn() }))
vi.mock('./pdf-generator', () => ({ generatePdfFromHtml: vi.fn() }))
vi.mock('@/v19/tools/cigo', () => ({ generaAllegato10Cigo: vi.fn() }))

import { executeDocumentTemplateTool, mapCigoInput } from './document-template-tools'
import * as dt from './document-templates'
import * as drive from './drive'
import * as pdf from './pdf-generator'
import * as cigo from '@/v19/tools/cigo'

beforeEach(() => vi.clearAllMocks())

describe('executeDocumentTemplateTool', () => {
  it('ritorna null per tool non gestiti', async () => {
    expect(await executeDocumentTemplateTool('altro_tool', {})).toBeNull()
  })

  it('compila_modello: modello assente -> errore chiaro', async () => {
    ;(dt.getTemplate as any).mockResolvedValue(null)
    const out = await executeDocumentTemplateTool('compila_modello', { slug: 'xxx', valori: {} })
    expect(out).toMatch(/non.*trovat/i)
  })

  it('compila_modello: campi obbligatori mancanti -> li chiede, non genera', async () => {
    ;(dt.getTemplate as any).mockResolvedValue({
      slug: 'm', titolo: 'M', metodo: 'B_html', html_template: '<p>{{x}}</p>',
      campi: [{ nome: 'x', label: 'X', tipo: 'testo', obbligatorio: true }],
      formati_output: ['pdf'], mai_inviare: true,
    })
    const out = await executeDocumentTemplateTool('compila_modello', { slug: 'm', valori: {} })
    expect(out).toMatch(/mancano|servono/i)
    expect(out).toContain('X')
    expect(pdf.generatePdfFromHtml).not.toHaveBeenCalled()
    expect(drive.uploadBinaryToDrive).not.toHaveBeenCalled()
  })

  it('compila_modello B_html: happy path -> PDF su Drive + link reale', async () => {
    ;(dt.getTemplate as any).mockResolvedValue({
      slug: 'm', titolo: 'M', metodo: 'B_html', html_template: '<p>{{x}}</p>',
      campi: [{ nome: 'x', label: 'X', tipo: 'testo', obbligatorio: true }],
      formati_output: ['pdf'], mai_inviare: true,
    })
    ;(pdf.generatePdfFromHtml as any).mockResolvedValue(Buffer.from('PDF'))
    ;(drive.uploadBinaryToDrive as any).mockResolvedValue({ id: 'fid', webViewLink: 'https://drive/x' })
    const out = await executeDocumentTemplateTool('compila_modello', { slug: 'm', valori: { x: 'ciao' } })
    expect(pdf.generatePdfFromHtml).toHaveBeenCalledOnce()
    expect(drive.uploadBinaryToDrive).toHaveBeenCalledOnce()
    expect(out).toContain('https://drive/x')
  })

  it('compila_modello builtin_cigo: delega a generaAllegato10Cigo + carica ZIP', async () => {
    ;(dt.getTemplate as any).mockResolvedValue({
      slug: 'cigo_allegato10', titolo: 'CIGO', metodo: 'builtin_cigo',
      campi: [
        { nome: 'periodo_dal', label: 'dal', tipo: 'data', obbligatorio: true },
        { nome: 'periodo_al', label: 'al', tipo: 'data', obbligatorio: true },
      ],
      formati_output: ['pdf'], mai_inviare: true,
    })
    ;(cigo.generaAllegato10Cigo as any).mockResolvedValue({ zipBuffer: Buffer.from('ZIP'), warnings: [] })
    ;(drive.uploadBinaryToDrive as any).mockResolvedValue({ id: 'z', webViewLink: 'https://drive/zip' })
    const out = await executeDocumentTemplateTool('compila_modello', {
      slug: 'cigo_allegato10',
      valori: { periodo_dal: '2026-06-01', periodo_al: '2026-06-11' },
    })
    expect(cigo.generaAllegato10Cigo).toHaveBeenCalledOnce()
    expect(drive.uploadBinaryToDrive).toHaveBeenCalledWith(expect.any(Buffer), expect.stringContaining('.zip'), 'application/zip', undefined)
    expect(out).toContain('https://drive/zip')
  })

  it('lista_modelli: elenca gli slug', async () => {
    ;(dt.listTemplates as any).mockResolvedValue([{ slug: 'cigo_allegato10', titolo: 'CIGO', parole_chiave: [] }])
    const out = await executeDocumentTemplateTool('lista_modelli', {})
    expect(out).toContain('cigo_allegato10')
  })
})

describe('mapCigoInput', () => {
  it('mappa le ore di stop per operaio su ore_perse_settimana_1 (-> OreCIG nel CSV)', () => {
    const out = mapCigoInput({
      periodo_dal: '2026-06-01',
      periodo_al: '2026-06-11',
      beneficiari: [
        { cognome: 'PACILLI', nome: 'MARTIN', codice_fiscale: 'PCLMTN94C04E977G', qualifica: 'Muratore Edile', ore: 24 },
      ],
    })
    const ben = (out.beneficiari as Array<Record<string, unknown>>)[0]
    expect(ben.ore_perse_settimana_1).toBe(24)
    expect(ben.codice_fiscale).toBe('PCLMTN94C04E977G')
    expect(ben.qualifica).toBe('Muratore Edile')
  })

  it('ore mancanti o non numeriche -> 0 (mai NaN)', () => {
    const out = mapCigoInput({ beneficiari: [{ cognome: 'A', nome: 'B', codice_fiscale: 'C' }] })
    expect((out.beneficiari as Array<Record<string, unknown>>)[0].ore_perse_settimana_1).toBe(0)
    const out2 = mapCigoInput({ beneficiari: [{ cognome: 'A', nome: 'B', codice_fiscale: 'C', ore: 'abc' }] })
    expect((out2.beneficiari as Array<Record<string, unknown>>)[0].ore_perse_settimana_1).toBe(0)
  })

  it('periodo mappato correttamente', () => {
    const out = mapCigoInput({ periodo_dal: '2026-06-01', periodo_al: '2026-06-11', beneficiari: [] })
    expect(out.periodo).toEqual({ data_inizio: '2026-06-01', data_fine: '2026-06-11' })
  })
})
