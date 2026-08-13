import { describe, it, expect } from 'vitest'
import { calcolaSal, SalReconcileError, type SalCalcInput } from './sal-calc'

const base: SalCalcInput = {
  numero_sal: 1,
  totale_computo: 1000,
  gruppi: [
    { nome: 'A', importo_contrattuale: 600, percentuale: 50 },
    { nome: 'B', importo_contrattuale: 400, percentuale: 25 },
  ],
  sal_precedente: 0,
  params: { iva_perc: 10, ritenuta_garanzia_perc: 0, anticipazione: 0, is_ultimo_sal: false },
}

describe('calcolaSal', () => {
  it('calcola il maturato per gruppo e i totali (primo SAL, no ritenuta/anticipo)', () => {
    const r = calcolaSal(base)
    expect(r.gruppi[0].maturato_a_oggi).toBe(300)
    expect(r.gruppi[1].maturato_a_oggi).toBe(100)
    expect(r.totale_maturato_a_oggi).toBe(400)
    expect(r.maturato_nel_periodo).toBe(400)
    expect(r.imponibile_certificato).toBe(400)
    expect(r.iva).toBe(40)
    expect(r.totale_certificato).toBe(440)
  })

  it('detrae il SAL precedente per ottenere il maturato del periodo', () => {
    const r = calcolaSal({ ...base, numero_sal: 2, sal_precedente: 250 })
    expect(r.totale_maturato_a_oggi).toBe(400)
    expect(r.maturato_nel_periodo).toBe(150)
    expect(r.imponibile_certificato).toBe(150)
    expect(r.iva).toBe(15)
  })

  it('applica la ritenuta di garanzia sul maturato del periodo e riporta la cumulata', () => {
    const r = calcolaSal({ ...base, params: { ...base.params, ritenuta_garanzia_perc: 0.5 } })
    expect(r.ritenuta_periodo).toBe(2)
    expect(r.ritenuta_cumulata).toBe(2)
    expect(r.imponibile_certificato).toBe(398)
    expect(r.iva).toBe(39.8)
  })

  it("recupera l'anticipazione solo se is_ultimo_sal", () => {
    const noUltimo = calcolaSal({ ...base, params: { ...base.params, anticipazione: 100, is_ultimo_sal: false } })
    expect(noUltimo.recupero_anticipazione).toBe(0)
    const ultimo = calcolaSal({ ...base, params: { ...base.params, anticipazione: 100, is_ultimo_sal: true } })
    expect(ultimo.recupero_anticipazione).toBe(100)
    expect(ultimo.imponibile_certificato).toBe(300)
  })

  it('lancia SalReconcileError se Σ gruppi != totale_computo (oltre ±1€)', () => {
    expect(() => calcolaSal({ ...base, totale_computo: 1500 })).toThrow(SalReconcileError)
  })

  it('accetta scarti di arrotondamento entro ±1€', () => {
    expect(() => calcolaSal({ ...base, totale_computo: 1000.4 })).not.toThrow()
  })

  it('rifiuta input non numerici (NaN non deve bypassare il gate)', () => {
    const bad = { ...base, gruppi: [{ nome: 'A', importo_contrattuale: NaN, percentuale: 50 }] }
    expect(() => calcolaSal(bad as never)).toThrow(SalReconcileError)
    const badPerc = { ...base, gruppi: [{ nome: 'A', importo_contrattuale: 1000, percentuale: NaN }] }
    expect(() => calcolaSal(badPerc as never)).toThrow(SalReconcileError)
  })

  it('rifiuta gruppi vuoti', () => {
    expect(() => calcolaSal({ ...base, gruppi: [] })).toThrow(SalReconcileError)
  })

  it('rifiuta un maturato nel periodo negativo (SAL precedente troppo alto)', () => {
    expect(() => calcolaSal({ ...base, sal_precedente: 900 })).toThrow(SalReconcileError) // maturato a oggi 400
  })
})
