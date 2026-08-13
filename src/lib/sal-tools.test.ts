import { describe, it, expect, vi } from 'vitest'

// Mock delle dipendenze IO per isolare la logica del dispatcher
vi.mock('./supabase-server', () => ({
  getSupabaseServer: () => ({
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: '00000000-0000-4000-8000-000000000000' }, error: null }) }) }),
      update: () => ({ eq: function () { return this }, neq: function () { return this }, select: async () => ({ data: [{ id: 'x' }], error: null }) }),
    }),
  }),
}))

import { executeSalTool, cancelSal } from './sal-tools'

describe('sal_calcola', () => {
  it('ritorna un errore leggibile se la riconciliazione fallisce (niente pending)', async () => {
    const out = await executeSalTool('sal_calcola', {
      commessa: 'X', commessa_folder_id: 'f', oggetto: 'o', data: '2026-08-13',
      numero_sal: 1, totale_computo: 1000, sal_precedente: 0,
      gruppi: [{ nome: 'A', importo_contrattuale: 700, percentuale: 50 }],
      params: { iva_perc: 10, ritenuta_garanzia_perc: 0, anticipazione: 0, is_ultimo_sal: false },
    })
    expect(out).toContain('Riconciliazione fallita')
  })

  it('ritorna null per un tool non suo', async () => {
    expect(await executeSalTool('altro_tool', {})).toBeNull()
  })
})

describe('cancelSal', () => {
  it('conferma annullamento con claim ottimistico', async () => {
    const msg = await cancelSal('00000000-0000-4000-8000-000000000000')
    expect(msg.toLowerCase()).toContain('annull')
  })
})
