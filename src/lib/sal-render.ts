import type { SalResult } from './sal-calc'
import type { XlsxSheet } from './pdf-generator'

export interface SalMeta { commessa: string; oggetto: string; data: string; numero_sal: number }

const eur = (n: number) => n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function buildSalSheets(result: SalResult, _meta: SalMeta): XlsxSheet[] {
  const rows: (string | number | null)[][] = []
  rows.push(['Gruppo di lavorazione', 'Importo contrattuale', '% avanz.', 'Maturato a oggi'])
  for (const g of result.gruppi) rows.push([g.nome, g.importo_contrattuale, g.percentuale, g.maturato_a_oggi])
  rows.push([])
  rows.push(['Totale maturato a oggi', null, null, result.totale_maturato_a_oggi])
  rows.push(['SAL precedente', null, null, result.sal_precedente])
  rows.push(['Maturato nel periodo', null, null, result.maturato_nel_periodo])
  if (result.ritenuta_periodo) rows.push(['Ritenuta di garanzia (periodo)', null, null, result.ritenuta_periodo])
  if (result.recupero_anticipazione) rows.push(['Recupero anticipazione', null, null, result.recupero_anticipazione])
  rows.push(['Imponibile certificato', null, null, result.imponibile_certificato])
  rows.push(['IVA', null, null, result.iva])
  rows.push(['Totale certificato', null, null, result.totale_certificato])
  return [{ name: `SAL n${result.numero_sal}`, rows }]
}

export function buildSalHtml(result: SalResult, meta: SalMeta): string {
  const righe = result.gruppi.map(g =>
    `<tr><td>${g.nome}</td><td style="text-align:right">€ ${eur(g.importo_contrattuale)}</td>` +
    `<td style="text-align:right">${g.percentuale}%</td><td style="text-align:right">€ ${eur(g.maturato_a_oggi)}</td></tr>`,
  ).join('')
  const rigaEcon = (label: string, val: number) =>
    `<tr><td colspan="3" style="text-align:right"><strong>${label}</strong></td><td style="text-align:right">€ ${eur(val)}</td></tr>`
  return `
    <h1>SAL n° ${result.numero_sal}</h1>
    <p><strong>Commessa:</strong> ${meta.commessa}<br/>
       <strong>Oggetto:</strong> ${meta.oggetto}<br/>
       <strong>Data:</strong> ${meta.data}</p>
    <table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;width:100%">
      <thead><tr><th>Gruppo di lavorazione</th><th>Importo contrattuale</th><th>% avanz.</th><th>Maturato a oggi</th></tr></thead>
      <tbody>${righe}</tbody>
      <tfoot>
        ${rigaEcon('Totale maturato a oggi', result.totale_maturato_a_oggi)}
        ${rigaEcon('SAL precedente', result.sal_precedente)}
        ${rigaEcon('Maturato nel periodo', result.maturato_nel_periodo)}
        ${result.ritenuta_periodo ? rigaEcon('Ritenuta di garanzia (periodo)', result.ritenuta_periodo) : ''}
        ${result.recupero_anticipazione ? rigaEcon('Recupero anticipazione', result.recupero_anticipazione) : ''}
        ${rigaEcon('Imponibile certificato', result.imponibile_certificato)}
        ${rigaEcon('IVA', result.iva)}
        ${rigaEcon('Totale certificato', result.totale_certificato)}
      </tfoot>
    </table>`
}
