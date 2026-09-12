import { describe, it, expect } from 'vitest'
import { verificaDatiSocietari, pivaNostre, messaggioBlocco } from './guardia-societa'

const RESTRUKTURA = { denominazione: 'RESTRUKTURA S.r.l.', piva: '02087420762' }
const LAREALESTATE = { denominazione: 'LA REAL ESTATE SRLS', piva: '02232730768' }

describe('pivaNostre', () => {
  it('deriva dal registro, non da valori riscritti a mano', () => {
    const m = pivaNostre()
    expect(m.size).toBe(2)
    expect(m.get('02087420762')?.codice).toBe('restruktura')
    expect(m.get('02232730768')?.codice).toBe('larealestate')
  })
})

describe('verificaDatiSocietari — CONTROLLO NEGATIVO: il caso normale deve passare', () => {
  it('preventivo Restruktura con la P.IVA del COMMITTENTE nel corpo: passa', () => {
    const html = `<h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762</p>
      <div>Committente: Edil Limongi S.r.l. — P.IVA 01234567890</div>`
    expect(verificaDatiSocietari(html, RESTRUKTURA)).toEqual({ ok: true })
  })

  it('documento che non nomina nessuna partita IVA: passa', () => {
    expect(verificaDatiSocietari('<p>Relazione tecnica senza dati fiscali</p>', RESTRUKTURA)).toEqual({ ok: true })
  })

  it('documento La Real Estate con la SUA partita IVA: passa', () => {
    const html = `<h1>LA REAL ESTATE SRLS</h1><p>P.IVA 02232730768</p>`
    expect(verificaDatiSocietari(html, LAREALESTATE)).toEqual({ ok: true })
  })
})

describe('verificaDatiSocietari — CONTROLLO POSITIVO: il caso vero deve mordere', () => {
  it('IL DIFETTO DI OGGI: La Real Estate attiva, intestazione Restruktura cablata', () => {
    const html = `<div class="header"><h1>RESTRUKTURA S.r.l.</h1><p>P.IVA 02087420762 — Villa d'Agri (PZ)</p></div>
      <h2>PREVENTIVO N. 1</h2>`
    const esito = verificaDatiSocietari(html, LAREALESTATE)
    expect(esito.ok).toBe(false)
    if (esito.ok) throw new Error('controllo positivo inerte: la guardia non ha morso')
    expect(esito.trovate).toEqual([{ piva: '02087420762', denominazione: 'RESTRUKTURA S.r.l.' }])
    expect(esito.attesa).toEqual(LAREALESTATE)
  })

  it('riconosce la P.IVA anche con prefisso IT', () => {
    const esito = verificaDatiSocietari('<p>IT02087420762</p>', LAREALESTATE)
    expect(esito.ok).toBe(false)
  })

  it('riconosce la P.IVA anche con separatori', () => {
    const esito = verificaDatiSocietari('<p>P.IVA 02.087.420.762</p>', LAREALESTATE)
    expect(esito.ok).toBe(false)
  })

  it('il messaggio di blocco NOMINA le due partite IVA: un rifiuto muto costringe a indovinare', () => {
    const esito = verificaDatiSocietari('<h1>RESTRUKTURA S.r.l.</h1><p>02087420762</p>', LAREALESTATE)
    if (esito.ok) throw new Error('atteso blocco')
    const msg = messaggioBlocco(esito)
    expect(msg).toContain('02087420762')
    expect(msg).toContain('02232730768')
    expect(msg).toContain('LA REAL ESTATE SRLS')
  })
})
