import { formatEuro, formatDate } from './format'

export interface VoceCalcolata {
  numero: number
  descrizione: string
  um: string
  quantita: number
  prezzo_unitario: number
  importo: number
  categoria?: string
  prezzo_prezziario?: number | null
  scostamento_percentuale?: number | null
}

export interface PreventivoCalcolato {
  titolo: string
  numero: string
  data: string
  committente: { nome: string; indirizzo?: string; cf_piva?: string; telefono?: string; email?: string }
  cantiere: { indirizzo: string; comune: string; descrizione: string }
  voci: VoceCalcolata[]
  subtotale_lavori: number
  spese_generali: number
  spese_generali_perc: number
  utile_impresa: number
  utile_impresa_perc: number
  oneri_sicurezza: number
  oneri_sicurezza_perc: number
  totale_imponibile: number
  iva: number
  iva_perc: number
  totale_complessivo: number
  note: string[]
  esclusioni: string[]
  condizioni_pagamento: string
  validita_offerta: string
}

function voceRow(v: VoceCalcolata): string {
  return `<tr><td>${v.numero}</td><td>${v.descrizione}</td><td>${v.um}</td><td class="amount">${v.um === 'a corpo' ? '' : formatEuro(v.quantita)}</td><td class="amount">${formatEuro(v.prezzo_unitario)}</td><td class="amount">${formatEuro(v.importo)}</td></tr>\n`
}

