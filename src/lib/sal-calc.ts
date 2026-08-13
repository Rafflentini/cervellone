export interface SalGruppoInput { nome: string; importo_contrattuale: number; percentuale: number }
export interface SalParams { iva_perc: number; ritenuta_garanzia_perc: number; anticipazione: number; is_ultimo_sal: boolean }
export interface SalCalcInput { numero_sal: number; totale_computo: number; gruppi: SalGruppoInput[]; sal_precedente: number; params: SalParams }
export interface SalGruppoCalcolato { nome: string; importo_contrattuale: number; percentuale: number; maturato_a_oggi: number }
export interface SalResult {
  numero_sal: number
  gruppi: SalGruppoCalcolato[]
  totale_maturato_a_oggi: number
  sal_precedente: number
  maturato_nel_periodo: number
  ritenuta_periodo: number
  ritenuta_cumulata: number
  recupero_anticipazione: number
  imponibile_certificato: number
  iva: number
  totale_certificato: number
}

export class SalReconcileError extends Error {
  constructor(message: string) { super(message); this.name = 'SalReconcileError' }
}

const r2 = (n: number): number => Math.round(n * 100) / 100

export function calcolaSal(input: SalCalcInput): SalResult {
  const { gruppi, totale_computo, sal_precedente, params } = input

  // FIX audit #2: valida la finitezza PRIMA del gate, altrimenti un NaN
  // (input LLM malformato) fa passare `NaN > 1 === false` e produce "NaN" negli importi.
  if (!Number.isFinite(totale_computo) || !Number.isFinite(sal_precedente)) {
    throw new SalReconcileError('totale_computo o sal_precedente non numerici')
  }
  // FIX audit-verify: valida anche i params economici, altrimenti un iva_perc/
  // ritenuta/anticipazione undefined|NaN (letto da un contratto incompleto)
  // produrrebbe importi certificati NaN salvati come SAL ufficiale.
  if (!params || !Number.isFinite(params.iva_perc) ||
      !Number.isFinite(params.ritenuta_garanzia_perc) || !Number.isFinite(params.anticipazione)) {
    throw new SalReconcileError('Parametri economici non validi (iva_perc / ritenuta_garanzia_perc / anticipazione mancanti o non numerici). Leggili dal Contratto d\'Appalto.')
  }
  if (!Array.isArray(gruppi) || gruppi.length === 0) {
    throw new SalReconcileError('Nessun gruppo di lavorazione fornito')
  }
  for (const g of gruppi) {
    if (!g || !Number.isFinite(g.importo_contrattuale)) {
      throw new SalReconcileError(`Importo contrattuale non valido per "${g?.nome ?? '?'}"`)
    }
    if (!Number.isFinite(g.percentuale) || g.percentuale < 0 || g.percentuale > 100) {
      throw new SalReconcileError(`Percentuale non valida per "${g.nome}": ${g.percentuale} (attesa 0..100)`)
    }
  }

  const sommaGruppi = r2(gruppi.reduce((s, g) => s + g.importo_contrattuale, 0))
  if (Math.abs(sommaGruppi - totale_computo) > 1) {
    throw new SalReconcileError(
      `Riconciliazione fallita: Σ gruppi = ${sommaGruppi} € ≠ totale computo = ${totale_computo} €. ` +
      `Controlla il raggruppamento delle voci.`,
    )
  }

  const gruppiCalcolati: SalGruppoCalcolato[] = gruppi.map(g => ({
    nome: g.nome,
    importo_contrattuale: r2(g.importo_contrattuale),
    percentuale: g.percentuale,
    maturato_a_oggi: r2(g.importo_contrattuale * g.percentuale / 100),
  }))

  const totale_maturato_a_oggi = r2(gruppiCalcolati.reduce((s, g) => s + g.maturato_a_oggi, 0))
  const maturato_nel_periodo = r2(totale_maturato_a_oggi - sal_precedente)
  // FIX audit #3: un periodo negativo (SAL precedente > maturato a oggi) è un errore
  // di input, non un SAL valido. Meglio bloccare che archiviare importi negativi.
  if (maturato_nel_periodo < -1) {
    throw new SalReconcileError(
      `Maturato nel periodo negativo (€ ${maturato_nel_periodo}): il SAL precedente ` +
      `(€ ${r2(sal_precedente)}) supera il maturato a oggi (€ ${totale_maturato_a_oggi}). ` +
      `Controlla le percentuali o l'importo del SAL precedente.`,
    )
  }
  const ritenuta_periodo = r2(maturato_nel_periodo * params.ritenuta_garanzia_perc / 100)
  const ritenuta_cumulata = r2(totale_maturato_a_oggi * params.ritenuta_garanzia_perc / 100)
  const recupero_anticipazione = params.is_ultimo_sal ? r2(params.anticipazione) : 0
  const imponibile_certificato = r2(maturato_nel_periodo - ritenuta_periodo - recupero_anticipazione)
  const iva = r2(imponibile_certificato * params.iva_perc / 100)
  const totale_certificato = r2(imponibile_certificato + iva)

  return {
    numero_sal: input.numero_sal,
    gruppi: gruppiCalcolati,
    totale_maturato_a_oggi,
    sal_precedente: r2(sal_precedente),
    maturato_nel_periodo,
    ritenuta_periodo,
    ritenuta_cumulata,
    recupero_anticipazione,
    imponibile_certificato,
    iva,
    totale_certificato,
  }
}
