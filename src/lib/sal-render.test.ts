import { describe, it, expect } from 'vitest'
import { buildSalSheets, buildSalHtml } from './sal-render'
import { calcolaSal, type SalCalcInput } from './sal-calc'

const input: SalCalcInput = {
  numero_sal: 1, totale_computo: 1000,
  gruppi: [
    { nome: 'Ponteggio', importo_contrattuale: 600, percentuale: 50 },
    { nome: 'Facciata', importo_contrattuale: 400, percentuale: 25 },
  ],
  sal_precedente: 0,
  params: { iva_perc: 10, ritenuta_garanzia_perc: 0.5, anticipazione: 0, is_ultimo_sal: false },
}
const meta = { commessa: 'C2026-008 Cond. E. Fermi', oggetto: 'Ripristino facciate', data: '2026-08-13', numero_sal: 1 }

describe('buildSalSheets', () => {
  it('produce un foglio con intestazione commessa, header e una riga per gruppo', () => {
    const sheets = buildSalSheets(calcolaSal(input), meta)
    expect(sheets).toHaveLength(1)
    const rows = sheets[0].rows
    const flat = JSON.stringify(rows)
    // intestazione commessa dentro il foglio
    expect(flat).toContain('C2026-008')
    // header tabella e prima riga gruppo (posizione trovata, non assunta a indice 0)
    const headerIdx = rows.findIndex(r => r[0] === 'Gruppo di lavorazione')
    expect(headerIdx).toBeGreaterThanOrEqual(0)
    expect(rows[headerIdx]).toEqual(['Gruppo di lavorazione', 'Importo contrattuale', '% avanz.', 'Maturato a oggi'])
    expect(rows[headerIdx + 1]).toEqual(['Ponteggio', 600, 50, 300])
    expect(flat).toContain('Imponibile certificato')
  })
})

describe('buildSalHtml', () => {
  it('include numero SAL, commessa e totale certificato', () => {
    const html = buildSalHtml(calcolaSal(input), meta)
    expect(html).toContain('SAL n° 1')
    expect(html).toContain('C2026-008')
    expect(html).toContain('Totale certificato')
  })
})