export function generaHtmlPreventivo(p: PreventivoCalcolato): string {
  // Group voci by categoria if present
  const hasCategorie = p.voci.some(v => v.categoria)

  let tableRows = ''
  if (hasCategorie) {
    const categorie = [...new Set(p.voci.map(v => v.categoria || 'Altro'))]
    for (const cat of categorie) {
      const vociCat = p.voci.filter(v => (v.categoria || 'Altro') === cat)
      tableRows += `<tr class="categoria"><td colspan="6">${cat}</td></tr>\n`
      for (const v of vociCat) {
        tableRows += voceRow(v)
      }
      const subtotaleCat = vociCat.reduce((s, v) => s + v.importo, 0)
      tableRows += `<tr class="subtotal"><td colspan="5">Subtotale ${cat}</td><td class="amount">${formatEuro(subtotaleCat)}</td></tr>\n`
    }
  } else {
    for (const v of p.voci) {
      tableRows += voceRow(v)
    }
  }

  // Scostamenti significativi
  const scostamenti = p.voci.filter(v => v.prezzo_prezziario && v.scostamento_percentuale && Math.abs(v.scostamento_percentuale) > 15)
  let confrontoSection = ''
  if (scostamenti.length > 0) {
    const confrontoRows = scostamenti.map(v =>
      `<tr><td>${v.descrizione}</td><td class="amount">${formatEuro(v.prezzo_unitario)}</td><td class="amount">${formatEuro(v.prezzo_prezziario!)}</td><td class="amount ${v.scostamento_percentuale! > 0 ? 'positive' : 'negative'}">${v.scostamento_percentuale! > 0 ? '+' : ''}${v.scostamento_percentuale!.toFixed(1)}%</td></tr>`
    ).join('\n')
    confrontoSection = `
    <h2 class="section-title">Confronto Prezziario Regionale</h2>
    <table>
      <thead><tr><th>Voce</th><th>P.U. Applicato</th><th>P.U. Prezziario</th><th>Scostamento</th></tr></thead>
      <tbody>${confrontoRows}</tbody>
    </table>`
  }

  const noteHtml = p.note.length > 0 ? `
    <div class="notes">
      <div class="notes-title">Note e Condizioni</div>
      <ul>${p.note.map(n => `<li>${n}</li>`).join('')}</ul>
      <p><strong>Condizioni di pagamento:</strong> ${p.condizioni_pagamento}</p>
      <p><strong>Validit&agrave; offerta:</strong> ${p.validita_offerta}</p>
    </div>` : `
    <div class="notes">
      <div class="notes-title">Condizioni</div>
      <p><strong>Condizioni di pagamento:</strong> ${p.condizioni_pagamento}</p>
      <p><strong>Validit&agrave; offerta:</strong> ${p.validita_offerta}</p>
    </div>`

  const esclusioniHtml = p.esclusioni.length > 0 ? `
    <div class="notes exclusions">
      <div class="notes-title">Esclusioni</div>
      <ul>${p.esclusioni.map(e => `<li>${e}</li>`).join('')}</ul>
    </div>` : ''

  const committentInfo = [
    p.committente.indirizzo ? `<div><div class="info-label">Indirizzo</div><div class="info-value">${p.committente.indirizzo}</div></div>` : '',
    p.committente.cf_piva ? `<div><div class="info-label">C.F. / P.IVA</div><div class="info-value">${p.committente.cf_piva}</div></div>` : '',
    p.committente.telefono ? `<div><div class="info-label">Telefono</div><div class="info-value">${p.committente.telefono}</div></div>` : '',
    p.committente.email ? `<div><div class="info-label">Email</div><div class="info-value">${p.committente.email}</div></div>` : '',
  ].filter(Boolean).join('\n      ')

  return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4; margin: 15mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', system-ui, Arial, sans-serif; color: #1a1a2e; background: #fff; line-height: 1.6; max-width: 210mm; margin: 0 auto; }
  .header { background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #1e40af 100%); color: white; padding: 32px 40px; position: relative; overflow: hidden; }
  .header::after { content: ''; position: absolute; top: -50%; right: -20%; width: 300px; height: 300px; background: radial-gradient(circle, rgba(59,130,246,0.15) 0%, transparent 70%); border-radius: 50%; }
  .header-content { position: relative; z-index: 1; }
  .company-name { font-size: 26px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; }
  .company-subtitle { font-size: 11px; color: #93c5fd; letter-spacing: 2px; text-transform: uppercase; margin-top: 2px; }
  .company-details { font-size: 11px; color: #bfdbfe; margin-top: 10px; line-height: 1.8; }
  .doc-title-bar { background: #f0f4ff; border-bottom: 3px solid #1e40af; padding: 14px 40px; display: flex; justify-content: space-between; align-items: center; }
  .doc-title { font-size: 17px; font-weight: 700; color: #1e3a5f; text-transform: uppercase; letter-spacing: 0.5px; }
  .doc-meta { font-size: 11px; color: #64748b; text-align: right; line-height: 1.8; }
  .doc-meta strong { color: #1e3a5f; }
  .content { padding: 24px 40px; }
  .section-title { font-size: 13px; font-weight: 700; color: #1e40af; text-transform: uppercase; letter-spacing: 0.5px; padding-bottom: 5px; border-bottom: 2px solid #e2e8f0; margin: 20px 0 10px 0; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 20px; background: #f8fafc; border-radius: 8px; padding: 14px; margin-bottom: 14px; }
  .info-label { color: #64748b; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
  .info-value { color: #1a1a2e; font-weight: 600; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 11px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); border-radius: 8px; overflow: hidden; }
  thead th { background: linear-gradient(135deg, #1e3a5f, #1e40af); color: white; padding: 9px 10px; text-align: left; font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; }
  thead th:nth-child(n+3) { text-align: right; }
  tbody td { padding: 8px 10px; border-bottom: 1px solid #e8ecf1; }
  tbody td:nth-child(n+3) { text-align: right; }
  tbody tr:nth-child(even) { background: #f8fafc; }
  tbody tr.categoria { background: #eef2ff; font-weight: 700; font-size: 11px; color: #1e40af; }
  tbody tr.subtotal { background: #f0f4ff; font-weight: 700; border-top: 2px solid #cbd5e1; }
  tbody tr.coeff td { color: #475569; font-style: italic; }
  tbody tr.total { background: linear-gradient(135deg, #0f172a, #1e3a5f); color: white; font-weight: 800; font-size: 12px; }
  tbody tr.total td { padding: 11px 10px; border: none; }
  .amount { font-variant-numeric: tabular-nums; font-weight: 600; }
  .positive { color: #16a34a; }
  .negative { color: #dc2626; }
  .notes { background: #fffbeb; border-left: 4px solid #f59e0b; padding: 12px 16px; margin: 14px 0; border-radius: 0 8px 8px 0; font-size: 11px; }
  .notes.exclusions { background: #fef2f2; border-left-color: #ef4444; }
  .notes-title { font-weight: 700; color: #92400e; margin-bottom: 4px; font-size: 10px; text-transform: uppercase; }
  .notes.exclusions .notes-title { color: #991b1b; }
  .notes ul { padding-left: 16px; margin: 4px 0; }
  .notes li { margin-bottom: 3px; }
  .notes p { margin-top: 6px; }
  .signature-area { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin: 28px 0 14px; }
  .signature-box { text-align: center; font-size: 11px; color: #64748b; }
  .signature-line { border-top: 1px solid #cbd5e1; padding-top: 8px; margin-top: 48px; }
  .footer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 40px; display: flex; justify-content: space-between; font-size: 9px; color: #94a3b8; margin-top: 20px; }
</style>
</head>
<body>
  <div class="header">
    <div class="header-content">
      <div class="company-name">Restruktura S.r.l.</div>
      <div class="company-subtitle">Ingegneria &bull; Costruzioni &bull; Ponteggi</div>
      <div class="company-details">P.IVA 02087420762 &bull; Villa d'Agri &ndash; Marsicovetere (PZ)<br>Ing. Raffaele Lentini &bull; Legale Rappresentante</div>
    </div>
  </div>
  <div class="doc-title-bar">
    <div class="doc-title">${p.titolo}</div>
    <div class="doc-meta"><strong>N.:</strong> ${p.numero}<br><strong>Data:</strong> ${formatDate(p.data)}</div>
  </div>
  <div class="content">
    <h2 class="section-title">Committente</h2>
    <div class="info-grid">
      <div><div class="info-label">Nome</div><div class="info-value">${p.committente.nome}</div></div>
      ${committentInfo}
    </div>

    <h2 class="section-title">Cantiere</h2>
    <div class="info-grid">
      <div><div class="info-label">Indirizzo</div><div class="info-value">${p.cantiere.indirizzo}</div></div>
      <div><div class="info-label">Comune</div><div class="info-value">${p.cantiere.comune}</div></div>
      <div style="grid-column: 1 / -1;"><div class="info-label">Descrizione lavori</div><div class="info-value">${p.cantiere.descrizione}</div></div>
    </div>

    <h2 class="section-title">Voci di Preventivo</h2>
    <table>
      <thead><tr><th>N.</th><th>Descrizione</th><th>U.M.</th><th>Qt.</th><th>P.U. (&euro;)</th><th>Importo (&euro;)</th></tr></thead>
      <tbody>
        ${tableRows}
        <tr class="subtotal"><td colspan="5">Importo Lavori</td><td class="amount">${formatEuro(p.subtotale_lavori)}</td></tr>
        <tr class="coeff"><td colspan="5">Spese generali (${(p.spese_generali_perc * 100).toFixed(0)}%)</td><td class="amount">${formatEuro(p.spese_generali)}</td></tr>
        <tr class="coeff"><td colspan="5">Utile d'impresa (${(p.utile_impresa_perc * 100).toFixed(0)}%)</td><td class="amount">${formatEuro(p.utile_impresa)}</td></tr>
        <tr class="coeff"><td colspan="5">Oneri sicurezza (${(p.oneri_sicurezza_perc * 100).toFixed(1)}%)</td><td class="amount">${formatEuro(p.oneri_sicurezza)}</td></tr>
        <tr class="subtotal"><td colspan="5">Totale Imponibile</td><td class="amount">${formatEuro(p.totale_imponibile)}</td></tr>
        <tr class="coeff"><td colspan="5">IVA (${(p.iva_perc * 100).toFixed(0)}%)</td><td class="amount">${formatEuro(p.iva)}</td></tr>
        <tr class="total"><td colspan="5">TOTALE COMPLESSIVO</td><td class="amount">${formatEuro(p.totale_complessivo)}</td></tr>
      </tbody>
    </table>

    ${confrontoSection}
    ${noteHtml}
    ${esclusioniHtml}

    <div class="signature-area">
      <div class="signature-box"><div class="signature-line">Restruktura S.r.l.<br>Ing. Raffaele Lentini</div></div>
      <div class="signature-box"><div class="signature-line">Il Committente<br>${p.committente.nome}</div></div>
    </div>
  </div>
  <div class="footer">
    <span>Restruktura S.r.l. &bull; Documento generato dal Cervellone</span>
    <span>${formatDate(p.data)}</span>
  </div>
</body>
</html>`
}
