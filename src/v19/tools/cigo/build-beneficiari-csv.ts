/**
 * Cervellone V19 — Builder CSV beneficiari (tracciato Msg INPS 3566/2018)
 *
 * Spec: docs/superpowers/specs/2026-05-09-cervellone-v19-rifondazione.md sez. 9.4
 *
 * NOTA: il tracciato esatto Msg INPS 3566/2018 ha più di 10 colonne secondo
 * il flag pagamento (pagamento conto azienda vs pagamento diretto). Per la
 * V19 foundation implementiamo il subset documentato nelle ricerche.
 * Da verificare/completare con il PDF ufficiale del Messaggio INPS.
 */

import type { Beneficiario, Periodo } from './types'

export const BENEFICIARI_HEADER = [
  'Cognome',
  'Nome',
  'CodiceFiscale',
  'DataAssunzione',
  'TipoContratto',
  'OreContrattuali',
  'TipoIntegrazione',
  'DataInizio',
  'DataFine',
  'OreCIG',
  'Importo',
] as const

export function buildBeneficiariCsv(beneficiari: Beneficiario[], periodo: Periodo): string {
  const rows: string[] = []
  rows.push(BENEFICIARI_HEADER.join(';'))

  for (const b of beneficiari) {
    const orePerse =
      (b.ore_perse_settimana_1 ?? 0) +
      (b.ore_perse_settimana_2 ?? 0) +
      (b.ore_perse_settimana_3 ?? 0) +
      (b.ore_perse_settimana_4 ?? 0)

    const row = [
      escapeCsv(b.cognome),
      escapeCsv(b.nome),
      escapeCsv(b.codice_fiscale),
      escapeCsv(b.data_assunzione ?? ''),
      escapeCsv(b.tipo_contratto ?? 'CCNL Edilizia'),
      String(b.ore_contrattuali_settimana ?? 40),
      'CIGO_EM', // CIGO Eventi Meteo
      escapeCsv(periodo.data_inizio),
      escapeCsv(periodo.data_fine),
      String(orePerse),
      '', // Importo: lasciato vuoto, sarà calcolato da INPS
    ].join(';')

    rows.push(row)
  }

  // Aggiungi BOM UTF-8 per compatibilità Excel italiano
  return '﻿' + rows.join('\n')
}

function escapeCsv(value: string): string {
  if (!value) return ''
  if (value.includes(';') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}
