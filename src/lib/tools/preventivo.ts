import { formatEuro, generateNumeroPreventivo } from './format'
import { cercaPrezziario } from './prezziario'
import { generaHtmlPreventivo, VoceCalcolata, PreventivoCalcolato } from './preventivo-html'

export interface PreventivoInput {
  titolo?: string
  numero?: string
  data?: string
  committente: { nome: string; indirizzo?: string; cf_piva?: string; telefono?: string; email?: string }
  cantiere: { indirizzo: string; comune: string; descrizione: string }
  voci: Array<{
    descrizione: string
    um: string
    quantita: number
    prezzo_unitario: number
    categoria?: string
  }>
  coefficienti?: {
    spese_generali?: number
    utile_impresa?: number
    oneri_sicurezza?: number
    iva?: number
  }
  regione?: string
  note?: string[]
  esclusioni?: string[]
  condizioni_pagamento?: string
  validita_offerta?: string
}

export async function executeCalcolaPreventivo(input: PreventivoInput): Promise<string> {
  const sg = input.coefficienti?.spese_generali ?? 0.15
  const ui = input.coefficienti?.utile_impresa ?? 0.10
  const os = input.coefficienti?.oneri_sicurezza ?? 0.025
  const iva = input.coefficienti?.iva ?? 0.10
  const regione = input.regione || 'basilicata'

  // Calculate each voce and compare with prezziario
  const vociCalcolate: VoceCalcolata[] = []
  let numero = 1

  for (const voce of input.voci) {
    // Search prezziario for comparison
    let prezzoPrezziario: number | null = null
    let scostamento: number | null = null

    try {
      const prezziarioResult = await cercaPrezziario(voce.descrizione, regione)
      if (prezziarioResult.found && prezziarioResult.prezzo !== null) {
        prezzoPrezziario = prezziarioResult.prezzo
      }
    } catch (err) {
      console.error(`PREVENTIVO: errore ricerca prezziario per "${voce.descrizione}":`, err)
    }

    // Use the GREATER of our price vs prezziario
    let prezzoFinale = voce.prezzo_unitario
    if (prezzoPrezziario !== null && prezzoPrezziario > prezzoFinale) {
      prezzoFinale = prezzoPrezziario
    }

    if (prezzoPrezziario !== null) {
      scostamento = ((prezzoFinale - prezzoPrezziario) / prezzoPrezziario) * 100
    }

    const importo = voce.quantita * prezzoFinale

    vociCalcolate.push({
      numero,
      descrizione: voce.descrizione,
      um: voce.um,
      quantita: voce.quantita,
      prezzo_unitario: prezzoFinale,
      importo: Math.round(importo * 100) / 100,
      categoria: voce.categoria,
      prezzo_prezziario: prezzoPrezziario,
      scostamento_percentuale: scostamento,
    })

    numero++
  }

  // Calculate totals — all in code, zero LLM math
  const subtotale = vociCalcolate.reduce((sum, v) => sum + v.importo, 0)
  const speseGen = Math.round(subtotale * sg * 100) / 100
  const utileImp = Math.round(subtotale * ui * 100) / 100
  const oneriSic = Math.round(subtotale * os * 100) / 100
  const totaleImponibile = Math.round((subtotale + speseGen + utileImp + oneriSic) * 100) / 100
  const ivaImporto = Math.round(totaleImponibile * iva * 100) / 100
  const totaleComplessivo = Math.round((totaleImponibile + ivaImporto) * 100) / 100

  const preventivo: PreventivoCalcolato = {
    titolo: input.titolo || 'Preventivo Estimativo',
    numero: input.numero || generateNumeroPreventivo(),
    data: input.data || new Date().toISOString().slice(0, 10),
    committente: input.committente,
    cantiere: input.cantiere,
    voci: vociCalcolate,
    subtotale_lavori: subtotale,
    spese_generali: speseGen,
    spese_generali_perc: sg,
    utile_impresa: utileImp,
    utile_impresa_perc: ui,
    oneri_sicurezza: oneriSic,
    oneri_sicurezza_perc: os,
    totale_imponibile: totaleImponibile,
    iva: ivaImporto,
    iva_perc: iva,
    totale_complessivo: totaleComplessivo,
    note: input.note || [],
    esclusioni: input.esclusioni || [],
    condizioni_pagamento: input.condizioni_pagamento || '30% alla firma, 40% al SAL, 30% al collaudo',
    validita_offerta: input.validita_offerta || '60 giorni',
  }

  console.log(`PREVENTIVO: ${vociCalcolate.length} voci, subtotale ${formatEuro(subtotale)}, totale ${formatEuro(totaleComplessivo)}`)

  return generaHtmlPreventivo(preventivo)
}
