import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./document-templates', () => ({
  getTemplate: vi.fn(),
  listTemplates: vi.fn(),
  createTemplate: vi.fn(),
  setDatiFissi: vi.fn(),
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
      dati_fissi: {},
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
      dati_fissi: {},
      formati_output: ['pdf'], mai_inviare: true,
    })
    ;(pdf.generatePdfFromHtml as any).mockResolvedValue(Buffer.from('PDF'))
    ;(drive.uploadBinaryToDrive as any).mockResolvedValue({ id: 'fid', webViewLink: 'https://drive/x' })
    const out = await executeDocumentTemplateTool('compila_modello', { slug: 'm', valori: { x: 'ciao' } })
    expect(pdf.generatePdfFromHtml).toHaveBeenCalledOnce()
    expect(drive.uploadBinaryToDrive).toHaveBeenCalledOnce()
    expect(out).toContain('https://drive/x')
  })

  it('compila_modello builtin_cigo: delega a generaAllegato10Cigo + carica ZIP con filename periodo', async () => {
    ;(dt.getTemplate as any).mockResolvedValue({
      slug: 'cigo_allegato10', titolo: 'CIGO', metodo: 'builtin_cigo',
      campi: [
        { nome: 'periodo_dal', label: 'dal', tipo: 'data', obbligatorio: true },
        { nome: 'periodo_al', label: 'al', tipo: 'data', obbligatorio: true },
      ],
      dati_fissi: {},
      formati_output: ['pdf'], mai_inviare: true,
    })
    ;(cigo.generaAllegato10Cigo as any).mockResolvedValue({ zipBuffer: Buffer.from('ZIP'), warnings: [] })
    ;(drive.uploadBinaryToDrive as any).mockResolvedValue({ id: 'z', webViewLink: 'https://drive/zip' })
    const out = await executeDocumentTemplateTool('compila_modello', {
      slug: 'cigo_allegato10',
      valori: {
        periodo_dal: '2026-06-01',
        periodo_al: '2026-06-11',
        beneficiari: [{ cognome: 'ROSSI', nome: 'MARIO', codice_fiscale: 'RSSMRA80A01H501U', ore: 8 }],
      },
    })
    expect(cigo.generaAllegato10Cigo).toHaveBeenCalledOnce()
    // Filename must contain the periodo, not today's date
    expect(drive.uploadBinaryToDrive).toHaveBeenCalledWith(
      expect.any(Buffer),
      'CIGO_Allegato10_2026-06-01_2026-06-11.zip',
      'application/zip',
      undefined,
    )
    expect(out).toContain('https://drive/zip')
    // Worker count appears in success message
    expect(out).toContain('1 operai')
  })

  it('compila_modello builtin_cigo: zero beneficiari -> errore, NON chiama generaAllegato10Cigo', async () => {
    ;(dt.getTemplate as any).mockResolvedValue({
      slug: 'cigo_allegato10', titolo: 'CIGO', metodo: 'builtin_cigo',
      campi: [
        { nome: 'periodo_dal', label: 'dal', tipo: 'data', obbligatorio: true },
        { nome: 'periodo_al', label: 'al', tipo: 'data', obbligatorio: true },
      ],
      dati_fissi: {},
      formati_output: ['pdf'], mai_inviare: true,
    })
    const out = await executeDocumentTemplateTool('compila_modello', {
      slug: 'cigo_allegato10',
      valori: { periodo_dal: '2026-06-01', periodo_al: '2026-06-11' },
    })
    expect(cigo.generaAllegato10Cigo).not.toHaveBeenCalled()
    expect(out).toMatch(/operai|beneficiari|imposta_dati_fissi/i)
  })

  it('compila_modello: dati_fissi soddisfano campi obbligatori senza richiederli di nuovo', async () => {
    ;(dt.getTemplate as any).mockResolvedValue({
      slug: 'cigo_allegato10', titolo: 'CIGO', metodo: 'builtin_cigo',
      campi: [
        { nome: 'azienda_denominazione', label: 'Azienda — denominazione', tipo: 'testo', obbligatorio: true },
        { nome: 'azienda_cf', label: 'Azienda — CF', tipo: 'testo', obbligatorio: true },
        { nome: 'azienda_matricola_inps', label: 'Azienda — matricola INPS', tipo: 'testo', obbligatorio: true },
        { nome: 'lr_nome_cognome', label: 'LR — nome cognome', tipo: 'testo', obbligatorio: true },
        { nome: 'periodo_dal', label: 'dal', tipo: 'data', obbligatorio: true },
        { nome: 'periodo_al', label: 'al', tipo: 'data', obbligatorio: true },
      ],
      dati_fissi: {
        azienda_denominazione: 'ACME S.R.L.',
        azienda_cf: '99999999999',
        azienda_matricola_inps: '1234567890',
        lr_nome_cognome: 'Mario Rossi',
      },
      formati_output: ['pdf'], mai_inviare: true,
    })
    ;(cigo.generaAllegato10Cigo as any).mockResolvedValue({ zipBuffer: Buffer.from('ZIP'), warnings: [] })
    ;(drive.uploadBinaryToDrive as any).mockResolvedValue({ id: 'z', webViewLink: 'https://drive/zip2' })

    // Only per-request variable fields provided — company fields come from dati_fissi
    const out = await executeDocumentTemplateTool('compila_modello', {
      slug: 'cigo_allegato10',
      valori: {
        periodo_dal: '2026-06-01',
        periodo_al: '2026-06-30',
        beneficiari: [{ cognome: 'VERDI', nome: 'LUCA', codice_fiscale: 'VRDLCU90A01F205E', ore: 16 }],
      },
    })

    // Must NOT ask for missing fields (they're covered by dati_fissi)
    expect(out).not.toMatch(/mancano|servono/i)
    expect(cigo.generaAllegato10Cigo).toHaveBeenCalledOnce()
    // The merged values passed to generaAllegato10Cigo must include azienda from dati_fissi
    const callArg = (cigo.generaAllegato10Cigo as any).mock.calls[0][0] as Record<string, unknown>
    expect((callArg.azienda as Record<string, unknown>).denominazione).toBe('ACME S.R.L.')
    expect(out).toContain('https://drive/zip2')
  })

  it('lista_modelli: elenca gli slug', async () => {
    ;(dt.listTemplates as any).mockResolvedValue([{ slug: 'cigo_allegato10', titolo: 'CIGO', parole_chiave: [] }])
    const out = await executeDocumentTemplateTool('lista_modelli', {})
    expect(out).toContain('cigo_allegato10')
  })

  it('imposta_dati_fissi: chiama setDatiFissi e restituisce conferma', async () => {
    ;(dt.setDatiFissi as any).mockResolvedValue({ ok: true })
    const out = await executeDocumentTemplateTool('imposta_dati_fissi', {
      slug: 'cigo_allegato10',
      valori: { azienda_denominazione: 'ACME S.R.L.', azienda_cf: '99999999999' },
    })
    expect(dt.setDatiFissi).toHaveBeenCalledWith('cigo_allegato10', {
      azienda_denominazione: 'ACME S.R.L.',
      azienda_cf: '99999999999',
    })
    expect(out).toMatch(/salvat/i)
  })

  it('imposta_dati_fissi: errore da setDatiFissi -> messaggio di errore', async () => {
    ;(dt.setDatiFissi as any).mockResolvedValue({ ok: false, error: 'slug non trovato' })
    const out = await executeDocumentTemplateTool('imposta_dati_fissi', {
      slug: 'inesistente',
      valori: { azienda_denominazione: 'X' },
    })
    expect(out).toMatch(/non.*riuscito|errore/i)
    expect(out).toContain('slug non trovato')
  })
})

