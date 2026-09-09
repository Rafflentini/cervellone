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
      // ⭐ NIENTE valori inventati. Qui c'era `?? 'CCNL Edilizia'` e `?? 40`:
      // poiche' `mapCigoInput` non scriveva mai quei due campi, OGNI operaio
      // usciva dichiarato all'INPS come edile a tempo pieno, sempre, senza che
      // nessuno l'avesse detto. Le ore contrattuali sono il denominatore
      // dell'integrazione salariale: un part-time a 20 ore dichiarato a 40 e'
      // una dichiarazione falsa su un modulo pubblico, e il segnaposto e'
      // troppo plausibile perche' qualcuno se ne accorga.
      //
      // Una casella vuota l'INPS la rifiuta: e' visibile e si corregge. Un
      // numero sbagliato l'INPS lo accetta. Un segnaposto non e' una
      // dichiarazione — vedi il sesso predefinito «M» del check-in.
      escapeCsv(b.tipo_contratto ?? ''),
      b.ore_contrattuali_settimana === undefined ? '' : String(b.ore_contrattuali_settimana),
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

/**
 * Gli operai a cui manca un dato obbligatorio del tracciato INPS, detti per
 * nome e cognome.
 *
 * Una casella vuota da sola non basta: se nessuno lo dice, il pacchetto parte
 * lo stesso e il rifiuto dell'INPS arriva giorni dopo, senza spiegare quale
 * operaio e quale campo. Questi avvisi finiscono nei `warnings` del pacchetto,
 * che `compila_modello` riporta in chat.
 */
export function avvisiBeneficiariIncompleti(beneficiari: Beneficiario[]): string[] {
  const avvisi: string[] = []

  for (const b of beneficiari) {
    const mancanti: string[] = []
    if (!b.tipo_contratto) mancanti.push('tipo di contratto')
    if (b.ore_contrattuali_settimana === undefined) mancanti.push('ore contrattuali settimanali')
    if (!b.data_assunzione) mancanti.push('data di assunzione')

    if (mancanti.length > 0) {
      const nome = `${b.cognome} ${b.nome}`.trim() || b.codice_fiscale
      avvisi.push(
        `${nome}: manca ${mancanti.join(', ')}. La casella resta VUOTA nel CSV per l'INPS — vanno compilate prima di inviare la domanda.`,
      )
    }
  }

  return avvisi
}
