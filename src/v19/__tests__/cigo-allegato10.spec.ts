import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { generaAllegato10Cigo } from '../tools/cigo'
import { fixtureCigoAprile2026, mockBollettinoFetch } from './fixtures/cigo-aprile-2026'

describe('genera_allegato10_cigo (Aprile 2026 ground-truth)', () => {
  it('produce 3 file (DOCX + CSV + bollettino PDF)', async () => {
    const result = await generaAllegato10Cigo(fixtureCigoAprile2026, {
      dryRun: true,
      fetchImpl: mockBollettinoFetch(),
    })
    expect(result.files).toHaveLength(3)
    const names = result.files.map((f) => f.name)
    expect(names).toContain('Allegato10_RelazioneTecnica.docx')
    expect(names).toContain('ElencoBeneficiari.csv')
    expect(names.some((n) => n.startsWith('Bollettino_Criticita_Basilicata'))).toBe(true)
  })

  it('Allegato 10 DOCX contiene tabella nativa per box DATI AZIENDA', async () => {
    const result = await generaAllegato10Cigo(fixtureCigoAprile2026, {
      dryRun: true,
      fetchImpl: mockBollettinoFetch(),
    })
    const docx = result.files.find((f) => f.name === 'Allegato10_RelazioneTecnica.docx')!
    const zip = await JSZip.loadAsync(docx.buffer)
    const xml = (await zip.file('word/document.xml')?.async('string')) ?? ''
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('RESTRUKTURA S.r.l.')
    expect(xml).toContain('02087420762')
    expect(xml).toContain('All.10')
    expect(xml).toContain('EVENTI METEOROLOGICI')
  })

  it('CSV beneficiari rispetta tracciato Msg INPS 3566/2018', async () => {
    const result = await generaAllegato10Cigo(fixtureCigoAprile2026, {
      dryRun: true,
      fetchImpl: mockBollettinoFetch(),
    })
    const csvFile = result.files.find((f) => f.name === 'ElencoBeneficiari.csv')!
    const csv = csvFile.buffer.toString('utf-8')
    // Rimuovi BOM
    const cleaned = csv.replace(/^﻿/, '')
    const lines = cleaned.split('\n')
    expect(lines[0]).toBe('Cognome;Nome;CodiceFiscale;DataAssunzione;TipoContratto;OreContrattuali;TipoIntegrazione;DataInizio;DataFine;OreCIG;Importo')
    expect(lines.length).toBe(1 + fixtureCigoAprile2026.beneficiari.length) // header + 5 righe
    expect(lines[1]).toContain('Bianchi;Mario;BNCMRA80A01F104X')
    expect(lines[5]).toContain('Esposito;Carmine;SPSCMN78D03F104V')
  })

  it('bollettino è PDF valido con magic bytes', async () => {
    const result = await generaAllegato10Cigo(fixtureCigoAprile2026, {
      dryRun: true,
      fetchImpl: mockBollettinoFetch(),
    })
    const bol = result.files.find((f) => f.name.startsWith('Bollettino_Criticita_Basilicata'))!
    expect(bol.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF')
    expect(bol.buffer.length).toBeGreaterThan(1000)
  })

  it('zip contiene tutti i file', async () => {
    const result = await generaAllegato10Cigo(fixtureCigoAprile2026, {
      dryRun: true,
      fetchImpl: mockBollettinoFetch(),
    })
    expect(result.zipBuffer).toBeDefined()
    const zip = await JSZip.loadAsync(result.zipBuffer!)
    const filesInZip = Object.keys(zip.files)
    expect(filesInZip).toContain('Allegato10_RelazioneTecnica.docx')
    expect(filesInZip).toContain('ElencoBeneficiari.csv')
    expect(filesInZip.some((n) => n.startsWith('Bollettino_Criticita_Basilicata'))).toBe(true)
  })

  it('se pagamento_diretto=true include SR41', async () => {
    const result = await generaAllegato10Cigo(
      { ...fixtureCigoAprile2026, pagamento_diretto: true },
      { dryRun: true, fetchImpl: mockBollettinoFetch() },
    )
    expect(result.files).toHaveLength(4)
    expect(result.files.map((f) => f.name)).toContain('SR41_PagamentoDiretto.docx')
  })
})