describe('mapCigoInput', () => {
  it('mappa le ore di stop per operaio su ore_perse_settimana_1 (-> OreCIG nel CSV)', () => {
    const out = mapCigoInput({
      azienda_denominazione: 'TEST S.R.L.',
      azienda_cf: '11111111111',
      azienda_matricola_inps: '9999999999',
      lr_nome_cognome: 'Rossi Mario',
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

  it('cantiere folded into attivita_svolta (comune + indirizzo + data_apertura + lavorazioni)', () => {
    const out = mapCigoInput({
      cantiere_comune: 'Viggiano',
      cantiere_indirizzo: 'Via Roma 1',
      cantiere_data_apertura: '2026-03-15',
      lavorazioni: 'Carpenteria in ferro',
      beneficiari: [],
    })
    expect(out.attivita_svolta).toContain('Cantiere sito in Viggiano, Via Roma 1')
    expect(out.attivita_svolta).toContain('aperto il 15/03/2026')
    expect(out.attivita_svolta).toContain('Carpenteria in ferro')
  })

  it('cantiere senza data_apertura: no virgola extra', () => {
    const out = mapCigoInput({
      cantiere_comune: 'Marsico Nuovo',
      cantiere_indirizzo: 'Contrada Valle',
      lavorazioni: 'Demolizioni',
      beneficiari: [],
    })
    expect(out.attivita_svolta).toContain('Cantiere sito in Marsico Nuovo, Contrada Valle.')
    expect(out.attivita_svolta).not.toContain('aperto il')
    expect(out.attivita_svolta).toContain('Demolizioni')
  })

  it('senza cantiere_comune/indirizzo: attivita_svolta e solo lavorazioni', () => {
    const out = mapCigoInput({ lavorazioni: 'Solo lavorazioni', beneficiari: [] })
    expect(out.attivita_svolta).toBe('Solo lavorazioni')
  })

  it('dati azienda letti da valori, non hardcodati', () => {
    const out = mapCigoInput({
      azienda_denominazione: 'NUOVA IMPRESA S.R.L.',
      azienda_cf: '12345678901',
      azienda_matricola_inps: '5555555555',
      azienda_unita_produttiva: 'Sede Principale',
      lr_nome_cognome: 'Bianchi Carlo',
      lr_qualifica: 'titolare',
      beneficiari: [],
    })
    const az = out.azienda as Record<string, unknown>
    expect(az.denominazione).toBe('NUOVA IMPRESA S.R.L.')
    expect(az.codice_fiscale).toBe('12345678901')
    expect(az.matricola_inps).toBe('5555555555')
    expect(az.unita_produttiva).toBe('Sede Principale')
    const lr = out.legale_rappresentante as Record<string, unknown>
    expect(lr.nome_cognome).toBe('Bianchi Carlo')
    expect(lr.qualifica).toBe('titolare')
  })

  it('fallback operai_abituali quando beneficiari e\' assente o vuoto', () => {
    const out = mapCigoInput({
      operai_abituali: [
        { cognome: 'VERDI', nome: 'GIUSEPPE', codice_fiscale: 'VRDGPP80A01H501U', ore: 16 },
      ],
    })
    const ben = (out.beneficiari as Array<Record<string, unknown>>)[0]
    expect(ben.cognome).toBe('VERDI')
    expect(ben.ore_perse_settimana_1).toBe(16)
  })

  it('qualifica LR non valida non viene inclusa', () => {
    const out = mapCigoInput({ lr_nome_cognome: 'Rossi', lr_qualifica: 'socio', beneficiari: [] })
    const lr = out.legale_rappresentante as Record<string, unknown>
    expect(lr.qualifica).toBeUndefined()
  })
})
